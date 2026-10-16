# Hermes — DeepSeek Harness 启动器 for VS Code

Windows-first 的 VS Code 一键启动器：把官方 `dsh --profile web` 以**守护进程**方式跑在 WSL 里的**固定端口**（默认 `18431`），然后在系统浏览器打开。运行时与 VS Code 生命周期完全脱钩——点完按钮就关编辑器，浏览器长期收藏 `http://127.0.0.1:18431` 干活。

> 0.4.0 起不再内嵌 webview、不再有认证代理（0.3.0 的 iframe + SameSite=Strict 方案已废弃）。官方 UI 直接在真实浏览器里跑，cookie（默认 30 天有效）原生工作。

## 一键流程

1. 点状态栏 `▶ Hermes`（或活动栏 Hermes 图标 →「启动并在浏览器打开」）；
2. 扩展在 WSL 里守护化启动 `dsh --profile web --port 18431`（冷启动 10-60s，进度实时提示）；
3. 浏览器自动打开带 token 的认证地址，完成一次性登录（cookie 30 天）；
4. 之后日常直接访问/收藏 **http://127.0.0.1:18431**，无需再经过扩展。

关闭 VS Code **不会**停止运行时（nohup 守护化）；重开 VS Code 会自动探测并"领养"还在跑的实例。想让运行时真正退出：侧边栏点「停止」，或 `wsl --shutdown`。

## 按钮（侧边栏 + 状态栏）

| 按钮 | 行为 |
|---|---|
| ▶ 启动并在浏览器打开 | 守护化启动 → 等就绪 → 浏览器打开认证地址 |
| ⏹ 停止运行时 | 按 pid 精确 kill（先 TERM 后 KILL），不影响同机其他 dsh 实例 |
| ⟳ 重启运行时 | 停止 + 重新守护化启动 |
| ↗ 在浏览器打开 | 打开认证地址（cookie 过期/换浏览器时用） |
| 🔗 复制固定地址 | 复制 `http://127.0.0.1:18431` 供收藏 |
| ⬆ 升级 dsh | npm 全局安装 `@deepseek-ai/dsh@latest`（路径自动探测 nvm 目录），完成后自动重启运行时 |
| ⚙ 设置 | 打开扩展设置 |

运行日志（dsh stdout/stderr、启动/升级输出）见输出面板 **Hermes**。

## 为什么这样设计

- **固定端口是前提**：dsh 的认证 cookie 绑定「主机名 + 端口」，端口变了浏览器 cookie 就作废；固定端口才能长期收藏同一地址。
- **守护化是前提**：0.3.0 把 dsh 绑死在 VS Code 扩展宿主上，关编辑器就断；守护化后运行时长期存活，VS Code 只是遥控器。
- **不做 webview/代理**：webview 不透明源 + `SameSite=Strict` cookie 是死结，0.3.0 用 170 行代理绕（Host/Origin 重写耦合 dsh 内部信任栅栏，升级易碎）。真实浏览器里 cookie 天然工作，整层复杂度直接删除。
- **精确 kill**：按记录的 pid 停止，绝不 `pkill dsh`——同机可能还跑着桌面版实例。

## Windows + WSL 设置

1. WSL 内安装官方 Harness 并验证：`dsh --version`；
2. 安装 `.vsix` 到 Windows VS Code；
3. 点状态栏 ▶ 即可。默认自动探测 dsh（PATH 或 `~/.nvm/versions/node/*/bin/dsh` 最新版本）；探测失败时在设置里把 `Hermes Chat: Dsh Path` 设为绝对路径。

主要设置：

- `hermesChat.webPort` — 固定端口，默认 `18431`；`0` 为 OS 随机（不推荐，破坏固定地址）。
- `hermesChat.webHost` — 绑定地址，默认 `127.0.0.1`（WSL2 localhost 转发直达 Windows；`0.0.0.0` 会暴露局域网，谨慎）。
- `hermesChat.runtime` — `auto` / `wsl`（Windows 宿主经 wsl.exe）/ `windows`（本机直跑）。
- `hermesChat.wslDistribution` — 发行版名，留空用默认。
- `hermesChat.dshPath` — dsh 绝对路径（运行时侧视角），留空自动探测。
- `hermesChat.dshPackage` — 升级按钮安装的 npm 包，默认 `@deepseek-ai/dsh@latest`。

## 构建

```bash
npm install
npm run compile
npm run package
code --install-extension ./hermes-chat-0.4.0.vsix
```

## 故障排查

- **端口被占**：dsh 起不来且日志报 bind 错误 → 换 `hermesChat.webPort`，或在侧边栏「停止」旧实例。
- **浏览器打开 401**：cookie 过期（30 天）或换了浏览器 → 点「在浏览器打开」走一次 token 认证。
- **探测到"端口上不是 dsh"**：记录端口被其他程序占用 → 换端口。
- **找不到 dsh**：设置 `Hermes Chat: Dsh Path` 为绝对路径（如 `~/.nvm/versions/node/v24.19.0/bin/dsh`）。
- **VS Code 重开显示已停止但明明在跑**：多半是 `wsl --shutdown` 过（WSL 重启会杀掉守护进程），重新点启动即可。
