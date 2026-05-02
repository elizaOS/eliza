---
title: "Auth API"
sidebarTitle: "Auth"
description: "REST API endpoints for API authentication and pairing flow."
---

The Eliza API can be secured with a token by setting the `ELIZA_API_TOKEN` environment variable. When set, include the token as a `Bearer` token in the `Authorization` header on all requests. The pairing flow allows remote UIs to obtain the token without embedding it directly.

## Authentication Methods

The API supports four authentication headers, checked in priority order:

| Priority | Header | Format | Example |
|----------|--------|--------|---------|
| 1 | `Authorization` | `Bearer <token>` | `Authorization: Bearer sk-eliza-...` |
| 2 | `x-eliza-token` | Plain token string | `x-eliza-token: sk-eliza-...` |
| 3 | `x-elizaos-token` | Plain token string | `x-elizaos-token: sk-eliza-...` |
| 4 | `x-api-key` / `x-api-token` | Plain token string | `x-api-key: sk-eliza-...` |

When no `ELIZA_API_TOKEN` is set, all requests are allowed without authentication.

All token comparisons use `crypto.timingSafeEqual` to prevent timing attacks.

## WebSocket Authentication

WebSocket connections to `/ws` use the same auth headers. Additionally, when `ELIZA_ALLOW_WS_QUERY_TOKEN=1` is set, the token can be passed as a query parameter (less secure, useful for clients that cannot set headers):

| Priority | Parameter |
|----------|-----------|
| 1 | `?token=<token>` |
| 2 | `?apiKey=<token>` |
| 3 | `?api_key=<token>` |

Header authentication is always checked first; query parameters are the fallback.

## Pairing Flow

The pairing flow allows remote UIs (like the dashboard) to obtain the API token without embedding it directly. The server displays a pairing code in its logs, and the UI submits it to receive the token.

### How It Works

1. The server generates a pairing code on first request to `GET /api/auth/status`
2. The code is displayed in the server logs: `[eliza-api] Pairing code: XXXX-XXXX (valid for 10 minutes)`
3. The user enters the code in the UI, which submits it to `POST /api/auth/pair`
4. On success, the token is returned and the pairing code is cleared

### Pairing Code Format

Codes follow the `XXXX-XXXX` pattern (two groups of 4 characters separated by a dash, 8 characters total). The alphabet excludes visually ambiguous characters:

```
ABCDEFGHJKLMNPQRSTUVWXYZ23456789
```

No `I`, `O`, `0`, or `1` — reducing user input errors.

Code submission normalizes input by stripping non-alphanumeric characters and uppercasing, so the dash is optional when submitting.

### Pairing Code Lifecycle

- Generated lazily on first request to `GET /api/auth/status`
- Valid for **10 minutes** from generation
- Automatically rotated when expired (next request generates a new code)
- Cleared after successful pairing (one-time use)

### Pairing Enabled Condition

Pairing is active when:
- `ELIZA_API_TOKEN` is set (non-empty after trimming)
- `ELIZA_PAIRING_DISABLED` is not `"1"`

## Rate Limiting

The `POST /api/auth/pair` endpoint is rate-limited per IP address:

| Parameter | Value |
|-----------|-------|
| Max attempts | 5 |
| Window | 10 minutes (sliding) |
| Scope | Per IP address |
| Reset | Window resets after expiry on next attempt |

The IP is resolved from `req.socket.remoteAddress`. When the limit is exceeded, the endpoint returns `429 Too Many Requests`.

## Cloud provisioning bypass

When the agent is running as a cloud-provisioned container (e.g., on Eliza Cloud or in an enterprise deployment), authentication and pairing are bypassed automatically. The bypass activates only when **both** conditions are met:

1. `ELIZA_CLOUD_PROVISIONED=1` is set
2. `ELIZA_API_TOKEN` is configured

When cloud provisioned, `GET /api/auth/status` returns `{ "required": false, "pairingEnabled": false, "expiresAt": null }` — cloud-provisioned containers enforce API auth upstream, and reporting `required: true` locally would strand clients in the pairing flow. The pairing flow is disabled since the token is already provisioned.

A container with only the cloud flag but no API token falls through to the normal pairing flow.

## Endpoints

### GET /api/auth/status

Check whether authentication is required and whether the pairing flow is currently enabled. If pairing is enabled, this call ensures a pairing code is generated and ready.

**Response**

```json
{
  "required": true,
  "pairingEnabled": true,
  "expiresAt": 1718003600000
}
```

| Field | Type | Description |
|-------|------|-------------|
| `required` | boolean | `true` when `ELIZA_API_TOKEN` is set and not cloud provisioned. `false` when running in a cloud-provisioned container (auth is enforced upstream). |
| `pairingEnabled` | boolean | `true` when the pairing flow is active. `false` when cloud provisioned. |
| `expiresAt` | number \| null | Unix ms timestamp when the current pairing code expires, or `null` if pairing is disabled or cloud provisioned |

---

### POST /api/auth/pair

Submit a pairing code to receive the API token. Rate-limited by IP address.

**Request**

```json
{
  "code": "WXYZ-2345"
}
```

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `code` | string | Yes | The pairing code from the server logs. Dash is optional |

**Response (success)**

```json
{
  "token": "your-api-token-here"
}
```

**Error Responses**

| Status | Condition |
|--------|-----------|
| `400` | Pairing not enabled (no `ELIZA_API_TOKEN` set) |
| `403` | Pairing disabled or invalid code |
| `410` | Pairing code expired — a new code has been automatically generated |
| `429` | Too many attempts — rate limit exceeded (5 per 10 minutes per IP) |

## Sensitive endpoint authorization

Certain endpoints (such as `POST /api/agent/reset`) are classified as sensitive and require stricter authorization than standard API routes:

- **Loopback requests** (from `127.0.0.1`, `::1`, or `::ffff:127.0.0.1`) are allowed without a token when no `ELIZA_API_TOKEN` is configured. This supports the desktop app, which communicates over localhost and does not need token auth for local operations.
- In `development` or `dev` environments (set via `NODE_ENV`) with `ELIZA_DEV_AUTH_BYPASS=1`, sensitive endpoints are accessible without a token regardless of the request origin.
- In all other cases, a valid `ELIZA_API_TOKEN` must be configured **and** included in the request. Non-loopback requests without a configured token return `403 Forbidden` with the message "Sensitive endpoint requires API token authentication".

<Note>
The wallet key export endpoint (`POST /api/wallet/export`) enforces stricter rules: in production, a token is always required even from loopback addresses.
</Note>

## CORS

The API server includes these auth-related headers in CORS preflight responses:

```
Access-Control-Allow-Headers: Content-Type, Authorization, X-API-Token, X-Api-Key, X-ElizaOS-Client-Id, X-ElizaOS-UI-Language, X-ElizaOS-Token, X-Eliza-Export-Token, X-Eliza-Terminal-Token
```

## Related

- [API Reference overview](/api-reference)
- [Environment variables](/cli/environment) — `ELIZA_API_TOKEN`, `ELIZA_ALLOW_WS_QUERY_TOKEN`, `ELIZA_PAIRING_DISABLED`, `ELIZA_CLOUD_PROVISIONED`

## Common Error Codes

| Status | Code | Description |
|--------|------|-------------|
| 400 | `INVALID_REQUEST` | Request body is malformed or missing required fields |
| 401 | `UNAUTHORIZED` | Missing or invalid authentication token |
| 404 | `NOT_FOUND` | Requested resource does not exist |
| 401 | `INVALID_CREDENTIALS` | Provided credentials are incorrect |
| 429 | `RATE_LIMITED` | Too many requests from this IP address |
| 500 | `INTERNAL_ERROR` | Unexpected server error |
| 401 | `TOKEN_EXPIRED` | Authentication token has expired |
