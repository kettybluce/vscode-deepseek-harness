# Hermes Embed（实验分支）— 把 DeepSeek Harness 内嵌进 VS Code

> 这是 `feat/embedded-webview` 分支的产物，**与正式版 Hermes Chat 是两个不同的扩展**。
> 两者可以同时安装，装这个不会覆盖、也不会影响你正在用的那个。

## 和正式版的区别

| | Hermes Chat（正式版，`main`） | Hermes Embed（本分支） |
|---|---|---|
| 扩展 ID | `local.hermes-chat` | `local.hermes-embed` |
| 命令前缀 | `hermesChat.*` | `hermesEmbed.*` |
| 视图容器 | `hermes` | `hermesEmbed` |
| 配置命名空间 | `hermesChat.*` | `hermesEmbed.*` |
| 界面位置 | 系统浏览器 | **VS Code 编辑器区** |
| 升级 dsh | 有 | **无**（避免动全局 npm 安装影响正式版） |

状态文件、`globalStorage` 各自独立，互不读写。

## 怎么实现的（为什么不用重写 UI）

Claude Code / Codex 的扩展面板是它们自己重写的 React 界面；dsh 的界面已经是一个完整的 Web 应用，重写既不可能也没必要。所以这里采用**同源 iframe + 本地认证代理**，官方 Web 端的每个功能原样可用，升级 dsh 不用改这里一行。

难点在认证：dsh 的浏览器会话是 `HttpOnly; SameSite=Strict` cookie，且 cookie 名是 `sha256(授权域)`、签名绑定 `host:port`。VS Code webview 的文档源是 `vscode-webview://`，把 dsh 放进 iframe 属于第三方上下文——`SameSite=Strict` 的 cookie 根本不会被发送。实测直连 `/` 返回 `401`，带跨站头的 `/api` 返回 `403`。

代理（`src/embed-proxy.ts`）在服务端补齐：

1. 用运行时启动 token 向 dsh 换一张真 cookie，之后每个请求由代理注入；
2. 把 `Host` 改写成上游授权域，`Origin` / `Referer` / `Sec-Fetch-Site` 对齐到同一授权域（这是 dsh `isTrustedApiRequest` 栅栏要求的形状）；
3. 透传 HTTP（dsh 的 RPC 是纯 HTTP POST JSON，**没有 WebSocket**）；
4. 上游 `401` 时重新换 cookie 并重试一次，运行时重启后自愈。

代理只监听 `127.0.0.1`，默认端口 `18432`，仅服务于内嵌窗口，不改变浏览器侧任何行为。

## 安全性：优先附着，绝不抢端口

打开内嵌窗口时：

- 探测配置端口（默认 `18431`）上是否已有 dsh 在跑——**通常就是正式版启动的那个**：
  - 有 → **只读附着**，复用它的 token 做代理，不重复启动；「停止」按钮对它会明确拒绝；
  - 没有 → 才自己守护化启动，并记录 pid；
- 「停止」只停本扩展自己启动的进程。

## 使用

```bash
npm run compile
npm run package      # 产出 hermes-embed-0.5.0.vsix
```

安装（与正式版并存）：

```bash
code --install-extension ./hermes-embed-0.5.0.vsix
```

点活动栏鱼形图标 →「在 VS Code 内嵌打开」，或命令面板 `Hermes Embed: 在 VS Code 内嵌打开`。

卸载只影响它自己：`code --uninstall-extension local.hermes-embed`。

## 设置

- `hermesEmbed.webPort` — 目标 dsh 端口，默认 `18431`（与正式版一致，便于附着）。
- `hermesEmbed.proxyPort` — 内嵌代理端口，默认 `18432`；`0` = 系统随机。
- `hermesEmbed.runtime` — `auto` / `wsl` / `windows`。
- `hermesEmbed.wslDistribution` — WSL 发行版，留空用默认。
- `hermesEmbed.dshPath` — dsh 绝对路径，留空自动探测。

## 已知限制

- 内嵌窗口依赖扩展侧代理进程：VS Code 关闭后内嵌面板随之消失（守护化运行时仍在，浏览器侧照常）。
- 若把 `proxyPort` 设成已被占用的端口，打开会报错，改用其它端口或 `0`。
- 极端情况（运行时刚重启、日志里还没有新 token）首次请求可能 401，代理会自动重试一次；仍失败请点「在浏览器打开」确认运行时状态。
