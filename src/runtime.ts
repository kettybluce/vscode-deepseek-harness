import * as os from 'node:os';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';

/**
 * 运行时机械层：把官方 `dsh --profile web` 以守护进程方式跑在 WSL（或本机）里。
 *
 * 与 0.3.0 的根本区别：不再内嵌 webview，也就不再需要认证代理。浏览器用真实
 * cookie（dsh 默认 30 天有效，签名密钥持久化在 $DSH_HOME/.credentials.yaml），
 * 首次经 token URL 认证后即可长期收藏固定地址。
 *
 * 守护化模型（关键）：
 *   - 启动 = 通过 `bash -s` 从 stdin 喂脚本执行
 *       nohup <dsh 绝对路径> --profile web ... >> "$HOME/.hermes-chat/dsh-web.log" 2>&1 &
 *     进程立刻与 VS Code 脱钩——关闭 VS Code、重启它，运行时都继续活着；
 *   - pid 由脚本 `echo $!` 返回并持久化，停止时精确 kill 该 pid（绝不 pkill 全局，
 *     避免误伤同机其他 dsh 实例，比如桌面版）；
 *   - token URL 从日志文件 tail 流式解析；下次 VS Code 启动时按 pid+端口"领养"。
 * stdin 传脚本可完全绕开 wsl.exe 的二次 shell 解析。
 */

export interface LaunchConfig {
  runtime: string; // auto | wsl | windows
  dshPath: string; // 运行时侧视角的 dsh 路径或命令名
  wslDistribution: string;
  webPort: number; // 0 = OS 随机（不推荐，破坏固定地址）
  webHost: string; // 绑定地址，默认 127.0.0.1（WSL2 localhost 转发直达 Windows）
  dshPackage: string; // 升级按钮安装的 npm 包
}

export interface Plan {
  /** wsl = Windows 宿主经 wsl.exe；local = 本机直接跑（含 Remote-WSL 扩展宿主） */
  mode: 'wsl' | 'local';
  distribution: string;
  /** 守护化脚本里使用的 dsh 绝对路径（已解析，$HOME 形式） */
  dshAbs: string;
  args: string[];
  linuxCwd?: string;
}

export interface RuntimeState {
  pid: number;
  port: number;
  mode: 'wsl' | 'local';
  distribution: string;
  url: string; // 带 token 的认证地址（浏览器首次打开用；cookie 30 天）
  startedAt: number;
}

const LOG_DIR = '$HOME/.hermes-chat';
const LOG_FILE = '$HOME/.hermes-chat/dsh-web.log';
const READY_CAP_MS = 180_000;

/** 单引号 shell 转义；仅用于不含 $HOME 展开需求的字面值。 */
function shq(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function runScript(mode: Plan['mode'], distribution: string, script: string, opts: { timeoutMs?: number; extraArgs?: string[]; onLine?: (line: string) => void } = {}): Promise<string> {
  const { timeoutMs = 15_000, extraArgs = [], onLine } = opts;
  return new Promise((resolve, reject) => {
    let child: ChildProcess;
    if (mode === 'wsl') {
      const args = [...(distribution ? ['-d', distribution] : []), ...extraArgs, '--', 'bash', '-s'];
      child = spawn('wsl.exe', args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    } else {
      child = spawn('bash', ['-s'], { stdio: ['pipe', 'pipe', 'pipe'] });
    }
    let out = '';
    let err = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error(`执行超时（${timeoutMs}ms）`)); }, timeoutMs);
    child.stdout!.on('data', (d: Buffer) => {
      const text = String(d);
      out += text;
      if (onLine) for (const line of text.split('\n')) if (line.trim()) onLine(line.trimEnd());
    });
    child.stderr!.on('data', (d: Buffer) => { err += String(d); });
    child.on('error', (e: Error) => { clearTimeout(timer); reject(e); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(out);
      else reject(new Error(`bash 退出（code ${code}）${err.trim() ? '：' + err.trim().split('\n').slice(-4).join('\n') : ''}`));
    });
    child.stdin.end(script);
  });
}

/** 把 Windows 路径转成 WSL 内路径；转换失败则按盘符规则猜。 */
async function toLinuxCwd(distribution: string, windowsCwd: string): Promise<string> {
  const script = `wslpath -u ${shq(windowsCwd)}\n`;
  try {
    const out = await runScript('wsl', distribution, script, { timeoutMs: 8000 });
    const trimmed = out.trim();
    if (trimmed) return trimmed;
  } catch { /* 落到猜 */ }
  return windowsCwd.replace(/^([A-Za-z]):[\\/]/, (_m, drive: string) => `/mnt/${drive.toLowerCase()}/`).replaceAll('\\', '/');
}

/**
 * 解析 dsh 绝对路径（运行时侧视角）。依次尝试：
 *   1. 配置的 dshPath 本身是存在的绝对路径（支持 ~ 前缀）；
 *   2. PATH 里的 command -v dsh；
 *   3. nvm 安装目录兜底（HOME/.nvm/versions/node/&lt;版本&gt;/bin/dsh 取版本号最大者）。
 */
export async function resolveDshAbs(mode: Plan['mode'], distribution: string, dshPath: string): Promise<string | null> {
  const script = [
    `p=${shq(dshPath.trim() || 'dsh')}`,
    'case "$p" in "~"*) p="$HOME${p#~}" ;; esac',
    'case "$p" in /*) [ -x "$p" ] && { echo "$p"; exit 0; } ;; esac',
    'p="$(command -v dsh 2>/dev/null)" && { echo "$p"; exit 0; }',
    'p="$(ls -1d "$HOME"/.nvm/versions/node/*/bin/dsh 2>/dev/null | sort -V | tail -n1)" && [ -n "$p" ] && { echo "$p"; exit 0; }',
    'exit 3',
  ].join('\n') + '\n';
  try {
    const out = (await runScript(mode, distribution, script)).trim();
    return out || null;
  } catch {
    return null;
  }
}

/** 组装启动计划：决定 wsl/local 模式、参数、并解析 dsh 绝对路径。 */
export async function resolvePlan(cfg: LaunchConfig, windowsCwd: string): Promise<Plan> {
  const useWsl = cfg.runtime === 'wsl' || (cfg.runtime === 'auto' && process.platform === 'win32');
  const mode: Plan['mode'] = useWsl && process.platform === 'win32' ? 'wsl' : 'local';
  const dshAbs = await resolveDshAbs(mode, cfg.wslDistribution, cfg.dshPath);
  if (!dshAbs) {
    throw new Error(
      `在${mode === 'wsl' ? ' WSL ' + (cfg.wslDistribution || '默认发行版') : '本机'}里找不到 dsh。` +
      `请把 "Hermes Chat: Dsh Path" 设为绝对路径（如 ~/.nvm/versions/node/<版本>/bin/dsh），或先在目标环境安装官方 Harness。`,
    );
  }
  const args = ['--profile', 'web', '--no-open'];
  if (cfg.webHost) args.push('--host', cfg.webHost);
  args.push('--port', String(cfg.webPort));
  const plan: Plan = { mode, distribution: cfg.wslDistribution, dshAbs, args };
  if (mode === 'wsl') plan.linuxCwd = await toLinuxCwd(cfg.wslDistribution, windowsCwd);
  return plan;
}

/** 守护化启动：nohup 后台运行 dsh，返回运行时侧 pid。 */
export async function startDaemon(plan: Plan, log: (line: string) => void): Promise<number> {
  const cmd = [shq(plan.dshAbs), ...plan.args.map(shq)].join(' ');
  const script = [
    `mkdir -p "${LOG_DIR}"`,
    `: > "${LOG_FILE}"`,
    `nohup ${cmd} >> "${LOG_FILE}" 2>&1 &`,
    'echo $!',
  ].join('\n') + '\n';
  const extraArgs = plan.mode === 'wsl' && plan.linuxCwd ? ['--cd', plan.linuxCwd] : [];
  const out = await runScript(plan.mode, plan.distribution, script, { timeoutMs: 20_000, extraArgs, onLine: log });
  const pid = Number(out.trim().split('\n').filter(Boolean).pop());
  if (!Number.isFinite(pid) || pid <= 0) {
    log(`启动脚本输出：${out.trim()}`);
    throw new Error('未能获取守护进程 pid（脚本无输出）');
  }
  return pid;
}

/** 流式跟踪日志直到出现带 token 的 URL；期间监测 pid 死亡。tail --pid 保证 dsh 死了 tail 也退出。 */
export function tailForUrl(plan: Plan, pid: number, onLine: (line: string) => void): Promise<string> {
  return new Promise((resolve, reject) => {
    let child: ChildProcess;
    if (plan.mode === 'wsl') {
      const script = `tail -n +1 -F --pid=${pid} "${LOG_FILE}"\n`;
      child = spawn('wsl.exe', [...(plan.distribution ? ['-d', plan.distribution] : []), '--', 'bash', '-s'], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
      child.stdin!.end(script);
    } else {
      child = spawn('tail', ['-n', '+1', '-F', `--pid=${pid}`, LOG_FILE.replace('$HOME', os.homedir())], { stdio: ['ignore', 'pipe', 'pipe'] });
    }
    let buf = '';
    let whole = ''; // 完整累计文本：URL 行可能带换行完整到达，不能只看不完整尾行
    let settled = false;
    const timer = setInterval(() => {
      if (settled) { clearInterval(timer); return; }
      void alive(plan, pid).then((a) => {
        if (!a && !settled) { settle(reject, new Error('dsh 进程在就绪前退出，详见输出面板日志')); }
      }).catch(() => { /* 探测失败就继续等 URL */ });
    }, 5000);
    const timeout = setTimeout(() => settle(reject, new Error(`已等待 ${Math.round(READY_CAP_MS / 1000)}s 仍未在日志中看到 dsh web 地址（进程可能仍在初始化，可点 ⟳ 重试）`)), READY_CAP_MS);
    const settle = (fn: (e?: Error) => void, e?: Error | string) => {
      if (settled) return;
      settled = true;
      clearInterval(timer);
      clearTimeout(timeout);
      try { child.kill(); } catch { /* 已退出 */ }
      if (typeof e === 'string') resolve(e);
      else if (e) reject(e);
    };
    child.stdout!.on('data', (d: Buffer) => {
      buf += String(d);
      whole += String(d);
      for (const line of buf.split('\n').slice(0, -1)) onLine(line.trimEnd());
      buf = buf.slice(buf.lastIndexOf('\n') + 1);
      const m = whole.match(/https?:\/\/[^\s"']+/);
      if (m) settle(null, m[0]);
    });
    child.on('error', (e: Error) => settle(reject, e));
  });
}

/** pid 是否存活。探测不到按已死算（wsl 不可达时也无法操作运行时）。 */
export async function alive(plan: Plan, pid: number): Promise<boolean> {
  const script = `kill -0 ${pid} 2>/dev/null && echo alive || echo dead\n`;
  try {
    const out = await runScript(plan.mode, plan.distribution, script, { timeoutMs: 8000 });
    return out.trim() === 'alive';
  } catch {
    return false;
  }
}

/** 探测 127.0.0.1:port 是 dsh web（裸路径 401 认证栅栏）还是别的程序。 */
export function probeDsh(port: number): Promise<'dsh' | 'refused' | 'other'> {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/', timeout: 3000 }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode === 401 ? 'dsh' : 'other'));
    });
    req.on('timeout', () => { req.destroy(); resolve('other'); });
    req.on('error', () => resolve('refused'));
  });
}

/** 停止守护进程：先 TERM 后 KILL，按 pid 精确打击。 */
export async function stopDaemon(plan: Plan, pid: number): Promise<void> {
  const script = `kill ${pid} 2>/dev/null || true\n`;
  if (plan.mode === 'local') { try { process.kill(pid, 'SIGTERM'); } catch { /* 已退出 */ } }
  else { await runScript(plan.mode, plan.distribution, script, { timeoutMs: 8000 }).catch(() => undefined); }
  for (let i = 0; i < 10; i++) {
    await new Promise((r) => setTimeout(r, 400));
    if (!(await alive(plan, pid))) return;
  }
  const kill9 = `kill -9 ${pid} 2>/dev/null || true\n`;
  if (plan.mode === 'local') { try { process.kill(pid, 'SIGKILL'); } catch { /* 已退出 */ } }
  else { await runScript(plan.mode, plan.distribution, kill9, { timeoutMs: 8000 }).catch(() => undefined); }
}

/** 当前 dsh 版本（失败返回 null）。 */
export async function dshVersion(plan: Plan): Promise<string | null> {
  const script = `${shq(plan.dshAbs)} --version 2>/dev/null || true\n`;
  try {
    const out = await runScript(plan.mode, plan.distribution, script, { timeoutMs: 20_000 });
    const v = out.trim().split('\n').filter(Boolean).pop();
    return v || null;
  } catch {
    return null;
  }
}

/**
 * 升级 dsh：npm 全局装指定包（默认 @deepseek-ai/dsh@latest）。
 * npm 取 dsh 同目录（nvm 全局安装二者必同目录），输出逐行回调。
 */
export async function upgradeDsh(plan: Plan, pkg: string, onLine: (line: string) => void): Promise<void> {
  const npm = path.posix.join(path.posix.dirname(plan.dshAbs), 'npm');
  const script = [
    `if [ ! -x ${shq(npm)} ]; then echo "未找到 npm：${npm}" >&2; exit 4; fi`,
    `${shq(npm)} install -g ${shq(pkg)} 2>&1`,
  ].join('\n') + '\n';
  await runScript(plan.mode, plan.distribution, script, { timeoutMs: 600_000, onLine });
}

/** 状态持久化：跨 VS Code 会话领养运行时靠它。url 允许为空（就绪前先落盘 pid/port）。 */
export function readState(file: string): RuntimeState | null {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as RuntimeState;
    if (Number.isFinite(raw.pid) && Number.isFinite(raw.port) && typeof raw.url === 'string') return raw;
  } catch { /* 无状态文件 */ }
  return null;
}

/** 从运行日志恢复 token URL（VS Code 在就绪前被关闭时，领养阶段兜底用）。 */
export async function readUrlFromLog(mode: Plan['mode'], distribution: string): Promise<string | null> {
  const script = `grep -m1 -o 'https\\?://[^ "]*' "${LOG_FILE}" 2>/dev/null || true\n`;
  try {
    const out = mode === 'wsl'
      ? await runScript('wsl', distribution, script, { timeoutMs: 10_000 })
      : fs.readFileSync(LOG_FILE.replace('$HOME', os.homedir()), 'utf8').match(/https?:\/\/[^\s"']+/)?.[0] ?? '';
    return out.trim() || null;
  } catch {
    return null;
  }
}

export function writeState(file: string, state: RuntimeState | null): void {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (state) fs.writeFileSync(file, JSON.stringify(state, null, 2));
    else fs.rmSync(file, { force: true });
  } catch { /* 写不进去就降级为不持久化 */ }
}
