import * as vscode from 'vscode';
import { ChildProcessWithoutNullStreams, execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';

const execAsync = promisify(execFile);

interface Message { role: 'system'|'user'|'assistant'; content: string }
interface JsonRpcFrame { jsonrpc?: string; id?: string|number; method?: string; params?: any; result?: any; error?: { code?: number; message?: string; data?: unknown } }
interface HistoryEntry { role: 'user'|'assistant'; content: string }

export function activate(context: vscode.ExtensionContext) {
  const provider = new HermesViewProvider(context);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('hermesChatView', provider, { webviewOptions: { retainContextWhenHidden: true } }),
    vscode.commands.registerCommand('hermesChat.open', () => vscode.commands.executeCommand('workbench.view.extension.hermes')),
    vscode.commands.registerCommand('hermesChat.configure', () => vscode.commands.executeCommand('workbench.action.openSettings', '@ext:local.hermes-chat')),
    vscode.commands.registerCommand('hermesChat.explainSelection', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) return vscode.window.showInformationMessage('Open an editor and select code first.');
      const selection = editor.selection.isEmpty ? editor.document.getText() : editor.document.getText(editor.selection);
      if (!selection.trim()) return vscode.window.showInformationMessage('Select some code first.');
      await vscode.commands.executeCommand('workbench.view.extension.hermes');
      provider.sendExternalPrompt(`Explain this ${editor.document.languageId || 'code'} and suggest improvements:\n\n${selection}`);
    }),
    vscode.commands.registerCommand('hermesChat.openTerminal', () => provider.openTerminal()),
    vscode.commands.registerCommand('hermesChat.checkUpdates', () => provider.checkUpdates()),
  );
  context.subscriptions.push({ dispose: () => provider.dispose() });
}

class HermesViewProvider implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;
  private abort?: AbortController;
  private harness?: ChildProcessWithoutNullStreams;
  private rpcBuffer = '';
  private rpcNextId = 1;
  private rpcPending = new Map<string|number, { resolve: (value: any) => void; reject: (error: Error) => void }>();
  private harnessInitialized = false;
  private sessionId: string;
  private history: Record<string, HistoryEntry[]> = {};
  private readonly context: vscode.ExtensionContext;
  private readonly extensionUri: vscode.Uri;
  constructor(context: vscode.ExtensionContext) {
    this.context = context;
    this.extensionUri = context.extensionUri;
    this.history = context.globalState.get<Record<string, HistoryEntry[]>>('hermesChat.history', {});
    this.sessionId = context.globalState.get<string>('hermesChat.lastSessionId') ?? `vscode-${Date.now().toString(36)}`;
  }

  resolveWebviewView(view: vscode.WebviewView) {
    this.view = view;
    view.webview.options = { enableScripts: true, localResourceRoots: [this.extensionUri] };
    view.webview.html = this.html(view.webview);
    void this.initView();
    view.webview.onDidReceiveMessage(async (m) => {
      if (m.type === 'send') await this.send(m.id, m.text, m.messages);
      if (m.type === 'stop') this.stopRuntime();
      if (m.type === 'saveConfig') await this.saveConfig(m);
      if (m.type === 'newSession') { this.sessionId = `vscode-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`; void this.context.globalState.update('hermesChat.lastSessionId', this.sessionId); this.post({ type: 'restore', sessionId: this.sessionId, messages: [] }); }
      if (m.type === 'openSettings') vscode.commands.executeCommand('workbench.action.openSettings', '@ext:local.hermes-chat');
      if (m.type === 'insert') await this.insertIntoEditor(m.text);
      if (m.type === 'showDiff') await this.showDiff(m.path);
      if (m.type === 'approvalDecision') this.post({ type: 'approvalInfo', text: 'The official SDK JSON-RPC protocol does not expose approval decisions; this runtime remains fail-closed.' });
    });
  }

  private async restoreHistory() {
    this.post({ type: 'restore', sessionId: this.sessionId, messages: this.history[this.sessionId] ?? [] });
  }

  /** 首次打开先进入配置页；配置就绪后展示聊天并恢复历史。 */
  private async initView() {
    const cfg = vscode.workspace.getConfiguration('hermesChat');
    if (!cfg.get<string>('dshPath', '') && !cfg.get<string>('endpoint', '')) {
      const found = await this.detectDsh();
      this.post({ type: 'showSetup', dshPath: found ?? '', model: cfg.get<string>('model', 'deepseek-v4-flash') });
      return;
    }
    void this.restoreHistory();
  }

  /** 在当前环境探测 dsh 可执行文件（PATH + 常见安装位置，nvm 取版本最高的一个）。 */
  private async detectDsh(): Promise<string | undefined> {
    const candidates = new Set<string>();
    try {
      const { stdout } = await execAsync('command -v dsh || which dsh', { timeout: 5000 });
      const p = stdout.trim();
      if (p) candidates.add(p);
    } catch { /* PATH 上没有 dsh */ }
    const homes = [process.env.HOME, '/usr/local/bin', '/usr/bin'].filter(Boolean) as string[];
    for (const home of homes) {
      for (const p of [`${home}/.local/bin/dsh`, `${home}/bin/dsh`, `${home}/dsh`]) {
        await fs.access(p, fs.constants.X_OK).then(() => candidates.add(p)).catch(() => undefined);
      }
    }
    const nvmDir = `${process.env.HOME ?? ''}/.nvm/versions/node`;
    try {
      const versions = (await fs.readdir(nvmDir)).filter(v => v.startsWith('v')).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
      for (const v of versions) {
        const p = `${nvmDir}/${v}/bin/dsh`;
        await fs.access(p, fs.constants.X_OK).then(() => candidates.add(p)).catch(() => undefined);
        break; // 只取最新 node 版本下的 dsh
      }
    } catch { /* 无 nvm 目录 */ }
    const [best] = [...candidates].sort((a, b) => {
      const nvm = (p: string) => (p.includes('/.nvm/') ? 0 : 1);
      return nvm(a) - nvm(b);
    });
    return best;
  }

  /** 保存面板配置页提交的设置；dshPath 留空则回落到自动探测结果。 */
  private async saveConfig(m: { dshPath?: string; model?: string; provider?: string; endpoint?: string; apiKey?: string }) {
    const cfg = vscode.workspace.getConfiguration('hermesChat');
    const dshPath = (m.dshPath ?? '').trim() || await this.detectDsh() || '';
    await cfg.update('dshPath', dshPath, vscode.ConfigurationTarget.Global);
    if (m.model?.trim()) await cfg.update('model', m.model.trim(), vscode.ConfigurationTarget.Global);
    if (m.provider?.trim()) await cfg.update('provider', m.provider.trim(), vscode.ConfigurationTarget.Global);
    if (m.endpoint?.trim()) await cfg.update('endpoint', m.endpoint.trim(), vscode.ConfigurationTarget.Global);
    if (m.apiKey) await cfg.update('apiKey', m.apiKey, vscode.ConfigurationTarget.Global);
    const saved = dshPath
      ? `已保存配置：dsh = ${dshPath}`
      : '已保存配置，但未找到 dsh 可执行文件——请确认 DeepSeek Harness 已安装，或在下方 endpoint 填写 OpenAI 兼容地址。';
    this.post({ type: 'configSaved', text: saved });
    void this.restoreHistory();
  }

  private async persistHistory() {
    await this.context.globalState.update('hermesChat.history', this.history);
  }

  sendExternalPrompt(text: string) {
    this.post({ type: 'externalPrompt', text });
  }

  private async send(id: string, text: string, messages: Message[]) {
    const cfg = vscode.workspace.getConfiguration('hermesChat');
    const dsh = cfg.get<string>('dshPath', '');
    if (dsh || cfg.get<string>('runtime', 'auto') !== 'windows' || !cfg.get<string>('endpoint', '')) {
      try { await this.sendToHarness(id, text, messages); return; } catch (e: any) {
        this.post({ type: 'error', id, error: `Harness launch failed: ${e?.message ?? e}` });
        return;
      }
    }
    const endpoint = cfg.get<string>('endpoint', 'http://127.0.0.1:8080/v1').replace(/\/$/, '');
    const model = cfg.get<string>('model', 'deepseek-hermes');
    const apiKey = cfg.get<string>('apiKey', '');
    this.abort = new AbortController();
    const all: Message[] = [{ role: 'system', content: cfg.get<string>('systemPrompt', '') }, ...messages, { role: 'user', content: text }];
    this.post({ type: 'assistantStart', id });
    try {
      const res = await fetch(`${endpoint}/chat/completions`, { method: 'POST', signal: this.abort.signal,
        headers: { 'content-type': 'application/json', ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) },
        body: JSON.stringify({ model, messages: all, temperature: cfg.get<number>('temperature', .2), max_tokens: cfg.get<number>('maxTokens', 4096), stream: true }) });
      if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
      if (!res.body) throw new Error('Server returned no response body');
      const reader = res.body.getReader(); const decoder = new TextDecoder(); let buffer = '';
      while (true) {
        const r = await reader.read(); if (r.done) break; buffer += decoder.decode(r.value, { stream: true });
        const lines = buffer.split(/\r?\n/); buffer = lines.pop() ?? '';
        for (const line of lines) { if (!line.startsWith('data:')) continue; const raw = line.slice(5).trim(); if (raw === '[DONE]') continue;
          try { const c = JSON.parse(raw).choices?.[0]?.delta?.content; if (c) this.post({ type: 'delta', id, text: c }); } catch { /* keep partial SSE chunks */ }
        }
      }
      this.post({ type: 'assistantEnd', id });
    } catch (e: any) { this.post({ type: 'error', id, error: e?.name === 'AbortError' ? 'Stopped.' : `${e?.message ?? e}\n\nCheck Hermes server and hermesChat.endpoint in Settings.` }); }
    finally { this.abort = undefined; }
  }

  /** Starts the official `dsh --profile sdk` JSON-RPC bridge and drives one session. */
  private async sendToHarness(id: string, text: string, _messages: Message[]) {
    const cfg = vscode.workspace.getConfiguration('hermesChat');
    const runtime = cfg.get<string>('runtime', 'auto');
    const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
    const useWsl = runtime === 'wsl' || (runtime === 'auto' && process.platform === 'win32');
    const dshPath = cfg.get<string>('dshPath', '') || 'dsh';
    const configuredArgs = cfg.get<string[]>('dshArgs', ['--profile', 'sdk']);
    const args = configuredArgs.length > 0 ? configuredArgs : ['--profile', 'sdk'];
    const launch = await this.resolveLaunch(useWsl, dshPath, args, cwd, cfg.get<string>('wslDistribution', ''));
    if (!this.harness) {
      this.harness = spawn(launch.command, launch.args, { cwd: launch.cwd, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
      this.attachRpc(this.harness);
      await this.rpcRequest('initialize', {
        cwd: launch.harnessCwd,
        provider: cfg.get<string>('provider', 'deepseek-official'),
        model: cfg.get<string>('model', 'deepseek-v4-flash'),
        ...(cfg.get<string>('reasoningEffort', '') ? { reasoningEffort: cfg.get<string>('reasoningEffort') } : {}),
        maxTokens: cfg.get<number>('maxTokens', 4096),
      });
      this.harnessInitialized = true;
    }
    if (!this.harnessInitialized) throw new Error('Harness runtime did not initialize');
    this.post({ type: 'assistantStart', id });
    const prompt = await this.workspacePrompt(text);
    let responseText = '';
    const onEvent = (frame: JsonRpcFrame) => {
      if (frame.method !== 'session.event' || frame.params?.sessionId !== this.sessionId) return;
      const event = frame.params.event;
      if (!event || typeof event !== 'object') return;
      const streamText = this.eventText(event);
      if (streamText && streamText.length > responseText.length) {
        const delta = streamText.slice(responseText.length);
        responseText = streamText;
        this.post({ type: 'delta', id, text: delta });
      }
      if (event.type !== 'assistant/attempt' && event.type !== 'assistant/message') this.post({ type: 'activity', id, eventType: event.type, data: event.data });
      this.projectEvent(id, event);
    };
    this.eventListeners.add(onEvent);
    try {
      const promptResult = await this.rpcRequest('session/prompt', { sessionId: this.sessionId, contentBlocks: [{ type: 'text', text: prompt }] });
      if (!promptResult?.messageId) throw new Error('Harness accepted the prompt without returning a messageId');
      await this.rpcRequest('session/wait', { sessionId: this.sessionId }, 10 * 60 * 1000);
      await this.collectChangedFiles();
      this.post({ type: 'assistantEnd', id });
      const current = this.history[this.sessionId] ?? [];
      current.push({ role: 'user', content: text }, { role: 'assistant', content: responseText });
      this.history[this.sessionId] = current.slice(-80);
      await this.persistHistory();
    } finally {
      this.eventListeners.delete(onEvent);
    }
  }

  private eventListeners = new Set<(frame: JsonRpcFrame) => void>();

  private attachRpc(child: ChildProcessWithoutNullStreams) {
    child.on('error', error => this.failRpc(error));
    child.on('exit', code => { this.harnessInitialized = false; if (code !== 0) this.failRpc(new Error(`dsh exited with code ${code}`)); });
    child.stderr.on('data', data => this.post({ type: 'runtimeLog', text: String(data) }));
    child.stdout.on('data', data => {
      this.rpcBuffer += String(data);
      const lines = this.rpcBuffer.split(/\r?\n/); this.rpcBuffer = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const frame = JSON.parse(line) as JsonRpcFrame;
          if (frame.id !== undefined) {
            const pending = this.rpcPending.get(frame.id);
            if (pending) { this.rpcPending.delete(frame.id); frame.error ? pending.reject(new Error(frame.error.message ?? 'Harness JSON-RPC error')) : pending.resolve(frame.result); }
          }
          for (const listener of this.eventListeners) listener(frame);
        } catch { /* dsh diagnostics must not corrupt the JSON-RPC stream */ }
      }
    });
  }

  private rpcRequest(method: string, params: Record<string, unknown>, timeoutMs = 30_000): Promise<any> {
    if (!this.harness) return Promise.reject(new Error('Harness process is not running'));
    const requestId = this.rpcNextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.rpcPending.delete(requestId);
        reject(new Error(`Harness RPC timed out: ${method}`));
      }, timeoutMs);
      this.rpcPending.set(requestId, {
        resolve: value => { clearTimeout(timer); resolve(value); },
        reject: error => { clearTimeout(timer); reject(error); },
      });
      try {
        this.harness?.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: requestId, method, params }) + '\n');
      } catch (error) {
        this.rpcPending.delete(requestId);
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private failRpc(error: Error) { for (const pending of this.rpcPending.values()) pending.reject(error); this.rpcPending.clear(); }

  private eventText(event: any): string {
    if ((event.type === 'assistant/message' || event.type === 'assistant/attempt') && Array.isArray(event.data?.message?.content)) return event.data.message.content.filter((b: any) => b?.type === 'text').map((b: any) => b.text).join('');
    if (Array.isArray(event.data?.stream)) {
      return event.data.stream.flatMap((record: any) => {
        if (record?.type === 'text-chunks' && Array.isArray(record.texts)) return record.texts;
        if (record?.type === 'chunk' && record.chunk?.type === 'block-end' && record.chunk.block?.type === 'text') return [record.chunk.block.text];
        return [];
      }).join('');
    }
    return '';
  }

  private projectEvent(id: string, event: any) {
    if (event.type === 'todo/write' && Array.isArray(event.data?.todos)) this.post({ type: 'todo', id, todos: event.data.todos });
    if (event.type === 'approval/asked') this.post({ type: 'approval', id, request: event.data });
    if (event.type === 'approval/decided') this.post({ type: 'approvalResult', id, outcome: event.data?.outcome });
    if (event.type === 'tool/call') this.post({ type: 'toolCall', id, tool: event.data });
    if (event.type === 'tool/result') this.post({ type: 'toolResult', id, result: event.data });
  }

  private async collectChangedFiles() {
    const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!cwd) return;
    execFile('git', ['-C', cwd, 'diff', 'HEAD', '--name-only'], { windowsHide: true }, (_error, stdout) => {
      const files = String(stdout ?? '').split(/\r?\n/).map(x => x.trim()).filter(Boolean).slice(0, 100);
      if (files.length) this.post({ type: 'changedFiles', files });
    });
  }

  async openTerminal() {
    const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    const terminal = vscode.window.createTerminal({ name: 'Hermes Harness', cwd });
    terminal.show();
  }

  async checkUpdates() {
    const cfg = vscode.workspace.getConfiguration('hermesChat');
    const runtime = cfg.get<string>('runtime', 'auto');
    const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
    const useWsl = runtime === 'wsl' || (runtime === 'auto' && process.platform === 'win32');
    const dshPath = cfg.get<string>('dshPath', '') || 'dsh';
    const launch = await this.resolveLaunch(useWsl, dshPath, cfg.get<string[]>('dshArgs', ['--profile', 'sdk']), cwd, cfg.get<string>('wslDistribution', ''));
    execFile(launch.command, [...launch.args, '--version'], { cwd: launch.cwd, windowsHide: true }, (error, stdout, stderr) => {
      const text = error ? `Harness update check failed: ${error.message}` : `Installed Harness: ${String(stdout || stderr).trim()}\nUpdates follow the official Harness installer/repository lifecycle; this extension never replaces the runtime in place.`;
      this.post({ type: 'updateStatus', text });
      void vscode.window.showInformationMessage(text.split('\n')[0]);
    });
  }

  private async showDiff(file: string) {
    const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!cwd || !file) return;
    const target = path.resolve(cwd, file);
    const relative = path.relative(cwd, target);
    if (relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      return vscode.window.showWarningMessage(`Refusing to open a diff outside the workspace: ${file}`);
    }
    execFile('git', ['-C', cwd, 'show', `HEAD:${relative}`], { windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, async (error, stdout) => {
      if (error) return vscode.window.showWarningMessage(`No HEAD baseline for ${relative}; opening the current file.`).then(() => vscode.window.showTextDocument(vscode.Uri.file(target)));
      const baseline = path.join(os.tmpdir(), `hermes-baseline-${Date.now()}-${path.basename(target)}`);
      await fs.writeFile(baseline, stdout);
      await vscode.commands.executeCommand('vscode.diff', vscode.Uri.file(baseline), vscode.Uri.file(target), `Hermes: ${relative}`);
    });
  }

  private resolveLaunch(useWsl: boolean, dshPath: string, args: string[], cwd: string, distribution: string): Promise<{ command: string; args: string[]; cwd: string; harnessCwd: string }> {
    if (!useWsl || process.platform !== 'win32') return Promise.resolve({ command: dshPath, args, cwd, harnessCwd: path.normalize(cwd) });
    return new Promise(resolve => execFile('wsl.exe', [...(distribution ? ['-d', distribution] : []), '--', 'wslpath', '-a', '-u', cwd], { windowsHide: true }, (error, stdout) => {
      const linuxCwd = !error && stdout.trim() ? stdout.trim() : cwd.replace(/^([A-Za-z]):[\\/]/, (_m, drive) => `/mnt/${String(drive).toLowerCase()}/`).replaceAll('\\', '/');
      resolve({ command: 'wsl.exe', args: [...(distribution ? ['-d', distribution] : []), '--cd', linuxCwd, '--', dshPath, ...args], cwd, harnessCwd: linuxCwd });
    }));
  }

  dispose() {
    this.abort?.abort();
    const child = this.harness;
    if (child) {
      void this.rpcRequest('shutdown', {}).catch(() => undefined);
      setTimeout(() => { try { child.kill(); } catch { /* process already exited */ } }, 500).unref();
    }
    this.harness = undefined;
    this.harnessInitialized = false;
    this.failRpc(new Error('Extension disposed'));
  }

  private stopRuntime() {
    this.abort?.abort();
    if (this.harness) {
      try { this.harness.stdin.end(); } catch { /* already closed */ }
      this.harness.kill();
      this.harness = undefined;
      this.harnessInitialized = false;
      this.failRpc(new Error('Stopped by user'));
    }
    this.post({ type: 'stopped' });
  }

  private async insertIntoEditor(text: string) {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return vscode.window.showInformationMessage('Open an editor first.');
    await editor.edit(edit => edit.insert(editor.selection.active, text));
  }

  private async workspacePrompt(text: string): Promise<string> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return text;
    const selection = editor.selection && !editor.selection.isEmpty ? editor.document.getText(editor.selection) : '';
    const file = editor.document.uri?.fsPath ?? '';
    const details = [
      'VS Code workspace context (use this only as task context):',
      file ? `Active file: ${file}` : '',
      editor.document.languageId ? `Language: ${editor.document.languageId}` : '',
      selection ? 'Selected code:\n```' + selection.slice(0, 16000) + '```' : '',
      '',
      'User request:',
      text,
    ].filter(Boolean).join('\n');
    return details;
  }

  private post(message: unknown) { this.view?.webview.postMessage(message); }

  private html(webview: vscode.Webview) {
    const nonce = Math.random().toString(36).slice(2);
    return `<!doctype html><html><head><meta charset="UTF-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';"><style>
      *{box-sizing:border-box}body{padding:0;margin:0;color:var(--vscode-foreground);font:13px var(--vscode-font-family);background:var(--vscode-sideBar-background)}header{height:42px;display:flex;align-items:center;padding:0 12px;border-bottom:1px solid var(--vscode-widget-border);gap:8px;font-weight:600}.brand{font-size:14px;flex:1}.icon{background:none;border:0;color:var(--vscode-foreground);font-size:16px;cursor:pointer;padding:4px}.main{height:calc(100vh - 42px);display:flex;flex-direction:column}.messages{flex:1;overflow:auto;padding:12px 10px}.empty{text-align:center;opacity:.6;margin-top:35vh}.msg{margin:0 0 16px}.role{font-size:11px;text-transform:uppercase;opacity:.6;margin-bottom:4px}.bubble{white-space:pre-wrap;line-height:1.5;overflow-wrap:anywhere}.user .bubble{background:var(--vscode-textBlockQuote-background);padding:8px 10px;border-radius:8px}.assistant .bubble{padding:2px 0}.activity{margin:8px 0}.activity .bubble{border-left:2px solid var(--vscode-textLink-foreground);padding:4px 8px;color:var(--vscode-descriptionForeground);font-size:12px}.error{color:var(--vscode-errorForeground);white-space:pre-wrap}.composer{padding:8px;border-top:1px solid var(--vscode-widget-border)}textarea{width:100%;resize:none;min-height:60px;max-height:180px;border:1px solid var(--vscode-input-border);border-radius:8px;background:var(--vscode-input-background);color:var(--vscode-input-foreground);padding:9px;font:inherit;outline:none}.bar{display:flex;align-items:center;margin-top:6px;gap:5px}.hint{opacity:.5;font-size:11px;flex:1}button.send{background:var(--vscode-button-background);color:var(--vscode-button-foreground);border:0;border-radius:5px;padding:5px 12px;cursor:pointer}button.send:disabled{opacity:.5}code{font-family:var(--vscode-editor-font-family)}pre{background:var(--vscode-textCodeBlock-background);padding:8px;border-radius:5px;overflow:auto}
    </style></head><body><header><span class="brand">Hermes Chat</span><button class="icon" id="new" title="New chat">＋</button><button class="icon" id="settings" title="Settings">⚙</button></header><div class="main"><div class="messages" id="messages"><div class="empty" id="empty">Ask your local model anything<br><small>Running in the VS Code WSL extension host</small></div></div><div class="composer"><textarea id="input" placeholder="Message Hermes…"></textarea><div class="bar"><span class="hint">Enter to send · Shift+Enter for newline</span><button class="send" id="stop" hidden>Stop</button><button class="send" id="send">Send</button></div></div></div><div id="setup" hidden style="position:absolute;inset:42px 0 0 0;overflow:auto;padding:18px 16px;background:var(--vscode-sideBar-background)"><h3 style="margin:0 0 4px;font-size:14px">配置 Hermes / DeepSeek Harness</h3><p style="opacity:.6;font-size:12px;margin:0 0 14px">首次使用请先配置模型运行时。dsh 留空将自动探测当前 WSL 中的安装。</p><label style="display:block;font-size:12px;margin-bottom:10px">dsh 可执行文件路径<input id="cfgDsh" placeholder="/home/you/.nvm/versions/node/vX/bin/dsh" style="display:block;width:100%;margin-top:4px;padding:7px;border:1px solid var(--vscode-input-border);border-radius:6px;background:var(--vscode-input-background);color:var(--vscode-input-foreground);font:inherit"></label><label style="display:block;font-size:12px;margin-bottom:10px">模型<input id="cfgModel" placeholder="deepseek-v4-flash" style="display:block;width:100%;margin-top:4px;padding:7px;border:1px solid var(--vscode-input-border);border-radius:6px;background:var(--vscode-input-background);color:var(--vscode-input-foreground);font:inherit"></label><label style="display:block;font-size:12px;margin-bottom:10px">Provider（官方 Harness 路由）<input id="cfgProvider" placeholder="deepseek-official" style="display:block;width:100%;margin-top:4px;padding:7px;border:1px solid var(--vscode-input-border);border-radius:6px;background:var(--vscode-input-background);color:var(--vscode-input-foreground);font:inherit"></label><details style="font-size:12px;margin-bottom:12px"><summary style="cursor:pointer;opacity:.7">没有 dsh？改用 OpenAI 兼容接口（可选）</summary><label style="display:block;margin-top:8px">Endpoint<input id="cfgEndpoint" placeholder="http://127.0.0.1:8080/v1" style="display:block;width:100%;margin-top:4px;padding:7px;border:1px solid var(--vscode-input-border);border-radius:6px;background:var(--vscode-input-background);color:var(--vscode-input-foreground);font:inherit"></label><label style="display:block;margin-top:8px">API Key<input id="cfgKey" type="password" placeholder="可选" style="display:block;width:100%;margin-top:4px;padding:7px;border:1px solid var(--vscode-input-border);border-radius:6px;background:var(--vscode-input-background);color:var(--vscode-input-foreground);font:inherit"></label></details><div style="display:flex;align-items:center;gap:8px"><button class="send" id="cfgSave">保存并开始</button><span id="cfgMsg" style="font-size:12px;opacity:.7"></span></div></div><script nonce="${nonce}">
      const vscode=acquireVsCodeApi(); let messages=[], busy=false; const $=id=>document.getElementById(id), esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
      function render(role,text,cls=''){ $("empty").style.display='none'; const el=document.createElement('div'); el.className='msg '+role; el.innerHTML='<div class="role">'+(role==='user'?'You':'Hermes')+'</div><div class="bubble '+cls+'">'+esc(text)+'</div>'; if(role==='assistant'&&!cls){const action=document.createElement('button');action.className='icon';action.title='Insert into editor';action.textContent='↳';action.onclick=()=>vscode.postMessage({type:'insert',text:el.querySelector('.bubble').textContent||''});el.appendChild(action);} $('messages').appendChild(el); $('messages').scrollTop=999999; return el.querySelector('.bubble'); }
      function renderTodo(todos){const box=render('assistant',todos.map(t=>(t.status==='completed'?'☑ ':t.status==='in_progress'?'◉ ':'☐ ')+t.content).join('\n'),'activity');box.dataset.kind='todo';}
      function renderApproval(req){render('assistant',(req.toolName||'Tool')+' requests approval'+(req.reason?'\n'+req.reason:'')+'\n\nApproval is controlled by the official Harness host. This SDK bridge currently exposes no decision RPC, so the runtime will fail closed unless its own answerer is configured.','activity');}
      function setBusy(v){busy=v;$('send').disabled=v;$('stop').hidden=!v;$('input').disabled=v;}
      function send(){const t=$('input').value.trim();if(!t||busy)return; render('user',t); const bubble=render('assistant',''); messages.push({role:'user',content:t}); $('input').value=''; setBusy(true); vscode.postMessage({type:'send',id:String(Date.now()),text:t,messages}); window.current=bubble;}
      $('send').onclick=send; $('stop').onclick=()=>vscode.postMessage({type:'stop'}); $('settings').onclick=()=>vscode.postMessage({type:'openSettings'}); $('new').onclick=()=>{messages=[];vscode.postMessage({type:'newSession'});$('messages').innerHTML='<div class="empty" id="empty">Ask your local model anything<br><small>Running in the VS Code WSL extension host</small></div>';}; $('input').onkeydown=e=>{if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();send();}};
      function activityText(m){const d=m.data||{};const tool=d.tool?.name||d.name;const command=d.command||d.commandLine||d.input?.command;const file=d.path||d.filePath||d.file?.path;const detail=tool?'Tool: '+tool:command?'Command: '+command:file?'File: '+file:d.reason?.kind?'Reason: '+d.reason.kind:'';return (m.eventType||'runtime').replaceAll('/',' · ')+(detail?'\n'+detail:'');}
      function restore(list){(list||[]).forEach(x=>render(x.role,x.content));}
      window.onmessage=e=>{const m=e.data;if(m.type==='restore'){restore(m.messages);} if(m.type==='showSetup'){$('setup').hidden=false;if(m.dshPath)$('cfgDsh').value=m.dshPath;if(m.model)$('cfgModel').value=m.model;} if(m.type==='configSaved'){$('cfgMsg').textContent=m.text||'已保存';setTimeout(()=>{$('setup').hidden=true;$('cfgMsg').textContent='';},1800);} if(m.type==='externalPrompt'){$('input').value=m.text||'';$('input').focus();} if(m.type==='delta'&&window.current){window.current.textContent+=m.text;$('messages').scrollTop=999999;} if(m.type==='activity')render('assistant',activityText(m),'activity'); if(m.type==='todo')renderTodo(m.todos||[]); if(m.type==='approval')renderApproval(m.request||{}); if(m.type==='changedFiles'){const box=render('assistant','Changed files:\n'+m.files.join('\n'),'activity');m.files.forEach(f=>{const b=document.createElement('button');b.textContent='Diff '+f;b.className='send';b.onclick=()=>vscode.postMessage({type:'showDiff',path:f});box.appendChild(b);});} if(m.type==='updateStatus')render('assistant',m.text,'activity'); if(m.type==='runtimeLog')render('assistant','Runtime\n'+m.text,'activity'); if(m.type==='assistantEnd'&&window.current){messages.push({role:'assistant',content:window.current.textContent});setBusy(false);} if(m.type==='stopped'){setBusy(false);} if(m.type==='error'){if(window.current){window.current.className='bubble error';window.current.textContent=m.error;}else render('assistant',m.error,'error');setBusy(false);}};
      $('cfgSave').onclick=()=>vscode.postMessage({type:'saveConfig',dshPath:$('cfgDsh').value,model:$('cfgModel').value,provider:$('cfgProvider').value,endpoint:$('cfgEndpoint').value,apiKey:$('cfgKey').value});
    </script></body></html>`;
  }
}
