---
title: "System API"
sidebarTitle: "System"
description: "REST API endpoints for system status, runtime introspection, provider switching, process restart, configuration management, and TTS proxy."
---

The system API covers core server operations that don't belong to a specific domain: health checks, runtime debugging, AI provider switching, process restart, configuration CRUD, and the ElevenLabs TTS proxy.

## Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/status` | Agent status and health check |
| GET | `/api/health` | Structured subsystem health check |
| GET | `/api/runtime` | Deep runtime introspection |
| POST | `/api/provider/switch` | Switch the active AI provider |
| POST | `/api/restart` | Restart the server process |
| GET | `/api/config` | Get the full configuration (redacted) |
| GET | `/api/config/schema` | Get the configuration JSON schema |
| PUT | `/api/config` | Update configuration |
| POST | `/api/tts/elevenlabs` | ElevenLabs text-to-speech proxy |
| POST | `/api/tts/cloud` | Eliza Cloud text-to-speech proxy |
| POST | `/api/terminal/run` | Execute a shell command |
| POST | `/api/ingest/share` | Submit shared content for ingestion |
| GET | `/api/ingest/share` | Retrieve the share ingest queue |

---

### GET /api/status

Returns the agent's current state, name, model, uptime, cloud connection status, and whether a restart is pending.

**Response**

```json
{
  "state": "running",
  "agentName": "Eliza",
  "model": "@elizaos/plugin-anthropic",
  "startedAt": 1718000000000,
  "uptime": 3600000,
  "startup": {
    "phase": "ready",
    "attempt": 1
  },
  "cloud": {
    "connectionStatus": "disconnected",
    "activeAgentId": null,
    "cloudProvisioned": false,
    "hasApiKey": false
  },
  "pendingRestart": false,
  "pendingRestartReasons": []
}
```

| Field | Type | Description |
|-------|------|-------------|
| `state` | string | `not_started`, `starting`, `running`, `paused`, `stopped`, `restarting`, or `error` |
| `agentName` | string | Current agent display name |
| `model` | string\|undefined | Active model/plugin identifier |
| `startedAt` | number\|undefined | Unix timestamp (ms) when the agent started |
| `uptime` | number\|undefined | Milliseconds since the agent started |
| `startup` | object | Startup diagnostics with `phase`, `attempt`, and optional error fields |
| `pendingRestart` | boolean | Whether configuration changes require a restart |
| `pendingRestartReasons` | string[] | Descriptions of what changed |

---

### GET /api/health

Structured health check endpoint that returns the status of each subsystem. The `ready` field indicates whether the agent has finished starting and is available to serve requests.

**Response**

```json
{
  "ready": true,
  "runtime": "ok",
  "database": "ok",
  "plugins": {
    "loaded": 12,
    "failed": 0
  },
  "coordinator": "ok",
  "connectors": {
    "discord": "connected",
    "telegram": "configured"
  },
  "uptime": 3600,
  "agentState": "running",
  "startup": {
    "phase": "ready",
    "attempt": 1
  }
}
```

| Field | Type | Description |
|-------|------|-------------|
| `ready` | boolean | `false` while agent state is `starting` or `restarting`, `true` otherwise |
| `runtime` | string | `"ok"` if the runtime is initialized, `"not_initialized"` otherwise |
| `database` | string | `"ok"` if the runtime is initialized, `"unknown"` otherwise |
| `plugins.loaded` | number | Count of enabled plugins |
| `plugins.failed` | number | Count of plugins that failed to load |
| `coordinator` | string | `"ok"` if the swarm coordinator service is available, `"not_wired"` otherwise |
| `connectors` | object | Map of connector name to status string |
| `uptime` | number | Seconds since the agent started |
| `agentState` | string | Current agent state (`not_started`, `starting`, `running`, `paused`, `stopped`, `restarting`, `error`) |
| `startup` | object | Startup diagnostics with `phase`, `attempt`, and optional `lastError`, `lastErrorAt`, `nextRetryAt` fields |

---

### GET /api/runtime

Deep runtime introspection endpoint for advanced debugging. Returns detailed information about plugins, actions, providers, evaluators, and services registered in the runtime.

**Query Parameters**

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `depth` | number | 10 | Max object nesting depth (capped at 24) |
| `maxArrayLength` | number | 1000 | Max array elements to include |
| `maxObjectEntries` | number | 1000 | Max object entries to include |
| `maxStringLength` | number | 8000 | Max string truncation length |

**Response**

```json
{
  "runtimeAvailable": true,
  "generatedAt": 1718000000000,
  "settings": { "maxDepth": 3, "..." : "..." },
  "meta": {
    "agentId": "uuid",
    "agentState": "running",
    "agentName": "Eliza",
    "model": "@elizaos/plugin-anthropic",
    "pluginCount": 12,
    "actionCount": 45,
    "providerCount": 8,
    "evaluatorCount": 3,
    "serviceTypeCount": 6,
    "serviceCount": 10
  },
  "order": {
    "plugins": ["@elizaos/plugin-example", "..."],
    "actions": ["CHAT", "..."],
    "providers": ["..."],
    "evaluators": ["..."],
    "services": { "MODEL": ["..."] }
  },
  "sections": {
    "runtime": { "..." : "..." },
    "plugins": [ "..." ],
    "actions": [ "..." ],
    "providers": [ "..." ],
    "evaluators": [ "..." ],
    "services": { "..." : "..." }
  }
}
```

---

### POST /api/provider/switch

Atomically switch the active AI provider selection. The server persists the
selection into canonical runtime config, primarily `serviceRouting.llmText`,
updates linked-account state when needed, and triggers a restart after the
switch.

**Request Body**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `provider` | string | Yes | Provider ID |
| `apiKey` | string | No | Optional new credential to store for the selected provider. Max 512 characters. |
| `primaryModel` | string | No | Optional primary model override for local providers that support it |

Canonical providers: `elizacloud`, `openai-subscription`, `anthropic-subscription`, `openai`, `anthropic`, `deepseek`, `gemini`, `groq`, `grok`, `openrouter`, `ollama`, `mistral`, `together`, `zai`.

Compatibility aliases are still accepted on input and normalized before persistence, including `google`, `google-genai`, `xai`, and `openai-codex`.

When switching to `elizacloud`, text inference is routed through the Eliza
Cloud proxy. Switching away from `elizacloud` changes only the active text
route; linked cloud accounts and other routed cloud services can remain
available independently.

**Response**

```json
{
  "success": true,
  "provider": "anthropic",
  "restarting": true
}
```

**Errors**

| Status | Condition |
|--------|-----------|
| 400 | Missing or invalid provider |
| 400 | API key is too long (max 512 characters) |
| 409 | Provider switch already in progress |

---

### POST /api/restart

Restart the server process. Sets the agent state to `restarting`, broadcasts a status update, and responds immediately. The process exits after a short delay.

**Response**

```json
{
  "ok": true
}
```

---

### GET /api/config

Returns the full Eliza configuration with secret values redacted.

**Response**

The full config object — structure varies based on what has been configured. Secrets are replaced with redacted placeholders.

---

### GET /api/config/schema

Returns the JSON schema for the Eliza configuration file. Useful for building dynamic configuration UIs.

**Response**

A JSON Schema object describing all config keys, types, and defaults.

---

### PUT /api/config

Update one or more configuration keys. Uses a deep-merge strategy — provided
keys are merged recursively without wiping sibling keys. Protected against
prototype pollution.

Canonical runtime routing and hosting live in these top-level config fields:

- `deploymentTarget`
- `linkedAccounts`
- `serviceRouting`

The server resolves runtime behavior from those canonical fields. Client flows
should update hosting and routing there instead of sending legacy onboarding
mirrors or provider-specific compatibility blobs. Initial onboarding secrets
belong on `POST /api/onboarding` under `credentialInputs`; `PUT /api/config`
is for persisted canonical config, not for replaying old onboarding payloads.

**Request Body**

Partial config object. Only provided keys are updated:

```json
{
  "ui": {
    "theme": "haxor"
  },
  "models": {
    "small": "openai/gpt-5-mini"
  }
}
```

**Response**

Returns the updated redacted config snapshot.

---

### POST /api/tts/elevenlabs

Proxy endpoint for ElevenLabs text-to-speech. Forwards the request to the ElevenLabs API and returns the audio stream. Resolves the API key from the request body, config, or `ELEVENLABS_API_KEY` env var.

**Request Body**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `text` | string | Yes | Text to synthesize |
| `voiceId` | string | No | ElevenLabs voice ID (default: `EXAVITQu4vr4xnSDxMaL`) |
| `modelId` | string | No | Model ID (default: `eleven_flash_v2_5`) |
| `outputFormat` | string | No | Output format (default: `mp3_22050_32`) |
| `apiKey` | string | No | Override API key |
| `apply_text_normalization` | string | No | `auto`, `on`, or `off` |
| `voice_settings` | object | No | `{ stability?, similarity_boost?, speed? }` |

**Response**

Binary audio stream with `Content-Type: audio/mpeg`.

**Errors**

| Status | Condition |
|--------|-----------|
| 400 | Missing text or API key not available |
| 429 | ElevenLabs rate limit |
| 502 | ElevenLabs request failed |

---

### POST /api/tts/cloud

Proxy endpoint for Eliza Cloud text-to-speech. Sends the request to the Eliza Cloud TTS service and returns the audio stream. Requires an active Eliza Cloud connection with a valid API key.

The endpoint resolves the cloud API key from (in order): `ELIZAOS_CLOUD_API_KEY` environment variable, `cloud.apiKey` in the config file, or the sealed secret store.

**Request Body**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `text` | string | Yes | Text to synthesize |
| `voiceId` | string | No | ElevenLabs voice id (e.g. premade `EXAVITQu4vr4xnSDxMaL`). OpenAI-style names (`nova`, `alloy`, …) and Edge/Azure neural ids (`en-US-AriaNeural`, …) are mapped to the default premade voice. Same behavior for snake_case `voice_id`. Override default via `ELIZAOS_CLOUD_TTS_VOICE`. |
| `modelId` | string | No | ElevenLabs model id (default: `eleven_flash_v2_5`). OpenAI TTS ids (`gpt-*-tts`, `tts-1`, …) and OpenAI voice names sent by mistake are coerced to `eleven_flash_v2_5`. Same for snake_case `model_id` and `ELIZAOS_CLOUD_TTS_MODEL`. |

**Response**

Binary audio stream with `Content-Type: audio/mpeg`.

**Errors**

| Status | Condition |
|--------|-----------|
| 400 | Missing text, invalid JSON, or text over 5000 characters (Eliza Cloud limit) |
| 401 | Eliza Cloud is not connected (no API key available), or upstream rejected the cloud API key |
| 402 | Upstream: insufficient Eliza Cloud credits for TTS (JSON body may include `required`) |
| 429 | Upstream rate limit |
| 502 | Eliza Cloud TTS request failed after retries (e.g. gateway errors) |

---

### POST /api/terminal/run

Execute a shell command on the server and stream output via WebSocket. Responds immediately — output is broadcast as `terminal-output` WebSocket events.

**Request Body**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `command` | string | Yes | Shell command to execute |
| `clientId` | string | Conditional | WebSocket client ID to receive output. Required if not provided via header. |
| `terminalToken` | string | Conditional | Required when `ELIZA_TERMINAL_RUN_TOKEN` is configured |

The `clientId` can alternatively be sent via the `X-Eliza-Client-Id` header.

**Constraints**

- Max 4096 characters
- Single line only (no newlines or control characters)
- Concurrent runs are rate-limited

**Response**

```json
{
  "ok": true
}
```

Output is streamed via WebSocket:

```json
{ "type": "terminal-output", "runId": "run-...", "event": "stdout", "data": "..." }
{ "type": "terminal-output", "runId": "run-...", "event": "exit", "code": 0 }
```

**Errors**

| Status | Condition |
|--------|-----------|
| 400 | Missing client ID (provide `clientId` in body or `X-Eliza-Client-Id` header) |
| 400 | Missing or empty command |
| 403 | Shell access is disabled |
| 403 | Terminal authorization required (invalid `terminalToken`) |
| 429 | Too many concurrent terminal runs |

---

### POST /api/ingest/share

Submit external content (URLs, text, articles) to the agent's share ingest queue for processing.

**Request Body**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `source` | string | No | Content source identifier |
| `title` | string | No | Content title |
| `url` | string | No | Content URL |
| `text` | string | No | Content body text |

**Response**

```json
{
  "ok": true,
  "item": {
    "id": "uuid",
    "source": "chrome-extension",
    "title": "Article Title",
    "url": "https://example.com/article",
    "suggestedPrompt": "What do you think about \"Article Title\"?",
    "receivedAt": 1718000000000
  }
}
```

---

### GET /api/ingest/share

Retrieve the share ingest queue.

**Query Parameters**

| Parameter | Type | Description |
|-----------|------|-------------|
| `consume` | string | Set to `1` to consume (clear) the queue after reading |

**Response**

```json
{
  "items": [
    {
      "id": "uuid",
      "source": "chrome-extension",
      "title": "...",
      "receivedAt": 1718000000000
    }
  ]
}
```
