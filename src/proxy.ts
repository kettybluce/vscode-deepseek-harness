import * as http from 'node:http';
import * as net from 'node:net';
import type { Duplex } from 'node:stream';

/**
 * 本地认证代理 —— 解决 VS Code webview iframe 内嵌 `dsh web` 的认证死结。
 *
 * 背景（2026-10-15 实锤）：dsh web 的浏览器认证 cookie 带 `HttpOnly; SameSite=Strict`，
 * 而 VS Code webview 的顶层源是 vscode-webview://（不透明源），iframe 祖先链全部跨站，
 * `/?token=T` 的 303 跳转回 `./` 时 Strict cookie 永远发不出去 → 恒定 401。
 * 在 webview 里靠 cookie 认证没有出路，所以由扩展侧代理完成认证：
 *   1. 代理用自身 HTTP 客户端访问 `?token=T` 完成交换，拿到 dsh-auth cookie；
 *   2. 之后把浏览器的每个请求（含 WebSocket upgrade）转发给 dsh 并注入该 cookie、
 *      重写 Host/Origin（dsh 用 Host 头计算 authority 校验 cookie 名与载荷）。
 * 浏览器侧全程不需要 cookie，SameSite 语义不再参与。
 */

/** 逐跳头（RFC 7230），转发时剥离；host 由代理按上游重写。 */
const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade', 'host',
]);

export interface AuthProxy { port: number; dispose(): void }

/** 从 set-cookie 值里取第一段 name=value；无 cookie 返回 null。 */
function firstPair(setCookie: string): string | null {
  const pair = setCookie.split(';')[0]?.trim();
  return pair && pair.includes('=') ? pair : null;
}

/** 代理启动前的 token→cookie 交换；上游可能尚未就绪，做有限重试。 */
async function exchangeToken(url: URL): Promise<string[]> {
  let lastError = '';
  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      const jar = await new Promise<string[]>((resolve, reject) => {
        const req = http.request(
          { hostname: url.hostname, port: url.port, path: url.pathname + url.search, method: 'GET', timeout: 5000 },
          res => {
            const raw = res.headers['set-cookie'] ?? [];
            const jar = raw.map(firstPair).filter((p): p is string => p !== null);
            res.resume();
            res.on('end', () => jar.length ? resolve(jar) : reject(new Error(`token 交换响应未携带 cookie（HTTP ${res.statusCode}）`)));
          },
        );
        req.on('timeout', () => req.destroy(new Error('token 交换请求超时')));
        req.on('error', reject);
        req.end();
      });
      return jar;
    } catch (e: any) {
      lastError = String(e?.message ?? e);
      await new Promise(r => setTimeout(r, 500));
    }
  }
  throw new Error(`token 交换失败：${lastError}`);
}

/** 把 dsh 打印的带 token URL 换成一个免认证的本地代理端口。 */
export async function startAuthProxy(targetUrl: string): Promise<AuthProxy> {
  const target = (() => {
    try { return new URL(targetUrl); } catch { throw new Error(`dsh web 地址无法解析：${targetUrl}`); }
  })();
  const targetHost = target.hostname;
  const targetPort = Number(target.port || (target.protocol === 'https:' ? 443 : 80));
  const jar = await exchangeToken(target);

  const agent = new http.Agent({ keepAlive: true, maxSockets: 64 });
  const sockets = new Set<Duplex>();
  const server = http.createServer();

  const jarHeader = (extra: string | undefined): string => {
    const parts = [...jar];
    if (extra) for (const pair of extra.split(';')) if (pair.trim()) parts.push(pair.trim());
    return parts.join('; ');
  };

  /** 拷贝 rawHeaders，剔除逐跳头并按需重写 host/origin。 */
  function forwardHeaders(raw: string[], withCookie: string | undefined): http.OutgoingHttpHeaders {
    const headers: http.OutgoingHttpHeaders = {};
    let sawOrigin = false;
    for (let i = 0; i < raw.length; i += 2) {
      const key = raw[i]!, value = raw[i + 1] ?? '';
      const lk = key.toLowerCase();
      if (HOP_BY_HOP.has(lk)) continue;
      if (lk === 'cookie') continue; // 统一由代理注入
      if (lk === 'origin') { sawOrigin = true; continue; } // 统一改写为上游源
      if (Array.isArray(headers[key])) headers[key] = [...(headers[key] as string[]), value];
      else if (headers[key] !== undefined) headers[key] = [String(headers[key]), value];
      else headers[key] = value;
    }
    headers.host = target.host;
    // dsh 的 /api 信任栅栏要求 origin.host === Host（isTrustedApiRequest）：
    // 浏览器同源 POST 必带 Origin（= 代理端口），不改写会被 403 全拒——
    // 症状即「界面能渲染（GET 无 Origin 可过），但所有交互全死」（2026-10-16 实锤）。
    if (sawOrigin) headers.origin = target.origin;
    if (withCookie) headers.cookie = withCookie;
    return headers;
  }

  server.on('request', (req, res) => {
    const headers = forwardHeaders(req.rawHeaders, jarHeader(req.headers.cookie));
    const upstream = http.request(
      { host: targetHost, port: targetPort, method: req.method, path: req.url, headers, agent },
      upres => {
        // dsh 若中途重发认证 cookie（续期/轮换），同步进 jar 再透传
        for (const raw of upres.headers['set-cookie'] ?? []) {
          const pair = firstPair(raw);
          if (pair) {
            const idx = jar.findIndex(j => j.split('=')[0] === pair.split('=')[0]);
            if (idx >= 0) jar[idx] = pair; else jar.push(pair);
          }
        }
        const out = forwardHeaders(upres.rawHeaders, undefined);
        delete out['x-frame-options']; // 防御性剥离，避免未来版本挡 iframe
        res.writeHead(upres.statusCode ?? 502, out);
        upres.pipe(res);
      },
    );
    upstream.on('error', err => {
      if (res.headersSent) { res.destroy(); return; }
      res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
      res.end(`Harness 本地认证代理无法连到官方运行时：${err.message}（运行时可能已退出，请点 ⟳ 重试）`);
    });
    req.pipe(upstream);
  });

  // WebSocket：原样字节隧道，重写 Host/Origin、注入认证 cookie
  server.on('upgrade', (req, socket, head) => {
    const upstream = net.connect({ host: targetHost, port: targetPort }, () => {
      const lines: string[] = [`${req.method} ${req.url} HTTP/1.1`];
      for (let i = 0; i < req.rawHeaders.length; i += 2) {
        const key = req.rawHeaders[i]!, value = req.rawHeaders[i + 1] ?? '';
        const lk = key.toLowerCase();
        if (lk === 'cookie') continue;
        if (lk === 'host') lines.push(`Host: ${target.host}`);
        else if (lk === 'origin') lines.push(`Origin: ${target.origin}`);
        else lines.push(`${key}: ${value}`);
      }
      lines.push(`Cookie: ${jarHeader(req.headers.cookie)}`, '', '');
      upstream.write(lines.join('\r\n'));
      if (head.length) upstream.write(head);
      upstream.setNoDelay(true);
      socket.pipe(upstream);
      upstream.pipe(socket);
    });
    const fail = () => { socket.destroy(); upstream.destroy(); };
    upstream.on('error', fail);
    socket.on('error', fail);
    socket.on('close', () => sockets.delete(socket));
    sockets.add(socket);
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });

  return {
    port: (server.address() as net.AddressInfo).port,
    dispose() {
      for (const s of sockets) s.destroy();
      sockets.clear();
      agent.destroy();
      server.close();
      server.closeAllConnections?.();
    },
  };
}
