---
title: "Cloud API"
sidebarTitle: "Cloud"
description: "REST API endpoints for Eliza Cloud authentication, connection status, credit balance, and cloud agent management."
---

The cloud API connects the local Eliza agent to Eliza Cloud for cloud-hosted inference, credits, and remote agent management. Login uses a browser-based OAuth-style flow with polling for session completion.

Billing is now expected to stay inside the app whenever Eliza Cloud exposes the required billing endpoints. The `topUpUrl` values returned by `/api/cloud/status` and `/api/cloud/credits` should be treated as a hosted fallback, not the primary UX.

## Endpoints

### POST /api/cloud/login

Start the Eliza Cloud login flow. Creates a session on the cloud and returns a browser URL for the user to authenticate. Poll `GET /api/cloud/login/status` with the returned `sessionId` to check completion.

**Response**

```json
{
  "ok": true,
  "sessionId": "550e8400-e29b-41d4-a716-446655440000",
  "browserUrl": "https://www.elizacloud.ai/auth/cli-login?session=550e8400-e29b-41d4-a716-446655440000"
}
```

---

### GET /api/cloud/login/status

Poll the status of a login session. When status is `"authenticated"`, the API key is automatically saved to config and applied to the process environment.

When the cloud wallet feature is enabled (`ENABLE_CLOUD_WALLET=1`), a successful login also triggers best-effort cloud wallet provisioning. The agent attempts to import EVM and Solana wallets from Eliza Cloud and set them as the primary wallet source. If provisioning fails, the login still succeeds — the API key is saved, and the wallet provisioning failure is logged without affecting the authentication response. You can manually retry wallet provisioning later using `POST /api/wallet/refresh-cloud`.

**Query Parameters**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `sessionId` | string | Yes | Session ID returned by `POST /api/cloud/login` |

**Response (pending)**

```json
{
  "status": "pending"
}
```

**Response (authenticated)**

```json
{
  "status": "authenticated",
  "keyPrefix": "eca-..."
}
```

**Possible status values**

| Status | Description |
|--------|-------------|
| `"pending"` | User has not yet completed authentication |
| `"authenticated"` | Login successful — API key has been saved |
| `"expired"` | Session expired or not found |
| `"error"` | An error occurred communicating with Eliza Cloud |

---

### GET /api/cloud/status

Get cloud connection status, authentication state, and billing URL.

**Response (connected)**

```json
{
  "connected": true,
  "enabled": true,
  "hasApiKey": true,
  "userId": "user-123",
  "organizationId": "org-456",
  "topUpUrl": "https://elizacloud.ai/dashboard/settings?tab=billing"
}
```

**Response (not connected)**

```json
{
  "connected": false,
  "enabled": true,
  "hasApiKey": false,
  "userId": null,
  "organizationId": null,
  "topUpUrl": "https://elizacloud.ai"
}
```

| Field | Type | Description |
|-------|------|-------------|
| `connected` | boolean | Whether the cloud auth service is authenticated |
| `enabled` | boolean | Whether cloud mode is enabled in config |
| `cloudVoiceProxyAvailable` | boolean | Whether cloud voice proxy is available for the current session (may be omitted) |
| `hasApiKey` | boolean | Whether an API key is present in config |
| `userId` | string\|null | Authenticated user ID, or `null` when not connected |
| `organizationId` | string\|null | Authenticated organization ID, or `null` when not connected |
| `topUpUrl` | string | URL to the cloud billing page |

---

### GET /api/cloud/credits

Get the cloud credit balance. Returns `null` balance when not connected.

**Response**

```json
{
  "connected": true,
  "balance": 15.50,
  "low": false,
  "critical": false,
  "topUpUrl": "https://elizacloud.ai/dashboard/settings?tab=billing"
}
```

| Field | Type | Description |
|-------|------|-------------|
| `connected` | boolean | Whether the cloud auth service is authenticated |
| `balance` | number \| null | Credit balance in dollars, or `null` when not connected |
| `low` | boolean | `true` when balance is below $2.00 |
| `critical` | boolean | `true` when balance is below $0.50 |
| `authRejected` | boolean | `true` when the cloud API key was rejected during the credit check |
| `topUpUrl` | string | URL to the cloud billing page |

---

### Billing proxy endpoints

These endpoints proxy authenticated Eliza Cloud billing APIs through the local Eliza backend so the desktop app can keep billing, payment methods, and top-ups in-app. They require an active Eliza Cloud login because the local server forwards the saved cloud API key.

Use `topUpUrl` only as a hosted fallback if Eliza Cloud does not return an embedded checkout or crypto quote flow the app can render directly.

#### GET /api/cloud/billing/summary

Get the current Eliza Cloud billing summary.

**Typical response**

```json
{
  "balance": 15.5,
  "currency": "USD",
  "embeddedCheckoutEnabled": false,
  "hostedCheckoutEnabled": true,
  "cryptoEnabled": true
}
```

#### GET /api/cloud/billing/payment-methods

List saved payment methods for the authenticated Eliza Cloud account.

#### GET /api/cloud/billing/history

List recent billing activity, including top-ups and settlement history.

#### POST /api/cloud/billing/checkout

Create a billing checkout session.

**Request**

```json
{
  "amountUsd": 25,
  "mode": "hosted"
}
```

**Typical response**

```json
{
  "provider": "stripe",
  "mode": "hosted",
  "checkoutUrl": "https://checkout.stripe.com/c/pay/cs_xxx...",
  "sessionId": "cs_xxx..."
}
```

Eliza prefers embedded checkout when Eliza Cloud supports it, but the current cloud billing integration can still return a hosted checkout URL.

#### POST /api/cloud/billing/crypto/quote

Request a crypto invoice or quote for a credit top-up.

**Request**

```json
{
  "amountUsd": 25,
  "walletAddress": "0xabc123..."
}
```

**Typical response**

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

### POST /api/cloud/disconnect

Disconnect from Eliza Cloud. Clears the API key from config, process environment, and agent database record.

**Response**

```json
{
  "ok": true,
  "status": "disconnected"
}
```

---

### GET /api/cloud/agents

List cloud agents. Requires an active cloud connection.

**Response**

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

### POST /api/cloud/agents

Create a new cloud agent. Requires an active cloud connection.

**Request**

```json
{
  "agentName": "My Cloud Agent",
  "agentConfig": { "character": "eliza" },
  "environmentVars": { "OPENAI_API_KEY": "<OPENAI_API_KEY>" }
}
```

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `agentName` | string | Yes | Display name for the cloud agent |
| `agentConfig` | object | No | Agent configuration object |
| `environmentVars` | object | No | Environment variables to set on the cloud agent |

**Response (201 Created)**

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

### POST /api/cloud/agents/:id/provision

Provision a cloud agent — connect the local agent to the cloud agent instance.

**Path Parameters**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `id` | UUID | Yes | Cloud agent ID |

**Response**

```json
{
  "ok": true,
  "agentId": "550e8400-e29b-41d4-a716-446655440000",
  "agentName": "My Cloud Agent",
  "status": { "connected": true }
}
```

---

### POST /api/cloud/agents/:id/shutdown

Shutdown and delete a cloud agent.

**Path Parameters**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `id` | UUID | Yes | Cloud agent ID |

**Response**

```json
{
  "ok": true,
  "agentId": "550e8400-e29b-41d4-a716-446655440000",
  "status": "stopped"
}
```

---

### POST /api/cloud/agents/:id/connect

Connect to an existing cloud agent (disconnecting from any currently active agent first).

**Path Parameters**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `id` | UUID | Yes | Cloud agent ID |

**Response**

```json
{
  "ok": true,
  "agentId": "550e8400-e29b-41d4-a716-446655440000",
  "agentName": "My Cloud Agent",
  "status": { "connected": true }
}
```
