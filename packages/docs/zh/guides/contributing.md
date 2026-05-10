---
title: 贡献指南
description: 如何设置开发环境、遵循代码规范以及向 Eliza 项目提交 pull request。
---

<div id="contributing-guide">
# 贡献指南
</div>

欢迎来到 Eliza！本指南将帮助你设置开发环境并有效地贡献代码。

<div id="table-of-contents">
## 目录
</div>

1. [入门](#getting-started)
2. [开发环境](#development-environment)
3. [项目结构](#project-structure)
4. [构建和测试](#building-and-testing)
5. [代码风格](#code-style)
6. [Pull request 流程](#pull-request-process)
7. [社区](#community)

---

<div id="getting-started">
## 入门
</div>

<div id="prerequisites">
### 前提条件
</div>

- **Node.js 22 LTS** — 必需的运行时（`.nvmrc` 已固定）
- **Bun** — 仓库脚本使用的包管理器/运行时
- **Git** — 版本控制

<div id="quick-setup">
### 快速设置
</div>

```bash
# Clone the repository
git clone https://github.com/eliza-ai/eliza.git
cd eliza

# Match repository Node version
nvm use || nvm install
node -v  # expected: v22.22.0

# Install dependencies
bun install

# Build the project
bun run build

# Run in development mode
bun run dev
```

---

<div id="development-environment">
## 开发环境
</div>

<div id="required-tools">
### 必需工具
</div>

| 工具 | 版本 | 用途 |
|------|------|------|
| Node.js | 22.x LTS | 运行时 |
| Bun | 最新 | 包管理 + 脚本执行器 |
| Git | 最新 | 版本控制 |

<div id="optional-tools">
### 可选工具
</div>

| 工具 | 用途 |
|------|------|
| bun | 仓库外工作流的可选包管理器 |
| Docker | 容器化测试 |
| VS Code | 推荐的编辑器 |

<div id="editor-setup">
### 编辑器设置
</div>

**VS Code 扩展：**
- ESLint
- Prettier
- TypeScript
- Biome（用于格式化）

**设置（.vscode/settings.json）：**
```json
{
  "editor.formatOnSave": true,
  "editor.defaultFormatter": "biomejs.biome",
  "typescript.preferences.importModuleSpecifier": "relative"
}
```

---

<div id="monorepo-structure">
## Monorepo 结构
</div>

Eliza 是一个使用 Turborepo 和 Bun 工作空间管理的 monorepo。

```
eliza/
├── packages/                # Shared packages
│   ├── typescript/          # @elizaos/core — Core TypeScript SDK
│   ├── elizaos/             # CLI tool (eliza command)
│   ├── skills/              # Skills system and bundled skills
│   ├── docs/                # Documentation site (Mintlify)
│   ├── schemas/             # Protobuf schemas
│   └── tui/                 # Terminal UI (disabled)
├── plugins/                 # Official plugins (100+)
│   ├── plugin-anthropic/    # Anthropic model provider
│   ├── plugin-telegram/     # Telegram connector
│   ├── plugin-discord/      # Discord connector
│   └── ...
├── apps/
│   ├── app/                 # Desktop/mobile app (Capacitor + React)
│   └── ...                  # No shipped chrome-extension app in this release checkout
├── src/                     # Eliza runtime
│   ├── runtime/             # elizaOS runtime bootstrap
│   ├── plugins/             # Built-in Eliza plugins
│   ├── config/              # Configuration loading
│   ├── services/            # Registry client, plugin manager
│   └── api/                 # REST API server
├── skills/                  # Workspace skills
├── docs/                    # Documentation (this site)
├── scripts/                 # Build and utility scripts
├── test/                    # Test setup, helpers, e2e
├── AGENTS.md                # Repository guidelines
├── plugins.json             # Plugin registry manifest
└── tsdown.config.ts         # Build config
```

<div id="turbo-build-system">
### Turbo 构建系统
</div>

Turborepo 通过依赖感知缓存编排所有包的构建：

```bash
# Build everything (with caching)
turbo run build

# Build a specific package
turbo run build --filter=@elizaos/core

# Build a package and all its dependencies
turbo run build --filter=@elizaos/plugin-telegram...

# Run tests across all packages
turbo run test

# Lint all packages
turbo run lint
```

<div id="key-entry-points">
### 关键入口点
</div>

| 文件 | 用途 |
|------|------|
| `src/entry.ts` | CLI 入口点 |
| `src/index.ts` | 库导出 |
| `src/runtime/eliza.ts` | elizaOS 运行时初始化 |
| `src/runtime/eliza-plugin.ts` | Eliza 主插件 |
| `eliza.mjs` | npm bin 入口 |

---

<div id="building-and-testing">
## 构建和测试
</div>

<div id="build-commands">
### 构建命令
</div>

```bash
# Full build (TypeScript + UI)
bun run build

# TypeScript only
bun run build

# Desktop app (Electrobun)
bun run build:desktop

# Mobile (Android)
bun run build:android

# Mobile (iOS)
bun run build:ios
```

<div id="development-mode">
### 开发模式
</div>

```bash
# Run with auto-reload on changes
bun run dev

# Run CLI directly (via tsx)
bun run eliza start

# UI development only
bun run dev:ui

# Desktop app development
bun run dev:desktop
```

<div id="testing">
### 测试
</div>

覆盖率阈值由 `scripts/coverage-policy.mjs` 强制执行：行/函数/语句 25%，分支 15%。当覆盖率低于这些下限时，CI 会失败。

```bash
# Run all tests (parallel)
bun run test

# Run with coverage (enforces thresholds)
bun run test:coverage

# Watch mode
bun run test:watch

# End-to-end tests
bun run test:e2e

# Live tests (requires API keys)
ELIZA_LIVE_TEST=1 bun run test:live

# Docker-based tests
bun run test:docker:all
```

<div id="runtime-fallback-for-bun-crashes">
### Bun 崩溃的运行时回退
</div>

如果 Bun 在你的平台上长时间运行时出现段错误，请在 Node 运行时上运行 Eliza：

```bash
ELIZA_RUNTIME=node bun run eliza start
```

<div id="test-file-conventions">
### 测试文件约定
</div>

| 模式 | 用途 |
|------|------|
| `*.test.ts` | 单元测试（与源码并置） |
| `*.e2e.test.ts` | 端到端测试 |
| `*.live.test.ts` | 实时 API 测试 |
| `test/**/*.test.ts` | 集成测试 |

<div id="packagesapp-core-in-the-root-vitest-config">
### 根 Vitest 配置中的 `packages/app-core`
</div>

仓库根目录的 **`vitest.config.ts`**（由 **`bun run test`** → 单元分片使用）包含：

- **`packages/app-core/src/**/*.test.ts`** 和 **`packages/app-core/src/**/*.test.tsx`** — 并置测试，包括 TSX，无需逐个列出。
- **`packages/app-core/test/**/*.test.ts`** 和 **`.../test/**/*.test.tsx`** — 共享测试工具测试（例如 `test/state`、`test/runtime`）。

**原因：** 这些目录之前被遗漏，因此新的测试套件从未在 CI 中运行。**`packages/app-core/test/**/*.e2e.test.ts(x)`** 从此任务中排除，以便 e2e 保持在 **`test/vitest/e2e.config.ts`** 上。**`test/vitest/unit.config.ts`** 仍然从以覆盖率为重点的单元测试中省略 **`packages/app-core/test/app/**`**（重量级渲染器工具） — **原因：** 这些在特定的 app 工作空间或单独的任务中运行。

---

<div id="code-style">
## 代码风格
</div>

<div id="typescript-guidelines">
### TypeScript 指南
</div>

- **严格模式** — 始终使用严格 TypeScript
- **避免 `any`** — 使用正确的类型或 `unknown`
- **ESM** — 使用 ES 模块（`import`/`export`）
- **Async/await** — 优先于原始 promise

<div id="naming-conventions">
### 命名约定
</div>

| 项目 | 约定 | 示例 |
|------|------|------|
| 文件 | kebab-case | `my-feature.ts` |
| 类 | PascalCase | `MyService` |
| 函数 | camelCase | `processMessage` |
| 常量 | UPPER_SNAKE | `MAX_RETRIES` |
| 动作 | UPPER_SNAKE | `RESTART_AGENT` |
| 类型/接口 | PascalCase | `PluginConfig` |

<div id="product-vs-code-naming">
### 产品名称 vs 代码名称
</div>

- **Eliza** — 产品名称、标题、文档
- **eliza** — CLI 命令、包名、路径、配置键

<div id="formatting">
### 格式化
</div>

项目使用 **Biome** 进行格式化和代码检查：

```bash
# Check formatting and lint
bun run check

# Fix formatting issues
bun run format:fix

# Fix lint issues
bun run lint:fix
```

<div id="file-size">
### 文件大小
</div>

尽量将文件保持在 **~500 行**以下。在以下情况改善时进行拆分：
- 清晰度
- 可测试性
- 可复用性

<div id="comments">
### 注释
</div>

```typescript
// ✅ Explain WHY, not WHAT
// Rate limit to avoid API throttling during batch operations
const BATCH_DELAY_MS = 100;

// ❌ Don't explain obvious code
// Increment counter by 1
counter++;
```

<div id="error-handling">
### 错误处理
</div>

```typescript
// ✅ Specific error types with context
throw new Error(`Failed to load plugin "${name}": ${err.message}`);

// ✅ Graceful degradation
try {
  await riskyOperation();
} catch (err) {
  runtime.logger?.warn({ err, context }, "Operation failed, using fallback");
  return fallbackValue;
}

// ❌ Silent swallowing
try {
  await something();
} catch {}
```

---

<div id="pull-request-process">
## Pull request 流程
</div>

<div id="branch-strategy">
### 分支策略
</div>

| 分支 | 用途 | 发布到 |
|------|------|--------|
| `develop` | 活跃开发，PR 合并到此 | Alpha 发布 |
| `main` | 稳定发布 | Beta 发布 |
| GitHub Releases | 标记版本 | 生产（npm、PyPI、Snap、APT、Homebrew） |
| `feature/*` | 新功能 | — |
| `fix/*` | Bug 修复 | — |

<div id="creating-a-pr">
### 创建 PR
</div>

1. **Fork 并 clone**（或从 develop 分支）
   ```bash
   git checkout develop
   git pull origin develop
   git checkout -b feature/my-feature
   ```

2. **进行更改**并提交有意义的 commit
   ```bash
   git add .
   git commit -m "feat: add new action for X"
   ```

3. **推送前运行检查**
   ```bash
   bun run check
   bun run test
   ```

4. **推送并创建 PR**
   ```bash
   git push origin feature/my-feature
   # Then open PR on GitHub
   ```

<div id="commit-message-format">
### Commit 消息格式
</div>

使用约定式提交：

```
<type>: <description>

[optional body]

[optional footer]
```

**类型：**
- `feat:` — 新功能
- `fix:` — Bug 修复
- `docs:` — 文档
- `refactor:` — 代码重构
- `test:` — 测试添加/更改
- `chore:` — 构建、依赖、配置

**示例：**
```
feat: add voice message support to telegram connector

fix: prevent crash when config file is missing

docs: add plugin development guide

refactor: extract session key logic to provider

chore: update @elizaos/core to 2.0.0-alpha.4
```

<div id="pr-checklist">
### PR 清单
</div>

提交前：

- [ ] 代码编译无错误（`bun run build`）
- [ ] 测试通过（`bun run test`）
- [ ] 代码检查通过（`bun run check`）
- [ ] 新代码有测试（如适用）
- [ ] 文档已更新（如适用）
- [ ] Commit 消息遵循约定
- [ ] PR 描述说明了变更

<div id="code-review">
### 代码审查
</div>

PR 由维护者审查。期待以下方面的反馈：

- **正确性** — 它能工作吗？
- **设计** — 方法是否合理？
- **风格** — 是否遵循约定？
- **测试** — 是否充分测试？
- **文档** — 是否有文档？

Claude Code Review 已启用用于自动化初始反馈。

---

<div id="community">
## 社区
</div>

<div id="discord">
### Discord
</div>

加入社区 Discord 获取帮助、讨论和公告：

**[discord.gg/ai16z](https://discord.gg/ai16z)**

频道：
- `#eliza` — Eliza 专属讨论
- `#dev` — 开发帮助
- `#showcase` — 分享你构建的项目

<div id="github">
### GitHub
</div>

- **Issues** — Bug 报告、功能请求
- **Discussions** — 问题、想法、RFC
- **PRs** — 代码贡献

<div id="reporting-issues">
### 报告问题
</div>

提交 issue 时：

1. **检查现有 issues** — 避免重复
2. **使用模板** — 填写提供的模板
3. **包含复现步骤** — 复现步骤
4. **分享日志** — 相关错误输出
5. **环境** — 操作系统、Node 版本、Eliza 版本

```markdown
## Bug Report

**Describe the bug:**
Brief description

**To reproduce:**
1. Run `eliza start`
2. Send message "..."
3. Error occurs

**Expected behavior:**
What should happen

**Environment:**
- OS: macOS 14.2
- Node: 22.12.0
- Eliza: 2.0.0-alpha.8

**Logs:**
```
[error output here]
```
```

---

<div id="getting-help">
## 获取帮助
</div>

- **Discord** — 问题的最快响应
- **GitHub Issues** — Bug 报告和功能请求
- **文档** — 先查阅 `/docs`
- **AGENTS.md** — 仓库特定指南

---

<div id="next-steps">
## 后续步骤
</div>

- [插件开发指南](/zh/plugins/development) — 构建插件
- [Skills 文档](/zh/plugins/skills) — 创建 skills
- [本地插件开发](/zh/plugins/local-plugins) — 本地开发
- 浏览代码库：从 `src/runtime/eliza-plugin.ts` 开始
