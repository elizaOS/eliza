---
title: "插件与注册表 API"
sidebarTitle: "插件"
description: "用于插件管理、elizaOS 插件注册表和核心插件操作的 REST API 端点。"
---

插件 API 管理智能体的插件系统。它涵盖三个领域：**插件管理**（列出、配置、启用/禁用已安装的插件）、**插件安装**（从 npm 安装、卸载、弹出、同步）和**插件注册表**（浏览 elizaOS 社区目录）。

当设置了 `ELIZA_API_TOKEN` 时，将其作为 `Bearer` 令牌包含在 `Authorization` 请求头中。

<div id="endpoints">

## 端点

</div>

<div id="plugin-management">

### 插件管理

</div>

| 方法 | 路径 | 描述 |
|--------|------|-------------|
| GET | `/api/plugins` | 列出所有插件及其状态和配置 |
| PUT | `/api/plugins/:id` | 更新插件（启用/禁用、配置） |
| POST | `/api/plugins/:id/test` | 测试插件的连通性 |
| GET | `/api/plugins/installed` | 列出已安装的插件包 |
| GET | `/api/plugins/ejected` | 列出已弹出（本地副本）的插件 |

<div id="plugin-installation">

### 插件安装

</div>

| 方法 | 路径 | 描述 |
|--------|------|-------------|
| POST | `/api/plugins/install` | 从 npm 安装插件 |
| POST | `/api/plugins/uninstall` | 卸载插件 |
| POST | `/api/plugins/:id/eject` | 将插件弹出到本地副本 |
| POST | `/api/plugins/:id/sync` | 将已弹出的插件同步回 npm |
| POST | `/api/plugins/:id/reinject` | 将已弹出的插件恢复为注册表版本 |

<div id="core-plugin-management">

### 核心插件管理

</div>

| 方法 | 路径 | 描述 |
|--------|------|-------------|
| GET | `/api/core/status` | 核心管理器状态 |
| GET | `/api/plugins/core` | 列出核心插件及其状态 |
| POST | `/api/plugins/core/toggle` | 切换核心插件 |

<div id="plugin-registry">

### 插件注册表

</div>

| 方法 | 路径 | 描述 |
|--------|------|-------------|
| GET | `/api/registry/plugins` | 列出所有注册表插件 |
| GET | `/api/registry/plugins/:name` | 获取注册表插件的详情 |
| GET | `/api/registry/search` | 搜索注册表 |
| POST | `/api/registry/refresh` | 刷新注册表缓存 |
| GET | `/api/registry/status` | 注册表连接状态 |
| POST | `/api/registry/register` | 向注册表注册智能体 |
| POST | `/api/registry/update-uri` | 更新智能体的注册表 URI |
| POST | `/api/registry/sync` | 将智能体状态与注册表同步 |
| GET | `/api/registry/config` | 获取注册表配置 |

---

<div id="plugin-management-1">

## 插件管理

</div>

<div id="get-apiplugins">

### GET /api/plugins

</div>

列出所有已知插件——捆绑的、已安装的和从配置中发现的。每个条目包括启用/激活状态、带有当前值的配置参数（敏感值已遮蔽）和验证结果。

**响应**

```json
{
  "plugins": [
    {
      "id": "twitter",
      "name": "Twitter",
      "description": "Twitter/X integration",
      "category": "social",
      "enabled": true,
      "isActive": true,
      "configured": true,
      "loadError": null,
      "parameters": [
        {
          "key": "TWITTER_API_KEY",
          "required": true,
          "sensitive": true,
          "isSet": true,
          "currentValue": "sk-****...xxxx"
        }
      ],
      "validationErrors": [],
      "validationWarnings": []
    }
  ]
}
```

| 字段 | 类型 | 描述 |
|-------|------|-------------|
| `id` | string | 插件标识符 |
| `enabled` | boolean | 用户是否希望其激活（配置驱动） |
| `isActive` | boolean | 是否实际加载在运行时中 |
| `configured` | boolean | 是否已设置所有必需参数 |
| `loadError` | string\|null | 已安装但加载失败时的错误消息 |

---

<div id="put-apipluginsid">

### PUT /api/plugins/:id

</div>

更新插件的启用状态和/或配置。启用/禁用插件会安排运行时重启。

**请求体**

| 字段 | 类型 | 必需 | 描述 |
|-------|------|----------|-------------|
| `enabled` | boolean | 否 | 启用或禁用插件 |
| `config` | object | 否 | 参数键到新值的映射 |

```json
{
  "enabled": true,
  "config": {
    "TWITTER_API_KEY": "sk-new-key"
  }
}
```

**响应**

```json
{
  "ok": true,
  "plugin": { "id": "twitter", "enabled": true, "..." : "..." }
}
```

**错误**

| 状态码 | 条件 |
|--------|-----------|
| 404 | 未找到插件 |
| 422 | 配置验证失败 |

---

<div id="post-apipluginsidtest">

### POST /api/plugins/:id/test

</div>

测试插件的连通性或配置。测试行为因插件而异（例如验证 API 密钥有效性、检查端点可达性）。

**响应**

```json
{
  "ok": true,
  "result": { "..." : "..." }
}
```

---

<div id="get-apipluginsinstalled">

### GET /api/plugins/installed

</div>

列出所有已安装的插件包及版本信息。

**响应**

```json
{
  "count": 3,
  "plugins": [
    {
      "name": "@elizaos/plugin-x",
      "version": "1.2.0",
      "installedAt": "2025-06-01T12:00:00.000Z"
    }
  ]
}
```

| 字段 | 类型 | 描述 |
|-------|------|-------------|
| `count` | number | 已安装插件的总数 |
| `plugins` | array | 已安装插件包的列表 |

---

<div id="get-apipluginsejected">

### GET /api/plugins/ejected

</div>

列出所有已弹出的插件（已复制到本地目录进行开发的插件）。

**响应**

```json
{
  "plugins": [
    {
      "name": "@elizaos/plugin-x",
      "localPath": "/path/to/local/plugin-twitter"
    }
  ]
}
```

---

<div id="plugin-installation-1">

## 插件安装

</div>

<div id="post-apipluginsinstall">

### POST /api/plugins/install

</div>

从 npm 安装插件包。插件安装可能需要较长时间，具体取决于包大小和依赖树。客户端 SDK 对此端点使用 120 秒超时（与其他 API 调用使用的默认超时相比）。

**请求体**

| 字段 | 类型 | 必需 | 描述 |
|-------|------|----------|-------------|
| `name` | string | 是 | npm 包名 |
| `autoRestart` | boolean | 否 | 安装后是否重启智能体（默认为 `true`） |

**响应**

```json
{
  "ok": true,
  "requiresRestart": true
}
```

---

<div id="post-apipluginsuninstall">

### POST /api/plugins/uninstall

</div>

卸载插件包。

**请求体**

| 字段 | 类型 | 必需 | 描述 |
|-------|------|----------|-------------|
| `name` | string | 是 | npm 包名 |

**响应**

```json
{
  "ok": true,
  "requiresRestart": true
}
```

---

<div id="post-apipluginsideject">

### POST /api/plugins/:id/eject

</div>

将插件弹出到本地目录进行开发。创建可独立修改的插件源代码本地副本。如果结果指示需要重启，运行时会安排自动重启。

**响应**

```json
{
  "ok": true,
  "pluginName": "@elizaos/plugin-x",
  "requiresRestart": true,
  "message": "@elizaos/plugin-x ejected to local source."
}
```

| 字段 | 类型 | 描述 |
|-------|------|-------------|
| `pluginName` | string | 已弹出插件的名称 |
| `requiresRestart` | boolean | 运行时是否会重启以加载本地副本 |
| `message` | string | 人类可读的状态消息 |

**错误**

| 状态码 | 条件 |
|--------|-----------|
| 422 | 弹出失败（插件未找到或已弹出） |

---

<div id="post-apipluginsidsync">

### POST /api/plugins/:id/sync

</div>

将已弹出的插件同步回——从本地副本重新构建。

**响应**

```json
{
  "ok": true,
  "pluginName": "@elizaos/plugin-x",
  "requiresRestart": true,
  "message": "@elizaos/plugin-x synced with upstream."
}
```

| 字段 | 类型 | 描述 |
|-------|------|-------------|
| `pluginName` | string | 已同步插件的名称 |
| `requiresRestart` | boolean | 运行时是否会重启以应用更改 |
| `message` | string | 人类可读的状态消息 |

**错误**

| 状态码 | 条件 |
|--------|-----------|
| 422 | 同步失败（插件未弹出或同步错误） |

---

<div id="post-apipluginsid reinject">

### POST /api/plugins/:id/reinject

</div>

将之前弹出的插件恢复为注册表版本，并删除本地副本。

**响应**

```json
{
  "ok": true,
  "pluginName": "@elizaos/plugin-x",
  "requiresRestart": true,
  "message": "@elizaos/plugin-x restored to registry version."
}
```

| 字段 | 类型 | 描述 |
|-------|------|-------------|
| `pluginName` | string | 已恢复插件的名称 |
| `requiresRestart` | boolean | 运行时是否会重启以加载注册表版本 |
| `message` | string | 人类可读的状态消息 |

**错误**

| 状态码 | 条件 |
|--------|-----------|
| 422 | 恢复失败（插件未弹出或恢复错误） |

---

<div id="core-plugin-management-1">

## 核心插件管理

</div>

<div id="get-apicorestatus">

### GET /api/core/status

</div>

获取核心管理器状态和可用的核心插件。

**响应**

```json
{
  "available": true,
  "corePlugins": ["knowledge", "sql"],
  "optionalCorePlugins": ["plugin-manager"]
}
```

- **knowledge** -- RAG 知识检索
- **sql** -- 数据库层

---

<div id="get-apipluginscore">

### GET /api/plugins/core

</div>

列出核心和可选核心插件及其启用/加载状态。

**响应**

```json
{
  "core": [
    { "name": "knowledge", "loaded": true, "required": true },
    { "name": "sql", "loaded": true, "required": true }
  ],
  "optionalCore": [
    { "name": "plugin-manager", "loaded": true, "required": false, "enabled": true }
  ]
}
```

---

<div id="post-apipluginscoretoggle">

### POST /api/plugins/core/toggle

</div>

切换可选核心插件的开启或关闭状态。

**请求体**

| 字段 | 类型 | 必需 | 描述 |
|-------|------|----------|-------------|
| `name` | string | 是 | 核心插件名称 |
| `enabled` | boolean | 是 | 期望的状态 |

**响应**

```json
{
  "ok": true,
  "requiresRestart": true
}
```

---

<div id="plugin-registry-1">

## 插件注册表

</div>

<div id="get-apiregistryplugins">

### GET /api/registry/plugins

</div>

列出 elizaOS 注册表中的所有插件及其安装和加载状态。

**响应**

```json
{
  "count": 87,
  "plugins": [
    {
      "name": "@elizaos/plugin-x",
      "displayName": "Twitter",
      "description": "Twitter/X integration for posting and monitoring",
      "npm": {
        "package": "@elizaos/plugin-x",
        "version": "1.2.0"
      },
      "installed": false,
      "installedVersion": null,
      "loaded": false,
      "bundled": false
    }
  ]
}
```

| 字段 | 类型 | 描述 |
|-------|------|-------------|
| `name` | string | 完整的 npm 包名 |
| `installed` | boolean | 此插件是否已安装 |
| `installedVersion` | string\|null | 已安装版本，未安装则为 `null` |
| `loaded` | boolean | 此插件是否已加载在运行中的智能体运行时中 |
| `bundled` | boolean | 此插件是否捆绑在 Eliza 二进制文件中 |

---

<div id="get-apiregistrypluginsname">

### GET /api/registry/plugins/:name

</div>

获取特定注册表插件的详情。如果 `name` 参数包含斜杠，应进行 URL 编码（例如 `%40elizaos%2Fplugin-twitter`）。

**路径参数**

| 参数 | 类型 | 必需 | 描述 |
|-----------|------|----------|-------------|
| `name` | string | 是 | 完整的 npm 包名（URL 编码） |

**响应**

```json
{
  "plugin": {
    "name": "@elizaos/plugin-x",
    "displayName": "Twitter",
    "description": "Twitter/X integration for posting and monitoring",
    "npm": {
      "package": "@elizaos/plugin-x",
      "version": "1.2.0"
    },
    "author": "elizaOS Team",
    "repository": "https://github.com/elizaos/eliza",
    "tags": ["social", "twitter"],
    "installed": false,
    "loaded": false,
    "bundled": false
  }
}
```

---

<div id="get-apiregistrysearch">

### GET /api/registry/search

</div>

按关键词搜索插件注册表。

**查询参数**

| 参数 | 类型 | 必需 | 描述 |
|-----------|------|----------|-------------|
| `q` | string | 是 | 搜索查询 |
| `limit` | integer | 否 | 返回的最大结果数（默认：15，最大：50） |

**响应**

```json
{
  "query": "twitter",
  "count": 2,
  "results": [
    {
      "name": "@elizaos/plugin-x",
      "displayName": "Twitter",
      "description": "Twitter/X integration",
      "npmPackage": "@elizaos/plugin-x",
      "version": "1.2.0"
    }
  ]
}
```

---

<div id="post-apiregistryrefresh">

### POST /api/registry/refresh

</div>

从上游 elizaOS 注册表强制刷新本地注册表缓存。

**响应**

```json
{
  "ok": true,
  "count": 87
}
```

---

<div id="get-apiregistrystatus">

### GET /api/registry/status

</div>

获取智能体的注册表连接状态。

**响应**

当注册表服务已配置时：

```json
{
  "registered": true,
  "configured": true,
  "tokenId": 1,
  "agentName": "Eliza",
  "agentEndpoint": "https://...",
  "capabilitiesHash": "...",
  "isActive": true,
  "tokenURI": "https://...",
  "walletAddress": "0x...",
  "totalAgents": 42
}
```

当注册表服务未配置时：

```json
{
  "registered": false,
  "configured": false,
  "tokenId": 0,
  "agentName": "",
  "agentEndpoint": "",
  "capabilitiesHash": "",
  "isActive": false,
  "tokenURI": "",
  "walletAddress": "",
  "totalAgents": 0
}
```

---

<div id="post-apiregistryregister">

### POST /api/registry/register

</div>

向 elizaOS 注册表注册智能体。

**请求体**

| 字段 | 类型 | 必需 | 描述 |
|-------|------|----------|-------------|
| `name` | string | 否 | 智能体名称覆盖 |
| `endpoint` | string | 否 | 公共端点 URL |
| `tokenURI` | string | 否 | 注册使用的 Token URI |

**响应**

返回注册表服务的注册结果（模式取决于注册表实现）。

---

<div id="post-apiregistryupdate-uri">

### POST /api/registry/update-uri

</div>

更新智能体在注册表中的 token URI。

**请求体**

| 字段 | 类型 | 必需 | 描述 |
|-------|------|----------|-------------|
| `tokenURI` | string | 是 | 新的 token URI |

**响应**

```json
{
  "ok": true
}
```

---

<div id="post-apiregistrysync">

### POST /api/registry/sync

</div>

将智能体状态与注册表同步（心跳、状态更新）。

**请求体**

| 字段 | 类型 | 必需 | 描述 |
|-------|------|----------|-------------|
| `name` | string | 否 | 智能体名称覆盖 |
| `endpoint` | string | 否 | 公共端点 URL |
| `tokenURI` | string | 否 | Token URI |

**响应**

```json
{
  "ok": true,
  "txHash": "0x..."
}
```

---

<div id="get-apiregistryconfig">

### GET /api/registry/config

</div>

获取当前注册表配置。返回 `config.registry` 的内容以及链元数据。

**响应**

```json
{
  "chainId": 1,
  "explorerUrl": "https://etherscan.io",
  "...": "additional fields from config.registry"
}
```

确切的响应结构取决于 `eliza.json` 中 `registry` 键下的配置内容。
