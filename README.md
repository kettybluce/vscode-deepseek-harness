# DeepSeek Harness for VS Code

Windows-first VS Code chat client for the official open-source DeepSeek Harness. The extension keeps the VS Code UI native (activity-bar chat, editor context actions, streaming activity) and launches the official `dsh --profile sdk` JSON-RPC runtime in WSL or Windows.

## How it works

The extension does not reimplement the model runtime and does not bundle model weights. It starts the `dsh` executable you configure, performs the official SDK handshake, sends `session/prompt`, consumes `session.event`/`session.status` notifications, and waits with `session/wait`. This is the same SDK boundary used by the official desktop application and keeps runtime upgrades in the cloned Harness installation.

## Windows + WSL setup

1. Install the official DeepSeek Harness and verify it in the target environment:

   ```bash
   dsh --version
   dsh --profile sdk
   ```

2. Install the generated `.vsix` in Windows VS Code.
3. Open a Windows or Remote-WSL workspace.
4. Run **Hermes: Configure Harness** and set `hermesChat.runtime` to `auto`, `wsl`, or `windows`; configure `dshPath`, optional `wslDistribution`, and normally leave `dshArgs` as `["--profile", "sdk"]`.

For a Windows VS Code extension host, `runtime: wsl` launches through `wsl.exe`. For a Remote-WSL extension host, `dsh` is launched directly inside WSL. The active workspace, file, language, and selected code are added to the prompt context.

## Build and install

```bash
npm install
npm run compile
npm run package
code --install-extension ./hermes-chat-0.1.0.vsix
```

The official Harness repository is intentionally kept outside the extension bundle; configure its installed `dsh` path so the runtime can upgrade independently.

## VS Code features

- Native activity-bar chat panel with streaming assistant output.
- New session and stop controls.
- Runtime/tool/file activity summaries from official Harness events.
- Todo/Plan snapshots from `todo/write` events.
- Changed-file cards with VS Code `vscode.diff` baselines when Git is available.
- Native VS Code terminal launcher for the Harness workspace.
- Session history persisted in VS Code global state and restored when the chat opens.
- Active editor and selection context.
- **Hermes: Explain Selection** from the editor context menu.
- WSL or Windows executable configuration.
- Optional legacy OpenAI-compatible endpoint for installations without `dsh`; the official SDK path is preferred whenever configured.

The Harness SDK has no wire-level prompt cancellation. Stop therefore closes the runtime process; the next request starts a fresh SDK runtime, matching the official client lifecycle semantics.

The official SDK JSON-RPC profile currently exposes no approval-decision RPC and no desktop updater RPC. Approval requests are displayed fail-closed in the panel; configure the official Harness host's answerer/policy for decisions. **Hermes: Check Harness Runtime** reports the installed `dsh` version and leaves upgrades to the official Harness installer/repository, so the extension cannot silently replace your runtime.
