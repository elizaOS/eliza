---
title: "Subscriptions API"
sidebarTitle: "Subscriptions"
description: "REST API endpoints for OAuth-based subscription flows for Anthropic and OpenAI provider authentication."
---

The subscriptions API manages OAuth flows for Anthropic Max and OpenAI Codex subscriptions. These flows allow users to authenticate with their existing provider subscriptions rather than providing raw API keys.

## Endpoints

### GET /api/subscription/status

Get the status of all subscription-based auth providers.

**Response**

```json
{
  "providers": {
    "anthropic-subscription": {
      "authenticated": true,
      "expiresAt": 1720000000000
    },
    "openai-codex": {
      "authenticated": false
    }
  }
}
```

---

### POST /api/subscription/anthropic/start

Start the Anthropic OAuth login flow. Returns a URL for the user to visit in their browser to authenticate with their Anthropic account.

**Response**

```json
{
  "authUrl": "https://claude.ai/oauth/authorize?..."
}
```

After visiting the URL, the user receives an authorization code. Pass this code to `POST /api/subscription/anthropic/exchange`.

---

### POST /api/subscription/anthropic/exchange

Exchange an Anthropic authorization code for access tokens. The `/start` endpoint must have been called in the same session first.

**Request**

```json
{
  "code": "auth-code-from-anthropic"
}
```

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `code` | string | Yes | Authorization code received from the Anthropic OAuth redirect |

**Response**

```json
{
  "success": true,
  "expiresAt": 1720000000000
}
```

---

### POST /api/subscription/anthropic/setup-token

Accept an Anthropic setup token (format: `sk-ant-oat01-...`) directly, bypassing the OAuth flow. The token is saved to config and persists across restarts.

**Request**

```json
{
  "token": "sk-ant-oat01-..."
}
```

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `token` | string | Yes | Anthropic setup token beginning with `sk-ant-` |

**Response**

```json
{
  "success": true
}
```

**Error response (400)**

Returned when the token format is invalid (does not start with `sk-ant-`).

```json
{
  "error": "Invalid token format — expected sk-ant-oat01-..."
}
```

---

### POST /api/subscription/openai/start

Start the OpenAI Codex OAuth flow. Returns an authorization URL and a state parameter for verification. Also starts a local callback server that listens for the OAuth redirect (auto-expires after 10 minutes).

**Response**

```json
{
  "authUrl": "https://chatgpt.com/auth/...",
  "state": "random-state-string",
  "instructions": "Open the URL in your browser. After login, if auto-redirect doesn't work, paste the full redirect URL."
}
```

---

### POST /api/subscription/openai/exchange

Exchange an OpenAI authorization code for tokens, or wait for the callback server to receive the redirect automatically.

**Request**

```json
{
  "code": "auth-code-from-openai"
}
```

Or to wait for the callback server:

```json
{
  "waitForCallback": true
}
```

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `code` | string | No | Authorization code — either the code itself or the full redirect URL |
| `waitForCallback` | boolean | No | If `true`, wait for the local callback server to receive the redirect automatically |

One of `code` or `waitForCallback: true` must be provided.

**Response**

```json
{
  "success": true,
  "expiresAt": 1720000000000
}
```

---

### DELETE /api/subscription/:provider

Remove subscription credentials for a provider.

**Path Parameters**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `provider` | string | Yes | Provider identifier: `anthropic-subscription` or `openai-codex` |

**Response**

```json
{
  "success": true
}
```

**Error response (400)**

Returned for unknown provider names.

```json
{
  "error": "Unknown provider: unknown-provider"
}
```
