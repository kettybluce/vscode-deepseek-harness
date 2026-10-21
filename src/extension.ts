import * as vscode from 'vscode';
import * as path from 'node:path';
import {
  type LaunchConfig, type Plan, type RuntimeState,
  resolvePlan, startDaemon, tailForUrl, alive, probeDsh,
  stopDaemon, dshVersion, readState, writeState, readUrlFromLog,
} from './runtime';
import { EmbedHost } from './embed-panel';

/**
 * DSH —— 实验分支：把 DeepSeek Harness 的完整 Web 界面内嵌到
 * VS Code 编辑器区（形态对齐 Claude Code / Codex 的扩展面板）。
 *
 * 与正式版 Hermes Chat 的隔离（重要）：
 *   - 扩展 ID 不同（local.hermes-embed vs local.hermes-chat），两个 vsix
 *     可以并存安装，装这个**不会覆盖**正在用的那个；
 *   - 命令前缀 hermesEmbed.*、视图容器 hermesEmbed、配置命名空间
 *     hermesEmbed.* 全部独立，快捷键与设置互不干扰；
 *   - 状态文件、globalStorage 各自独立；
 *   - **优先附着**：探测到配置端口上已有 dsh 在跑（多半来自正式版）就直接
 *     复用，不重复启动、不抢端口；只有探测不到时才自己守护化启动；
 *   - 「停止」只停本扩展自己启动的进程，绝不碰别人的实例；
 *   - 不提供「升级 dsh」——那会动全局 npm 安装，影响正式版。
 */

const STATE_FILE = 'hermes-embed-runtime.json';

function cfg(): LaunchConfig {
  const c = vscode.workspace.getConfiguration('hermesEmbed');
  return {
    runtime: c.get<string>('runtime', 'auto'),
    dshPath: c.get<string>('dshPath', ''),
    wslDistribution: c.get<string>('wslDistribution', ''),
    webPort: c.get<number>('webPort', 18431),
    webHost: c.get<string>('webHost', '127.0.0.1'),
    dshPackage: '@deepseek-ai/dsh@latest', // 本扩展不使用；仅为复用 LaunchConfig 类型
  };
}

function workspaceCwd(): string {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.env.HOME ?? process.cwd();
}

function fixedAddress(port: number): string {
  return `http://127.0.0.1:${port}`;
}

/** 运行时解析侧的模式（与 resolvePlan 的判断保持一致）。 */
function resolveMode(c: LaunchConfig): Plan['mode'] {
  const useWsl = c.runtime === 'wsl' || (c.runtime === 'auto' && process.platform === 'win32');
  return useWsl && process.platform === 'win32' ? 'wsl' : 'local';
}

class EmbedController implements vscode.Disposable {
  private readonly out = vscode.window.createOutputChannel('DSH', { log: true });
  private readonly treeEmitter = new vscode.EventEmitter<void>();
  readonly onTreeChanged = this.treeEmitter.event;
  private readonly status: vscode.StatusBarItem;
  private state: RuntimeState | null = null;
  private plan: Plan | null = null;
  /** true = 附着到外部（通常是正式版）启动的实例，本扩展无权停止它。 */
  private external = false;
  private busy = false;
  private version: string | null = null;
  private versionFetched = false;
  private readonly embed: EmbedHost;

  constructor(private readonly context: vscode.ExtensionContext) {
    this.status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 99);
    this.context.subscriptions.push(this.status, this.out);
    this.embed = new EmbedHost({
      extensionUri: context.extensionUri,
      port: () => vscode.workspace.getConfiguration('hermesEmbed').get<number>('proxyPort', 18432),
      targetPort: () => this.state?.port ?? cfg().webPort,
      token: () => this.launchToken(),
      log: (line: string) => this.log(`[embed] ${line}`),
    });
    this.context.subscriptions.push(this.embed);
    this.render();
  }

  private stateFile(): string {
    return path.join(this.context.globalStorageUri.fsPath, STATE_FILE);
  }

  log(line: string) {
    this.out.appendLine(line);
  }

  /** 从守护化运行时打印的认证地址里取出启动 token（内嵌代理换 cookie 用）。 */
  private launchToken(): string | null {
    const url = this.state?.url;
    if (!url) return null;
    try {
      return new URL(url).searchParams.get('token');
    } catch {
      return null;
    }
  }

  /**
   * 启动时解析当前可用运行时：先看自己的状态，再探测端口上是否已有实例。
   * 命中外部实例时只读附着（不接管 pid、不重复启动）。
   */
  async adopt() {
    const c = cfg();
    const mode = resolveMode(c);

    // 1) 本扩展自己记录、且确实还活着的实例
    const saved = readState(this.stateFile());
    if (saved && saved.port === c.webPort) {
      const plan: Plan = { mode: saved.mode, distribution: saved.distribution, dshAbs: 'dsh', args: [] };
      if ((await alive(plan, saved.pid)) && (await probeDsh(saved.port)) === 'dsh') {
        if (!saved.url) saved.url = (await readUrlFromLog(saved.mode, saved.distribution)) ?? '';
        this.state = saved;
        this.plan = plan;
        this.external = false;
        this.log(`领养本扩展启动的运行时：pid ${saved.pid}，${fixedAddress(saved.port)}`);
        this.render();
        return;
      }
      this.log(`记录的运行时 pid ${saved.pid} 已不存在，清理状态`);
      writeState(this.stateFile(), null);
    }

    // 2) 端口上已有实例（多半来自正式版 Hermes Chat）：只读附着
    if (c.webPort > 0 && (await probeDsh(c.webPort)) === 'dsh') {
      const url = (await readUrlFromLog(mode, c.wslDistribution)) ?? '';
      this.state = { pid: 0, port: c.webPort, mode, distribution: c.wslDistribution, url, startedAt: Date.now() };
      this.plan = { mode, distribution: c.wslDistribution, dshAbs: 'dsh', args: [] };
      this.external = true;
      this.log(
        url
          ? `附着到已在运行的 dsh（端口 ${c.webPort}），不重复启动`
          : `附着到已在运行的 dsh（端口 ${c.webPort}），但共享日志里没有 token，内嵌窗口首次请求时会再尝试`,
      );
    }
    this.render();
  }

  get running(): boolean { return this.state !== null; }

  /** 未运行则守护化启动（静默，不打开浏览器）。 */
  async ensureRuntime(): Promise<boolean> {
    if (this.state) return true;
    const c = cfg();
    this.busy = true;
    try {
      const plan = await resolvePlan(c, workspaceCwd());
      this.plan = plan;
      this.log(`启动：${plan.mode === 'wsl' ? 'wsl' : 'local'} ${plan.dshAbs} ${plan.args.join(' ')}`);
      const pid = await startDaemon(plan, (l) => this.log(l));
      this.state = { pid, port: c.webPort, mode: plan.mode, distribution: plan.distribution, url: '', startedAt: Date.now() };
      writeState(this.stateFile(), this.state);
      this.external = false;
      this.render();
      const url = await tailForUrl(plan, pid, (l) => this.log(l));
      const port = Number(new URL(url).port) || c.webPort;
      this.state = { ...this.state, port, url };
      writeState(this.stateFile(), this.state);
      this.render();
      this.log(`就绪：${url}`);
      return true;
    } catch (e: any) {
      this.log(`启动失败：${e?.message ?? e}`);
      void vscode.window.showErrorMessage(`DSH 启动失败：${e?.message ?? e}（详见输出面板 "DSH"）`);
      this.state = null;
      writeState(this.stateFile(), null);
      this.render();
      return false;
    } finally {
      this.busy = false;
      this.render();
    }
  }

  /** 主操作：在编辑器区打开内嵌窗口。 */
  async open() {
    if (this.busy) { void vscode.window.showInformationMessage('DSH 正在启动运行时，请稍候。'); return; }
    try {
      if (!(await this.ensureRuntime())) return;
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'DSH：正在打开内嵌窗口' },
        async () => { await this.embed.show(); },
      );
    } catch (e: any) {
      this.log(`打开内嵌窗口失败：${e?.message ?? e}`);
      void vscode.window.showErrorMessage(`DSH 打开内嵌窗口失败：${e?.message ?? e}`);
    }
  }

  /** 显式启动（侧边栏按钮）。 */
  async launch() {
    if (this.busy) return;
    if (this.state) { void vscode.window.showInformationMessage('DSH：运行时已在运行。'); return; }
    await this.ensureRuntime();
  }

  /** 只停本扩展自己启动的实例；附着的外部实例一律不动。 */
  async stop() {
    if (this.busy) return;
    if (!this.state) { void vscode.window.showInformationMessage('DSH：本扩展没有在管理的运行时。'); return; }
    if (this.external) {
      void vscode.window.showWarningMessage(
        'DSH：当前附着的是外部启动的 dsh（通常来自正式版 Hermes Chat），本扩展不会停止它。请在正式版里停止。',
      );
      return;
    }
    const { state, plan } = this;
    if (!plan || state.pid <= 0) return;
    this.busy = true;
    try {
      await stopDaemon(plan, state.pid);
      this.log(`已停止 pid ${state.pid}`);
    } catch (e: any) {
      void vscode.window.showErrorMessage(`DSH 停止失败：${e?.message ?? e}`);
    } finally {
      this.state = null;
      writeState(this.stateFile(), null);
      this.busy = false;
      this.render();
    }
  }

  async openInBrowser() {
    if (!this.state) { void vscode.window.showInformationMessage('DSH：运行时未启动。'); return; }
    await vscode.env.openExternal(vscode.Uri.parse(this.state.url || fixedAddress(this.state.port)));
  }

  async copyAddress() {
    const port = this.state?.port ?? cfg().webPort;
    await vscode.env.clipboard.writeText(fixedAddress(port));
    void vscode.window.showInformationMessage(`已复制固定地址：${fixedAddress(port)}`);
  }

  private async lazyVersion() {
    if (this.versionFetched || this.busy) return;
    this.versionFetched = true;
    try {
      const plan = await resolvePlan(cfg(), workspaceCwd());
      this.version = await dshVersion(plan);
      this.treeEmitter.fire();
    } catch { this.version = null; }
  }

  private render() {
    const c = cfg();
    const port = this.state?.port ?? c.webPort;
    this.status.text = this.state
      ? this.external
        ? `$(window) DSH:${port}`
        : `$(window) DSH:${port} ●`
      : this.busy
        ? '$(loading~spin) DSH'
        : '$(window) DSH';
    this.status.tooltip = this.state
      ? new vscode.MarkdownString(
          `${this.external ? '附着到外部实例' : '本扩展启动'}：dsh web（端口 ${port}）\n\n点击在 VS Code 内嵌打开`,
        )
      : new vscode.MarkdownString('在 VS Code 内部打开 DeepSeek Harness\n\n点击打开内嵌窗口（必要时自动启动运行时）');
    this.status.command = 'hermesEmbed.open';
    this.status.show();
    this.treeEmitter.fire();
    void this.lazyVersion();
  }

  treeItems(): vscode.TreeItem[] {
    const c = cfg();
    const items: vscode.TreeItem[] = [];
    if (this.state) {
      const status = new vscode.TreeItem(
        this.external ? '附着中' : '运行中',
        vscode.TreeItemCollapsibleState.None,
      );
      status.description = `${fixedAddress(this.state.port)}${this.external ? ' · 外部实例' : ` · pid ${this.state.pid}`}`;
      status.iconPath = new vscode.ThemeIcon('circle-filled', new vscode.ThemeColor('charts.green'));
      status.tooltip = this.external
        ? '该 dsh 由其它入口启动（通常是正式版 Hermes Chat），本扩展只读复用，不会停止它'
        : '本扩展守护化启动的实例';
      items.push(status);
      items.push(this.button('window', '在 VS Code 内嵌打开', 'hermesEmbed.open', '推荐'));
      items.push(this.button('globe', '在浏览器打开', 'hermesEmbed.openInBrowser'));
      items.push(this.button('link', '复制固定地址', 'hermesEmbed.copyAddress'));
      if (!this.external) items.push(this.button('debug-stop', '停止运行时', 'hermesEmbed.stop', '仅本扩展实例'));
    } else {
      const status = new vscode.TreeItem('未运行', vscode.TreeItemCollapsibleState.None);
      status.description = `端口 ${c.webPort || '自动'}`;
      status.iconPath = new vscode.ThemeIcon('circle-outline', new vscode.ThemeColor('disabledForeground'));
      status.tooltip = '点击打开：探测到已有实例会直接附着，否则自动启动';
      items.push(status);
      items.push(this.button('window', '在 VS Code 内嵌打开', 'hermesEmbed.open', '自动启动'));
      items.push(this.button('play', '仅启动运行时', 'hermesEmbed.launch'));
    }
    items.push(this.button('gear', '设置', 'hermesEmbed.configure', this.version ? `dsh ${this.version}` : undefined));
    return items;
  }

  /** 统一按钮渲染：图标走 ThemeIcon（TreeItem.label 里的 $(...) 不会渲染），右侧放说明。 */
  private button(icon: string, label: string, command: string, description?: string): vscode.TreeItem {
    const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
    item.iconPath = new vscode.ThemeIcon(icon);
    if (description) item.description = description;
    item.command = { command, title: label };
    return item;
  }

  dispose() {
    this.status.dispose();
    this.out.dispose();
    this.treeEmitter.dispose();
  }
}

export function activate(context: vscode.ExtensionContext) {
  const controller = new EmbedController(context);
  const provider = new (class implements vscode.TreeDataProvider<vscode.TreeItem> {
    readonly onDidChangeTreeData = controller.onTreeChanged;
    getTreeItem(element: vscode.TreeItem): vscode.TreeItem { return element; }
    getChildren(): vscode.TreeItem[] { return controller.treeItems(); }
  })();

  const cmd = (id: string, fn: (...args: unknown[]) => unknown) =>
    context.subscriptions.push(vscode.commands.registerCommand(id, fn));
  cmd('hermesEmbed.open', () => controller.open());
  cmd('hermesEmbed.launch', () => controller.launch());
  cmd('hermesEmbed.stop', () => controller.stop());
  cmd('hermesEmbed.openInBrowser', () => controller.openInBrowser());
  cmd('hermesEmbed.copyAddress', () => controller.copyAddress());
  cmd('hermesEmbed.configure', () =>
    vscode.commands.executeCommand('workbench.action.openSettings', '@ext:local.hermes-embed'));

  context.subscriptions.push(
    vscode.window.createTreeView('hermesEmbedLauncher', { treeDataProvider: provider }),
    controller,
  );
  void controller.adopt();
}

export function deactivate() { /* 守护化运行时有意存活，不做清理 */ }
