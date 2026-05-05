---
title: 桌面本地开发
sidebarTitle: 本地开发
description: Eliza 桌面开发编排器（scripts/dev-platform.mjs）为何以及如何同时运行 Vite、API 和 Electrobun — 环境变量、信号和关闭行为。
---

**桌面开发栈**不是一个单一的二进制文件。`bun run dev:desktop` 和 `bun run dev:desktop:watch` 运行 `scripts/dev-platform.mjs`，它**编排**独立的进程：可选的一次性 `vite build`、可选的仓库根目录 `tsdown`，然后是长期运行的 **Vite**（当 `ELIZA_DESKTOP_VITE_WATCH=1` 时）、**`bun --watch` API** 和 **Electrobun**。

**为什么要编排？** Electrobun 需要 (a) 一个渲染器 URL，(b) 通常需要一个运行中的仪表盘 API，(c) 在开发中需要一个根目录 `dist/` 包用于嵌入式 Eliza 运行时。手动执行容易出错；一个脚本保持端口、环境变量和关闭一致。

<div id="commands">
## 命令
</div>

**CLI 标志**（优先用于临时使用；`bun run dev:desktop -- --help` 列出它们）：`--no-api`、`--force-renderer`、`--rollup-watch`、`--vite-force`。

| 命令 | 启动内容 | 典型用途 |
|------|---------|---------|
| `bun run dev:desktop` | API（除非 `--no-api`）+ Electrobun；当 `apps/app/dist` 比源代码更新时**跳过** `vite build` | 针对**已构建**渲染资产的快速迭代 |
| `bun run dev:desktop:watch` | 同一编排器带 **`ELIZA_DESKTOP_VITE_WATCH=1`** — **Vite 开发服务器** + HMR | 桌面 UI 工作流 |
| `bun run dev` / `bun run dev:web:ui` | 仅浏览器仪表盘栈（API + Vite） | 兼容无头模式的仪表盘迭代 |

**启动表：** 编排器、Vite、API 和 Electrobun 各自打印一个**纯文本设置表**（列为 *Setting / Effective / Source / Change*），以便你查看默认值与环境值及如何更改选项。不带 `--help` 运行即可在终端中查看。

<div id="startup-tables-and-terminal-banners">
### 启动表和终端横幅
</div>

在 **TTY** 上，表格可能使用 **Unicode 方框框架**和子系统名称（编排器、Vite、API、Electrobun）的大型 **figlet 风格**标题，带有 **ANSI 颜色**（洋红色标题、青色框架），除非设置了 **`NO_COLOR`**（**`FORCE_COLOR`** 可以为管道输出启用颜色）。

**为什么：** 桌面开发运行**四个进程**，环境重叠（端口、URL、功能标志）。目标是为人类和 IDE 代理提供*有效*值的**快速视觉扫描** — 与端口预分配和带前缀日志相同的逻辑。这**不是** companion 或仪表盘 UI；不作为产品界面交付给最终用户。

**文档：** [开发者诊断和工作空间](../guides/developer-diagnostics-and-workspace.md)。

**为什么要分开命令？** 完整的**生产** Vite 构建在你需要与发布资产保持一致或不触及桌面 shell UI 时仍然有用。`bun run dev:desktop:watch` 将 Electrobun 指向 Vite 开发服务器以使用 HMR，而 `bun run dev` 保持在浏览器仪表盘栈上。

<div id="legacy-rollup-vite-build---watch">
### Legacy：Rollup `vite build --watch`
</div>

如果你明确需要每次保存时输出文件（例如调试 Rollup 行为）：

```bash
ELIZA_DESKTOP_VITE_WATCH=1 bun scripts/dev-platform.mjs -- --rollup-watch
# or env-only:
ELIZA_DESKTOP_VITE_WATCH=1 ELIZA_DESKTOP_VITE_BUILD_WATCH=1 bun scripts/dev-platform.mjs
```

**为什么这是可选的：** `vite build --watch` 仍然运行 Rollup 生产输出；"3 modules transformed" 仍可能意味着**数秒**重写多 MB 的 chunk。默认的 watch 路径使用 **Vite 开发服务器**代替。

<div id="environment-variables">
## 环境变量
</div>

| 变量 | 用途 |
|------|------|
| `ELIZA_DESKTOP_VITE_WATCH=1` | 启用 watch 工作流（默认为开发服务器；见下文） |
| `ELIZA_DESKTOP_VITE_BUILD_WATCH=1` | 与 `VITE_WATCH` 一起使用，用 `vite build --watch` 代替 `vite dev` |
| `ELIZA_PORT` | Vite / 预期 UI 端口（默认 **2138**） |
| `ELIZA_API_PORT` | API 端口（默认 **31337**）；转发到 Vite 代理 env 和 Electrobun |
| `ELIZA_RENDERER_URL` | 使用 Vite dev 时**由编排器设置** — Electrobun 的 `resolveRendererUrl()` 优先使用此值而非内置静态服务器（**原因：** HMR 仅对开发服务器有效） |
| `ELIZA_DESKTOP_RENDERER_BUILD=always` | 即使 `dist/` 看起来是最新的也强制 `vite build` |
| `--force-renderer` | 等同于始终重新构建渲染器 |
| `--vite-force` | 在 Vite 开发服务器启动时传递 `vite --force`（清除依赖优化缓存） |
| `--rollup-watch` | 与 `ELIZA_DESKTOP_VITE_WATCH=1` 一起使用，用 `vite build --watch` 代替 `vite dev` |
| `--no-api` | 仅 Electrobun；不启动 `dev-server.ts` 子进程 |
| `ELIZA_DESKTOP_SCREENSHOT_SERVER` | 对于 `dev:desktop` / `bun run dev` **默认开启**：Electrobun 在 `127.0.0.1:ELIZA_SCREENSHOT_SERVER_PORT`（默认 **31339**）上监听；Eliza API 将 **`GET /api/dev/cursor-screenshot`**（loopback）代理为**全屏 PNG** 供代理/工具使用（macOS 需要 Screen Recording 权限）。设置为 **`0`**、**`false`**、**`no`** 或 **`off`** 以禁用。 |
| `ELIZA_DESKTOP_DEV_LOG` | **默认开启：** 子进程日志（vite / api / electrobun）镜像到仓库根目录的 **`.eliza/desktop-dev-console.log`**。API（loopback）上的 **`GET /api/dev/console-log`** 返回尾部内容（`?maxLines=`、`?maxBytes=`）。设置为 **`0`** / **`false`** / **`no`** / **`off`** 以禁用。 |

<div id="when-default-ports-are-busy">
### 当默认端口被占用时
</div>

`scripts/dev-platform.mjs` 运行 **`dev:desktop`** 和 **`bun run dev`**。在启动长期运行的子进程之前，它**探测 loopback TCP**，起始端口为：

| 环境变量 | 角色 | 默认值 |
|---------|------|--------|
| **`ELIZA_API_PORT`** | Eliza API（`dev-server.ts`） | **31337** |
| **`ELIZA_PORT`** | Vite 开发服务器（仅 watch 模式） | **2138** |

如果首选端口已被占用，编排器尝试 **preferred + 1**，然后 +2，...（有上限），并将**解析后的**值传递给**每个**子进程（`ELIZA_DESKTOP_API_BASE`、**`ELIZA_RENDERER_URL`**、Vite 的 **`ELIZA_PORT`** 等）。

**为什么在父进程中预分配（而不只在 API 进程内）：** Vite 在启动时只读取一次 `vite.config.ts`；代理的 **`target`** 必须在第一个请求**之前**与 API 端口匹配。如果只有 API 在绑定后才切换端口，UI 仍会代理到旧的默认值直到有人重启 Vite。在 `dev-platform.mjs` 中**一次**解析端口可以保持**编排器日志、环境、代理和 Electrobun** 使用相同的端口号。

**打包桌面（`local` 嵌入式代理）：** Electrobun 主进程从首选的 **`ELIZA_PORT`**（默认 **2138**）调用 **`findFirstAvailableLoopbackPort`**（`apps/app/electrobun/src/native/loopback-port.ts`），将其传递给 **`entry.js start`** 子进程，健康启动后更新 shell 中的 **`process.env.ELIZA_PORT` / `ELIZA_API_PORT`**。**为什么停止默认的 `lsof` + SIGKILL：** 当状态目录不同时，同一默认端口上的第二个 Eliza 实例（或任何应用）是合法的；从 shell 中杀死 PID 令人意外且可能终止无关的工作。**可选回收：** **`ELIZA_AGENT_RECLAIM_STALE_PORT=1`** 运行旧的**"先释放此端口"**行为，供希望单实例接管的开发者使用。

**分离窗口：** 当嵌入式 API 端口确定或变更时，**`injectApiBase`** 对主窗口和**所有** `SurfaceWindowManager` 窗口执行（**原因：** chat/settings/等不能继续轮询过时的 `http://127.0.0.1:…`）。

**相关：** [桌面应用 — 端口配置](./desktop#port-configuration)；**`GET /api/dev/stack`** 在可能的情况下从**接受的 socket** 覆盖 **`api.listenPort`**（**原因：** 如果其他东西重定向了服务器，真实值优于环境变量）。

<div id="macos-frameless-window-chrome-native-dylib">
## macOS：无边框窗口 chrome（原生 dylib）
</div>

在 **macOS** 上，Electrobun 仅在该文件存在时将 **`libMacWindowEffects.dylib`** 复制到开发 bundle 中（见 `apps/app/electrobun/electrobun.config.ts`）。没有它，**交通灯布局、拖拽区域和内边缘调整大小**可能缺失或错误 — 容易被误认为是 Electrobun 的通用 bug。

克隆仓库后，或当你修改 `native/macos/window-effects.mm` 时，从 Electrobun 包构建 dylib：

```bash
cd apps/app/electrobun && bun run build:native-effects
```

更多详情：[Electrobun shell 包](https://github.com/eliza-ai/eliza/tree/main/apps/app/electrobun)（README：*macOS window chrome*），以及 [Electrobun macOS 窗口 chrome](../guides/electrobun-mac-window-chrome.md)。

<div id="macos-local-network-permission-gateway-discovery">
## macOS：本地网络权限（网关发现）
</div>

桌面 shell 使用 **Bonjour/mDNS** 在局域网上发现 Eliza 网关。macOS 可能显示**本地网络**隐私对话框 — 如果你依赖本地发现，请选择**允许**。

Eliza 固定的 **Electrobun** 配置类型（以本仓库中的版本为准）**不**公开 **`NSLocalNetworkUsageDescription`** 的 `Info.plist` 合并，因此操作系统可能显示通用提示。如果上游稍后添加该 hook，我们可以设置更清晰的文案；行为不依赖于它。

<div id="why-vite-build-is-sometimes-skipped">
## 为什么 `vite build` 有时会被跳过
</div>

在启动服务之前，脚本检查 `viteRendererBuildNeeded()`（`scripts/lib/vite-renderer-dist-stale.mjs`）：比较 `apps/app/dist/index.html` 的 mtime 与 `apps/app/src`、`vite.config.ts`、共享包（`packages/ui`、`packages/app-core`）等。

**为什么是 mtime 而非完整的依赖图？** 这是一个**低成本的本地优先启发式方法**，使重启不必在源代码未更改时花费 10–30 秒进行冗余的生产构建。当你需要干净的 bundle 时可以覆盖。

<div id="signals-ctrl-c-and-detached-children-unix">
## 信号、Ctrl-C 和 `detached` 子进程（Unix）
</div>

在 **macOS/Linux** 上，长期运行的子进程以 `detached: true` 启动，使它们生活在编排器的**独立会话**中。

**为什么：** TTY 上的 **Ctrl-C** 被发送到**前台进程组**。没有 `detached`，Electrobun、Vite 和 API 都同时收到 **SIGINT**。Electrobun 处理第一次中断（"press Ctrl+C again…"），而 **Vite 和 API 继续运行**；父进程保持活跃因为 **stdio 管道**仍然打开 — 感觉第一次 Ctrl-C"什么都没做"。

使用 `detached`，**只有编排器**收到 TTY **SIGINT**；它执行单一的关闭路径：**SIGTERM** 每个已知子树，短暂等待，然后 **SIGKILL**，最后 `process.exit`。

关闭期间的**第二次 Ctrl-C** **立即强制退出**（`exit 1`），确保你不会被卡在等待定时器后面。

**Windows：** `detached` 的使用方式**不同**（stdio + 进程模型不同）；端口清理使用 `netstat`/`taskkill` 而非仅 `lsof`。

<div id="quitting-from-the-app-electrobun-exits">
## 从应用退出（Electrobun 退出）
</div>

如果你从原生菜单 **Quit**，Electrobun 以代码 0 退出，而 **Vite 和 API 可能仍在运行**。编排器监视 **electrobun** 子进程：退出时，它**停止剩余服务**并退出。

**为什么：** 否则终端会话在 "App quitting…" 后挂起，因为父进程仍然持有到 Vite/API 的管道 — 与不完整的 Ctrl-C 关闭相同的底层问题。

<div id="port-cleanup-before-vite-killuilistenport">
## Vite 之前的端口清理（`killUiListenPort`）
</div>

在绑定 UI 端口之前，脚本尝试终止正在监听的进程（**原因：** 过时的 Vite 或崩溃的运行会留下 `EADDRINUSE`）。实现：`scripts/lib/kill-ui-listen-port.mjs`（Unix：`lsof`；Windows：`netstat` + `taskkill`）。

<div id="process-trees-and-kill-process-tree">
## 进程树和 `kill-process-tree`
</div>

关闭使用 `signalSpawnedProcessTree` — **仅**以每个**生成的**子进程为根的 PID 树（**原因：** 避免 `pkill bun` 风格的大规模终止，那会杀死机器上不相关的 Bun 工作空间）。

<div id="seeing-many-bun-processes">
## 看到很多 `bun` 进程
</div>

**预期的。** 你通常会有：编排器、`bun run vite`、`bun --watch` API、Electrobun 下的 `bun run dev`（preload 构建 + `bunx electrobun dev`），加上 Bun/Vite/Electrobun 内部进程。如果计数**无限增长**或进程在开发会话完全结束后**存活**，才需要担心。

<div id="ide-and-agent-observability-cursor-scripts">
## IDE 和代理可观测性（Cursor、脚本）
</div>

编辑器和编码代理**看不到**原生 Electrobun 窗口，听不到音频，也无法自动发现 localhost。Eliza 添加了**显式的、机器可读的 hook**，以便工具可以推理"正在运行什么"并近似"用户看到了什么"。

**为什么存在**

1. **多进程事实** — 健康不是一个 PID。Vite、API 和 Electrobun 可能在端口上不一致；日志是交错的。一个 JSON 端点和一个日志文件避免了"在五个终端中搜索"。
2. **安全 vs 便利** — 截图和日志尾部端点**仅限 loopback**；截图路径在 Electrobun 和 API 代理之间使用**会话令牌**；日志 API 仅对名为 **`desktop-dev-console.log`** 的文件做 tail。**原因：** 本地优先不意味着"LAN 上的任何进程都可以获取你的屏幕"。
3. **默认启用可关闭** — 截图和聚合日志对 `dev:desktop` / `bun run dev` **默认开启**，因为代理和人类一起调试时受益；两者都可以通过 **`ELIZA_DESKTOP_SCREENSHOT_SERVER=0`** 和 **`ELIZA_DESKTOP_DEV_LOG=0`** 禁用，以缩小攻击面或减少磁盘 I/O。
4. **Cursor 不自动轮询** — 发现是**文档 + `.cursor/rules`**（见仓库）加上你要求代理运行 `curl` 或读取文件。**原因：** 产品不会静默扫描你的机器；hook 在被指示时才存在。

<div id="get-apidevstack-eliza-api">
### `GET /api/dev/stack`（Eliza API）
</div>

返回稳定的 JSON（`schema: eliza.dev.stack/v1`）：API **监听端口**（可能时来自**socket**）、来自 env 的**桌面** URL/端口（`ELIZA_RENDERER_URL`、`ELIZA_PORT`、…）、**`cursorScreenshot`** / **`desktopDevLog`** 可用性和路径，以及简短的 **hints**（例如启动器日志中 Electrobun 的内部 RPC 端口）。

**为什么在 API 上：** 代理通常已经探测 `/api/health`；额外一个 GET 复用同一主机，避免解析 Electrobun 的临时端口。

<div id="bun-run-desktopstack-status----json">
### `bun run desktop:stack-status -- --json`
</div>

脚本：`scripts/desktop-stack-status.mjs`（使用 `scripts/lib/desktop-stack-status.mjs`）。探测 UI/API 端口，获取 `/api/dev/stack`、`/api/health` 和 `/api/status`。

**为什么是 CLI：** 代理和 CI 可以在不加载仪表盘的情况下运行它；JSON 退出代码反映 API 健康状态，便于简单自动化。

<div id="full-screen-png--get-apidevcursor-screenshot">
### 全屏 PNG — `GET /api/dev/cursor-screenshot`
</div>

**仅限 loopback。** 代理 Electrobun 的开发服务器（默认 **`127.0.0.1:31339`**），该服务器使用与 `ScreenCaptureManager.takeScreenshot()` 相同的 **OS 级捕获**（例如 macOS `screencapture`）。**不仅仅是** webview 像素。

**为什么通过 API 代理：** 一个 URL 在熟悉的 API 端口上；令牌保留在编排器生成的子进程之间的 env 中。**为什么先全屏：** 按窗口 ID 捕获是平台特定的；此路径复用现有的、经过测试的代码。

<div id="aggregated-console--file--get-apidevconsolelog">
### 聚合控制台 — 文件 + `GET /api/dev/console-log`
</div>

带前缀的 **vite / api / electrobun** 行被镜像到 **`.eliza/desktop-dev-console.log`**（每次编排器启动时有会话横幅）。**`GET /api/dev/console-log`**（loopback）返回**文本尾部**；查询参数 **`maxLines`**（默认 400，上限 5000）和 **`maxBytes`**（默认 256000）。

**为什么是文件：** 代理可以从 `desktopDevLog.filePath` `read_file` 路径而无需 HTTP。**为什么是 HTTP tail：** 避免将多 MB 的日志读入上下文；限制防止 OOM。**为什么是基名允许列表：** `ELIZA_DESKTOP_DEV_LOG_PATH` 否则可能指向任意文件。

<div id="ui-e2e-playwright">
## UI E2E（Playwright）
</div>

浏览器冒烟测试目标是 Electrobun 在 watch 模式下加载的**同一渲染器 URL**（`http://localhost:<ELIZA_PORT>`，默认 **2138**）。它们**不**驱动原生 Electrobun webview；托盘、原生菜单和仅打包行为由 **`bun run test:desktop:packaged`**（适用时）和[发布回归检查清单](./release-regression-checklist.md)覆盖。

**为什么是 Playwright：** 应用已经包含 Playwright 用于渲染器和打包检查，因此浏览器冒烟流程现在使用相同的受支持栈，而不是单独的 TestCafe 工具链。这完全消除了有漏洞的 `replicator` 依赖，并将 UI E2E 面保持在一个运行器上。

**依赖：** Playwright 位于 **`@elizaai/app`** 中，冒烟 spec 位于 `apps/app/test/ui-smoke/`。正常的根目录 `bun install` 仍然提升工作空间包；这些浏览器检查通过 `test:ui:playwright*` 选择加入。

**浏览器运行时：** 该套件使用 Playwright Chromium。如果机器上尚未安装，请用 `cd apps/app && bunx playwright install chromium` 安装一次。

| 命令 | 用途 |
|------|------|
| `bun run test:ui:playwright` | 运行 [`apps/app/test/ui-smoke/ui-smoke.spec.ts`](../../apps/app/test/ui-smoke/ui-smoke.spec.ts)；需要时自动在 **:2138** 上启动 Vite 渲染器。 |
| `bun run test:ui:playwright:settings-chat` | 运行 [`apps/app/test/ui-smoke/settings-chat-companion.spec.ts`](../../apps/app/test/ui-smoke/settings-chat-companion.spec.ts)，用于 companion 媒体设置持久化。 |
| `bun run test:ui:playwright:packaged` | 运行 [`apps/app/test/ui-smoke/packaged-hash.spec.ts`](../../apps/app/test/ui-smoke/packaged-hash.spec.ts) 对 `apps/app/dist/index.html`；如果 `dist` 不存在则跳过。 |

**完整测试矩阵：** `bun run test` 默认**不**运行 Playwright UI 冒烟测试。设置 **`ELIZA_TEST_UI_PLAYWRIGHT=1`** 将 UI 套件添加到 `test/scripts/test-parallel.mjs`（串行，在 Vitest e2e 之后）。`ELIZA_TEST_UI_TESTCAFE=1` 仍被接受为旧版别名。

**路径 A vs 原生 webview（阶段 B）：** 这些 spec 仍然目标是渲染器 URL，而不是嵌入式 Electrobun webview。打包/原生行为由 **`bun run test:desktop:packaged`**、**`bun run test:desktop:playwright`** 和[发布回归检查清单](./release-regression-checklist.md)覆盖。

<div id="related-source">
## 相关源代码
</div>

| 部分 | 角色 |
|------|------|
| `.cursor/rules/eliza-desktop-dev-observability.mdc` | Cursor：何时使用 stack / screenshot / console hook（**原因：** 产品不自动扫描 localhost） |
| `scripts/dev-platform.mjs` | 编排器；为 stack / screenshot / 日志路径设置 env |
| `scripts/lib/vite-renderer-dist-stale.mjs` | 何时需要 `vite build` |
| `scripts/lib/kill-ui-listen-port.mjs` | 释放 UI 端口 |
| `scripts/lib/kill-process-tree.mjs` | 范围限定的进程树终止 |
| `scripts/lib/desktop-stack-status.mjs` | `desktop:stack-status` 的端口 + HTTP 探测 |
| `scripts/desktop-stack-status.mjs` | 代理的 CLI 入口（`--json`） |
| `packages/app-core/src/api/dev-stack.ts` | `GET /api/dev/stack` 的 payload |
| `packages/app-core/src/api/dev-console-log.ts` | `GET /api/dev/console-log` 的安全 tail 读取 |
| `apps/app/electrobun/src/index.ts` | `resolveRendererUrl()`；启用时启动截图开发服务器 |
| `apps/app/electrobun/src/screenshot-dev-server.ts` | Loopback PNG 服务器（作为 `/api/dev/cursor-screenshot` 代理） |
| `apps/app/playwright.ui-smoke.config.ts` | 渲染器冒烟 spec 的 Playwright 配置 |
| `apps/app/playwright.ui-packaged.config.ts` | 打包 `file://` 冒烟的 Playwright 配置 |
| `apps/app/test/ui-smoke/ui-smoke.spec.ts` | 主要 UI 遍历 + `TAB_PATHS` 一致性（例如 `/apps` 已禁用） |
| `apps/app/test/ui-smoke/settings-chat-companion.spec.ts` | Companion 媒体设置持久化 |
| `apps/app/test/ui-smoke/packaged-hash.spec.ts` | `file://` + hash 路由一致性 |

<div id="see-also">
## 另请参阅
</div>

- [桌面应用（Electrobun）](/zh/apps/desktop) — 运行时模式、IPC、下载
- [Electrobun 启动和异常处理](../electrobun-startup.md) — 为什么主进程的 try/catch 要保留
