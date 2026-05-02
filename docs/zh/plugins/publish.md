---
title: "发布插件"
sidebarTitle: "发布"
description: "如何打包、版本控制和发布 Eliza 插件到 npm 注册表，并提交到社区注册表。"
---

本指南涵盖 Eliza 插件的完整发布流程——从打包到 npm 发布和社区注册表提交。

<div id="naming-conventions">

## 命名约定

</div>

选择遵循既定约定的包名称：

| 范围 | 模式 | 示例 |
|------|------|------|
| 官方 elizaOS | `@elizaos/plugin-{name}` | `@elizaos/plugin-openai` |
| 社区（有范围） | `@yourorg/plugin-{name}` | `@acme/plugin-analytics` |
| 社区（无范围） | `elizaos-plugin-{name}` | `elizaos-plugin-weather` |

运行时可以识别所有三种模式以实现自动发现。

<div id="packagejson-requirements">

## package.json 要求

</div>

你的插件的 `package.json` 必须包含以下字段：

```json
{
  "name": "@elizaos/plugin-my-feature",
  "version": "1.0.0",
  "description": "One-line description of what this plugin does",
  "type": "module",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "files": ["dist", "elizaos.plugin.json"],
  "keywords": ["elizaos", "eliza", "plugin"],
  "license": "MIT",
  "repository": {
    "type": "git",
    "url": "https://github.com/yourorg/plugin-my-feature"
  },
  "peerDependencies": {
    "@elizaos/core": ">=2.0.0-alpha"
  },
  "devDependencies": {
    "@elizaos/core": "alpha",
    "typescript": "^5.0.0"
  }
}
```

**要点：**
- 将 `@elizaos/core` 声明为 `peerDependency`——而非直接依赖——以避免版本冲突。
- 在 `files` 中包含 `elizaos.plugin.json`，以便清单与代码一起发布。
- 使用 `"type": "module"` 进行 ESM 输出。

<div id="build-configuration">

## 构建配置

</div>

使用 TypeScript 面向 ESM：

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "outDir": "dist",
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "strict": true,
    "skipLibCheck": true
  },
  "include": ["src"],
  "exclude": ["node_modules", "dist", "**/*.test.ts"]
}
```

<div id="versioning">

## 版本控制

</div>

遵循[语义化版本控制](https://semver.org/)：

| 变更 | 版本递增 |
|------|----------|
| 新操作、提供者或功能（向后兼容） | Minor (`1.0.0` → `1.1.0`) |
| 仅修复错误 | Patch (`1.0.0` → `1.0.1`) |
| 不兼容的 API 变更 | Major (`1.0.0` → `2.0.0`) |

对于面向 elizaOS `next` 发布线的插件，使用预发布版本：

```bash
npm version prerelease --preid=next
# 1.0.0 → 1.0.1-next.0
```

<div id="publishing-to-npm">

## 发布到 npm

</div>

<div id="1-authenticate">

### 1. 身份验证

</div>

```bash
npm login
```

<div id="2-build">

### 2. 构建

</div>

```bash
bun run build
```

在发布之前，验证 `dist/` 目录包含编译后的输出。

<div id="3-dry-run">

### 3. 试运行

</div>

始终预览将要发布的内容：

```bash
npm publish --dry-run --access public
```

检查输出是否仅包含 `dist/`、`elizaos.plugin.json`、`package.json` 和 `README.md`。

<div id="4-publish">

### 4. 发布

</div>

```bash
npm publish --access public
```

对于面向 elizaOS `next` 发布线的预发布版本：

```bash
npm publish --access public --tag next
```

<div id="5-verify">

### 5. 验证

</div>

```bash
npm info @yourorg/plugin-my-feature
```

<div id="plugin-manifest">

## 插件清单

</div>

在包根目录包含一个 `elizaos.plugin.json`，以在 Eliza 管理面板中实现丰富的 UI 集成：

```json
{
  "id": "my-feature",
  "name": "My Feature Plugin",
  "description": "Does something useful",
  "version": "1.0.0",
  "kind": "skill",

  "requiredSecrets": ["MY_FEATURE_API_KEY"],
  "optionalSecrets": ["MY_FEATURE_DEBUG"],

  "configSchema": {
    "type": "object",
    "properties": {
      "apiKey": { "type": "string" },
      "endpoint": { "type": "string", "format": "uri" }
    },
    "required": ["apiKey"]
  },

  "uiHints": {
    "apiKey": {
      "label": "API Key",
      "type": "password",
      "sensitive": true
    }
  }
}
```

<div id="best-practices">

## 最佳实践

</div>

**文档：**
- 包含一个 `README.md`，其中有安装说明、所需的环境变量和使用示例。
- 为每个操作记录 LLM 何时会调用它的描述。
- 在表格中列出所有必需和可选的环境变量。

**安全：**
- 永远不要记录 API 密钥或密文——谨慎使用 `runtime.logger`。
- 在操作处理程序中验证和清理所有参数。
- 对 `@elizaos/core` 使用 `peerDependencies` 以防止重复安装。

**兼容性：**
- 针对当前 `next` 版本的 `@elizaos/core` 进行测试。
- 保守地声明 `peerDependencies` 版本范围：`"@elizaos/core": ">=2.0.0"`。
- 导出与 `Plugin` 类型兼容的默认导出——不要将默认导出用于其他目的。

**质量：**
- 包含至少 80% 覆盖率的单元测试。（注意：这是独立发布插件的推荐标准。monorepo 从 `scripts/coverage-policy.mjs` 强制执行 25% 行/函数/语句和 15% 分支的最低标准。）
- 在 CI 中运行 `tsc --noEmit` 以检测类型错误。
- 在发布前使用 `npm pack` 测试已发布的包。

<div id="multi-language-plugins">

## 多语言插件

</div>

插件可以包含多种语言的实现：

```
my-plugin/
├── typescript/     # Primary TypeScript implementation
│   ├── src/
│   ├── package.json
│   └── tsconfig.json
├── python/         # Optional Python SDK bindings
│   ├── src/
│   └── pyproject.toml
├── rust/           # Optional Rust native module
│   ├── src/
│   └── Cargo.toml
└── elizaos.plugin.json
```

TypeScript 实现始终是必需的。Python 和 Rust 实现是可选的，由各自的 SDK 使用。根目录的 `elizaos.plugin.json` 清单描述了所有语言的插件。

<div id="community-registry">

## 社区注册表

</div>

发布到 npm 后，通过向 [`elizaos-plugins/registry`](https://github.com/elizaos-plugins/registry) 提交 PR 将你的插件提交到社区注册表。

在 PR 中包含：
1. `index.json` 中将你的包名映射到其 git 仓库的条目
2. 包中一个可用的 `elizaos.plugin.json` 清单
3. 至少一个通过的测试套件
4. 包含设置说明和所需环境变量的 README

社区插件在列出之前会经过安全性、功能性和文档质量审查。详情请参阅[注册表文档](/zh/plugins/registry#submitting-a-plugin-to-the-registry)。

<div id="related">

## 相关内容

</div>

- [插件模式](/zh/plugins/schemas) — 完整模式参考
- [创建插件](/zh/plugins/create-a-plugin) — 从零开始构建插件
- [插件注册表](/zh/plugins/registry) — 浏览已发布的插件
