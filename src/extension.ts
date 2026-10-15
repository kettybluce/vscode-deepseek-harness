import * as vscode from 'vscode';
import { ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import * as http from 'node:http';

/**
 * Hermes Chat —— DeepSeek 官方 Harness 桌面版 UI 的 VS Code 承载壳。
 *
 * 不手写任何聊天界面：扩展只负责
 *   1. 在所选运行时（WSL / Windows / 本机）拉起官方 `dsh --profile web` 服务；
 *   2. 从其 stdout 解析带登录 token 的本机 URL；
 *   3. 用 webview iframe 原样承载官方浏览器 UI（与桌面版同一套 React 界面）。
 * 运行时升级、协议、样式全部留在官方 Harness 安装内。
 */

interface LaunchPlan { command: string; args: string[]; cwd: string }

const DSH_NVM_HINT = '~/.nvm/versions/node/<最新版>/bin/dsh';

export function activate(context: vscode.ExtensionContext) {
  const provider = new HermesHostProvider(context);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('hermesChatView', provider, { webviewOptions: { retainContextWhenHidden: true } }),
    vscode.commands.registerCommand('hermesChat.open', () => vscode.commands.executeCommand('workbench.view.extension.hermes')),
    vscode.commands.registerCommand('hermesChat.configure', () => vscode.commands.executeCommand('workbench.action.openSettings', '@ext:local.hermes-chat')),
    vscode.commands.registerCommand('hermesChat.restart', () => provider.restart()),
    vscode.commands.registerCommand('hermesChat.openInBrowser', () => provider.openInBrowser()),
  );
  context.subscriptions.push({ dispose: () => provider.dispose() });
}

class HermesHostProvider implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;
  private child?: ChildProcessWithoutNullStreams;
  private readyUrl?: string;
  /** resolveWebviewView 首次渲染时 webview 还没拿到 URL，先出加载页，URL 就绪后 post 过去。 */
  private startupDone = false;
  private readonly context: vscode.ExtensionContext;
  private readonly extensionUri: vscode.Uri;

  constructor(context: vscode.ExtensionContext) {
    this.context = context;
    this.extensionUri = context.extensionUri;
  }

  resolveWebviewView(view: vscode.WebviewView) {
    this.view = view;
    view.webview.options = { enableScripts: true, localResourceRoots: [this.extensionUri] };
    view.webview.html = this.html(view.webview);
    view.webview.onDidReceiveMessage(m => {
      if (m.type === 'ready') { this.startupDone ? this.postUrl() : this.ensureStarted(); }
      if (m.type === 'openExternal') void vscode.env.openExternal(vscode.Uri.parse(String(m.url ?? '')));
      if (m.type === 'openSettings') vscode.commands.executeCommand('workbench.action.openSettings', '@ext:local.hermes-chat');
      if (m.type === 'copyToken') void vscode.env.clipboard.writeText(String(m.url ?? ''));
      if (m.type === 'retry') void this.restart();
    });
    // 面板被关掉再重开时 webview 重建，重新注入当前状态
    if (this.startupDone) this.postUrl(); else void this.ensureStarted();
  }

  /** 确保官方 web 运行时已启动；已就绪则直接把 URL 发给 webview。 */
  private async ensureStarted() {
    if (this.child && this.readyUrl) return this.postUrl();
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
      this.readyUrl = undefined;
      this.post({ type: 'error', text: `无法启动 dsh web：${e?.message ?? e}` });
    }
  }

  private start(launch: LaunchPlan) {
    this.post({ type: 'status', text: '正在启动 DeepSeek Harness web 运行时…' });
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(launch.command, launch.args, { cwd: launch.cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e: any) {
      this.post({ type: 'error', text: `无法启动 dsh：${e?.message ?? e}` });
      return;
    }
    this.child = child;
    let out = '';
    let err = '';
    child.stdout.on('data', (d: Buffer) => { out += String(d); this.tryExtractUrl(out); });
    child.stderr.on('data', (d: Buffer) => { err += String(d); if (err.length > 8000) err = err.slice(-4000); });
    child.on('error', (e: Error) => {
      if (this.child === child) { this.child = undefined; this.post({ type: 'error', text: `dsh 启动失败：${e.message}` }); }
    });
    child.on('exit', (code) => {
      if (this.child !== child) return;
      this.child = undefined;
      if (!this.readyUrl) {
        const tail = err.trim().split('\n').slice(-6).join('\n');
        this.post({ type: 'error', text: `dsh web 已退出（code ${code}）。${tail ? '\n\n' + tail : ''}` });
      } else {
        this.post({ type: 'status', text: `Harness web 运行时已退出（code ${code}），点击重试可重新拉起。` });
      }
    });
    // 10s 还没打印 URL 视为启动异常，把 stderr 末尾亮出来
    setTimeout(() => {
      if (this.child === child && !this.readyUrl) {
        const tail = (err || out).trim().split('\n').slice(-8).join('\n');
        this.post({ type: 'error', text: `启动 10s 内未收到 dsh web 地址。${tail ? '\n\n日志末尾：\n' + tail : '\n\n请确认 dsh 已安装且可执行（' + DSH_NVM_HINT + '）。'}` });
      }
    }, 10_000).unref();
  }

  /** 官方 stdout 形如：dsh web: http://127.0.0.1:18431/?token=… */
  private tryExtractUrl(buf: string) {
    if (this.readyUrl) return;
    const m = buf.match(/https?:\/\/[^\s"']+/);
    if (m) {
      this.readyUrl = m[0].trim();
      this.startupDone = true;
      this.postUrl();
    }
  }

  private postUrl() {
    if (!this.readyUrl) return;
    // wsl.exe 转发的服务只绑在 WSL 侧回环上，Windows 宿主 webview 直连不通，改走 localhost 转发
    const url = this.readyUrl.startsWith('http://127.0.0.1:') && process.platform === 'win32'
      ? this.readyUrl.replace('127.0.0.1', 'localhost')
      : this.readyUrl;
    this.post({ type: 'url', url });
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
    this.readyUrl = undefined;
    this.startupDone = false;
    this.post({ type: 'status', text: '正在重启…' });
    if (this.child) { try { this.child.kill(); } catch { /* 已退出 */ } this.child = undefined; }
    await this.ensureStarted();
  }

  async openInBrowser() {
    if (this.readyUrl) void vscode.env.openExternal(vscode.Uri.parse(this.readyUrl));
    else void vscode.window.showInformationMessage('Harness web 尚未就绪。');
  }

  dispose() {
    if (this.child) { try { this.child.kill(); } catch { /* 已退出 */ } }
    this.child = undefined;
  }

  private post(message: unknown) { void this.view?.webview.postMessage(message); }

  private html(webview: vscode.Webview) {
    const nonce = Math.random().toString(36).slice(2);
    return `<!doctype html><html><head><meta charset="UTF-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; frame-src http://127.0.0.1:* http://localhost:*; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';"><style>
      html,body{height:100%;margin:0;background:var(--vscode-sideBar-background);color:var(--vscode-foreground);font:13px var(--vscode-font-family)}
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
        <iframe id="frame" hidden></iframe>
        <div class="center" id="status">正在连接官方 Harness web 运行时…</div>
        <div class="center" id="error" hidden style="color:var(--vscode-errorForeground)"></div>
      </div>
    </div><script nonce="${nonce}">
      const vscode=acquireVsCodeApi();const $=id=>document.getElementById(id);
      $('refresh').onclick=()=>vscode.postMessage({type:'retry'});
      $('browser').onclick=()=>vscode.postMessage({type:'openExternal',url:window.currentUrl||''});
      $('settings').onclick=()=>vscode.postMessage({type:'openSettings'});
      function show(el){for(const id of ['status','error'])$(id).hidden=id!==el;$('frame').hidden=el!==null;}
      show('status');
      window.onmessage=e=>{const m=e.data;
        if(m.type==='url'){window.currentUrl=m.url;$('frame').src=m.url;show(null);}
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
