---
title: "Secrets API"
sidebarTitle: "Secrets"
description: "REST API endpoints for managing API keys and secrets used by plugins and providers."
---

The secrets API manages API keys and credentials for AI providers, blockchain RPCs, and third-party services. Secrets are stored in the Eliza config file and synced to `process.env` at runtime. Values are returned in redacted form — the UI can display which keys are set without exposing their contents.

## Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/secrets` | List all configured secrets (redacted) |
| PUT | `/api/secrets` | Update one or more secrets |

---

### GET /api/secrets

Returns all known secret keys with redacted values and metadata about which plugins they belong to. Enabled status is synced from the runtime plugin state.

**Response**

```json
{
  "secrets": [
    {
      "key": "OPENAI_API_KEY",
      "description": "OpenAI API key",
      "category": "ai-provider",
      "sensitive": true,
      "required": true,
      "isSet": true,
      "maskedValue": "sk-****...xxxx",
      "usedBy": [
        { "pluginId": "openai", "pluginName": "OpenAI", "enabled": true }
      ]
    },
    {
      "key": "ANTHROPIC_API_KEY",
      "description": "Anthropic API key",
      "category": "ai-provider",
      "sensitive": true,
      "required": true,
      "isSet": false,
      "maskedValue": null,
      "usedBy": [
        { "pluginId": "anthropic", "pluginName": "Anthropic", "enabled": false }
      ]
    }
  ]
}
```

| Field | Type | Description |
|-------|------|-------------|
| `secrets` | array | List of secret entries aggregated from all plugin parameters |
| `secrets[].key` | string | Environment variable name |
| `secrets[].description` | string | Human-readable description of the secret |
| `secrets[].category` | string | Plugin category (e.g. `ai-provider`, `connector`) |
| `secrets[].sensitive` | boolean | Whether this is a sensitive parameter |
| `secrets[].required` | boolean | Whether this parameter is required by its plugin |
| `secrets[].isSet` | boolean | Whether the key has a non-empty value in the environment |
| `secrets[].maskedValue` | string\|null | Redacted value (e.g. `sk-****...xxxx`) or `null` if unset |
| `secrets[].usedBy` | array | List of plugins that declare this parameter |
| `secrets[].usedBy[].pluginId` | string | Plugin identifier |
| `secrets[].usedBy[].pluginName` | string | Plugin display name |
| `secrets[].usedBy[].enabled` | boolean | Whether the plugin is currently loaded in the runtime |

---

### PUT /api/secrets

Update one or more secrets. Values are written to the config file and injected into `process.env` immediately. Keys with empty or whitespace-only values are silently skipped. Keys that are not declared as sensitive parameters by any plugin, or that match a blocked system variable name, are also skipped.

**Request Body**

```json
{
  "secrets": {
    "OPENAI_API_KEY": "sk-new-key-here",
    "ANTHROPIC_API_KEY": "sk-ant-new-key"
  }
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `secrets` | object | Yes | Map of environment variable names to new values |

**Response**

```json
{
  "ok": true,
  "updated": ["OPENAI_API_KEY", "ANTHROPIC_API_KEY"]
}
```

| Field | Type | Description |
|-------|------|-------------|
| `ok` | boolean | Whether the operation succeeded |
| `updated` | string[] | List of key names that were actually written |

Setting or clearing a provider key may require a restart for the runtime to pick up the change. The UI typically prompts the user accordingly.

## Common Error Codes

| Status | Code | Description |
|--------|------|-------------|
| 400 | `INVALID_REQUEST` | Request body is malformed or missing required fields |
| 401 | `UNAUTHORIZED` | Missing or invalid authentication token |
| 404 | `NOT_FOUND` | Requested resource does not exist |
| 400 | `INVALID_BODY` | Request body is not a valid JSON object with a `secrets` map |
| 500 | `INTERNAL_ERROR` | Unexpected server error |
