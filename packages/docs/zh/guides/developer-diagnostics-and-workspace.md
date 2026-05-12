---
title: 开发者诊断和 workspace 工具
---

# 开发者诊断和 workspace 工具（为什么）

本指南面向**从源码构建 Eliza 的人员**——编辑器、代理和维护者。它解释了近期面向开发者的行为**为什么**存在，以便你能更快地调试，而不会将可选的噪声误认为产品 bug。

<div id="plugin-load-reasons-optional-plugins">
## 插件加载原因（可选插件）
</div>

**问题：** 类似 `Cannot find module '@elizaos/plugin-solana'` 或 "browser server not found" 的日志看起来像是运行时出了问题，但实际上往往是**配置或环境变量**将某个插件拉入了加载集，而该包或原生二进制文件从未安装过。

**为什么要追踪来源：** `collectPluginNames()` 可以记录添加每个包的**第一个**来源（例如 `plugins.allow["@elizaos/plugin-solana"]`、`env: SOLANA_PRIVATE_KEY`、`features.browser`、`CORE_PLUGINS`）。`resolvePlugins()` 在解析过程中传递该映射；当**可选**插件因良性原因失败（缺少 npm 模块、缺少 stagehand）时，摘要日志会包含 **`(added by: …)`**，这样你就知道应该编辑 `eliza.json`、取消环境变量、安装包还是添加插件 checkout。

**范围：** 这是**诊断**，不是隐藏错误。严重的解析错误仍然会正常显示。

**相关代码：** `eliza/packages/agent/src/runtime/plugin-collector.ts`、`eliza/packages/agent/src/runtime/plugin-resolver.ts`。另见[插件解析和 NODE_PATH](/zh/plugin-resolution-and-node-path#optional-plugins-why-was-this-package-in-the-load-set)。

<div id="browser--stagehand-server-path">
## Browser / stagehand 服务器路径
</div>

**问题：** `@elizaos/plugin-browser` 期望在 npm 包的 `dist/server/` 下有一个 **stagehand-server** 二进制树，但发布的 tarball 不包含它。Eliza 会链接或发现 `plugins/plugin-browser/stagehand-server/` 下的 checkout。

**为什么要向上遍历：** 运行时文件位于不同的深度（`eliza/packages/agent/...` vs 使用子模块时的 `eliza/packages/agent/...`）。固定的 `../` 深度无法到达 workspace 根目录。**`findPluginBrowserStagehandDir()`** 向上遍历父目录，直到找到包含 `dist/index.js` 或 `src/index.ts` 的 `plugins/plugin-browser/stagehand-server`。

**操作说明：** 如果你不使用浏览器自动化，stagehand 的缺失是**预期行为**；消息在调试级别有意保持简洁，以免干扰日常开发。

**相关：** `scripts/link-browser-server.mjs`、`eliza/packages/agent/src/runtime/eliza.ts`（`ensureBrowserServerLink`、`findPluginBrowserStagehandDir`）。

<div id="life-ops-schema-migrations-pglite">
## Life-ops 架构迁移（PGlite）
</div>

**问题：** 在 **PGlite** / Postgres 上，`SAVEPOINT` 只在事务内有效；临时的 `executeRawSql` 调用默认使用自动提交。使用 savepoint 但没有外部 `BEGIN`/`COMMIT` 的嵌套迁移会失败或行为不一致。

**为什么使用显式事务：** `runMigrationWithSavepoint()` 将每个命名迁移包装在 `BEGIN` → `SAVEPOINT` → … → `RELEASE`/`ROLLBACK TO` → `COMMIT`（或外部失败时的 `ROLLBACK`）中。这符合 Postgres 语义，同时保持 SQLite 行为的有效性。

**索引 vs `ALTER TABLE`：** `life_task_definitions` 及相关表上的索引引用了**所有权列**（`domain`、`subject_type` 等）。**为什么索引在 ALTER 之后运行：** 在这些列存在之前创建的旧数据库，如果索引和初始 `CREATE TABLE` 在同一批次中运行而列尚不存在，`CREATE INDEX` 就会失败。核心索引语句在所有权 `ALTER TABLE` / 回填步骤**之后**应用。

**测试：** `packages/agent/test/lifeops-pglite-schema.test.ts` 覆盖了旧版升级路径。

<div id="workspace-dependency-scripts">
## Workspace 依赖脚本
</div>

**问题：** 混合使用 **`workspace:*`**、已发布的 semver 范围和本地 `./eliza` / `plugins/*` checkout 的 monorepo 容易产生偏差。手动编辑 `package.json` 容易出错且难以审查。

**为什么需要这些脚本：**

| 脚本 / npm 命令 | 功能 |
|---------------|------|
| `workspace:deps:sync`（`fix-workspace-deps.mjs`） | 在上游或本地变更后，将 workspace 依赖边规范化为一致的形式。 |
| `workspace:deps:check` / `--check` | 不写入地验证——用于 CI 或 pre-commit。 |
| `workspace:deps:restore` | 在适当的地方恢复 `workspace:*` 引用。 |
| `workspace:replace-versions` / `workspace:restore-refs` | 与 eliza 上游工具模式对齐的定向版本字符串操作。 |
| `workspace:prepare` | 用于全新 checkout 或分支切换后的顺序准备步骤。 |

**发现机制：** `scripts/lib/workspace-discovery.mjs` 集中了我们查找 workspace 根目录和插件包的方式，使脚本不会重复脆弱的路径逻辑。

<div id="terminal-dev-banners-orchestrator-vite-api-electrobun">
## 终端开发横幅（编排器、Vite、API、Electrobun）
</div>

**内容：** 在 TTY 上，启动时可以显示每个子系统（编排器、Vite、API、Electrobun）的 **Unicode 边框设置表格** 加上**大号 figlet 风格标题**，在允许颜色时使用 **cyan/magenta ANSI**（遵守 `NO_COLOR` / `FORCE_COLOR`）。

**为什么这不是"产品 UI"：** 输出是**仅用于本地开发的 stdout**——与端口表和日志前缀属于同一类别。**目标：** 当四个进程启动时，让人类/代理更快地扫描**有效环境**（端口、功能标志、来源）。它不会改变仪表盘、聊天或 companion 的渲染。

**位置：** `packages/shared`（表格 + 颜色 + figlet 助手）、`scripts/dev-platform.mjs`、`apps/app/vite.config.ts`、`packages/app-core/src/runtime/dev-server.ts`、`apps/app/electrobun/src/` 下的 Electrobun 横幅助手。

**相关文档：** [桌面本地开发](/zh/apps/desktop-local-development#startup-tables-and-terminal-banners)。

<div id="gitignored-local-artifacts">
## Git 忽略的本地产物
</div>

**`cache/audio/`** — 本地 TTS 或媒体缓存可能会变得很大；它们**不是**源代码树的一部分。

**`scripts/bin/*`（`.gitkeep` 除外）** — 可选的工具存放位置（例如 `yt-dlp`），用于 Electrobun 开发脚本中的 `PATH`。**为什么不提交二进制文件：** 大小、平台差异以及许可证/更新生命周期属于开发者机器，而非 git。

---

参见[更新日志](/zh/changelog)了解发布日期，以及[路线图](/zh/ROADMAP)了解后续计划。
