---
title: "云 API"
sidebarTitle: "Cloud"
description: "用于 Eliza Cloud 身份验证、连接状态、信用余额和云代理管理的 REST API 端点。"
---

云 API 将本地 Eliza 代理连接到 Eliza Cloud，用于云端推理、信用和远程代理管理。登录使用基于浏览器的 OAuth 风格流程，并通过轮询来完成会话。

现在预计计费将保留在应用程序内，只要 Eliza Cloud 公开所需的计费端点。`/api/cloud/status` 和 `/api/cloud/credits` 返回的 `topUpUrl` 值应被视为托管备用方案，而非主要用户体验。

<div id="endpoints">

## 端点

</div>

<div id="post-apicloudlogin">

### POST /api/cloud/login

</div>

启动 Eliza Cloud 登录流程。在云端创建一个会话并返回一个浏览器 URL 供用户进行身份验证。使用返回的 `sessionId` 轮询 `GET /api/cloud/login/status` 以检查完成状态。

**响应**

```json
{
  "ok": true,
  "sessionId": "550e8400-e29b-41d4-a716-446655440000",
  "browserUrl": "https://www.elizacloud.ai/auth/cli-login?session=550e8400-e29b-41d4-a716-446655440000"
}
```

---

<div id="get-apicloudloginstatus">

### GET /api/cloud/login/status

</div>

轮询登录会话的状态。当状态为 `"authenticated"` 时，API 密钥会自动保存到配置中并应用于进程环境。

当启用云钱包功能（`ENABLE_CLOUD_WALLET=1`）时，成功登录还会触发尽力而为的云钱包配置。代理尝试从 Eliza Cloud 导入 EVM 和 Solana 钱包，并将它们设置为主钱包来源。如果配置失败，登录仍然成功——API 密钥会被保存，钱包配置失败会被记录，但不会影响身份验证响应。您可以稍后使用 `POST /api/wallet/refresh-cloud` 手动重试钱包配置。

**查询参数**

| 参数 | 类型 | 必需 | 描述 |
|------|------|------|------|
| `sessionId` | string | 是 | 由 `POST /api/cloud/login` 返回的会话 ID |

**响应 (pending)**

```json
{
  "status": "pending"
}
```

**响应 (authenticated)**

```json
{
  "status": "authenticated",
  "keyPrefix": "eca-..."
}
```

**可能的状态值**

| 状态 | 描述 |
|------|------|
| `"pending"` | 用户尚未完成身份验证 |
| `"authenticated"` | 登录成功 — API 密钥已保存 |
| `"expired"` | 会话已过期或未找到 |
| `"error"` | 与 Eliza Cloud 通信时发生错误 |

---

<div id="get-apicloudstatus">

### GET /api/cloud/status

</div>

获取云连接状态、身份验证状态和计费 URL。

**响应 (已连接)**

```json
{
  "connected": true,
  "enabled": true,
  "cloudVoiceProxyAvailable": true,
  "hasApiKey": true,
  "userId": "user-123",
  "organizationId": "org-456",
  "topUpUrl": "https://elizacloud.ai/dashboard/settings?tab=billing"
}
```

**响应 (未连接)**

```json
{
  "connected": false,
  "enabled": false,
  "cloudVoiceProxyAvailable": false,
  "hasApiKey": false,
  "reason": "not_authenticated"
}
```

| 字段 | 类型 | 描述 |
|------|------|------|
| `connected` | boolean | 云身份验证服务是否已认证 |
| `enabled` | boolean | 配置中是否启用了云模式 |
| `cloudVoiceProxyAvailable` | boolean | 当前会话是否可用云语音代理 |
| `hasApiKey` | boolean | 配置中是否存在 API 密钥 |
| `userId` | string | 已认证的用户 ID（连接时） |
| `organizationId` | string | 已认证的组织 ID（连接时） |
| `topUpUrl` | string | 云计费页面的 URL |
| `reason` | string | 断开连接状态的原因 |

---

<div id="get-apicloudcredits">

### GET /api/cloud/credits

</div>

获取云信用余额。未连接时返回 `null` 余额。

**响应**

```json
{
  "connected": true,
  "balance": 15.50,
  "low": false,
  "critical": false,
  "authRejected": false,
  "topUpUrl": "https://elizacloud.ai/dashboard/settings?tab=billing"
}
```

| 字段 | 类型 | 描述 |
|------|------|------|
| `balance` | number \| null | 信用余额（美元） |
| `low` | boolean | 余额低于 $2.00 时为 `true` |
| `critical` | boolean | 余额低于 $0.50 时为 `true` |
| `authRejected` | boolean | 信用检查期间云 API 密钥被拒绝时为 `true` |

---

<div id="billing-proxy-endpoints">

### 计费代理端点

</div>

这些端点通过本地 Eliza 后端代理已认证的 Eliza Cloud 计费 API，以便桌面应用程序可以在应用内保留计费、支付方式和充值功能。它们需要活跃的 Eliza Cloud 登录，因为本地服务器会转发保存的云 API 密钥。

仅当 Eliza Cloud 未返回应用程序可以直接渲染的嵌入式结账或加密货币报价流程时，才将 `topUpUrl` 用作托管备用方案。

<div id="get-apicloudbillingsummary">

#### GET /api/cloud/billing/summary

</div>

获取当前的 Eliza Cloud 计费摘要。

**典型响应**

```json
{
  "balance": 15.5,
  "currency": "USD",
  "embeddedCheckoutEnabled": false,
  "hostedCheckoutEnabled": true,
  "cryptoEnabled": true
}
```

<div id="get-apicloudbillingpayment-methods">

#### GET /api/cloud/billing/payment-methods

</div>

列出已认证 Eliza Cloud 账户的已保存支付方式。

<div id="get-apicloudbillinghistory">

#### GET /api/cloud/billing/history

</div>

列出最近的计费活动，包括充值和结算历史。

<div id="post-apicloudbillingcheckout">

#### POST /api/cloud/billing/checkout

</div>

创建计费结账会话。

**请求**

```json
{
  "amountUsd": 25,
  "mode": "hosted"
}
```

**典型响应**

```json
{
  "provider": "stripe",
  "mode": "hosted",
  "checkoutUrl": "https://checkout.stripe.com/c/pay/cs_xxx...",
  "sessionId": "cs_xxx..."
}
```

Eliza 在 Eliza Cloud 支持时优先使用嵌入式结账，但当前的云计费集成仍可能返回托管结账 URL。

<div id="post-apicloudbillingcryptoquote">

#### POST /api/cloud/billing/crypto/quote

</div>

请求用于信用充值的加密货币发票或报价。

**请求**

```json
{
  "amountUsd": 25,
  "walletAddress": "0xabc123..."
}
```

**典型响应**

```json
{
  "provider": "oxapay",
  "network": "BEP20",
  "currency": "USDC",
  "amount": "25.000",
  "amountUsd": 25,
  "paymentLinkUrl": "https://pay.example.com/track_123",
  "expiresAt": "2026-03-15T01:00:00.000Z"
}
```

---

<div id="post-apiclouddisconnect">

### POST /api/cloud/disconnect

</div>

断开与 Eliza Cloud 的连接。从配置、进程环境和代理数据库记录中清除 API 密钥。

**响应**

```json
{
  "ok": true,
  "status": "disconnected"
}
```

---

<div id="get-apicloudagents">

### GET /api/cloud/agents

</div>

列出云代理。需要活跃的云连接。

**响应**

```json
{
  "ok": true,
  "agents": [
    {
      "id": "550e8400-e29b-41d4-a716-446655440000",
      "name": "My Cloud Agent",
      "status": "running",
      "createdAt": "2024-06-10T12:00:00Z"
    }
  ]
}
```

---

<div id="post-apicloudagents">

### POST /api/cloud/agents

</div>

创建新的云代理。需要活跃的云连接。

**请求**

```json
{
  "agentName": "My Cloud Agent",
  "agentConfig": { "character": "eliza" },
  "environmentVars": { "OPENAI_API_KEY": "<OPENAI_API_KEY>" }
}
```

| 参数 | 类型 | 必需 | 描述 |
|------|------|------|------|
| `agentName` | string | 是 | 云代理的显示名称 |
| `agentConfig` | object | 否 | 代理配置对象 |
| `environmentVars` | object | 否 | 要在云代理上设置的环境变量 |

**响应 (201 Created)**

```json
{
  "ok": true,
  "agent": {
    "id": "550e8400-e29b-41d4-a716-446655440000",
    "name": "My Cloud Agent",
    "status": "provisioning"
  }
}
```

---

<div id="post-apicloudagentsidprovision">

### POST /api/cloud/agents/:id/provision

</div>

配置云代理 — 将本地代理连接到云代理实例。

**路径参数**

| 参数 | 类型 | 必需 | 描述 |
|------|------|------|------|
| `id` | UUID | 是 | 云代理 ID |

**响应**

```json
{
  "ok": true,
  "agentId": "550e8400-e29b-41d4-a716-446655440000",
  "agentName": "My Cloud Agent",
  "status": { "connected": true }
}
```

---

<div id="post-apicloudagentsidshutdown">

### POST /api/cloud/agents/:id/shutdown

</div>

关闭并删除云代理。

**路径参数**

| 参数 | 类型 | 必需 | 描述 |
|------|------|------|------|
| `id` | UUID | 是 | 云代理 ID |

**响应**

```json
{
  "ok": true,
  "agentId": "550e8400-e29b-41d4-a716-446655440000",
  "status": "stopped"
}
```

---

<div id="post-apicloudagentsidconnect">

### POST /api/cloud/agents/:id/connect

</div>

连接到现有的云代理（首先断开与当前活跃代理的连接）。

**路径参数**

| 参数 | 类型 | 必需 | 描述 |
|------|------|------|------|
| `id` | UUID | 是 | 云代理 ID |

**响应**

```json
{
  "ok": true,
  "agentId": "550e8400-e29b-41d4-a716-446655440000",
  "agentName": "My Cloud Agent",
  "status": { "connected": true }
}
```
