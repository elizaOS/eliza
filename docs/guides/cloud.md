---
title: "Eliza Cloud Integration"
sidebarTitle: "Eliza Cloud"
description: "Remote agent hosting and provisioning via Eliza Cloud with backup scheduling, connection monitoring, and proxy routing."
---

Eliza Cloud provides remote agent hosting and provisioning. The Eliza cloud integration allows you to deploy agents to Eliza Cloud, manage their lifecycle, route chat through remote sandboxes, and maintain persistent backups.

## Table of Contents

1. [Overview](#overview)
2. [Getting Started](#getting-started)
3. [Cloud Manager](#cloud-manager)
4. [Cloud Login Flow](#cloud-login-flow)
5. [Cloud Proxy](#cloud-proxy)
6. [Backup Scheduler](#backup-scheduler)
7. [Connection Monitor](#connection-monitor)
8. [Granular Cloud Service Toggles](#granular-cloud-service-toggles)
9. [Cloud Status and Credits](#cloud-status-and-credits)
10. [Credits and Billing](#credits-and-billing)
11. [API Endpoints](#api-endpoints)

---

## Overview

The Eliza Cloud integration consists of several components:

- **CloudManager** -- top-level orchestrator that manages the client, proxy, backup scheduler, and connection monitor
- **ElizaCloudClient** -- HTTP client for the Eliza Cloud Eliza Sandbox API
- **CloudRuntimeProxy** -- routes chat and runtime operations through the remote sandbox
- **BackupScheduler** -- periodic state snapshots to the cloud
- **ConnectionMonitor** -- heartbeat monitoring with exponential backoff reconnection

The default cloud base URL is `https://www.elizacloud.ai`.

---

## Getting Started

The following walkthrough covers the full lifecycle of connecting to Eliza Cloud, deploying a cloud agent, and disconnecting — using the local dashboard API running on port `2138`.

### Step 1: Start the Login Flow

```bash
curl -X POST http://localhost:31337/api/cloud/login \
  -H "Authorization: Bearer your-token"
```

Response:
```json
{
  "ok": true,
  "sessionId": "a1b2c3d4-...",
  "browserUrl": "https://www.elizacloud.ai/auth/cli-login?session=a1b2c3d4-..."
}
```

Open the `browserUrl` in your browser to authenticate.

### Step 2: Poll for Authentication

```bash
curl "http://localhost:31337/api/cloud/login/status?sessionId=a1b2c3d4-..."
```

Responses:
- `{"status": "pending"}` — still waiting for browser login
- `{"status": "authenticated", "keyPrefix": "mk_..."}` — login complete, API key saved
- `{"status": "expired", "error": "Session not found or expired"}` — timed out

On success, the API key is automatically saved to `eliza.json` and `process.env.ELIZAOS_CLOUD_API_KEY` is set.

### Step 3: Check Connection Status

```bash
curl http://localhost:31337/api/cloud/status
```

Response:
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

### Step 4: Create a Cloud Agent

```bash
curl -X POST http://localhost:31337/api/cloud/agents \
  -H "Authorization: Bearer your-token" \
  -H "Content-Type: application/json" \
  -d '{
    "agentName": "my-cloud-agent",
    "agentConfig": {},
    "environmentVars": {}
  }'
```

### Step 5: Connect to the Agent

```bash
curl -X POST http://localhost:31337/api/cloud/agents/agent-id/connect \
  -H "Authorization: Bearer your-token"
```

### Disconnecting

```bash
curl -X POST http://localhost:31337/api/cloud/disconnect \
  -H "Authorization: Bearer your-token"
```

This takes a final backup snapshot, clears the API key from config, and removes cloud env vars.

---

## Cloud Manager

The `CloudManager` class (`src/cloud/cloud-manager.ts`) orchestrates all cloud components. It tracks connection state through the following transitions:

```
disconnected → connecting → connected → reconnecting → error
      ↑                        │              │
      └────────────────────────┘──────────────┘
```

### Connection States

| State | Description |
|-------|-------------|
| `disconnected` | Not connected to Eliza Cloud |
| `connecting` | Connection attempt in progress |
| `connected` | Active connection to a cloud agent |
| `reconnecting` | Lost connection, attempting to restore |
| `error` | Connection failed (may transition to disconnected) |

### Initialization

The manager requires a `CloudConfig` with at minimum an `apiKey`. The base URL defaults to `https://www.elizacloud.ai`. URL validation is performed before any connection attempt (rejects non-HTTPS URLs, validates format).

### Connect Flow

```
CloudManager.connect(agentId)
  1. Initialize client (if needed)
  2. Set status → "connecting"
  3. Provision agent on cloud
  4. Get agent info (name, status)
  5. Create CloudRuntimeProxy
  6. Start BackupScheduler (default: 60s interval)
  7. Start ConnectionMonitor (default: 30s heartbeat)
  8. Set status → "connected"
```

### Disconnect Flow

```
CloudManager.disconnect()
  1. Take final backup snapshot
  2. Stop BackupScheduler
  3. Stop ConnectionMonitor
  4. Clear proxy and agent ID
  5. Set status → "disconnected"
```

---

## Cloud Login Flow

Authentication with Eliza Cloud uses a browser-based OAuth flow (`src/cloud/auth.ts`):

1. **Create session** -- POST to `/api/auth/cli-session` with a random UUID session ID
2. **Open browser** -- Direct user to `{baseUrl}/auth/cli-login?session={sessionId}`
3. **Poll for completion** -- GET `/api/auth/cli-session/{sessionId}` at 2-second intervals
4. **Receive API key** -- When `status === "authenticated"`, the response includes the API key

### Login Parameters

| Parameter | Default | Description |
|-----------|---------|-------------|
| `baseUrl` | `https://www.elizacloud.ai` | Cloud instance URL |
| `timeoutMs` | 300,000 (5 min) | Total login timeout |
| `requestTimeoutMs` | 10,000 (10 sec) | Per-request timeout |
| `pollIntervalMs` | 2,000 (2 sec) | Polling interval |

### Login Result

```typescript
interface CloudLoginResult {
  apiKey: string;
  keyPrefix: string;
  expiresAt: string | null;
}
```

### API-Based Login

The dashboard also provides a login flow via `POST /api/cloud/login` which returns a `sessionId` and `browserUrl`. The frontend then polls `GET /api/cloud/login/status?sessionId=...` until authentication completes. On success, the API key is:

1. Saved to the `eliza.json` config file
2. Set in `process.env.ELIZAOS_CLOUD_API_KEY` (runtime environment variable)
3. Persisted to the agent's database record (survives config-file resets)
4. Used to initialize the cloud manager

---

## Cloud Proxy

The `CloudRuntimeProxy` routes agent operations through the remote cloud sandbox. When connected, chat messages and runtime requests are forwarded to the cloud-hosted agent instance.

The proxy is created during `CloudManager.connect()` and carries the agent ID and agent name for routing.

---

## Backup Scheduler

The `BackupScheduler` (`src/cloud/backup.ts`) takes periodic state snapshots of the cloud agent.

- **Default interval**: 60 seconds (configurable via `cloud.backup.autoBackupIntervalMs`)
- **Mechanism**: Calls `client.snapshot(agentId)` on each tick
- **Final snapshot**: Taken during `CloudManager.disconnect()` before stopping
- **Failure handling**: Backup failures are logged as warnings but do not interrupt the agent

---

## Connection Monitor

The `ConnectionMonitor` (`src/cloud/reconnect.ts`) ensures the cloud connection stays alive via heartbeat checks.

### Configuration

| Parameter | Default | Description |
|-----------|---------|-------------|
| `heartbeatIntervalMs` | 30,000 (30 sec) | How often to check connection |
| `maxFailures` | 3 | Consecutive failures before triggering reconnect |

### Reconnection Strategy

When `maxFailures` consecutive heartbeat failures occur:

1. Status transitions to `reconnecting`
2. Up to 10 reconnection attempts with exponential backoff
3. Initial delay: 3 seconds
4. Backoff multiplier: 2x per attempt
5. Maximum delay: 60 seconds
6. On success: status returns to `connected`
7. After 10 failures: status transitions to `disconnected`

---

## Granular cloud service routing

Eliza Cloud linkage and Eliza Cloud service use are separate.

Once an Eliza Cloud account is linked, the connected server can route individual capabilities through Eliza Cloud without forcing every capability onto the cloud path. The canonical runtime config expresses that through `serviceRouting`, for example:

- `serviceRouting.llmText` for chat inference
- `serviceRouting.tts` for text-to-speech
- `serviceRouting.media` for image/video generation
- `serviceRouting.embeddings` for embeddings
- `serviceRouting.rpc` for wallet / blockchain RPC

That means a server can:

- run locally while using Eliza Cloud only for inference
- run on Eliza Cloud while still using OpenAI, Anthropic, or Ollama for inference
- keep Eliza Cloud linked for RPC or media while `llmText` uses another provider

Provider switching updates the canonical route for the selected capability. The current Eliza app treats `llmText` as the main inference route; additional capabilities are expected to move onto the same `serviceRouting` contract instead of legacy `cloud.services.*` flags.

---

## Cloud Status and Credits

### Status Endpoint

`GET /api/cloud/status` returns the current cloud connection state:

```json
{
  "connected": true,
  "enabled": true,
  "hasApiKey": true,
  "userId": "...",
  "organizationId": "...",
  "topUpUrl": "https://elizacloud.ai/dashboard/settings?tab=billing"
}
```

When not connected, the response includes a `reason` field: `"not_authenticated"`, `"runtime_not_started"`, `"api_key_present_not_authenticated"`, or `"api_key_present_runtime_not_started"`.

### Credits Endpoint

`GET /api/cloud/credits` returns the account balance:

```json
{
  "connected": true,
  "balance": 15.50,
  "low": false,
  "critical": false,
  "topUpUrl": "https://elizacloud.ai/dashboard/settings?tab=billing"
}
```

Balance thresholds: `low` is true when balance < $2.00, `critical` when < $0.50.

---

## Credits and Billing

Monitor your Eliza Cloud balance before and during agent operation to avoid service interruption.

```bash
curl http://localhost:31337/api/cloud/credits \
  -H "Authorization: Bearer your-token"
```

Response:
```json
{
  "connected": true,
  "balance": 12.50,
  "low": false,
  "critical": false,
  "topUpUrl": "https://elizacloud.ai/dashboard/settings?tab=billing"
}
```

| Field | Type | Description |
|-------|------|-------------|
| `balance` | number \| null | Current balance in USD |
| `low` | boolean | `true` when balance is below $2.00 |
| `critical` | boolean | `true` when balance is below $0.50 |
| `topUpUrl` | string | Direct link to the billing page |

When `low` or `critical` is `true`, consider topping up to avoid service interruption.

---

## API Endpoints

### Authentication

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/cloud/login` | Start browser-based login flow (returns sessionId and browserUrl) |
| `GET` | `/api/cloud/login/status?sessionId=...` | Poll login status |
| `POST` | `/api/cloud/disconnect` | Disconnect from cloud and clear credentials |

### Agent Management

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/cloud/agents` | List all cloud agents |
| `POST` | `/api/cloud/agents` | Create a new cloud agent (requires `agentName`) |
| `POST` | `/api/cloud/agents/:id/provision` | Provision and connect to a cloud agent |
| `POST` | `/api/cloud/agents/:id/connect` | Connect to an existing cloud agent |
| `POST` | `/api/cloud/agents/:id/shutdown` | Shut down and delete a cloud agent |

### Status

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/cloud/status` | Get cloud connection status and auth state |
| `GET` | `/api/cloud/credits` | Get account credit balance |
