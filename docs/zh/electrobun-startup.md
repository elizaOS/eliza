<div id="electrobun-desktop-app-startup-and-exception-handling">
# Electrobun 桌面应用：启动和异常处理
</div>

本文档说明了嵌入式代理如何在打包的桌面应用中启动，以及**为什么** `eliza/packages/app-core/platforms/electrobun/src/native/agent.ts` 中的异常处理保护不能被移除。

<div id="startup-sequence">
## 启动序列
</div>

1. **Electrobun 主进程**启动，创建窗口，并解析渲染器 URL（通过 `ELIZA_RENDERER_URL` 使用 Vite 开发服务器，或使用打包的 `apps/app/dist` 的内置静态资产服务器）。
2. **`AgentManager.start()`**（在 `native/agent.ts` 中）生成一个 **Bun 子进程**：`bun run <eliza-dist>/entry.js start`（或你的 bundle 布局的等效路径）。子进程**不是** `server.js` / `eliza.js` 的进程内动态导入。
3. **子进程**启动 Eliza CLI 入口点，启动 API 服务器，并在该进程中以 headless 模式运行 elizaOS 运行时。
4. **主进程**对 `http://127.0.0.1:{port}/api/health` 进行健康轮询，直到子进程报告就绪（或超时/出错）。
5. **主进程**将 `apiBaseUpdate`（及相关 RPC）推送到渲染器，使 `window.__ELIZA_API_BASE__` 与活跃的 API 匹配。

如果子进程启动失败或始终未变为健康状态：

- **Electrobun 窗口保持打开**，这样用户不会面对空白的 shell。
- **状态**被设置为 `state: "error"` 并附带错误消息，这样 UI 可以显示 **Agent unavailable: …** 而不是通用的 **Failed to fetch**。

关于**开发编排**（Vite + API + Electrobun 在独立进程中），请参阅[桌面本地开发](./apps/desktop-local-development.md)。

<div id="why-the-guards-exist">
## 为什么存在这些保护
</div>

**目标：** 当运行时加载失败（例如缺少原生二进制文件）时，用户应该在 UI 中看到清晰的错误，而不是一个死窗口。这需要 (1) 主进程和渲染器保持活跃，(2) 状态/RPC 更新使 UI 能够显示 **Agent unavailable: …**。

没有显式处理：

1. 如果**子进程崩溃**或健康检查始终不成功，主进程必须将其作为 **error** 状态暴露给渲染器。
2. 如果**外部 `start()`** 销毁了窗口或假设 API 在进程内运行，渲染器可能丢失 **API base** 并显示 **Failed to fetch** 而没有解释。

因此我们保持：

- **子进程隔离** — API + 运行时故障被限制在子进程中；主进程观察退出码/健康状态。
- **try/catch 和 `.catch()` 在仍适用的地方** — 任何可能拒绝的剩余异步路径应设置 **error** 状态，而不是让 UI 保持未初始化。
- **当目标是显示应用内错误时不应终止 shell 的外部路径** — 与 `native/agent.ts` 注释和本文档保持一致。

<div id="do-not-remove-as-excess">
## 不要作为"多余"移除
</div>

代码审查或自动化的"deslop"清理有时会将 try/catch 或 `.catch()` 作为"冗余"或"过度的异常处理"移除。在此模块中，这些保护是**有意为之的**：它们在运行时加载失败时保持应用窗口可用。移除它们会恢复损坏的行为（死窗口、**Failed to fetch**、无错误消息）。

该文件和 `agent.ts` 中的关键位置包含引用本文档的 **WHY** 注释。编辑该文件时，请保留保护和理由。

<div id="logs">
## 日志
</div>

打包应用将启动日志写入：

- **macOS：** `~/Library/Application Support/Eliza/eliza-startup.log`
- **Windows：** `%APPDATA%\Eliza\eliza-startup.log`
- **Linux：** `~/.config/Eliza/eliza-startup.log`

使用它来调试加载失败（缺失模块、原生二进制路径等）。

<div id="see-also">
## 另请参阅
</div>

- [插件解析和 NODE_PATH](./plugin-resolution-and-node-path.md) — 为什么动态插件导入需要 `NODE_PATH` 以及在哪里设置它。
- [构建和发布](./build-and-release.md) — CI 流水线、Rosetta 构建、插件/依赖复制。
