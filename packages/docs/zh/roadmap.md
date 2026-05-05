---
title: "路线图"
sidebarTitle: "路线图"
description: "产品方向和设计理念；已发布的变更请参见 changelog。"
---

# Eliza 路线图

高层方向和设计理念。内容不详尽；已发布的变更及其原因请参见 **[Changelog](changelog.mdx)**（或仓库内的 `docs/changelog.mdx`）。

<div id="principles-energy-and-experience-desktop">

## 原则：能耗与体验（桌面端）

</div>

**目标：** 在笔记本电池上击败**常驻开发 shell** 的*体感*能耗成本，同时保持比平面编辑器界面**更具视觉辨识度**——追求**更好的 UX 和 DX**，而非规格参数的炫耀。

- **诚实对比：** **Cursor**（及类似工具）提供一个**大型常驻界面**：Chromium/Electron 风格的 shell、编辑器、扩展、LSP、索引，通常还有多个 web 上下文。Eliza 的桌面 UI **更窄且面向任务**：伴侣、聊天、设置和桥接——基于 **Electrobun / WKWebView** 加上可选的 **3D**。**总焦耳/秒取决于工作负载**；公平对比需要相同的场景和工具（Activity Monitor、`powermetrics`、Instruments）。我们的标准是作为**本地 AI 伴侣**实现**卓越的每瓦体验**，而非声称在与完整 IDE 的每次对比中都胜出。
- **优化重点：** **浪费的计算**——为**隐藏的**文档、**离屏的**画布和**冗余的 HTTP 轮询**消耗的 GPU 和定时器。**电池感知的质量调节**：未插电时限制 DPR、收紧 Spark splats、禁用方向阴影、减少后台 API 调用频率。用户**正在查看应用**且连接电源时默认**丰富渲染**。
- **已发布的调节手段（参见 changelog + 桌面文档）：** `VrmViewer` 可见性暂停；`desktop:getPowerState` → `VrmEngine.setLowPowerRenderMode`；可见性门控的定时器（dashboard、stream、game logs、fine-tuning、cloud credits）；矢量 3D 图形隐藏时暂停 `rAF`；开发钩子**默认关闭**以避免 DX 工具意外耗电（screenshot proxy、aggregated console）。
- **下一步 UX/DX 方向：** 用户可见的**效率** / **性能**配置（单一开关）、**`prefers-reduced-motion`**、头像的可选**空闲帧率限制**（当动作保真度不如电池续航重要时），以及更清晰的**应用内提示**（在电池节能模式激活时通知用户，使其信任这一权衡）。

<div id="done-this-cycle">

## 已完成（本周期）

</div>

- **Dashboard SSE: action callbacks replace in place** — 在 `generateChatResponse` 中，LLM `onStreamChunk` 仍然**追加** token 增量；来自 action 的 `HandlerCallback` 文本使用 **`replaceCallbackText`**：首次回调冻结 `preCallbackText`（流式模型输出），后续每次回调仅通过 `emitSnapshot` / `onSnapshot` 替换该基线之后的**后缀**。**原因：** 匹配 Discord/Telegram 的**渐进式消息**用户体验（编辑同一条消息），而不改变 elizaOS 回调契约或添加并行的 WebSocket 协议。**文档：** `docs/runtime/action-callback-streaming.md`，`docs/changelog.mdx`（2026-04-05）。**代码：** `packages/agent/src/api/chat-routes.ts`。
- **Plugin load provenance + stagehand discovery** — `collectPluginNames()` 记录每个插件进入加载集的首个**原因**（`plugins.allow`、env auto-enable、features 等）；`resolvePlugins()` 在可选插件安装失败时包含 **`(added by: …)`**，以便运维人员修复**配置/环境**而非追踪虚假的运行时 bug。**Stagehand：** `findPluginBrowserStagehandDir()` 从运行时文件向**上级**遍历以查找 `plugins/plugin-browser/stagehand-server` —— **原因**是固定的 `../` 深度在 `eliza/` 子模块布局下会失败。**文档：** `docs/plugin-resolution-and-node-path.md`（可选插件部分），`docs/guides/developer-diagnostics-and-workspace.md`。
- **Life-ops PGlite migrations** — 核心 **`CREATE INDEX`** 语句在所有权 **`ALTER TABLE`** / 列回填**之后**运行，以确保缺少 `domain` / `subject_*` 的旧数据库不会在升级时失败；**`runMigrationWithSavepoint`** 使用显式 **`BEGIN`/`COMMIT`**，使 **SAVEPOINT** 在 PGlite 下有效。**原因：** 实际数据库在 life-ops 模式演进期间遇到迁移错误。**测试：** `packages/agent/test/lifeops-pglite-schema.test.ts`。
- **Workspace dependency scripts** — `fix-workspace-deps.mjs`、`replace-workspace-versions.mjs`、`restore-workspace-refs.mjs`、`workspace-prepare.mjs` 和 `workspace-discovery.mjs` 减少了手动的工作区调整工作；根 `package.json` 公开了 `workspace:*` / `fix-deps` 别名。**原因：** 本地 `./eliza` 和 `plugins/*` 的检出经常在 `workspace:*` 和 semver 边界上产生偏移。**文档：** `docs/guides/developer-diagnostics-and-workspace.md`。
- **Terminal dev banners (TTY)** — 带框的设置表格 + 可选的 figlet 标题 + 在 stdout 为 TTY 时使用 ANSI（遵守 `NO_COLOR` / `FORCE_COLOR`）。**原因：** 四进程桌面开发需要**可快速扫描的**有效环境信息，面向人类/智能体——**不是**产品 UI。**文档：** `docs/apps/desktop-local-development.md`，`docs/guides/developer-diagnostics-and-workspace.md`。
- **Gitignore: `cache/audio/`, `scripts/bin/*`** — 将大型本地媒体缓存和可选的二进制文件（如 `yt-dlp`）排除在 git 之外；**`scripts/bin/.gitkeep`** 为 PATH 保留目录。**原因：** 克隆不应继承数百 MB 的产物。
- **Electrobun / Vite: single `three` for Spark + VRM** — `apps/app/vite.config.ts` 中的 **`sparkPatchPlugin`**（`resolveId` + splatDefines hoist）和 **`optimizeDeps.include`**（`three` + `three/examples/jsm/*`），使 `@sparkjsdev/spark` 和头像栈共享**同一个** `THREE.ShaderChunk`。**原因：** 嵌套的 `three`（例如在 Electrobun 下）导致 **`splatDefines`** 解析失败和"multiple Three.js instances"警告；仅使用 **`resolve.alias`** 会破坏 Rollup 生产构建。**文档：** `docs/apps/desktop-vrm-three-and-spark.md`，`docs/changelog.mdx`。
- **VRM resilience** — 惰性加载默认 VRM / DRACO 路径，**`eliza-1`** 作为缺失 **`default`** 资源的回退，Spark/world 失败时隔离以确保 **VRM** 仍能加载。**原因：** 捆绑模块初始化时序和可选的 splat 背景不应导致伴侣头像无法使用。**代码：** `VrmViewer.tsx`，`VrmEngine.ts`，`state/vrm.ts`。
- **Cloud login persist** — `cloud-routes.ts` 使用 **`cloudDisconnectEpoch`**（断开连接时递增，轮询前快照）替代 **`cloud.enabled === false`** 来跳过持久化。**原因：** 旧的守卫在 cloud 从未启用时阻止了**首次**登录。**文档：** `docs/apps/desktop-vrm-three-and-spark.md`（API 部分）。
- **OpenRouter plugin: pin broken npm `alpha.12`** — 根 `package.json` 将 **`@elizaos/plugin-openrouter`** 固定到一个确认可用的版本（当前为 **`2.0.0-alpha.13`**）。**原因：** **`2.0.0-alpha.12`** 发布了**截断的** `dist/node` 和 `dist/browser` ESM 文件：仅打包了 `utils/config`，但导出仍引用 **`openrouterPlugin`** / default——Bun 在加载时失败（*symbol not declared*）。**为何不在 postinstall 中修补 dist：** 插件实现块缺失，不是单行导出的拼写错误；在上游重新发布之前，固定版本是正确的缓解措施。**文档：** `docs/plugin-resolution-and-node-path.md`（*Pinned: @elizaos/plugin-openrouter* 部分），`docs/plugin-registry/llm/openrouter.md`，`docs/changelog.mdx`，`README.md`。**代码注释：** `scripts/patch-deps.mjs`（其他上游变通方案旁的注释块）。
- **Port collisions (dev + embedded desktop)** — **`dev:desktop` / `dev:desktop:watch`** 在启动 API、Vite 和 Electrobun 之前预分配空闲的回环端口用于 **`ELIZA_API_PORT`** 和 **`ELIZA_PORT`**（Vite），以保持 env、proxy 和 renderer URL 一致。**嵌入式 agent：** Electrobun 从首选的 **`ELIZA_PORT`** 开始寻找下一个空闲端口，而非默认的 **`lsof` + SIGKILL**；可选的 **`ELIZA_AGENT_RECLAIM_STALE_PORT=1`** 恢复端口回收。**运行时：** `eliza.ts` / `dev-server.ts` 在安全时将 **`process.env`** 同步到 API 的实际绑定端口。**UI：** 在 agent 状态上为主窗口及所有表面窗口执行 **`injectApiBase`**。**原因：** 两个 Eliza 栈或遗留进程不应需要手动端口查找或杀死无关进程；动态绑定必须传播到 renderer 和开发工具。**文档：** `docs/apps/desktop-local-development.md`，`docs/apps/desktop.md`（端口部分）。**代码：** `scripts/lib/allocate-loopback-port.mjs`，`apps/app/electrobun/src/native/loopback-port.ts`，`agent.ts`，`index.ts`，`surface-windows.ts`，`vite.config.ts`，`dev-server.ts`，`eliza.ts`。
- **Desktop dev observability (IDEs / agents)** — **`GET /api/dev/stack`**、**`desktop:stack-status`**、默认开启的 **screenshot proxy**（`/api/dev/cursor-screenshot`，回环 + token）、默认开启的**聚合控制台**（`.eliza/desktop-dev-console.log` + `/api/dev/console-log` 尾部读取，含基名白名单）。**原因：** 多进程开发对于无法看到原生窗口的工具是不透明的；显式的 HTTP + 文件钩子避免了端口猜测，并保持回环/token 有界。已记录可选退出的环境变量。**文档：** `docs/apps/desktop-local-development.md`（*IDE and agent observability* 部分）。**规则：** `.cursor/rules/eliza-desktop-dev-observability.mdc`。
- **Electrobun Darwin → macOS mapping (WebGPU)** — **`getMacOSMajorVersion()`** 对 **20–24**（macOS 11–15）使用 **`Darwin − 9`**，对 **≥ 25**（macOS 26+ Tahoe）使用 **`Darwin + 1`**。**原因：** `os.release()` 返回 Darwin 版本；Tahoe 是 **Darwin 25** 上的 **macOS 26**——旧的单一公式报告 **16** 并破坏了 WKWebView WebGPU 消息传递和门控。**文档：** `docs/apps/electrobun-darwin-macos-webgpu-version.md`。**测试：** `webgpu-browser-support.test.ts`。
- **Desktop menu reset (main process)** — 确认 + API 重置 + 重启 + 状态轮询在 Electrobun **主进程**中运行；renderer 通过 **`menu-reset-eliza-applied`** 和共享的 **`completeResetLocalStateAfterServerWipe`** 进行同步。**原因：** WKWebView 在原生对话框之后延迟了 renderer 网络请求；用户在确认后看到"没有任何反应"。可达性基线探测仅使用 **`res.ok`**。**文档：** `docs/apps/desktop-main-process-reset.md`。**测试：** `menu-reset-from-main.test.ts`，`reset-main-process.test.ts`。
- **Edge TTS disclosure** — 记录并暴露 **`ELIZA_DISABLE_EDGE_TTS`**（注册表 + `docs/cli/environment.md` + TTS 文档）。**原因：** orchestrator 自动加载 Edge TTS → `node-edge-tts` → Microsoft；"无需 API 密钥"不等于"离线"。
- **Vitest app-core coverage** — 根配置使用 glob 匹配 **`packages/app-core/test/**/*.test.ts(x)`** 和 **`src/**/*.test.tsx`**；将 `test/` 下的 app-core e2e 从默认单元测试任务中排除。**原因：** `test/state` 和 `test/runtime` 下的新测试被跳过了；单个硬编码的 TSX 路径不够健壮。
- **Node.js CI timeouts** — 全部使用 `actions/setup-node@v4` 且 `check-latest: false`；为 test、release、nightly、benchmark-tests、publish-npm 添加 Bun 全局缓存和 `timeout-minutes`。**原因：** 避免 nodejs.org 下载并限定作业持续时间。参见 `docs/build-and-release.md` "Node.js and Bun in CI: WHYs"。
- **Release workflow hardening** — 严格 shell（`bash -euo pipefail`）实现快速失败；`bun install` 的重试循环最终执行一次以确保所有重试失败时步骤也失败；崩溃转储使用维护中的 ASAR CLI；`find -print0` / `while IFS= read -r -d ''` 确保路径安全；通过 find+stat 获取 DMG 路径；打包前移除 node-gyp 产物；大小报告包含 eliza-dist；单一 Capacitor 构建步骤；打包后的 DMG E2E 在 CI 中使用 240s CDP 超时并在超时时转储 stdout/stderr。**原因：** 可复现的构建、清晰的失败信息和可调试的 CI；参见 `docs/build-and-release.md` "Release workflow: design and WHYs"。
- **Plugin resolution (NODE_PATH)** — 在三个位置设置 `NODE_PATH`，以便动态 `import("@elizaos/plugin-*")` 能够从 CLI（`run-node.mjs` 子进程）、直接 eliza 加载（`eliza.ts` 加载时）和 Electrobun（dev：向上遍历查找 `node_modules`；打包后：ASAR `node_modules`）中解析。**原因：** 当入口在 `dist/` 下或 cwd 是子目录时，Node 不会搜索仓库根目录；没有这个设置，"Cannot find module" 会导致 coding-agent 等功能中断。参见 `docs/plugin-resolution-and-node-path.md`。
- **Electrobun startup resilience** — 运行时加载失败时保持 API 服务器运行，以便 UI 可以显示错误而非"Failed to fetch"。**原因：** 单个缺失的原生模块（例如 Intel Mac 上的 onnxruntime）曾导致整个窗口无响应且没有任何解释。
- **Intel Mac x64 DMG** — 发布工作流在 `arch -x86_64` 下为 macos-x64 产物运行安装和桌面构建，以确保原生 `.node` 二进制文件是 x64 的。**原因：** CI 在 arm64 上运行；不使用 Rosetta 时我们会发布 arm64 二进制文件，导致 Intel 用户遇到"Cannot find module .../darwin/x64/..."。
- **Auto-derived plugin deps** — `copy-electrobun-plugins-and-deps.mjs` 遍历每个 @elizaos 包的 `package.json` 依赖，而非使用策展列表。**原因：** 策展列表会遗漏新的插件依赖，导致打包应用中的静默失败；自动遍历在插件变更时保持正确。
- **Regression tests for startup** — E2E 测试验证 keep-server-alive 和 eliza.js 加载失败行为。**原因：** 失败的测试比单纯的文档更能防止异常处理守卫被移除。
- **Plugin resolution fix** — 在 `eliza.ts`、`run-node.mjs` 和 `agent.ts`（Electrobun dev）中将 `NODE_PATH` 设置为仓库根目录的 `node_modules`。**原因：** 从捆绑的 `eliza.js` 进行的动态 `import("@elizaos/plugin-*")` 无法解析根目录的包；`NODE_PATH` 告诉 Node 去哪里查找。在打包应用中为空操作（existsSync 守卫）。参见 `docs/plugin-resolution-and-node-path.md`。
- **Bun exports patch** — `patch-deps.mjs` 中的 postinstall 重写受影响的 `@elizaos` 插件（及任何类似的包），使 `exports["."]` 不再有 `"bun": "./src/index.ts"`（当该文件不存在时）。**原因：** 已发布的 tarball 仅包含 `dist/`；Bun 优先选择 `"bun"` 条件然后失败。移除无效条件后 Bun 使用 `"import"` → `./dist/index.js`。参见 `docs/plugin-resolution-and-node-path.md` 中的"Bun and published package exports"。
- **Release size-report: SIGPIPE 141** — "Report packaged app size"步骤中的 `du | sort | head` 管道在子 shell 中运行，使用 `|| r=$?` 并允许退出码 141；`sort` stderr 已静默。**原因：** 在 `-euo pipefail` 下，141 会在我们允许之前退出步骤；子 shell 捕获了它。参见 `docs/build-and-release.md`。
- **NFA routes: optional plugin** — `/api/nfa/status` 和 `/api/nfa/learnings` 惰性加载 `@elizaos/plugin-bnb-identity` 并在缺失时回退。**原因：** 核心和测试在没有该插件的情况下工作；环境类型声明保持类型检查通过。

<div id="short-term--follow-ups">

## 短期 / 后续

</div>

- **Action callbacks：** 如果某个插件确实需要在一个 action 轮次中产生**多个独立的**助手段落（而非渐进式替换），我们可以添加一个可选的回调标志或单独的 API——目前不需要。**推迟原因：** 默认行为匹配 Discord/Telegram；在具体的插件提出需求之前属于 YAGNI。
- **OpenRouter: unpin when upstream fixes** — 当 `@elizaos/plugin-openrouter` 在 **`alpha.12`** 之后发布经验证的完整 `dist/node/index.node.js`（和 browser）包时，放宽精确固定。当前固定为 **`alpha.13`**。**原因：** 永远保持硬固定会错过真正的修复；我们只在 npm 有良好产物之前避开损坏的 tarball。
- **Upstream plugin hygiene** — 某些插件（如 `@elizaos/plugin-discord`）将 `typescript` 列在 `dependencies` 而非 `devDependencies` 中；我们通过 `DEP_SKIP` 跳过它以避免打包膨胀。**原因：** 修复上游将减少我们的跳过列表并保持插件 package.json 的正确性。
- **Optional: filter bundled deps** — 我们有意复制所有传递依赖（包括 tsdown 可能已内联的），因为插件可能在运行时进行 dynamic-require。**原因：** 排除"可能已打包"的依赖会有在打包应用中出现"Cannot find module"的风险。如果我们将来能对插件 dist/ 进行静态分析以了解哪些在运行时永远不会被 require，就可以缩小复制范围；目前不是优先事项。

<div id="longer-term">

## 长期

</div>

- **桌面端：** 通过 `lipo` 或桌面打包目标可以实现 Universal/fat macOS 二进制文件（单个 .app 包含 arm64+x64），但会增加构建时间和复杂性；目前单独的 DMG 是可接受的。
- **CI：** 考虑按架构缓存桌面原生重建以加速发布矩阵。
