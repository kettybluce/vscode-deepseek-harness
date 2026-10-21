import * as http from 'node:http';
import type { Socket } from 'node:net';

/**
 * 内嵌承载用的本地反向代理（实验特性）。
 *
 * 为什么需要它：dsh web 的浏览器会话是 `HttpOnly; SameSite=Strict` cookie，
 * 且 cookie 名与签名都把「Host 授权域」（`host:port`）绑死。VS Code webview
 * 的文档源是 `vscode-webview://`，把 dsh 放进 iframe 属于第三方上下文——
 * SameSite=Strict 的 cookie 根本不会被浏览器发送，因此必须由代理在服务端
 * 补齐认证，而不是依赖浏览器 cookie。
 *
 * 代理做四件事（都不改 dsh 一行代码）：
 *   1. 用进程启动 token 向 dsh 换一次真 cookie，之后每个请求由代理注入；
 *   2. 把 Host 改写成上游授权域，并把 Origin / Referer / Sec-Fetch-Site
 *      改写成同一授权域——这是 dsh `isTrustedApiRequest` 栅栏要求的形状；
 *   3. 透传 HTTP 请求/响应（dsh 的 RPC 是纯 HTTP POST JSON，没有 WebSocket）；
 *   4. 上游 401 时重新换 cookie 并重试一次（cookie 过期或运行时重启后自愈）。
 *
 * 关键取舍：Host 必须保持上游授权域（而不是代理自己的端口），因为 cookie
 * 名是 `sha256(授权域)` 的哈希——换成代理端口就必须伪造签名，那是另一套
 * 密钥问题。所以这里选择「Host 指向真实上游 + Origin 对齐」，也是 dsh 的
 * `--trusted-host` 设计里最稳妥的用法（回环地址本就通过信任栅栏）。
 */

export interface EmbedProxyOptions {
  /** dsh 实际监听端口（上游）。 */
  targetPort: number;
  /** 代理监听端口；0 = 让系统分配。 */
  listenPort: number;
  /** 取当前运行时的启动 token（来自守护化运行时打印的 URL）。 */
  token: () => string | null;
  log: (line: string) => void;
}

export interface EmbedProxyHandle {
  /** 代理实际监听端口。 */
  port: number;
  /** 浏览器（webview iframe）应加载的地址。 */
  url: string;
  close: () => Promise<void>;
}

interface AuthCookie {
  /** cookie 名，形如 dsh-auth-<hash>。 */
  name: string;
  /** cookie 值（v1.<payload>.<sig>）。 */
  value: string;
  /** 该 cookie 绑定的授权域，即 Host 头要呈现的值。 */
  authority: string;
}

/** 需要从客户端请求里剥掉的逐跳头（代理不该转发）。 */
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

function firstHeader(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value;
}

/**
 * 用启动 token 换一张真 cookie。
 * dsh 对 `GET /?token=<启动token>` 回 303 + Set-Cookie，不跟随跳转即可截获。
 */
function mintCookie(targetPort: number, token: string): Promise<AuthCookie> {
  const authority = `127.0.0.1:${targetPort}`;
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port: targetPort,
        method: 'GET',
        path: `/?token=${encodeURIComponent(token)}`,
        headers: { host: authority },
        timeout: 10_000,
      },
      (res) => {
        res.resume(); // 丢弃 body，只需要响应头
        const raw = res.headers['set-cookie'];
        const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
        for (const line of list) {
          const pair = line.split(';', 1)[0] ?? '';
          const at = pair.indexOf('=');
          if (at <= 0) continue;
          const name = pair.slice(0, at).trim();
          const value = pair.slice(at + 1).trim();
          if (!name.startsWith('dsh-auth-') || !value) continue;
          res.destroy();
          resolve({ name, value, authority });
          return;
        }
        res.destroy();
        reject(new Error(`dsh 未在 ${res.statusCode} 响应中下发认证 cookie（token 可能已失效）`));
      },
    );
    req.on('timeout', () => req.destroy(new Error('换取认证 cookie 超时')));
    req.on('error', reject);
    req.end();
  });
}

/** 把上游可能出现的绝对 Location 改写成相对路径，避免把上游端口泄露给 iframe。 */
function rewriteLocation(value: string | string[] | undefined, targetPort: number): string | undefined {
  const raw = firstHeader(value);
  if (!raw) return undefined;
  const upstream = `http://127.0.0.1:${targetPort}`;
  if (raw.startsWith(upstream)) return raw.slice(upstream.length) || '/';
  return raw;
}

export async function startEmbedProxy(opts: EmbedProxyOptions): Promise<EmbedProxyHandle> {
  const { targetPort, token, log } = opts;
  const authority = `127.0.0.1:${targetPort}`;
  const upstreamOrigin = `http://${authority}`;

  // 启动前先换一次 cookie：失败就让调用方明确知道（而不是打开一个 401 白屏）。
  let cookie: AuthCookie | null = null;
  const currentToken = token();
  if (currentToken) {
    cookie = await mintCookie(targetPort, currentToken);
    log(`内嵌代理：已获取认证 cookie（绑定 ${cookie.authority}）`);
  } else {
    log('内嵌代理：运行时尚未打印启动 token，首次请求时再尝试换取 cookie');
  }

  const refreshCookie = async (): Promise<AuthCookie | null> => {
    const t = token();
    if (!t) return null;
    try {
      cookie = await mintCookie(targetPort, t);
      log(`内嵌代理：认证 cookie 已刷新（绑定 ${cookie.authority}）`);
      return cookie;
    } catch (e: any) {
      log(`内嵌代理：刷新认证 cookie 失败：${e?.message ?? e}`);
      return null;
    }
  };

  /** 组装转发到上游的请求头。 */
  const buildHeaders = (incoming: http.IncomingHttpHeaders, auth: AuthCookie | null): http.OutgoingHttpHeaders => {
    const headers: http.OutgoingHttpHeaders = {};
    for (const [key, value] of Object.entries(incoming)) {
      if (value === undefined) continue;
      const lower = key.toLowerCase();
      if (HOP_BY_HOP.has(lower)) continue;
      if (lower === 'host' || lower === 'origin' || lower === 'referer' || lower === 'sec-fetch-site') continue;
      if (lower === 'cookie') continue; // 完全由代理供给，丢弃浏览器侧 cookie 避免撞名
      headers[lower] = value;
    }
    // dsh 的信任栅栏：Host 必须是 cookie 绑定的授权域，且 Origin 必须与之同源。
    headers.host = authority;
    headers['sec-fetch-site'] = 'same-origin';
    if (incoming.origin !== undefined) headers.origin = upstreamOrigin;
    if (incoming.referer !== undefined) {
      try {
        const ref = new URL(String(incoming.referer));
        headers.referer = `${upstreamOrigin}${ref.pathname}${ref.search}`;
      } catch {
        headers.referer = upstreamOrigin + '/';
      }
    }
    if (auth) headers.cookie = `${auth.name}=${auth.value}`;
    return headers;
  };

  /** 单次上游请求。返回是否因 401 需要重试由调用方判断。 */
  const forward = (
    req: http.IncomingMessage,
    res: http.ServerResponse,
    auth: AuthCookie | null,
  ): Promise<{ status: number }> =>
    new Promise((resolve, reject) => {
      const upstream = http.request(
        {
          host: '127.0.0.1',
          port: targetPort,
          method: req.method,
          path: req.url,
          headers: buildHeaders(req.headers, auth),
          timeout: 0,
        },
        (upstreamRes) => {
          const status = upstreamRes.statusCode ?? 502;
          const out: http.OutgoingHttpHeaders = {};
          for (const [key, value] of Object.entries(upstreamRes.headers)) {
            if (value === undefined) continue;
            const lower = key.toLowerCase();
            if (HOP_BY_HOP.has(lower)) continue;
            // 认证由代理供给：不把上游 cookie 传给 iframe，也不暴露给其它源。
            if (lower === 'set-cookie') continue;
            if (lower === 'location') continue;
            out[lower] = value;
          }
          const location = rewriteLocation(upstreamRes.headers.location, targetPort);
          if (location !== undefined) out.location = location;

          res.writeHead(status, out);
          upstreamRes.pipe(res);
          upstreamRes.on('end', () => resolve({ status }));
          upstreamRes.on('error', reject);
        },
      );
      upstream.on('timeout', () => upstream.destroy(new Error('上游响应超时')));
      upstream.on('error', reject);
      req.pipe(upstream);
    });

  const server = http.createServer((req, res) => {
    void (async () => {
      try {
        const first = await forward(req, res, cookie);
        if (first.status !== 401) return;
        // 401 = cookie 过期或运行时重启换了密钥：换一次再重试。
        // 注意：响应头已经写出时无法重试，因此只在未写出时继续。
        if (res.headersSent) return;
        const fresh = await refreshCookie();
        if (!fresh) {
          res.writeHead(401, { 'content-type': 'text/plain; charset=utf-8' });
          res.end('内嵌代理：无法获取认证凭据（运行时未就绪或 token 失效）');
          return;
        }
        await forward(req, res, fresh);
      } catch (e: any) {
        log(`内嵌代理请求失败 ${req.method} ${req.url}：${e?.message ?? e}`);
        if (!res.headersSent) {
          res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
          res.end('内嵌代理：上游不可达');
        } else {
          res.destroy();
        }
      }
    })();
  });

  // dsh 当前版本的 RPC 是纯 HTTP（无 WebSocket）；若未来出现升级请求，明确拒绝而不是挂起。
  server.on('upgrade', (_req: http.IncomingMessage, socket: Socket) => {
    socket.destroy();
  });

  // 记录活动连接：Electron/Chrome 会保持 keep-alive，server.close() 不会自己断开它们，
  // 不主动销毁会导致关了面板后端口仍被占、下次打开分配不到同一端口。
  const sockets = new Set<Socket>();
  server.on('connection', (socket: Socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });

  const listen = (port: number): Promise<number> =>
    new Promise<number>((resolve, reject) => {
      const onError = (e: NodeJS.ErrnoException) => {
        server.removeListener('listening', onListening);
        reject(e);
      };
      const onListening = () => {
        server.removeListener('error', onError);
        const addr = server.address();
        if (addr && typeof addr === 'object') resolve(addr.port);
        else reject(new Error('无法确定代理监听端口'));
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(port, '127.0.0.1');
    });

  let port: number;
  try {
    port = await listen(opts.listenPort);
  } catch (e: any) {
    if (e?.code !== 'EADDRINUSE' || opts.listenPort === 0) throw e;
    // 固定端口被占（常见于上次会话未完全释放）：退化为系统分配，保证能打开。
    log(`内嵌代理：端口 ${opts.listenPort} 已被占用，改为系统分配`);
    port = await listen(0);
  }

  return {
    port,
    url: `http://127.0.0.1:${port}/`,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        for (const socket of sockets) socket.destroy();
        sockets.clear();
        // 兜底：极端情况下 close 回调不触发也不阻塞关闭流程。
        setTimeout(() => resolve(), 1500);
      }),
  };
}
