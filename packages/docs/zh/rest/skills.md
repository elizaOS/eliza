---
title: "技能 API"
sidebarTitle: "技能"
description: "用于管理本地技能、技能目录和技能市场的 REST API 端点。"
---

技能 API 涵盖三个领域：**本地技能**（智能体专用的 TypeScript action 文件）、**技能目录**（社区技能的策展注册表）和**技能市场**（基于 npm 的技能包）。技能通过新的 action、provider 或 evaluator 扩展智能体。

当设置了 `ELIZA_API_TOKEN` 时，将其作为 `Bearer` 令牌包含在 `Authorization` 请求头中。

<div id="endpoints">

## 端点

</div>

<div id="local-skills">

### 本地技能

</div>

| 方法 | 路径 | 描述 |
|--------|------|-------------|
| GET | `/api/skills` | 列出所有本地技能及元数据 |
| POST | `/api/skills/refresh` | 重新扫描技能目录 |
| GET | `/api/skills/:id/scan` | 扫描技能文件并返回解析后的元数据 |
| POST | `/api/skills/create` | 从模板创建新的技能文件 |
| POST | `/api/skills/:id/open` | 在默认编辑器中打开技能文件 |
| GET | `/api/skills/:id/source` | 读取技能的源代码 |
| PUT | `/api/skills/:id/source` | 写入更新后的技能源代码 |
| POST | `/api/skills/:id/enable` | 启用技能（遵守扫描确认） |
| POST | `/api/skills/:id/disable` | 禁用技能 |

<div id="skills-catalog">

### 技能目录

</div>

| 方法 | 路径 | 描述 |
|--------|------|-------------|
| GET | `/api/skills/catalog` | 分页列出技能目录 |
| GET | `/api/skills/catalog/search` | 按查询搜索目录 |
| GET | `/api/skills/catalog/:id` | 获取单个目录条目的详情 |
| POST | `/api/skills/catalog/refresh` | 从远程注册表刷新目录 |
| POST | `/api/skills/catalog/install` | 安装目录中的技能 |
| POST | `/api/skills/catalog/uninstall` | 卸载目录中的技能 |

<div id="skills-marketplace">

### 技能市场

</div>

| 方法 | 路径 | 描述 |
|--------|------|-------------|
| GET | `/api/skills/marketplace/search` | 在 npm 市场中搜索技能 |
| GET | `/api/skills/marketplace/installed` | 列出已安装的市场技能 |
| POST | `/api/skills/marketplace/install` | 从 npm 安装技能 |
| POST | `/api/skills/marketplace/uninstall` | 卸载市场技能 |
| GET | `/api/skills/marketplace/config` | 获取市场配置 |
| PUT | `/api/skills/marketplace/config` | 更新市场配置 |

---

<div id="local-skills-1">

## 本地技能

</div>

<div id="get-apiskills">

### GET /api/skills

</div>

列出智能体技能目录中的所有本地技能。每个条目包括文件路径、解析后的 action 元数据以及启用/优先级偏好。

**响应**

```json
{
  "skills": [
    {
      "id": "my-custom-action",
      "name": "MY_CUSTOM_ACTION",
      "description": "Does something useful",
      "filePath": "/path/to/skills/my-custom-action.ts",
      "enabled": true,
      "priority": 0,
      "valid": true
    }
  ]
}
```

---

<div id="post-apiskillsrefresh">

### POST /api/skills/refresh

</div>

重新扫描技能目录并重新加载所有技能元数据。在手动添加或编辑技能文件后很有用。

**响应**

```json
{
  "ok": true,
  "count": 5
}
```

---

<div id="get-apiskillsidscan">

### GET /api/skills/:id/scan

</div>

扫描单个技能文件并返回其解析后的 AST 元数据——导出的 action、provider 和 evaluator。

**响应**

```json
{
  "id": "my-skill",
  "actions": [
    {
      "name": "MY_ACTION",
      "description": "Action description",
      "similes": ["DO_THING"],
      "parameters": []
    }
  ],
  "providers": [],
  "evaluators": []
}
```

---

<div id="post-apiskillscreate">

### POST /api/skills/create

</div>

从内置模板创建新的技能文件。

**请求体**

| 字段 | 类型 | 必需 | 描述 |
|-------|------|----------|-------------|
| `name` | string | 是 | 技能文件名（例如 `my-action`） |
| `template` | string | 否 | 使用的模板——默认为基本 action 模板 |

**响应**

```json
{
  "ok": true,
  "skill": {
    "id": "my-action",
    "filePath": "/path/to/skills/my-action.ts"
  }
}
```

---

<div id="post-apiskillsidopen">

### POST /api/skills/:id/open

</div>

在系统默认代码编辑器中打开技能文件。

**响应**

```json
{
  "ok": true
}
```

---

<div id="get-apiskillsidsource">

### GET /api/skills/:id/source

</div>

读取技能文件的原始 TypeScript 源代码。

**响应**

```json
{
  "id": "my-skill",
  "source": "import { Action } from '@elizaos/core';\n\nexport const myAction: Action = { ... };"
}
```

---

<div id="put-apiskillsidsource">

### PUT /api/skills/:id/source

</div>

将更新后的源代码写入技能文件。服务器在保存前会验证基本语法。

**请求体**

| 字段 | 类型 | 必需 | 描述 |
|-------|------|----------|-------------|
| `source` | string | 是 | 新的 TypeScript 源代码 |

**响应**

```json
{
  "ok": true
}
```

---

<div id="post-apiskillsidenable">

### POST /api/skills/:id/enable

</div>

启用已安装的技能。如果技能有未确认的扫描发现，返回 409——请先通过 `POST /api/skills/:id/acknowledge` 进行确认。

**响应**

```json
{
  "ok": true,
  "skill": {
    "id": "my-skill",
    "enabled": true
  },
  "scanStatus": null
}
```

---

<div id="post-apiskillsiddisable">

### POST /api/skills/:id/disable

</div>

禁用已安装的技能。

**响应**

```json
{
  "ok": true,
  "skill": {
    "id": "my-skill",
    "enabled": false
  },
  "scanStatus": null
}
```

---

<div id="skills-catalog-1">

## 技能目录

</div>

<div id="get-apiskillscatalog">

### GET /api/skills/catalog

</div>

浏览策展技能目录，支持分页和排序。

**查询参数**

| 参数 | 类型 | 默认值 | 描述 |
|-----------|------|---------|-------------|
| `page` | number | 1 | 页码 |
| `perPage` | number | 50 | 每页条目数（最大 100） |
| `sort` | string | `downloads` | 排序字段 |

**响应**

```json
{
  "skills": [
    {
      "id": "greeting-skill",
      "name": "Greeting Skill",
      "description": "Custom greeting actions",
      "author": "community",
      "downloads": 1234,
      "installed": false
    }
  ],
  "total": 42,
  "page": 1,
  "perPage": 50
}
```

---

<div id="get-apiskillscatalogsearch">

### GET /api/skills/catalog/search

</div>

按文本查询搜索目录。

**查询参数**

| 参数 | 类型 | 描述 |
|-----------|------|-------------|
| `q` | string | 搜索查询（必需） |
| `limit` | number | 最大结果数（默认 30，最大 100） |

**响应**

```json
{
  "skills": [ ... ],
  "total": 5
}
```

---

<div id="get-apiskillscatalogid">

### GET /api/skills/catalog/:id

</div>

获取单个目录技能条目的完整详情。

**响应**

```json
{
  "skill": {
    "id": "greeting-skill",
    "name": "Greeting Skill",
    "description": "Full description...",
    "author": "community",
    "version": "1.0.0",
    "installed": false,
    "readme": "# Greeting Skill\n..."
  }
}
```

---

<div id="post-apiskillscatalogrefresh">

### POST /api/skills/catalog/refresh

</div>

从远程注册表强制刷新目录。

**响应**

```json
{
  "ok": true
}
```

---

<div id="post-apiskillscataloginstall">

### POST /api/skills/catalog/install

</div>

从目录安装技能。

**请求体**

| 字段 | 类型 | 必需 | 描述 |
|-------|------|----------|-------------|
| `id` | string | 是 | 目录技能 ID |

**响应**

```json
{
  "ok": true,
  "skill": { "id": "greeting-skill", "installed": true }
}
```

---

<div id="post-apiskillscataloguninstall">

### POST /api/skills/catalog/uninstall

</div>

卸载之前安装的目录技能。

**请求体**

| 字段 | 类型 | 必需 | 描述 |
|-------|------|----------|-------------|
| `id` | string | 是 | 目录技能 ID |

**响应**

```json
{
  "ok": true
}
```

---

<div id="skills-marketplace-1">

## 技能市场

</div>

<div id="get-apiskillsmarketplacesearch">

### GET /api/skills/marketplace/search

</div>

在基于 npm 的技能市场中搜索。

**查询参数**

| 参数 | 类型 | 描述 |
|-----------|------|-------------|
| `q` | string | 搜索查询 |
| `limit` | number | 最大结果数（默认 30，最大 100） |

**响应**

```json
{
  "results": [
    {
      "name": "@community/skill-weather",
      "description": "Weather lookup skill",
      "version": "2.1.0"
    }
  ]
}
```

---

<div id="get-apiskillsmarketplaceinstalled">

### GET /api/skills/marketplace/installed

</div>

列出当前已安装的所有市场技能。

**响应**

```json
{
  "skills": [
    {
      "name": "@community/skill-weather",
      "version": "2.1.0",
      "installedAt": "2025-06-01T12:00:00Z"
    }
  ]
}
```

---

<div id="post-apiskillsmarketplaceinstall">

### POST /api/skills/marketplace/install

</div>

从 npm 市场安装技能包。

**请求体**

| 字段 | 类型 | 必需 | 描述 |
|-------|------|----------|-------------|
| `name` | string | 是 | npm 包名 |
| `version` | string | 否 | 特定版本（默认为最新版） |

**响应**

```json
{
  "ok": true
}
```

---

<div id="post-apiskillsmarketplaceuninstall">

### POST /api/skills/marketplace/uninstall

</div>

卸载市场技能包。

**请求体**

| 字段 | 类型 | 必需 | 描述 |
|-------|------|----------|-------------|
| `name` | string | 是 | npm 包名 |

**响应**

```json
{
  "ok": true
}
```

---

<div id="get-apiskillsmarketplaceconfig">

### GET /api/skills/marketplace/config

</div>

获取当前市场配置。

**响应**

```json
{
  "config": { ... }
}
```

---

<div id="put-apiskillsmarketplaceconfig">

### PUT /api/skills/marketplace/config

</div>

更新市场配置。

**请求体**

任意配置对象——因市场后端而异。

**响应**

```json
{
  "ok": true
}
```

<div id="acknowledge-skill-findings">

## 确认技能扫描发现

</div>

```
POST /api/skills/:id/acknowledge
```

确认技能的安全扫描发现。在技能可以启用之前必须执行此操作。可选地在同一请求中启用技能。

**路径参数：**

| 参数 | 类型 | 描述 |
|-------|------|-------------|
| `id` | string | 技能标识符 |

**请求体：**
```json
{ "enable": true }
```

`enable` 是可选的——省略或设为 `false` 则仅确认而不启用。

**响应——存在发现：**
```json
{
  "ok": true,
  "skillId": "my-skill",
  "acknowledged": true,
  "enabled": true,
  "findingCount": 3
}
```

**响应——无发现（清洁扫描）：**
```json
{
  "ok": true,
  "message": "No findings to acknowledge.",
  "acknowledged": true
}
```

**错误：** `404` 未找到扫描报告；`403` 技能状态为 `"blocked"`（无法确认）。

---

<div id="skills-catalog-and-marketplace-runbook">

## 技能目录和市场运维手册

</div>

<div id="setup-checklist">

### 设置检查清单

</div>

1. 确认技能目录（`~/.eliza/workspace/skills/`）对运行时可读可写。
2. 确认市场注册表/网络访问可用（默认：`https://clawhub.ai`）。检查 `SKILLS_REGISTRY`、`CLAWHUB_REGISTRY` 或 `SKILLS_MARKETPLACE_URL` 环境变量。
3. 确认插件安装先决条件（`bun` 和 `git`）在运行时 PATH 中可用。
4. 对于旧版 SkillsMP 市场，在环境中设置 `SKILLSMP_API_KEY`。
5. 验证目录文件存在于预期路径之一（与 `@elizaos/plugin-agent-skills` 捆绑）。

<div id="failure-modes">

### 故障模式

</div>

**搜索和目录：**

- 搜索意外返回空结果：
  检查查询输入、上游注册表可用性和速率限制。模糊匹配使用 slug、name、summary 和 tags——尝试更宽泛的搜索词。
- 目录缓存过期：
  内存缓存在 10 分钟后过期。使用 `POST /api/skills/catalog/refresh` 强制刷新或重启智能体。

**安装和卸载：**

- 安装因网络错误失败：
  检查包名/版本有效性、安装程序权限和网络。安装程序对基于 git 的安装使用 sparse checkout——确认 `git` 可用。
- 安全扫描阻止安装（`blocked` 状态）：
  扫描检测到二进制文件（`.exe`、`.dll`、`.so`）、符号链接逃逸或缺少 `SKILL.md`。技能目录会被自动删除。
- 安装失败并提示"already installed"：
  此技能 ID 已存在记录。先使用 `POST /api/skills/marketplace/uninstall` 卸载，然后重试。
- 卸载留下过期状态：
  刷新技能列表并验证包已从 `marketplace-installs.json` 中移除。

**技能加载：**

- 自定义技能未出现在 `/api/skills` 中：
  确认技能目录包含有效的 `SKILL.md`（带有 name/description frontmatter）。运行 `POST /api/skills/refresh` 重新扫描。
- 技能已加载但被禁用：
  检查启用/禁用的级联：数据库偏好覆盖配置，`denyBundled` 无条件阻止。

<div id="recovery-procedures">

### 恢复程序

</div>

1. **损坏的市场安装：** 删除 `~/.eliza/workspace/skills/.marketplace/<skill-id>/` 并从 `~/.eliza/workspace/skills/.cache/marketplace-installs.json` 中移除其条目，然后重新安装。
2. **目录文件缺失：** 重新安装或更新 `@elizaos/plugin-agent-skills` 以恢复捆绑的目录。
3. **技能覆盖冲突：** 如果工作区技能意外覆盖了捆绑技能，请重命名工作区技能目录或将其移至其他位置。

<div id="verification-commands">

### 验证命令

</div>

```bash
# Skill catalog and marketplace unit tests
bunx vitest run src/services/plugin-installer.test.ts src/services/skill-marketplace.test.ts src/services/skill-catalog-client.test.ts

# Skills marketplace API and services e2e
bunx vitest run --config test/vitest/e2e.config.ts test/skills-marketplace-api.e2e.test.ts test/skills-marketplace-services.e2e.test.ts

# API server e2e (includes skills routes)
bunx vitest run --config test/vitest/e2e.config.ts test/api-server.e2e.test.ts

bun run typecheck
```

<div id="common-error-codes">

## 常见错误码

</div>

| 状态码 | 代码 | 描述 |
|--------|------|-------------|
| 400 | `INVALID_REQUEST` | 请求体格式错误或缺少必需字段 |
| 401 | `UNAUTHORIZED` | 缺少或无效的认证令牌 |
| 404 | `NOT_FOUND` | 请求的资源不存在 |
| 500 | `SKILL_BLOCKED` | 技能因安全扫描发现而被阻止 |
| 500 | `SYNTAX_ERROR` | 技能源代码包含语法错误 |
| 500 | `ALREADY_INSTALLED` | 技能已安装 |
| 500 | `INTERNAL_ERROR` | 意外的服务器错误 |
