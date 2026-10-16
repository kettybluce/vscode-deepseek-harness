# DeepSeek Harness for VS Code

Windows-first VS Code host for the official open-source DeepSeek Harness. The extension embeds the **official Harness web UI — the same React interface that ships inside the DeepSeek desktop app** — in a full-size editor tab, and launches the official `dsh --profile web` runtime in WSL or Windows.

## How it works

The extension does not reimplement any chat UI and does not bundle model weights or the Harness itself. It:

1. spawns the official `dsh --profile web` server (the desktop app's own renderer backend),
2. parses the tokenized local URL from its stdout (the runtime prints it only after its whole plugin tree is ready — cold starts take 10-60s, the panel shows progress and waits instead of failing),
3. starts a **local authentication proxy** and loads the proxied URL inside the tab webview,
4. presents the official UI in a full editor tab, the same way the desktop app opens.

### Why a proxy?

`dsh web` authenticates browsers with an `HttpOnly; SameSite=Strict` cookie. A VS Code webview iframe has an opaque top-level origin (`vscode-webview://`), so every request inside it is cross-site and the Strict cookie is never sent — the tokenized URL always degrades to a 401 "authentication required" page. The proxy performs the token→cookie exchange itself (server-side, where cookies work) and injects the cookie into every forwarded request, WebSocket upgrades included. The browser side never needs cookies. `Hermes: Open in Browser` still uses the original tokenized URL, where real-browser cookies work fine.

Sessions, approvals, file trees, model settings — everything you see is the official desktop interface, driven by the official Harness runtime. Runtime upgrades stay in the cloned Harness installation.

## Windows + WSL setup

1. Install the official DeepSeek Harness and verify it in the target environment:

   ```bash
   dsh --version
   dsh --profile web --no-open
   ```

2. Install the generated `.vsix` in Windows VS Code.
3. Click the **Hermes** icon in the activity bar → **打开 DeepSeek Harness 桌面版** (or run **Hermes: Open Chat**) to open the desktop-style tab.
4. Optional: run **Hermes: Configure Harness** to set `hermesChat.runtime` (`auto` / `wsl` / `windows`), `hermesChat.dshPath`, `hermesChat.wslDistribution`, and `hermesChat.webPort` (0 = OS-picked free port).

For a Windows extension host with `runtime: wsl`, `dsh` is launched through `wsl.exe`. For a Remote-WSL extension host, `dsh` is launched directly inside WSL. On a Windows host the panel rewrites `127.0.0.1` to `localhost` so WSL-bound loopback ports remain reachable.

## Build and install

```bash
npm install
npm run compile
npm run package
code --install-extension ./hermes-chat-0.3.0.vsix
```

The official Harness repository is intentionally kept outside the extension bundle (`docs/` is excluded from the vsix); configure its installed `dsh` path so the runtime can upgrade independently.

## Panel controls

- **⟳ 重新连接** / **Hermes: Restart Harness Runtime** — stop the current `dsh web` process and start a fresh one.
- **↗ 在浏览器打开** / **Hermes: Open in Browser** — open the original tokenized URL in the system browser for a full-window desktop-app experience.
- **⚙ 设置** / **Hermes: Configure Harness** — open the extension settings.

Startup diagnostics surface the last lines of `dsh` stderr in the panel when the runtime exits, and a stale runtime left behind by a crashed extension host is cleaned up on the next activation (pidfile under the extension's global storage, Linux/Remote-WSL hosts only).
