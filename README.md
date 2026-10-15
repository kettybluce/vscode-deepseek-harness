# DeepSeek Harness for VS Code

Windows-first VS Code host for the official open-source DeepSeek Harness. The extension embeds the **official Harness web UI — the same React interface that ships inside the DeepSeek desktop app** — in a native activity-bar panel, and launches the official `dsh --profile web` runtime in WSL or Windows.

## How it works

The extension does not reimplement any chat UI and does not bundle model weights or the Harness itself. It:

1. spawns the official `dsh --profile web` server (the desktop app's own renderer backend),
2. parses the tokenized local URL from its stdout,
3. loads that URL inside the panel webview.

Sessions, approvals, file trees, model settings — everything you see is the official desktop interface, driven by the official Harness runtime. Runtime upgrades stay in the cloned Harness installation.

## Windows + WSL setup

1. Install the official DeepSeek Harness and verify it in the target environment:

   ```bash
   dsh --version
   dsh --profile web --no-open
   ```

2. Install the generated `.vsix` in Windows VS Code.
3. Open a Windows or Remote-WSL workspace.
4. Optional: run **Hermes: Configure Harness** to set `hermesChat.runtime` (`auto` / `wsl` / `windows`), `hermesChat.dshPath`, `hermesChat.wslDistribution`, and `hermesChat.webPort` (0 = OS-picked free port).

For a Windows extension host with `runtime: wsl`, `dsh` is launched through `wsl.exe`. For a Remote-WSL extension host, `dsh` is launched directly inside WSL. On a Windows host the panel rewrites `127.0.0.1` to `localhost` so WSL-bound loopback ports remain reachable.

## Build and install

```bash
npm install
npm run compile
npm run package
code --install-extension ./hermes-chat-0.2.0.vsix
```

The official Harness repository is intentionally kept outside the extension bundle (`docs/` is excluded from the vsix); configure its installed `dsh` path so the runtime can upgrade independently.

## Panel controls

- **⟳ 重新连接** / **Hermes: Restart Harness Runtime** — stop the current `dsh web` process and start a fresh one.
- **↗ 在浏览器打开** / **Hermes: Open in Browser** — open the same tokenized URL in the system browser for a full-window desktop-app experience.
- **⚙ 设置** / **Hermes: Configure Harness** — open the extension settings.

Startup diagnostics surface the last lines of `dsh` stderr in the panel when the runtime fails to start, and when the runtime exits the panel offers a one-click retry.
