---
title: "Agents API"
sidebarTitle: "Agents"
description: "REST API endpoints for agent lifecycle, administration, and transfer (export/import)."
---

All agent endpoints require the agent runtime to be initialized. The API server runs on port **2138** by default when started with `eliza start`. In dev mode (`bun run dev`), the API splits to port **31337** while the UI stays on **2138**. Override with `ELIZA_API_PORT` (dev API) or `ELIZA_PORT` (server-only / UI). All paths are prefixed with `/api/`. When `ELIZA_API_TOKEN` is set, include it as a `Bearer` token in the `Authorization` header.

## Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/agents` | List running agent(s) |
| POST | `/api/agent/start` | Start the agent |
| POST | `/api/agent/stop` | Stop the agent and disable autonomy |
| POST | `/api/agent/pause` | Pause the agent (keep uptime, disable autonomy) |
| POST | `/api/agent/resume` | Resume a paused agent and re-enable autonomy |
| POST | `/api/agent/restart` | Restart the agent runtime (also available as `POST /api/restart`) |
| POST | `/api/agent/reset` | Wipe config, workspace, memory and return to onboarding |
| POST | `/api/agent/export` | Export agent as a password-encrypted `.eliza-agent` binary file |
| GET | `/api/agent/export/estimate` | Estimate export file size before downloading |
| POST | `/api/agent/import` | Import agent from a password-encrypted `.eliza-agent` file |
| GET | `/api/agent/autonomy` | Check whether autonomy is enabled |
| POST | `/api/agent/autonomy` | Enable or disable autonomy |
| GET | `/api/agent/events` | Get buffered agent events (actions, thoughts, status changes) |
| GET | `/api/agent/self-status` | Structured self-status summary with capabilities, wallet, plugins, and awareness |

---

### GET /api/agents

List the running agent(s). The app runs a single agent; the response wraps it in an `agents` array for compatibility with multi-agent callers and health probes.

**Response**

```json
{
  "agents": [
    {
      "id": "550e8400-e29b-41d4-a716-446655440000",
      "name": "Eliza",
      "status": "running"
    }
  ]
}
```

| Field | Type | Description |
|-------|------|-------------|
| `agents[].id` | string | Agent UUID (falls back to a nil UUID if the runtime is not started) |
| `agents[].name` | string | Agent display name from the character config |
| `agents[].status` | string | Current agent state (`not_started`, `starting`, `running`, `paused`, `stopped`, `restarting`, `error`) |

---

### POST /api/agent/start

Start the agent. Sets the agent state to `running`, records the start timestamp, and detects the active model provider.

**Response**

```json
{
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

### POST /api/agent/stop

Stop the agent and disable autonomy. Sets the agent state to `stopped` and clears uptime tracking.

**Response**

```json
{
  "status": {
    "state": "stopped",
    "agentName": "Eliza",
    "model": "@elizaos/plugin-anthropic",
    "startedAt": 1718000000000,
    "uptime": 34200000
  }
}
```

---

### POST /api/agent/pause

Pause the agent while keeping uptime intact. Disables autonomy but preserves the `startedAt` timestamp and model info.

**Response**

```json
{
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

### POST /api/agent/resume

Resume a paused agent and re-enable autonomy. The first tick fires immediately.

**Response**

```json
{
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

### GET /api/agent/autonomy

Check whether autonomous operation is currently enabled.

**Response**

```json
{
  "enabled": true
}
```

---

### POST /api/agent/autonomy

Enable or disable autonomous operation.

**Request Body**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `enabled` | boolean | Yes | Whether to enable autonomy |

**Response**

```json
{
  "enabled": true
}
```

---

### POST /api/agent/restart

Restart the agent runtime. Returns `409` if a restart is already in progress and `501` if restart is not supported in the current mode.

**Response**

```json
{
  "status": {
    "state": "running",
    "agentName": "Eliza",
    "model": "@elizaos/plugin-anthropic",
    "startedAt": 1718000000000
  }
}
```

---

### POST /api/agent/reset

Wipe memory, onboarding config, cloud secrets, and return to onboarding state. Stops the runtime, deletes the PGlite database directory (with safety checks), clears persisted onboarding and cloud credentials, and resets server state. GGUF models and the state directory itself are preserved.

This is a sensitive endpoint with stricter authorization:
- If `ELIZA_API_TOKEN` is configured, the request must include it as a Bearer token.
- If no token is configured, the request is only allowed from loopback addresses (localhost). Non-loopback requests without a token return `403`.

**Response**

```json
{
  "ok": true
}
```

---

### POST /api/agent/export

Export the entire agent as a password-encrypted `.eliza-agent` binary file. The agent must be running. Returns an `application/octet-stream` file download.

**Request**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `password` | string | Yes | Encryption password — minimum 4 characters |
| `includeLogs` | boolean | No | Whether to include log files in the export |

**Response**

Binary file download with `Content-Disposition: attachment; filename="agentname-YYYY-MM-DDTHH-MM-SS.eliza-agent"`.

---

### GET /api/agent/export/estimate

Estimate the export file size before downloading. The agent must be running.

**Response**

```json
{
  "estimatedBytes": 1048576,
  "estimatedMb": 1.0
}
```

---

### POST /api/agent/import

Import an agent from a password-encrypted `.eliza-agent` file. The request body is a binary envelope: `[4 bytes password length (big-endian uint32)][password bytes][file data]`. Maximum import size is 512 MB.

**Request**

Raw binary body — not JSON. The first 4 bytes encode the password length as a big-endian unsigned 32-bit integer, followed by the UTF-8 password, followed by the file data.

**Response**

```json
{
  "ok": true
}
```

### GET /api/agent/events

Get buffered agent events including actions, thoughts, and status changes. Supports long-polling via the `since` parameter to receive only new events.

**Query Parameters**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `since` | string | No | Event ID to start from (returns only events after this ID) |

**Response**

```json
{
  "events": [],
  "latestEventId": null,
  "totalBuffered": 0,
  "replayed": true
}
```

---

### GET /api/agent/self-status

Get a structured summary of the agent's current state, capabilities, wallet status, active plugins, and an optional awareness registry snapshot. Designed for programmatic consumers and the agent's own self-awareness system.

**Response**

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

| Field | Type | Description |
|-------|------|-------------|
| `generatedAt` | string | ISO 8601 timestamp of when the response was generated |
| `state` | string | Current agent state (`not_started`, `starting`, `running`, `paused`, `stopped`, `restarting`, `error`) |
| `agentName` | string | Agent display name |
| `model` | string\|null | Active model identifier, resolved from runtime state, config, or environment |
| `provider` | string\|null | AI provider label derived from the model string |
| `automationMode` | string | `"connectors-only"` or `"full"` — controls scope of autonomous behavior |
| `tradePermissionMode` | string | Trade permission level from config |
| `shellEnabled` | boolean | Whether shell/terminal access is enabled |
| `wallet` | object | Wallet state summary (see below) |
| `plugins` | object | Active plugin summary (see below) |
| `capabilities` | object | Boolean capability flags (see below) |
| `registrySummary` | string\|undefined | One-line summary from the awareness registry, if available |

**`wallet` fields**

| Field | Type | Description |
|-------|------|-------------|
| `hasWallet` | boolean | `true` if any wallet address is configured |
| `hasEvm` | boolean | `true` if an EVM address is available |
| `hasSolana` | boolean | `true` if a Solana address is available |
| `evmAddress` | string\|null | Full EVM address |
| `evmAddressShort` | string\|null | Shortened EVM address (`0x1234...abcd`) |
| `solanaAddress` | string\|null | Full Solana address |
| `solanaAddressShort` | string\|null | Shortened Solana address |
| `localSignerAvailable` | boolean | `true` if `EVM_PRIVATE_KEY` is set |
| `managedBscRpcReady` | boolean | `true` if the managed BSC RPC endpoint is configured |

**`plugins` fields**

| Field | Type | Description |
|-------|------|-------------|
| `totalActive` | number | Count of active plugins |
| `active` | string[] | Names of all active plugins |
| `aiProviders` | string[] | Names of active AI provider plugins |
| `connectors` | string[] | Names of active connector plugins (Discord, Telegram, etc.) |

**`capabilities` fields**

| Field | Type | Description |
|-------|------|-------------|
| `canTrade` | boolean | `true` if wallet and RPC are configured for trading |
| `canLocalTrade` | boolean | `true` if local trade execution is available (wallet + signer + permission) |
| `canAutoTrade` | boolean | `true` if the agent can execute trades autonomously |
| `canUseBrowser` | boolean | `true` if a browser plugin is loaded |
| `canUseComputer` | boolean | `true` if a computer-use plugin is loaded |
| `canRunTerminal` | boolean | `true` if shell access is enabled |
| `canInstallPlugins` | boolean | `true` if plugin installation is available |
| `canConfigurePlugins` | boolean | `true` if plugin configuration is available |
| `canConfigureConnectors` | boolean | `true` if connector configuration is available |

---

## Common Error Codes

| Status | Code | Description |
|--------|------|-------------|
| 400 | `INVALID_REQUEST` | Request body is malformed or missing required fields |
| 401 | `UNAUTHORIZED` | Missing or invalid authentication token |
| 404 | `NOT_FOUND` | Requested resource does not exist |
| 409 | `STATE_CONFLICT` | Agent is in an invalid state for this operation |
| 500 | `INTERNAL_ERROR` | Unexpected server error |
| 500 | `AGENT_NOT_FOUND` | Agent runtime not found or not initialized |
