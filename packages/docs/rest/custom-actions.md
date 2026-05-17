---
title: "Custom Actions API"
sidebarTitle: "Custom Actions"
description: "REST API endpoints for creating, managing, and testing custom actions — user-defined HTTP, shell, or code handlers the agent can invoke."
---

Custom actions let you extend the agent with user-defined behaviors that can call HTTP APIs, run shell commands, or execute arbitrary JavaScript. They are stored in the Eliza config file and hot-registered into the running agent without a restart.

## Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/custom-actions` | List all custom actions |
| POST | `/api/custom-actions` | Create a new custom action |
| POST | `/api/custom-actions/generate` | AI-generate an action definition from a prompt |
| PUT | `/api/custom-actions/:id` | Update an existing custom action |
| DELETE | `/api/custom-actions/:id` | Delete a custom action |
| POST | `/api/custom-actions/:id/test` | Test-run a custom action |

---

### GET /api/custom-actions

List all configured custom actions.

**Response**

```json
{
  "actions": [
    {
      "id": "uuid",
      "name": "CHECK_WEATHER",
      "description": "Fetches current weather for a city",
      "similes": ["WEATHER_CHECK", "GET_WEATHER"],
      "parameters": [
        {
          "name": "city",
          "description": "City name",
          "required": true
        }
      ],
      "handler": {
        "type": "http",
        "method": "GET",
        "url": "https://api.weather.com/v1/current?city={{city}}"
      },
      "enabled": true,
      "createdAt": "2025-06-01T12:00:00.000Z",
      "updatedAt": "2025-06-01T12:00:00.000Z"
    }
  ]
}
```

---

### POST /api/custom-actions

Create a new custom action and hot-register it into the running agent.

**Request Body**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | Yes | Action name (converted to UPPER_SNAKE_CASE) |
| `description` | string | Yes | What the action does |
| `similes` | string[] | No | Alternative names/phrases that trigger the action |
| `parameters` | array | No | `[{ name, description, required }]` |
| `handler` | object | Yes | Handler definition (see below) |
| `enabled` | boolean | No | Whether to register immediately (default `true`) |
| `terminalToken` | string | Conditional | Required for `shell` and `code` handlers when `ELIZA_TERMINAL_RUN_TOKEN` is set |

**Handler Types**

HTTP handler:
```json
{
  "type": "http",
  "method": "GET",
  "url": "https://api.example.com/{{param}}",
  "headers": { "Authorization": "Bearer {{token}}" },
  "bodyTemplate": "{\"query\": \"{{query}}\"}"
}
```

Shell handler:
```json
{
  "type": "shell",
  "command": "curl -s https://api.example.com/{{param}}"
}
```

Code handler:
```json
{
  "type": "code",
  "code": "const res = await fetch(`https://api.example.com/${params.query}`); return await res.text();"
}
```

Use `{{paramName}}` placeholders in URLs, body templates, and shell commands. For code handlers, parameters are available via `params.paramName` and `fetch()` is available.

<Warning>
Creating, updating, or testing actions with `shell` or `code` handler types requires terminal authorization when `ELIZA_TERMINAL_RUN_TOKEN` is configured. Include the token in the request body as `terminalToken` or via the standard authorization mechanism. Requests without a valid token receive a `403` response.
</Warning>

**Response**

```json
{
  "ok": true,
  "action": {
    "id": "uuid",
    "name": "CHECK_WEATHER",
    "description": "...",
    "handler": { "type": "http", "..." : "..." },
    "enabled": true,
    "createdAt": "2025-06-01T12:00:00.000Z",
    "updatedAt": "2025-06-01T12:00:00.000Z"
  }
}
```

**Errors**

| Status | Condition |
|--------|-----------|
| 400 | Missing `name` or `description` |
| 400 | Invalid or missing handler type |
| 400 | HTTP handler missing `url`, shell handler missing `command`, or code handler missing `code` |
| 403 | Terminal authorization required for `shell`/`code` handler (missing or invalid `terminalToken`) |

---

### POST /api/custom-actions/generate

Use the agent's LLM to generate a custom action definition from a natural language description.

**Request Body**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `prompt` | string | Yes | Natural language description of what the action should do |

**Response**

```json
{
  "ok": true,
  "generated": {
    "name": "FETCH_CRYPTO_PRICE",
    "description": "Fetches the current price of a cryptocurrency",
    "handlerType": "http",
    "handler": {
      "type": "http",
      "method": "GET",
      "url": "https://api.coingecko.com/api/v3/simple/price?ids={{coin}}&vs_currencies=usd"
    },
    "parameters": [
      {
        "name": "coin",
        "description": "Cryptocurrency ID (e.g. bitcoin, ethereum)",
        "required": true
      }
    ]
  }
}
```

The generated definition is a suggestion — the client should let the user review and edit it before creating the action via `POST /api/custom-actions`.

| Status | Condition |
|--------|-----------|
| 400 | Missing prompt |
| 503 | Agent runtime not available |

---

### PUT /api/custom-actions/:id

Update an existing custom action.

**Request Body**

All fields are optional — only provided fields are updated.

| Field | Type | Description |
|-------|------|-------------|
| `name` | string | Action name (converted to UPPER_SNAKE_CASE) |
| `description` | string | Updated description |
| `similes` | string[] | Updated similes |
| `parameters` | array | Updated parameters |
| `handler` | object | Updated handler (must include valid `type`) |
| `enabled` | boolean | Enable or disable the action |
| `terminalToken` | string | Required when updating to a `shell` or `code` handler and `ELIZA_TERMINAL_RUN_TOKEN` is set |

**Response**

```json
{
  "ok": true,
  "action": { "id": "uuid", "name": "...", "..." : "..." }
}
```

| Status | Condition |
|--------|-----------|
| 400 | Invalid handler type |
| 403 | Terminal authorization required for `shell`/`code` handler |
| 404 | Action not found |

---

### DELETE /api/custom-actions/:id

Delete a custom action and remove it from the config file.

**Response**

```json
{
  "ok": true
}
```

| Status | Condition |
|--------|-----------|
| 404 | Action not found |

---

### POST /api/custom-actions/:id/test

Execute a custom action with test parameters and return the result. This does not go through the agent — the handler is invoked directly.

**Request Body**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `params` | object | No | Map of parameter names to test values |
| `terminalToken` | string | Conditional | Required for `shell`/`code` actions when `ELIZA_TERMINAL_RUN_TOKEN` is set |

```json
{
  "params": {
    "city": "Tokyo"
  }
}
```

**Response**

```json
{
  "ok": true,
  "output": "Weather in Tokyo: 22°C, partly cloudy",
  "durationMs": 340
}
```

On failure:

```json
{
  "ok": false,
  "output": "",
  "error": "Connection refused",
  "durationMs": 1200
}
```

| Status | Condition |
|--------|-----------|
| 403 | Terminal authorization required for `shell`/`code` action |
| 404 | Action not found |

## Common Error Codes

| Status | Code | Description |
|--------|------|-------------|
| 400 | `INVALID_REQUEST` | Request body is malformed or missing required fields |
| 401 | `UNAUTHORIZED` | Missing or invalid authentication token |
| 404 | `NOT_FOUND` | Requested resource does not exist |
| 400 | `INVALID_HANDLER` | Handler type or configuration is invalid |
| 500 | `EXECUTION_FAILED` | Custom action execution failed |
| 503 | `SERVICE_UNAVAILABLE` | Agent runtime or service is unavailable |
| 500 | `INTERNAL_ERROR` | Unexpected server error |
