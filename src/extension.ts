import * as vscode from 'vscode';
import * as path from 'node:path';
import {
  type LaunchConfig, type Plan, type RuntimeState,
  resolvePlan, startDaemon, tailForUrl, alive, probeDsh,
  stopDaemon, dshVersion, upgradeDsh, readState, writeState, readUrlFromLog,
} from './runtime';

/**
 * Hermes —— DeepSeek Harness web 运行时（WSL）的 VS Code 一键启动器。
 *
 * 0.4.0 起不再内嵌 webview、不再需要认证代理：扩展只做三件事
 *   1. 一键守护化启动官方 `dsh --profile web`（固定端口，默认 18431）——
 *      进程与 VS Code 生命周期脱钩，关掉编辑器照样在 WSL 里活着；
 *   2. 一键在系统浏览器打开带 token 的认证地址——真实 cookie（30 天）一次认证，
 *      之后长期收藏 http://127.0.0.1:<固定端口> 直接干活；
 *   3. 一键升级 dsh（npm 全局更新，升级后自动重启运行时）。
 * 运行时状态持久化在 globalStorage，VS Code 重开时自动"领养"还活着的运行时。
 */

const STATE_FILE = 'hermes-runtime.json';

function cfg(): LaunchConfig {
  const c = vscode.workspace.getConfiguration('hermesChat');
  return {
    runtime: c.get<string>('runtime', 'auto'),
    dshPath: c.get<string>('dshPath', ''),
    wslDistribution: c.get<string>('wslDistribution', ''),
    webPort: c.get<number>('webPort', 18431),
    webHost: c.get<string>('webHost', '127.0.0.1'),
    dshPackage: c.get<string>('dshPackage', '@deepseek-ai/dsh@latest'),
  };
}

function workspaceCwd(): string {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.env.HOME ?? process.cwd();
}

function fixedAddress(port: number): string {
  return `http://127.0.0.1:${port}`;
}

class HermesController implements vscode.Disposable {
  private readonly out = vscode.window.createOutputChannel('Hermes', { log: true });
  private readonly treeEmitter = new vscode.EventEmitter<void>();
  readonly onTreeChanged = this.treeEmitter.event;
  private readonly status: vscode.StatusBarItem;
  private state: RuntimeState | null = null;
  private plan: Plan | null = null;
  private busy = false; // 启动/停止/升级互斥
  private version: string | null = null;
  private versionFetched = false;

  constructor(private readonly context: vscode.ExtensionContext) {
    this.status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    this.context.subscriptions.push(this.status, this.out);
    this.render();
  }

  private stateFile(): string {
    return path.join(this.context.globalStorageUri.fsPath, STATE_FILE);
  }

  log(line: string) {
    this.out.appendLine(line);
  }

  /** 启动时领养：上次守护化的运行时若还活着，直接接管（不再重复拉起）。 */
  async adopt() {
    const saved = readState(this.stateFile());
    if (!saved) { this.render(); return; }
    const c = cfg();
    if (c.webPort !== 0 && saved.port !== c.webPort) {
      this.log(`丢弃过期状态：配置端口 ${c.webPort} ≠ 记录端口 ${saved.port}`);
      writeState(this.stateFile(), null);
      this.render();
      return;
    }
    const plan: Plan = { mode: saved.mode, distribution: saved.distribution, dshAbs: 'dsh', args: [] };
    if (!(await alive(plan, saved.pid))) {
      this.log(`记录的运行时 pid ${saved.pid} 已不存在（可能 WSL 重启过），按已停止处理`);
      writeState(this.stateFile(), null);
      this.render();
      return;
    }
    const probe = await probeDsh(saved.port);
    if (probe !== 'dsh') {
      this.log(`端口 ${saved.port} 上不是 dsh web（探测结果 ${probe}），丢弃记录（可能被其他程序占用端口）`);
      writeState(this.stateFile(), null);
      this.render();
      return;
    }
    // 就绪前被关掉的 VS Code：状态里还没有 token URL，从运行日志兜底恢复
    if (!saved.url) {
      const url = await readUrlFromLog(saved.mode, saved.distribution);
      if (url) saved.url = url;
      writeState(this.stateFile(), saved);
      this.log(saved.url ? `从日志恢复认证地址：${saved.url}` : `运行时在跑（pid ${saved.pid}）但日志里没有 token 地址，可用固定地址 ${fixedAddress(saved.port)} 访问`);
    } else {
      this.log(`领养运行时：pid ${saved.pid}，${fixedAddress(saved.port)}`);
    }
    this.state = saved;
    this.plan = plan;
    this.render();
  }

  get running(): boolean { return this.state !== null; }

  /** 一键：未启动则守护化启动并等就绪，然后浏览器打开认证地址。 */
  async launch(openBrowser = true) {
    if (this.busy) { void vscode.window.showInformationMessage('Hermes 正在执行启动/停止/升级，请稍候。'); return; }
    if (this.state) { if (openBrowser) await this.openInBrowser(); return; }
    this.busy = true;
    const c = cfg();
    let daemonPid: number | undefined;
    try {
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `Hermes：正在启动 dsh web 运行时（端口 ${c.webPort || '自动'}）`, cancellable: false },
        async (progress) => {
          progress.report({ message: '解析运行时环境…' });
          const plan = await resolvePlan(c, workspaceCwd());
          this.plan = plan;
          this.log(`启动：${plan.mode === 'wsl' ? `wsl${plan.distribution ? ' -d ' + plan.distribution : ''}` : 'local'} ${plan.dshAbs} ${plan.args.join(' ')}`);
          progress.report({ message: '守护化启动中…' });
          const pid = await startDaemon(plan, (l) => this.log(l));
          daemonPid = pid;
          // 先落盘 pid/port：就绪前 VS Code 被关掉也能在下次启动时领养（URL 之后补）
          this.state = { pid, port: c.webPort, mode: plan.mode, distribution: plan.distribution, url: '', startedAt: Date.now() };
          writeState(this.stateFile(), this.state);
          this.render();
          progress.report({ message: '等待官方运行时就绪（冷启动约 10-60s）…' });
          let tick = 0;
          const url = await tailForUrl(plan, pid, (l) => {
            this.log(l);
            if (++tick % 4 === 0) progress.report({ message: `等待官方运行时就绪…（已 ${tick * 2}s）` });
          });
          const port = Number(new URL(url).port) || c.webPort;
          this.state = { ...this.state, port, url };
          writeState(this.stateFile(), this.state);
          this.render();
          this.log(`就绪：${url}`);
          if (openBrowser) await this.openInBrowser();
          void vscode.window.showInformationMessage(
            `Hermes：dsh web 已就绪（${fixedAddress(port)}）。浏览器已认证一次（cookie 30 天），可长期收藏该固定地址。`,
          );
        },
      );
    } catch (e: any) {
      // 已守护化但未就绪（超时/进程早退）：清掉孤儿，避免下次启动撞固定端口
      if (daemonPid && this.plan && (!this.state || !this.state.url)) {
        this.log(`启动未就绪，清理守护进程 pid ${daemonPid}`);
        await stopDaemon(this.plan, daemonPid).catch(() => undefined);
      }
      this.log(`启动失败：${e?.message ?? e}`);
      void vscode.window.showErrorMessage(`Hermes 启动失败：${e?.message ?? e}（详情见输出面板 "Hermes"）`);
      this.render();
    } finally {
      this.busy = false;
      this.render();
    }
  }

  async stop() {
    if (this.busy) return;
    if (!this.state || !this.plan) { void vscode.window.showInformationMessage('Hermes：运行时未在运行。'); return; }
    this.busy = true;
    const { state, plan } = this;
    try {
      await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Hermes：正在停止 dsh web（pid ${state.pid}）` }, async () => {
        await stopDaemon(plan, state.pid);
      });
      this.log(`已停止 pid ${state.pid}`);
      void vscode.window.showInformationMessage(`Hermes：dsh web 已停止（${fixedAddress(state.port)}）。`);
    } catch (e: any) {
      void vscode.window.showErrorMessage(`Hermes 停止失败：${e?.message ?? e}`);
    } finally {
      this.state = null;
      writeState(this.stateFile(), null);
      this.busy = false;
      this.render();
    }
  }

  async restart() {
    if (this.busy) return;
    const wasRunning = this.running;
    if (wasRunning) await this.stop();
    await this.launch(false);
    if (this.state) void vscode.window.showInformationMessage(`Hermes：已重启，浏览器刷新 ${fixedAddress(this.state.port)} 即可（token 未变则无需重新认证）。`);
  }

  async openInBrowser() {
    if (!this.state) { void vscode.window.showInformationMessage('Hermes：运行时未启动，请先点启动。'); return; }
    // token 地址缺失（极端情况）时退回固定地址：浏览器 cookie 未过期仍可直接进
    await vscode.env.openExternal(vscode.Uri.parse(this.state.url || fixedAddress(this.state.port)));
  }

  /** 复制不带 token 的固定地址，方便收藏。 */
  async copyAddress() {
    const port = this.state?.port ?? cfg().webPort;
    await vscode.env.clipboard.writeText(fixedAddress(port));
    void vscode.window.showInformationMessage(`已复制固定地址：${fixedAddress(port)}`);
  }

  /** 一键升级：npm 全局更新 → 显示版本变化 → 运行时在跑则自动重启。 */
  async upgrade() {
    if (this.busy) return;
    this.busy = true;
    const c = cfg();
    const wasRunning = this.running;
    const keepState = this.state;
    try {
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `Hermes：正在升级 dsh（${c.dshPackage}）` },
        async (progress) => {
          progress.report({ message: '解析 dsh 路径…' });
          const plan = await resolvePlan(c, workspaceCwd());
          this.plan = plan;
          const oldV = await dshVersion(plan);
          progress.report({ message: oldV ? `当前 ${oldV}，开始 npm 安装…` : '开始 npm 安装…' });
          await upgradeDsh(plan, c.dshPackage, (l) => this.log(`[upgrade] ${l}`));
          const newV = await dshVersion(plan);
          this.version = newV;
          this.log(`升级完成：${oldV ?? '?'} → ${newV ?? '?'}`);
          if (wasRunning && keepState) {
            progress.report({ message: '重启运行时以加载新版本…' });
            await stopDaemon(plan, keepState.pid);
            this.state = null;
            writeState(this.stateFile(), null);
            this.render();
            this.busy = false;
            await this.launch(false);
          }
          void vscode.window.showInformationMessage(
            `Hermes：dsh 已升级 ${oldV ?? '?'} → ${newV ?? '?'}${wasRunning ? '，运行时已重启，浏览器刷新固定地址即可。' : '。'}`,
          );
          this.render();
        },
      );
    } catch (e: any) {
      this.log(`升级失败：${e?.message ?? e}`);
      void vscode.window.showErrorMessage(`Hermes 升级失败：${e?.message ?? e}（详情见输出面板 "Hermes"）`);
      this.render();
    } finally {
      this.busy = false;
      this.render();
    }
  }

  /** 惰性取一次版本号用于树显示；失败静默。 */
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
    const address = fixedAddress(port);
    this.status.text = this.state
      ? `$(globe) Hermes:${this.state.port}`
      : this.busy
        ? '$(loading~spin) Hermes'
        : '$(debug-start) Hermes';
    this.status.tooltip = this.state
      ? new vscode.MarkdownString(`dsh web 运行中（pid ${this.state.pid}）\n\n固定地址：\`${address}\`\n\n点击在浏览器打开`)
      : new vscode.MarkdownString('启动 DeepSeek Harness web 运行时（WSL 守护化）\n\n点击启动并在浏览器打开');
    this.status.command = this.state ? 'hermesChat.openInBrowser' : 'hermesChat.launch';
    this.status.show();
    this.treeEmitter.fire();
    void this.lazyVersion();
  }

  treeItems(): vscode.TreeItem[] {
    const c = cfg();
    const items: vscode.TreeItem[] = [];
    if (this.state) {
      const status = new vscode.TreeItem(`● 运行中 · ${fixedAddress(this.state.port)}（pid ${this.state.pid}）`, vscode.TreeItemCollapsibleState.None);
      status.tooltip = `守护化运行于${this.state.mode === 'wsl' ? ' WSL' : ' 本机'}，与 VS Code 生命周期无关\n${this.state.url}`;
      status.command = { command: 'hermesChat.openInBrowser', title: '在浏览器打开' };
      items.push(status);
      items.push(this.button('$(browser) 在浏览器打开（认证地址）', 'hermesChat.openInBrowser'));
      items.push(this.button('$(link) 复制固定地址（可收藏）', 'hermesChat.copyAddress'));
      items.push(this.button('$(debug-restart) 重启运行时', 'hermesChat.restart'));
      items.push(this.button('$(debug-stop) 停止运行时', 'hermesChat.stop'));
    } else {
      const status = new vscode.TreeItem(`○ 已停止 · 端口 ${c.webPort || '自动'}`, vscode.TreeItemCollapsibleState.None);
      status.tooltip = '点击下方启动；运行时守护化在 WSL 里，关闭 VS Code 不会停止它';
      items.push(status);
      items.push(this.button('$(play) 启动并在浏览器打开', 'hermesChat.launch'));
    }
    items.push(this.button(`$(arrow-up) 升级 dsh${this.version ? `（当前 ${this.version}）` : ''}`, 'hermesChat.upgrade'));
    items.push(this.button('$(gear) 设置', 'hermesChat.configure'));
    return items;
  }

  private button(label: string, command: string): vscode.TreeItem {
    const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
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
  const controller = new HermesController(context);
  const provider = new (class implements vscode.TreeDataProvider<vscode.TreeItem> {
    readonly onDidChangeTreeData = controller.onTreeChanged;
    getTreeItem(element: vscode.TreeItem): vscode.TreeItem { return element; }
    getChildren(): vscode.TreeItem[] { return controller.treeItems(); }
  })();

  const cmd = (id: string, fn: (...args: unknown[]) => unknown) =>
    context.subscriptions.push(vscode.commands.registerCommand(id, fn));
  cmd('hermesChat.launch', () => controller.launch(true));
  cmd('hermesChat.stop', () => controller.stop());
  cmd('hermesChat.restart', () => controller.restart());
  cmd('hermesChat.openInBrowser', () => controller.openInBrowser());
  cmd('hermesChat.copyAddress', () => controller.copyAddress());
  cmd('hermesChat.upgrade', () => controller.upgrade());
  cmd('hermesChat.configure', () => vscode.commands.executeCommand('workbench.action.openSettings', '@ext:local.hermes-chat'));

  context.subscriptions.push(
    vscode.window.createTreeView('hermesLauncher', { treeDataProvider: provider }),
    controller,
  );
  void controller.adopt();
}

export function deactivate() { /* 守护化运行时有意存活，不做清理 */ }
