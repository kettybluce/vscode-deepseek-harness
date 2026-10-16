import * as vscode from 'vscode';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { startAuthProxy, AuthProxy } from './proxy';

/**
 * Hermes Chat —— DeepSeek 官方 Harness 桌面版 UI 的 VS Code 承载壳。
 *
 * 不手写任何聊天界面：扩展只负责
 *   1. 在所选运行时（WSL / Windows / 本机）拉起官方 `dsh --profile web` 服务；
 *   2. 从其 stdout 解析带登录 token 的本机 URL；
 *   3. 起一个本地认证代理（webview iframe 里 dsh 的 SameSite=Strict cookie 走不通，
 *      见 proxy.ts 注释），webview 加载代理地址——与桌面版同一套官方 React 界面；
 *   4. 以编辑器全幅标签页呈现（桌面应用的打开方式），活动栏图标只作启动入口。
 * 运行时升级、协议、样式全部留在官方 Harness 安装内。
 */

interface LaunchPlan { command: string; args: string[]; cwd: string }

const DSH_NVM_HINT = '~/.nvm/versions/node/<最新版>/bin/dsh';
/** dsh web 要等整棵 runtime 插件树就绪才打印 URL，实测冷启动 >10s：超时只提示不判死。 */
const READY_TICK_MS = 10_000;
const READY_CAP_MS = 180_000;

export function activate(context: vscode.ExtensionContext) {
  killOrphanRuntime(context); // 扩展宿主被硬杀（崩溃/窗口强关）会遗留 dsh web 孤儿
  const provider = new HermesHostProvider(context);
  context.subscriptions.push(
    vscode.window.registerTreeDataProvider('hermesLauncher', provider.launcher),
    vscode.commands.registerCommand('hermesChat.open', () => provider.openPanel()),
    vscode.commands.registerCommand('hermesChat.configure', () => vscode.commands.executeCommand('workbench.action.openSettings', '@ext:local.hermes-chat')),
    vscode.commands.registerCommand('hermesChat.restart', () => provider.restart()),
    vscode.commands.registerCommand('hermesChat.openInBrowser', () => provider.openInBrowser()),
  );
  context.subscriptions.push({ dispose: () => provider.dispose() });
}

/** 仅 Linux（Remote-WSL）宿主：用 pidfile 清掉上次会话遗留的 dsh web 孤儿进程。 */
function killOrphanRuntime(context: vscode.ExtensionContext) {
  if (process.platform !== 'linux') return;
  try {
    const pid = Number(fs.readFileSync(runtimePidFile(context), 'utf8').trim());
    if (Number.isFinite(pid) && pid > 0) {
      const cmdline = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8'); // 进程已退出则抛错
      if (cmdline.includes('dsh') && cmdline.includes('--profile')) process.kill(pid, 'SIGKILL');
    }
  } catch { /* pidfile 缺失或进程已退出：无可清理 */ }
}

function runtimePidFile(context: vscode.ExtensionContext): string {
  return path.join(context.globalStorageUri.fsPath, 'dsh-runtime.pid');
}

/** 活动栏图标下的启动项：点击在编辑器里全幅打开桌面版。 */
class LauncherTree implements vscode.TreeDataProvider<vscode.TreeItem> {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.emitter.event;
  getTreeItem(element: vscode.TreeItem): vscode.TreeItem { return element; }
  getChildren(): vscode.TreeItem[] { return [this.item()]; }
  item(): vscode.TreeItem {
    const item = new vscode.TreeItem('打开 DeepSeek Harness 桌面版', vscode.TreeItemCollapsibleState.None);
    item.tooltip = '在编辑器标签页全幅打开官方 Harness 桌面界面';
    item.iconPath = new vscode.ThemeIcon('window');
    item.command = { command: 'hermesChat.open', title: '打开 DeepSeek Harness 桌面版' };
    return item;
  }
  dispose(): void { this.emitter.dispose(); }
}

class HermesHostProvider implements vscode.Disposable {
  private panel?: vscode.WebviewPanel;
  readonly launcher = new LauncherTree();
  private child?: ChildProcessWithoutNullStreams;
  private proxy?: AuthProxy;
  /** dsh 打印的带 token 原始地址：供系统浏览器直接打开（真实浏览器里 cookie 正常工作）。 */
  private browserUrl?: string;
  /** 免认证本地代理地址：webview iframe 只加载这个。 */
  private appUrl?: string;
  private readonly context: vscode.ExtensionContext;
  private readonly extensionUri: vscode.Uri;

  constructor(context: vscode.ExtensionContext) {
    this.context = context;
    this.extensionUri = context.extensionUri;
  }

  /** 命令/活动栏入口：已有面板则聚焦，否则在编辑器全幅新建（桌面应用的打开方式）。 */
  openPanel() {
    if (this.panel) { void this.panel.reveal(vscode.ViewColumn.One); return; }
    const panel = vscode.window.createWebviewPanel('hermesChat', 'Hermes · DeepSeek Harness', vscode.ViewColumn.One, {
      enableScripts: true,
      retainContextWhenHidden: true, // 切走再切回不重载，官方会话不打断
      localResourceRoots: [this.extensionUri],
    });
    this.initPanel(panel);
  }

  private initPanel(panel: vscode.WebviewPanel) {
    this.panel = panel;
    panel.webview.options = { enableScripts: true, localResourceRoots: [this.extensionUri] };
    panel.webview.html = this.html();
    panel.webview.onDidReceiveMessage(m => {
      if (m.type === 'ready') { this.browserUrl ? this.postUrl() : this.ensureStarted(); }
      if (m.type === 'openExternal') void vscode.env.openExternal(vscode.Uri.parse(String(m.url ?? '')));
      if (m.type === 'openSettings') vscode.commands.executeCommand('workbench.action.openSettings', '@ext:local.hermes-chat');
      if (m.type === 'copyToken') void vscode.env.clipboard.writeText(String(m.url ?? ''));
      if (m.type === 'retry') void this.restart();
    });
    panel.onDidDispose(() => { if (this.panel === panel) this.panel = undefined; });
    if (this.browserUrl) this.postUrl(); else this.ensureStarted();
  }

  /** 确保官方 web 运行时已启动；URL 已就绪则直接把代理地址发给 webview。 */
  private async ensureStarted() {
    if (this.browserUrl) return this.postUrl();
    if (this.child) return; // 启动中，等 stdout 解析
    const cfg = vscode.workspace.getConfiguration('hermesChat');
    const dshPath = (cfg.get<string>('dshPath', '') || 'dsh').trim();
    const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.env.HOME ?? process.cwd();
    const port = cfg.get<number>('webPort', 0) || 0;
    const args = ['--profile', 'web', '--no-open', '--port', String(port)];
    try {
      const launch = await this.resolveLaunch(cfg.get<string>('runtime', 'auto'), dshPath, args, cwd, cfg.get<string>('wslDistribution', ''));
      this.start(launch);
    } catch (e: any) {
      this.browserUrl = undefined;
      this.post({ type: 'error', text: `无法启动 dsh web：${e?.message ?? e}` });
    }
  }

  private start(launch: LaunchPlan) {
    this.post({ type: 'status', text: '正在启动官方 Harness web 运行时…' });
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(launch.command, launch.args, { cwd: launch.cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e: any) {
      this.post({ type: 'error', text: `无法启动 dsh：${e?.message ?? e}` });
      return;
    }
    this.child = child;
    this.writeRuntimePid(child.pid);
    let out = '';
    let err = '';
    child.stdout.on('data', (d: Buffer) => { out += String(d); this.tryExtractUrl(out); });
    child.stderr.on('data', (d: Buffer) => { err += String(d); if (err.length > 8000) err = err.slice(-4000); });
    let timer: NodeJS.Timeout | undefined;
    child.on('error', (e: Error) => {
      if (this.child === child) { clearInterval(timer); this.child = undefined; this.post({ type: 'error', text: `dsh 启动失败：${e.message}` }); }
    });
    child.on('exit', (code) => {
      if (this.child !== child) return;
      clearInterval(timer);
      this.child = undefined;
      this.proxy?.dispose();
      this.proxy = undefined;
      this.browserUrl = undefined; // 面板重开时走 ensureStarted 重新拉起，而不是对着死端口
      this.appUrl = undefined;
      if (!this.browserUrl) {
        const tail = err.trim().split('\n').slice(-6).join('\n');
        this.post({ type: 'error', text: `dsh web 已退出（code ${code}）。${tail ? '\n\n' + tail : ''}` });
      } else {
        this.post({ type: 'status', text: `Harness web 运行时已退出（code ${code}），点击重试可重新拉起。` });
      }
    });
    // 就绪进度提示：dsh 冷启动要等整棵插件树就绪（实测 >10s），只提示不判死；
    // URL 一旦到达，tryExtractUrl 会把界面切到官方 UI。
    let waited = 0;
    timer = setInterval(() => {
      if (this.child !== child || this.browserUrl) { clearInterval(timer); return; }
      waited += READY_TICK_MS;
      if (waited >= READY_CAP_MS) {
        clearInterval(timer);
        const tail = (err || out).trim().split('\n').slice(-8).join('\n');
        this.post({ type: 'error', text: `已等待 ${Math.round(waited / 1000)}s 仍未收到 dsh web 地址（进程仍在运行，可能是首次初始化较慢）。可继续等待或点 ⟳ 重试。${tail ? '\n\n日志末尾：\n' + tail : ''}` });
        return;
      }
      this.post({ type: 'status', text: `正在启动官方 Harness web 运行时…（已等待 ${Math.round(waited / 1000)}s；冷启动需初始化运行时，约 10-60s）` });
    }, READY_TICK_MS);
    timer.unref();
  }

  /** 官方 stdout 形如：dsh web: http://127.0.0.1:18431/?token=… */
  private tryExtractUrl(buf: string) {
    if (this.browserUrl) return;
    const m = buf.match(/https?:\/\/[^\s"']+/);
    if (!m) return;
    this.browserUrl = m[0].trim();
    void this.attachProxy(this.browserUrl);
  }

  /** 官方运行时就绪后起本地认证代理；webview 只加载代理地址。 */
  private async attachProxy(target: string) {
    try {
      const proxy = await startAuthProxy(target);
      if (this.browserUrl !== target) { proxy.dispose(); return; } // 期间已重启
      this.proxy = proxy;
      this.appUrl = `http://127.0.0.1:${proxy.port}/`;
      this.postUrl();
    } catch (e: any) {
      this.post({ type: 'error', text: `官方运行时已就绪，但本地认证代理启动失败：${e?.message ?? e}\n\n可点 ⟳ 重试。` });
    }
  }

  private postUrl() {
    if (!this.appUrl) return;
    // 实测（2026-10-15）：dsh 只绑 WSL 侧 127.0.0.1（IPv4 回环），WSL2 localhost 转发让
    // Windows 侧 127.0.0.1 直达；改写成 localhost 反而会先撞 IPv6 ::1 超时。原样使用。
    this.post({ type: 'url', url: this.appUrl, browser: this.browserUrl });
  }

  /** 按配置解析 dsh 的启动方式；Windows 宿主 + wsl 模式经 wsl.exe 转发。 */
  private async resolveLaunch(runtime: string, dshPath: string, args: string[], cwd: string, distribution: string): Promise<LaunchPlan> {
    const useWsl = runtime === 'wsl' || (runtime === 'auto' && process.platform === 'win32');
    if (!useWsl || process.platform !== 'win32') return { command: dshPath, args, cwd };
    const linuxCwd = await new Promise<string>(resolve => {
      execFileWsl(distribution, ['wslpath', '-u', cwd], (error, stdout) =>
        resolve(!error && stdout.trim() ? stdout.trim() : cwd.replace(/^([A-Za-z]):[\\/]/, (_m, drive) => `/mnt/${String(drive).toLowerCase()}/`).replaceAll('\\', '/')));
    });
    return { command: 'wsl.exe', args: [...(distribution ? ['-d', distribution] : []), '--cd', linuxCwd, '--', dshPath, ...args], cwd };
  }

  async restart() {
    this.browserUrl = undefined;
    this.appUrl = undefined;
    this.teardownRuntime();
    this.post({ type: 'status', text: '正在重启…' });
    await this.ensureStarted();
  }

  async openInBrowser() {
    if (this.browserUrl) void vscode.env.openExternal(vscode.Uri.parse(this.browserUrl));
    else void vscode.window.showInformationMessage('Harness web 尚未就绪。');
  }

  dispose() {
    this.teardownRuntime();
    this.launcher.dispose();
  }

  /** 杀掉当前 dsh 子进程、关掉代理并清 pidfile。 */
  private teardownRuntime() {
    if (this.child) { try { this.child.kill(); } catch { /* 已退出 */ } this.child = undefined; }
    this.proxy?.dispose();
    this.proxy = undefined;
    if (process.platform === 'linux') { try { fs.unlinkSync(runtimePidFile(this.context)); } catch { /* 本就没有 */ } }
  }

  private writeRuntimePid(pid: number | undefined) {
    if (process.platform !== 'linux' || !pid) return;
    try {
      fs.mkdirSync(this.context.globalStorageUri.fsPath, { recursive: true });
      fs.writeFileSync(runtimePidFile(this.context), String(pid));
    } catch { /* 写不了就算了：孤儿清理是尽力而为 */ }
  }

  private post(message: unknown) { void this.panel?.webview.postMessage(message); }

  private html() {
    const nonce = Math.random().toString(36).slice(2);
    return `<!doctype html><html><head><meta charset="UTF-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; frame-src http://127.0.0.1:* http://localhost:*; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';"><style>
      html,body{height:100%;margin:0;background:var(--vscode-editor-background);color:var(--vscode-foreground);font:13px var(--vscode-font-family)}
      .wrap{height:100%;display:flex;flex-direction:column}
      .bar{height:34px;display:flex;align-items:center;gap:8px;padding:0 10px;border-bottom:1px solid var(--vscode-widget-border);font-weight:600;flex:none}
      .bar .t{flex:1;font-size:12px}
      .icon{background:none;border:0;color:var(--vscode-foreground);font-size:14px;cursor:pointer;padding:2px 6px;border-radius:4px}
      .icon:hover{background:var(--vscode-toolbar-hoverBackground)}
      .stage{flex:1;position:relative}
      iframe{position:absolute;inset:0;width:100%;height:100%;border:0;background:#fff}
      .center{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;text-align:center;padding:24px;white-space:pre-wrap;line-height:1.6}
      .muted{opacity:.65}
      button.link{background:var(--vscode-button-background);color:var(--vscode-button-foreground);border:0;border-radius:4px;padding:5px 14px;cursor:pointer;margin-top:12px}
    </style></head><body><div class="wrap">
      <div class="bar"><span class="t">Hermes · DeepSeek Harness</span><button class="icon" id="refresh" title="重新连接">⟳</button><button class="icon" id="browser" title="在浏览器打开">↗</button><button class="icon" id="settings" title="设置">⚙</button></div>
      <div class="stage">
        <iframe id="frame" hidden allow="clipboard-read; clipboard-write"></iframe>
        <div class="center" id="status">正在连接官方 Harness web 运行时…</div>
        <div class="center" id="error" hidden style="color:var(--vscode-errorForeground)"></div>
      </div>
    </div><script nonce="${nonce}">
      const vscode=acquireVsCodeApi();const $=id=>document.getElementById(id);
      $('refresh').onclick=()=>vscode.postMessage({type:'retry'});
      $('browser').onclick=()=>vscode.postMessage({type:'openExternal',url:window.browserUrl||''});
      $('settings').onclick=()=>vscode.postMessage({type:'openSettings'});
      function show(el){for(const id of ['status','error'])$(id).hidden=id!==el;$('frame').hidden=el!==null;}
      show('status');
      window.onmessage=e=>{const m=e.data;
        if(m.type==='url'){window.browserUrl=m.browser||'';$('frame').src=m.url;show(null);}
        if(m.type==='status'){$('status').textContent=m.text;show('status');}
        if(m.type==='error'){$('error').textContent=m.text;show('error');}
      };
      vscode.postMessage({type:'ready'});
    </script></body></html>`;
  }
}

/** wsl.exe 辅助：仅在 Windows 宿主的 wsl 模式下使用。 */
function execFileWsl(distribution: string, args: string[], cb: (error: Error | null, stdout: string) => void) {
  const { execFile } = require('node:child_process') as typeof import('node:child_process');
  execFile('wsl.exe', [...(distribution ? ['-d', distribution] : []), '--', ...args], { windowsHide: true, timeout: 8000 }, (error, stdout) => cb(error ?? null, String(stdout ?? '')));
}
