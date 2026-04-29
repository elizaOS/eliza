---
title: "贡献指南"
sidebarTitle: "贡献"
description: "设置你的开发环境并为 Milady 做出贡献。"
---

欢迎来到 Milady 项目。本指南涵盖环境设置、开发工作流和 pull request 流程。

在贡献之前，请阅读仓库根目录的 [CONTRIBUTING.md](https://github.com/milady-ai/milady/blob/develop/CONTRIBUTING.md) 了解项目的贡献理念。Milady 是一个**仅限代理的代码库** -- 每个 PR 都由 AI 代理审查和合并，而非人类维护者。人类主要作为 QA 测试者和 bug 报告者参与贡献。

---

<div id="prerequisites">
## 前提条件
</div>

| 工具 | 版本 | 用途 |
|------|------|------|
| [Node.js](https://nodejs.org/) | >= 22 | 运行时（`engines` 字段要求） |
| [Bun](https://bun.sh/) | 最新 | 包管理器和脚本执行器 |
| [Git](https://git-scm.com/) | 最新 | 版本控制 |

Bun 是项目的包管理器。本指南中的所有命令都使用 `bun`。

---

<div id="setup">
## 设置
</div>

```bash
# Clone the repository
git clone https://github.com/milady-ai/milady.git
cd milady

# Install dependencies
bun install

# Build the project (TypeScript via tsdown + UI build)
bun run build
```

构建后，验证 CLI 是否正常工作：

```bash
bun run milady --help
```

配置存储在 `~/.milady/milady.json`，工作空间位于 `~/.milady/workspace/`。

---

<div id="development-workflow">
## 开发工作流
</div>

<div id="running-in-development">
### 开发运行
</div>

```bash
# Start dev server with auto-reload
bun run dev

# Run UI development only
bun run dev:ui

# Desktop app (Electrobun) development
bun run dev:desktop

# Run the CLI directly
bun run milady start
```

<div id="testing">
### 测试
</div>

项目使用 **Vitest 4.x** 和 V8 覆盖率。覆盖率阈值在 `scripts/coverage-policy.mjs` 中设置为行/函数/语句 **25%**，分支 **15%**。

```bash
# Run all tests (parallel runner)
bun run test

# Watch mode
bun run test:watch

# Run with coverage report
bun run test:coverage

# Run database safety/migration compatibility checks
bun run db:check

# End-to-end tests
bun run test:e2e

# Live API tests (requires API keys)
MILADY_LIVE_TEST=1 bun run test:live

# Docker-based integration tests
bun run test:docker:all
```

**测试文件约定：**

| 模式 | 位置 | 用途 |
|------|------|------|
| `*.test.ts` | 与源码并置 | 单元测试 |
| `*.e2e.test.ts` | `test/` 目录 | 端到端测试 |
| `*.live.test.ts` | `test/` 目录 | 实时 API 测试（需要真实密钥） |

<div id="linting-and-formatting">
### 代码检查和格式化
</div>

项目使用 **Biome 2.x** 同时进行代码检查和格式化。没有 ESLint 或 Prettier -- Biome 处理一切。

```bash
# Run typecheck + lint (the main pre-push check)
bun run check

# Auto-fix formatting issues
bun run format:fix

# Auto-fix lint issues
bun run lint:fix
```

`biome.json` 中配置的关键 Biome 规则：

- `noExplicitAny`：**error** -- 避免 `any` 类型
- `noNonNullAssertion`：warn
- `noImplicitAnyLet`：warn
- 格式化器：2 空格缩进，空格（非制表符）
- 导入组织已启用

<div id="build-commands">
### 构建命令
</div>

```bash
# Full build (TypeScript + UI)
bun run build

# Build using Node.js (instead of Bun runtime)
bun run build

# Desktop app (Electrobun)
bun run build:desktop

# Mobile builds
bun run build:android
bun run build:ios
```

---

<div id="pull-request-process">
## Pull request 流程
</div>

<div id="branch-strategy">
### 分支策略
</div>

| 分支 | 用途 |
|------|------|
| `main` | 稳定发布（发布到 npm） |
| `develop` | 集成分支（默认 PR 目标） |
| `feature/*` | 新功能 |
| `fix/*` | Bug 修复 |

始终从 `develop` 创建分支，PR 也指向 `develop`。

<div id="step-by-step">
### 分步指南
</div>

1. **从 develop 创建分支**
   ```bash
   git checkout develop
   git pull origin develop
   git checkout -b feature/my-feature
   ```

2. **进行更改**，提交简洁、面向行动的 commit
   ```bash
   git commit -m "milady: add verbose flag to send action"
   ```

3. **推送前运行检查**
   ```bash
   bun run check
   bun run test
   bun run build
   ```

4. **推送并打开 PR**
   ```bash
   git push origin feature/my-feature
   ```
   在 GitHub 上对 `develop` 打开 PR。

<div id="commit-conventions">
### Commit 约定
</div>

项目使用简洁、面向行动的 commit 消息。约定式 commit 前缀很常见：

```
feat: add voice message support to telegram connector
fix: prevent crash when config file is missing
test: add regression test for session timeout
refactor: extract session key logic to provider
chore: update @elizaos/core to latest
```

其他接受的风格遵循仓库历史中看到的 `milady: description` 模式（例如 `milady: fix telegram reconnect on rate limit`）。

<div id="the-agent-review-bot">
### 代理审查机器人
</div>

每个 PR 都会触发 **Agent Review** GitHub Actions 工作流。工作方式如下：

1. **分类** -- 工作流根据标题和正文自动将你的 PR 分类为 `bugfix`、`feature` 或 `aesthetic`。

2. **Claude 代码审查** -- 一个 AI 代理（Claude Opus）执行完整的代码审查。它评估：
   - **范围** -- 更改是否在项目范围内？
   - **代码质量** -- TypeScript 严格模式、Biome 合规性、文件大小
   - **安全性** -- 提示注入、凭据暴露、供应链风险
   - **测试** -- Bug 修复必须包含回归测试；功能必须包含单元测试

3. **决定** -- 代理发出三种裁决之一：
   - **APPROVE** -- PR 通过审查并自动合并（squash merge）到 `develop`
   - **REQUEST CHANGES** -- 发现问题；修复后重新推送以重新触发审查
   - **CLOSE** -- PR 超出范围，将被自动关闭

4. **信任评分** -- 贡献者随时间建立信任评分。较高的信任意味着加速审查；新贡献者接受更深入的审查。

**没有人工升级路径**。代理的决定是最终的。如果你不同意，请改进 PR 并重新提交。

**立即被拒绝的内容：**
- 美学/UI 重新设计、主题更改、图标替换、字体更改
- 不改善代理能力的"美化"PR
- 可测试更改的未测试代码
- 伪装成改进的范围扩展

<div id="pr-checklist">
### PR 清单
</div>

提交前，请验证：

- [ ] `bun run build` 无错误完成
- [ ] `bun run test` 通过
- [ ] `bun run check` 通过（类型检查 + lint）
- [ ] Bug 修复包含回归测试
- [ ] 新功能包含单元测试
- [ ] 代码中没有密钥、真实凭据或线上配置值
- [ ] Commit 消息简洁且有描述性
- [ ] PR 描述总结了更改并说明了执行的测试

---

<div id="code-style">
## 代码风格
</div>

<div id="typescript">
### TypeScript
</div>

- **严格模式** -- 始终使用严格 TypeScript
- **禁止 `any`** -- Biome 将 `noExplicitAny` 强制为错误。使用正确的类型或 `unknown`。
- **ESM** -- 使用 ES 模块语法（`import`/`export`）
- **Async/await** -- 优先于原始 promise 链

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

- **Milady** -- 产品名称、标题、文档正文
- **milady** -- CLI 二进制名称、包路径、配置键

<div id="file-size">
### 文件大小
</div>

将文件保持在 **~500 行**以下。在改善清晰度、可测试性或可复用性时进行拆分。

<div id="comments">
### 注释
</div>

```typescript
// Explain WHY, not WHAT
// Rate limit to avoid API throttling during batch operations
const BATCH_DELAY_MS = 100;
```

<div id="error-handling">
### 错误处理
</div>

```typescript
// Specific error messages with context
throw new Error("Failed to load plugin: " + err.message);

// Graceful degradation over silent swallowing
try {
  await riskyOperation();
} catch (err) {
  runtime.logger?.warn(err, "Operation failed, using fallback");
  return fallbackValue;
}
```

<div id="editor-setup">
### 编辑器设置
</div>

推荐的 VS Code 设置：

```json
{
  "editor.formatOnSave": true,
  "editor.defaultFormatter": "biomejs.biome"
}
```

安装 [Biome VS Code 扩展](https://marketplace.visualstudio.com/items?itemName=biomejs.biome) 获取编辑器内的格式化和 lint 反馈。

---

<div id="project-structure">
## 项目结构
</div>

```
milady/
├── apps/
│   ├── app/                 # Desktop/mobile app (Capacitor + React)
│   │   ├── electrobun/      # Electrobun desktop wrapper
│   │   └── src/             # React UI components
├── deploy/                  # Docker deployment configs
├── docs/                    # Documentation site
├── packages/                # Workspace packages
├── plugins/                 # Workspace plugin packages
├── scripts/                 # Build, dev, and release tooling
├── skills/                  # Skill catalog cache
├── src/                     # Core source code
│   ├── actions/             # Agent actions
│   ├── api/                 # HTTP API routes
│   ├── cli/                 # CLI command definitions
│   ├── config/              # Configuration handling
│   ├── hooks/               # Runtime hooks
│   ├── plugins/             # Built-in plugins
│   ├── providers/           # Context providers
│   ├── runtime/             # elizaOS runtime wrapper
│   ├── security/            # Security utilities
│   ├── services/            # Background services
│   ├── triggers/            # Trigger system
│   ├── tui/                 # Terminal UI (disabled)
│   └── utils/               # Helper utilities
├── test/                    # Test setup, helpers, e2e scripts
├── AGENTS.md                # Repository guidelines for agents
├── CONTRIBUTING.md          # Contribution philosophy
├── package.json             # Root package config
├── plugins.json             # Plugin registry manifest
├── biome.json               # Biome linter/formatter config
├── tsconfig.json            # TypeScript config
├── tsdown.config.ts         # Build config (tsdown bundler)
├── vitest.config.ts         # Vitest test config
└── milady.mjs               # npm bin entry point
```

<div id="key-entry-points">
### 关键入口点
</div>

| 文件 | 用途 |
|------|------|
| `src/entry.ts` | CLI 入口点 |
| `src/index.ts` | 库导出 |
| `src/runtime/eliza.ts` | elizaOS 运行时初始化 |
| `src/runtime/milady-plugin.ts` | Milady 主插件 |
| `milady.mjs` | npm bin 入口（package.json 中的 `"bin"`） |

---

<div id="reporting-issues">
## 报告问题
</div>

提交 bug 报告时：

1. **检查现有 issues** 避免重复
2. **包含复现步骤** -- 你做了什么、发生了什么、你期望什么
3. **分享你的环境** -- 操作系统、Node 版本、Milady 版本（`milady --version`）
4. **附加日志** -- 相关错误输出

一个 AI 代理对所有传入的 issue 进行分类。有效的 bug 会被标记和优先处理。超出范围的 issue（美学请求、功能扩展）将被关闭并附带解释。

---

<div id="further-reading">
## 延伸阅读
</div>

- [CONTRIBUTING.md](https://github.com/milady-ai/milady/blob/develop/CONTRIBUTING.md) -- 完整的贡献理念
- [AGENTS.md](https://github.com/milady-ai/milady/blob/develop/AGENTS.md) -- 编码代理的仓库指南
- [插件开发指南](/zh/plugins/development) -- 构建插件
- [Skills 文档](/zh/plugins/skills) -- 创建 skills
- [本地插件开发](/zh/plugins/local-plugins) -- 本地开发插件
