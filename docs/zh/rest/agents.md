---
title: "代理 API"
sidebarTitle: "代理"
description: "用于代理生命周期管理、行政操作和传输（导出/导入）的 REST API 端点。"
---

所有代理端点都需要代理运行时已初始化。API 服务器默认运行在端口 **31337** 上，所有路径以 `/api/` 为前缀。当设置了 `ELIZA_API_TOKEN` 时，需在 `Authorization` 请求头中将其作为 `Bearer` 令牌传递。

<div id="endpoints">
## 端点
</div>

| 方法 | 路径 | 描述 |
|--------|------|-------------|
| POST | `/api/agent/start` | 启动代理并启用自主运行 |
| POST | `/api/agent/stop` | 停止代理并禁用自主运行 |
| POST | `/api/agent/pause` | 暂停代理（保持运行时间，禁用自主运行） |
| POST | `/api/agent/resume` | 恢复已暂停的代理并重新启用自主运行 |
| POST | `/api/agent/restart` | 重启代理运行时 |
| POST | `/api/agent/reset` | 清除配置、工作区、记忆并返回引导状态 |
| POST | `/api/agent/export` | 将代理导出为密码加密的 `.eliza-agent` 二进制文件 |
| GET | `/api/agent/export/estimate` | 在下载前估算导出文件大小 |
| POST | `/api/agent/import` | 从密码加密的 `.eliza-agent` 文件导入代理 |
| GET | `/api/agent/self-status` | 包含功能、钱包、插件和感知信息的结构化自我状态摘要 |

---

<div id="post-apiagentstart">
### POST /api/agent/start
</div>

启动代理并启用自主运行。将代理状态设置为 `running`，记录启动时间戳，并启用自主任务，使第一个 tick 立即触发。

**响应**

```json
{
  "ok": true,
  "status": {
    "state": "running",
    "agentName": "Eliza",
    "model": "@elizaos/plugin-anthropic",
    "uptime": 0,
    "startedAt": 1718000000000
  }
}
```

---

<div id="post-apiagentstop">
### POST /api/agent/stop
</div>

停止代理并禁用自主运行。将代理状态设置为 `stopped` 并清除运行时间跟踪。

**响应**

```json
{
  "ok": true,
  "status": {
    "state": "stopped",
    "agentName": "Eliza"
  }
}
```

---

<div id="post-apiagentpause">
### POST /api/agent/pause
</div>

暂停代理，同时保持运行时间不变。禁用自主运行，但保留 `startedAt` 时间戳和模型信息。

**响应**

```json
{
  "ok": true,
  "status": {
    "state": "paused",
    "agentName": "Eliza",
    "model": "@elizaos/plugin-anthropic",
    "uptime": 34200000,
    "startedAt": 1718000000000
  }
}
```

---

<div id="post-apiagentresume">
### POST /api/agent/resume
</div>

恢复已暂停的代理并重新启用自主运行。第一个 tick 会立即触发。

**响应**

```json
{
  "ok": true,
  "status": {
    "state": "running",
    "agentName": "Eliza",
    "model": "@elizaos/plugin-anthropic",
    "uptime": 34200000,
    "startedAt": 1718000000000
  }
}
```

---

<div id="post-apiagentrestart">
### POST /api/agent/restart
</div>

重启代理运行时。如果重启已在进行中则返回 `409`，如果当前模式不支持重启则返回 `501`。

**响应**

```json
{
  "ok": true,
  "pendingRestart": false,
  "status": {
    "state": "running",
    "agentName": "Eliza",
    "startedAt": 1718000000000
  }
}
```

---

<div id="post-apiagentreset">
### POST /api/agent/reset
</div>

清除配置、工作区（记忆）、OAuth 令牌，并返回引导状态。停止运行时，删除 `~/.eliza/` 状态目录（带有安全检查以防止删除系统路径），并重置所有服务器状态。

**响应**

```json
{
  "ok": true
}
```

---

<div id="post-apiagentexport">
### POST /api/agent/export
</div>

将整个代理导出为密码加密的 `.eliza-agent` 二进制文件。代理必须处于运行状态。返回 `application/octet-stream` 文件下载。

**请求**

| 参数 | 类型 | 必填 | 描述 |
|-----------|------|----------|-------------|
| `password` | string | 是 | 加密密码 — 最少 4 个字符 |
| `includeLogs` | boolean | 否 | 是否在导出中包含日志文件 |

**响应**

二进制文件下载，带有 `Content-Disposition: attachment; filename="agentname-YYYY-MM-DDTHH-MM-SS.eliza-agent"`。

---

<div id="get-apiagentexportestimate">
### GET /api/agent/export/estimate
</div>

在下载前估算导出文件大小。代理必须处于运行状态。

**响应**

```json
{
  "estimatedBytes": 1048576,
  "estimatedMb": 1.0
}
```

---

<div id="post-apiagentimport">
### POST /api/agent/import
</div>

从密码加密的 `.eliza-agent` 文件导入代理。请求体是一个二进制信封：`[4 字节密码长度（大端序 uint32）][密码字节][文件数据]`。最大导入大小为 512 MB。

**请求**

原始二进制请求体 — 非 JSON。前 4 个字节以大端序无符号 32 位整数编码密码长度，随后是 UTF-8 编码的密码，再后是文件数据。

**响应**

```json
{
  "ok": true
}
```

<div id="get-apiagentself-status">
### GET /api/agent/self-status
</div>

获取代理当前状态、功能、钱包状态、活跃插件以及可选的感知注册表快照的结构化摘要。专为程序化消费者和代理自身的自我感知系统设计。

**响应**

```json
{
  "generatedAt": "2026-04-09T12:00:00.000Z",
  "state": "running",
  "agentName": "Eliza",
  "model": "anthropic/claude-sonnet-4.6",
  "provider": "anthropic",
  "automationMode": "connectors-only",
  "tradePermissionMode": "ask",
  "shellEnabled": true,
  "wallet": {
    "hasWallet": true,
    "hasEvm": true,
    "hasSolana": false,
    "evmAddress": "0x1234...abcd",
    "evmAddressShort": "0x1234...abcd",
    "solanaAddress": null,
    "solanaAddressShort": null,
    "localSignerAvailable": true,
    "managedBscRpcReady": true
  },
  "plugins": {
    "totalActive": 12,
    "active": ["..."],
    "aiProviders": ["@elizaos/plugin-anthropic"],
    "connectors": ["@elizaos/plugin-discord"]
  },
  "capabilities": {
    "canTrade": true,
    "canLocalTrade": true,
    "canAutoTrade": false,
    "canUseBrowser": false,
    "canUseComputer": false,
    "canRunTerminal": true,
    "canInstallPlugins": true,
    "canConfigurePlugins": true,
    "canConfigureConnectors": true
  },
  "registrySummary": "Runtime: running | Wallet: EVM ready | Plugins: 12 active | Cloud: disconnected"
}
```

| 字段 | 类型 | 描述 |
|-------|------|-------------|
| `generatedAt` | string | 响应生成时的 ISO 8601 时间戳 |
| `state` | string | 当前代理状态（`not_started`、`starting`、`running`、`paused`、`stopped`、`restarting`、`error`） |
| `agentName` | string | 代理显示名称 |
| `model` | string\|null | 活跃模型标识符，从运行时状态、配置或环境中解析 |
| `provider` | string\|null | 从模型字符串派生的 AI 提供商标签 |
| `automationMode` | string | `"connectors-only"` 或 `"full"` — 控制自主行为的范围 |
| `tradePermissionMode` | string | 配置中的交易权限级别 |
| `shellEnabled` | boolean | 是否启用 shell/终端访问 |
| `wallet` | object | 钱包状态摘要（见下文） |
| `plugins` | object | 活跃插件摘要（见下文） |
| `capabilities` | object | 布尔类型的功能标志（见下文） |
| `registrySummary` | string\|undefined | 来自感知注册表的单行摘要（如可用） |

**`wallet` 字段**

| 字段 | 类型 | 描述 |
|-------|------|-------------|
| `hasWallet` | boolean | 如果配置了任何钱包地址则为 `true` |
| `hasEvm` | boolean | 如果 EVM 地址可用则为 `true` |
| `hasSolana` | boolean | 如果 Solana 地址可用则为 `true` |
| `evmAddress` | string\|null | 完整 EVM 地址 |
| `evmAddressShort` | string\|null | 缩写 EVM 地址（`0x1234...abcd`） |
| `solanaAddress` | string\|null | 完整 Solana 地址 |
| `solanaAddressShort` | string\|null | 缩写 Solana 地址 |
| `localSignerAvailable` | boolean | 如果设置了 `EVM_PRIVATE_KEY` 则为 `true` |
| `managedBscRpcReady` | boolean | 如果配置了托管 BSC RPC 端点则为 `true` |

**`plugins` 字段**

| 字段 | 类型 | 描述 |
|-------|------|-------------|
| `totalActive` | number | 活跃插件数量 |
| `active` | string[] | 所有活跃插件的名称 |
| `aiProviders` | string[] | 活跃 AI 提供商插件的名称 |
| `connectors` | string[] | 活跃连接器插件的名称（Discord、Telegram 等） |

**`capabilities` 字段**

| 字段 | 类型 | 描述 |
|-------|------|-------------|
| `canTrade` | boolean | 如果钱包和 RPC 已配置用于交易则为 `true` |
| `canLocalTrade` | boolean | 如果本地交易执行可用（钱包 + 签名者 + 权限）则为 `true` |
| `canAutoTrade` | boolean | 如果代理可以自主执行交易则为 `true` |
| `canUseBrowser` | boolean | 如果已加载浏览器插件则为 `true` |
| `canUseComputer` | boolean | 如果已加载计算机使用插件则为 `true` |
| `canRunTerminal` | boolean | 如果启用了 shell 访问则为 `true` |
| `canInstallPlugins` | boolean | 如果插件安装可用则为 `true` |
| `canConfigurePlugins` | boolean | 如果插件配置可用则为 `true` |
| `canConfigureConnectors` | boolean | 如果连接器配置可用则为 `true` |

---

<div id="common-error-codes">
## 常见错误代码
</div>

| 状态码 | 代码 | 描述 |
|--------|------|-------------|
| 400 | `INVALID_REQUEST` | 请求体格式错误或缺少必填字段 |
| 401 | `UNAUTHORIZED` | 缺少或无效的认证令牌 |
| 404 | `NOT_FOUND` | 请求的资源不存在 |
| 409 | `STATE_CONFLICT` | 代理处于不适用于此操作的状态 |
| 500 | `INTERNAL_ERROR` | 意外的服务器错误 |
| 500 | `AGENT_NOT_FOUND` | 未找到代理运行时或未初始化 |
