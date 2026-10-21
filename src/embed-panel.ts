import * as vscode from 'vscode';
import { startEmbedProxy, type EmbedProxyHandle } from './embed-proxy';

/**
 * 「像 Claude Code / Codex 那样在 VS Code 内部打开」的承载层。
 *
 * 形态对齐参考实现：两者都用一个**编辑器区的 WebviewPanel**（不是侧边栏、
 * 不是外置浏览器）承载自己的界面，并通过 `retainContextWhenHidden` 保住
 * 切标签页后的状态，用 `WebviewPanelSerializer` 让窗口重载后能恢复。
 *
 * 与它们的关键差别：Claude Code / Codex 用的是自己重写的 React 界面，而 dsh
 * 的界面是完整的 Web 应用——重写既不可能也不该做。所以这里用**同源 iframe**
 * 承载官方页面，并把认证交给扩展侧的本地反向代理（见 embed-proxy.ts）。
 * 好处是官方 Web 端的每个功能都原样可用，升级 dsh 不用改这里一行。
 */

export interface EmbedHostOptions {
  extensionUri: vscode.Uri;
  /** 代理监听端口；0 = 系统分配。每次打开时读取，改了设置无需重载。 */
  port: () => number;
  /** 每次调用都返回当前 dsh 运行时监听端口（上游）。 */
  targetPort: () => number;
  /** 每次调用都返回当前运行时的最新启动 token（运行时重启后自动换新）。 */
  token: () => string | null;
  log: (line: string) => void;
}

const VIEW_TYPE = 'hermesChat.embedded';

export class EmbedHost implements vscode.Disposable {
  private panel: vscode.WebviewPanel | null = null;
  private proxy: EmbedProxyHandle | null = null;
  private opening: Promise<void> | null = null;

  constructor(private readonly opts: EmbedHostOptions) {}

  /** 是否已有内嵌面板在显示。 */
  get visible(): boolean { return this.panel !== null; }

  /**
   * 打开（或聚焦）内嵌面板。可重复调用：已打开时只做 reveal。
   * 代理按需启动一次，面板关闭时释放。
   */
  async show(): Promise<void> {
    if (this.panel) {
      this.panel.reveal(undefined, false);
      return;
    }
    if (this.opening) return this.opening;
    this.opening = this.doShow().finally(() => { this.opening = null; });
    return this.opening;
  }

  private async doShow(): Promise<void> {
    // 先起代理：拿不到 cookie 就直接报错，避免打开一个 401 白屏。
    this.proxy = await startEmbedProxy({
      targetPort: this.opts.targetPort(),
      listenPort: this.opts.port(),
      token: this.opts.token,
      log: this.opts.log,
    });
    this.opts.log(`内嵌代理已监听 ${this.proxy.url} → 127.0.0.1:${this.opts.targetPort()}`);

    const panel = vscode.window.createWebviewPanel(
      VIEW_TYPE,
      'Hermes',
      { viewColumn: vscode.ViewColumn.Active, preserveFocus: false },
      {
        enableScripts: true,
        // 切到别的标签页再回来，聊天状态不丢——这是 Claude Code 同款体验的核心。
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(this.opts.extensionUri, 'media')],
      },
    );
    panel.iconPath = vscode.Uri.joinPath(this.opts.extensionUri, 'media', 'hermes.svg');
    panel.webview.html = this.html(panel.webview, this.proxy.url);

    // 面板内点「在浏览器打开」时，走扩展的既有命令，保持单一行为来源。
    panel.webview.onDidReceiveMessage((msg) => {
      if (msg?.type === 'openExternal') void vscode.commands.executeCommand('hermesChat.openInBrowser');
    });

    panel.onDidDispose(() => {
      this.panel = null;
      void this.stopProxy();
    });
    this.panel = panel;
  }

  /** 运行时端口：代理的上游。由构造参数 `targetPort()` 提供。 */

  private async stopProxy(): Promise<void> {
    const proxy = this.proxy;
    this.proxy = null;
    if (!proxy) return;
    try {
      await proxy.close();
      this.opts.log('内嵌代理已释放');
    } catch { /* 已释放 */ }
  }

  /**
   * 面板 HTML：一个铺满编辑器的 iframe。
   * CSP 只放行本地回环的 frame，其余一律拒绝（脚本仅用于可选的状态切换）。
   */
  private html(webview: vscode.Webview, url: string): string {
    const nonce = Array.from({ length: 24 }, () =>
      'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'[Math.floor(Math.random() * 62)],
    ).join('');
    // 只允许回环地址作为 iframe 源；把端口从 URL 里取出来精确放行。
    const frameOrigin = (() => {
      try {
        const u = new URL(url);
        return `${u.protocol}//${u.hostname}:${u.port}`;
      } catch {
        return 'http://127.0.0.1:*';
      }
    })();
    const csp = [
      "default-src 'none'",
      `frame-src ${frameOrigin}`,
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `script-src 'nonce-${nonce}' ${webview.cspSource}`,
      `img-src ${webview.cspSource} data:`,
      `font-src ${webview.cspSource}`,
    ].join('; ');

    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<style>
  html, body { height: 100%; width: 100%; margin: 0; padding: 0; overflow: hidden;
    background: var(--vscode-editor-background); }
  /* 状态层在 iframe 之下：页面加载成功后自然被覆盖，失败时留在可见区域。 */
  #boot { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center;
    gap: 8px; color: var(--vscode-descriptionForeground);
    font-family: var(--vscode-font-family); font-size: 13px; }
  #frame { position: relative; z-index: 1; display: block; width: 100%; height: 100%;
    border: 0; background: transparent; }
</style>
</head>
<body>
  <div id="boot">正在连接 DeepSeek Harness…</div>
  <iframe id="frame" src="${url}" allow="clipboard-read; clipboard-write; microphone"></iframe>
</body>
</html>`;
  }

  dispose(): void {
    // 面板自身 dispose 会触发 onDidDispose → stopProxy；这里兜底防止泄漏。
    if (this.panel) {
      this.panel.dispose();
      this.panel = null;
    }
    void this.stopProxy();
  }
}
