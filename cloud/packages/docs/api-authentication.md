# API authentication, CORS, rate limits, and errors

This document describes how clients authenticate to Eliza Cloud APIs, how CORS is configured, how rate limiting works, and the canonical JSON error shape.

## Why this model exists

- **Edge** skips session auth for API-key-shaped requests so handlers can validate keys against the database (**why not validate keys at the edge:** avoid duplicating DB logic, permissions, and rate limits in middleware).
- **Handlers** choose `requireAuth*` (cookies only) vs `requireAuthOrApiKey*` (cookies + keys + wallet rules) per route (**why both:** browsers and automation are first-class; some flows must stay human-session-only for abuse and UX reasons).
- **Session-only lists at the edge** return `session_auth_required` when a client sends `X-API-Key` or `Bearer eliza_…` to a cookie-only route (**why:** clear errors instead of passing the edge then failing inside the handler).

For a longer rationale (CLI session public split, crypto GET/POST, key management), see [auth-api-consistency.md](./auth-api-consistency.md).

## Authentication methods

### Cookie session

- **Cookie**: session token cookie.
- **Used by**: Dashboard and browser flows via `getCurrentUser()` / `requireAuth()` / `requireAuthWithOrg()`.
- **Edge**: Non-public routes require a valid session JWT unless another bypass applies (see [Edge middleware](#edge-middleware)).
- **Session-only routes**: Some endpoints reject `X-API-Key` and `Authorization: Bearer eliza_…` at the edge and require a cookie session; see [Session-only routes](#session-only-routes-edge--handlers).

### API key

- **Header**: `X-API-Key: eliza_<secret>` (prefix is `eliza_`).
- **Used by**: Server and browser clients calling routes that use `requireAuthOrApiKey` / `requireAuthOrApiKeyWithOrg`.
- **Edge**: Requests with `X-API-Key` or `Authorization: Bearer eliza_...` skip session verification in the proxy so the route handler can validate the key.

### Bearer token

- **Header**: `Authorization: Bearer <token>`.
- **JWT**: Three-segment JWT verified as a session token; user loaded from DB.
- **API key**: Same value as `X-API-Key` may be sent as Bearer; keys are validated via `apiKeysService.validateApiKey`.

### Wallet-signed requests

- **Headers**: `X-Wallet-Address`, `X-Wallet-Signature`, `X-Timestamp` (all required together).
- **Behavior**: When all three are present, `requireAuthOrApiKey` attempts wallet verification only and does **not** fall through to API key or cookie auth (fail-closed).
- **Edge**: Wallet signature passthrough is limited to specific path prefixes (e.g. topup / user wallets); see `proxy.ts`.

### Internal service JWT

- **Prefix**: `/api/internal` is listed as a public path in the proxy (no session gate).
- **Auth**: Bearer JWT validated by `validateInternalJWTAsync` / `withInternalAuth` in `packages/lib/auth/internal-api.ts`.
- **Purpose**: Service-to-service calls (e.g. gateways); not end-user API keys.

### Webhooks and cron

- Paths under `/api/webhooks`, `/api/cron`, `/api/v1/cron`, provider callbacks, etc. are public at the edge; each handler verifies signatures, secrets, or tokens as appropriate.

## Edge middleware (`proxy.ts`)

- **`publicPaths` / `publicPathPatterns`**: No session required; handlers enforce their own auth. CLI login: `POST /api/auth/cli-session` and `GET /api/auth/cli-session/:sessionId` (poll) are matched by patterns; `POST .../:sessionId/complete` is not public so session-only / API-key rules apply at the edge.
- **`protectedPaths`**: Non-API paths (e.g. `/dashboard`) redirect to login when unauthenticated.
- **Other `/api/*`**: Requires session cookie or Bearer JWT, or API-key style bypass as implemented in `proxy.ts`.
- **`sessionOnlyPaths` / `sessionOnlyPathPatterns`**: For these paths, requests that present `X-API-Key` or `Authorization: Bearer eliza_…` receive **401** with `code: "session_auth_required"` at the edge (cookie session required). Wallet-signature passthrough for allowed topup/wallet paths is unchanged.
- **OPTIONS** for `/api/*`: CORS preflight uses shared constants from `packages/lib/cors-constants.ts`.

## Handler helpers (`packages/lib/auth.ts`)

| Helper | Use when |
|--------|-----------|
| `requireAuth()` | Cookie session only; anonymous users allowed per implementation. |
| `requireAuthWithOrg()` | Cookie session only; must have org. Use for handlers that must not accept API keys (e.g. signup-code redeem), or mixed files where one method stays session-only. |
| `requireAuthOrApiKey(request)` | Session **or** API key **or** wallet headers (with fail-closed wallet rules). |
| `requireAuthOrApiKeyWithOrg(request)` | Same as above but org required (typical for paid / credit usage). |
| `requireAdmin(request)` | Admin wallet + role via `requireAuthOrApiKeyWithOrg` then admin checks. |

**API key management**: `GET /api/v1/api-keys` and `POST /api/v1/api-keys`
use Steward session auth (`requireUserWithOrg`). `PATCH`/`DELETE
/api/v1/api-keys/:id` and `POST /api/v1/api-keys/:id/regenerate` accept
session or API key auth (`requireUserOrApiKeyWithOrg`). Use a **different** key
than the one you are modifying or revoking.

## Session-only routes (edge + handlers)

These are intentionally **not** usable with `X-API-Key` / `Bearer eliza_…` at the proxy (early **401** `session_auth_required`). Handlers use `requireAuth()` / `requireAuthWithOrg()` as documented in code.

| Area | Paths / notes |
|------|----------------|
| Post-login / CLI | `/api/auth/migrate-anonymous`, `/api/auth/cli-session/:sessionId/complete` |
| Invites (accept only) | `/api/invites/accept` — one-time user action |
| Promo / abuse | `/api/signup-code/redeem` |
| API Explorer UI key and key list/create | `/api/v1/api-keys/explorer`, `GET /api/v1/api-keys`, `POST /api/v1/api-keys` |
| Dashboard LLM helpers | `/api/v1/generate-prompts`, `/api/v1/character-assistant` |
| Stripe checkout | `/api/stripe/create-checkout-session` |
| My agents | `/api/my-agents/claim-affiliate-characters`, `/api/my-agents/characters/:id/track-interaction` |
| Crypto confirm | `/api/crypto/payments/:id/confirm` |
| Crypto create | `POST /api/crypto/payments` — handler stays session-only; `GET` list accepts API keys |

### Routes that accept API keys (non-exhaustive; org-scoped unless noted)

Infrastructure, billing reads, voices, keys, org admin, profile:

- `/api/v1/dashboard`, `/api/v1/apps/:id/deploy`, `/api/v1/apps/:id/domains` (+ status, sync, verify)
- `/api/elevenlabs/voices` (premade list), `/api/elevenlabs/voices/user`, `/api/elevenlabs/voices/jobs`, `/api/elevenlabs/voices/:id`, `/api/elevenlabs/voices/verify/:id`
- `PATCH`/`DELETE /api/v1/api-keys/:id`, `POST /api/v1/api-keys/:id/regenerate`
- `/api/v1/user` (GET/PATCH; org optional per user record)
- `/api/sessions/current`, `GET /api/crypto/payments`, `GET /api/crypto/payments/:id`
- `/api/organizations/members`, `/api/organizations/members/:userId`, `/api/organizations/invites`, `/api/organizations/invites/:inviteId`

## CORS

- **Shared allow list**: `CORS_ALLOW_HEADERS`, `CORS_ALLOW_METHODS`, `CORS_MAX_AGE` in [`packages/lib/cors-constants.ts`](../lib/cors-constants.ts) — used by `next.config.ts`, `proxy.ts` OPTIONS, `packages/lib/middleware/cors-apps.ts`, `packages/lib/services/proxy/cors.ts`, and reflected in `packages/lib/utils/cors.ts` for allowlisted origins.
- **Wildcard `*`**: Default for most `/api/*` responses; credentials are not used with `*`; auth is via headers or same-site cookies on the app origin.
- **Origin allowlist + credentials**: `getCorsHeaders` in `packages/lib/utils/cors.ts` for first-party domains that need `Access-Control-Allow-Credentials: true`.

## Rate limiting

- **Wrapper**: `withRateLimit(handler, config)` in `packages/lib/middleware/rate-limit.ts`.
- **Storage**: Redis when `REDIS_RATE_LIMITING=true` (recommended in multi-instance production); otherwise in-memory per instance.
- **Keying**: Prefers API key, then authenticated user id, then anonymous session; see `getDefaultKey` in the same file.
- **Org burst (MCP / A2A)**: `ORGANIZATION_SERVICE_BURST_LIMIT` (100 req / 60s) keys Redis as `mcp:ratelimit[:slug]:orgId` and `a2a:orgId`. Use `enforceMcpOrganizationRateLimit` so 429 bodies match `withRateLimit` (`success`, `code`, `message`, `retryAfter`, `X-RateLimit-*`).

### Presets (`RateLimitPresets`)

| Preset | Typical use |
|--------|-------------|
| `STANDARD` | Default API traffic (60/min). |
| `STRICT` | Sensitive mutations (10/min). |
| `RELAXED` | High read throughput (200/min). |
| `CRITICAL` | Rare, expensive ops (5 per 5 min). |
| `BURST` | Per-second burst cap. |
| `AGGRESSIVE` | Public / unauthenticated; keyed by IP (100/min). |

**429 response** includes `success: false`, `error`, `code: "rate_limit_exceeded"`, `message`, `retryAfter`, and rate-limit headers.

## Error format

Canonical JSON for API errors (aligned with `ApiError` in `packages/lib/api/errors.ts`):

```json
{
  "success": false,
  "error": "Human-readable message",
  "code": "authentication_required | session_auth_required | rate_limit_exceeded | ...",
  "details": {}
}
```

`details` is optional. Proxy-generated 401 responses use `code: "authentication_required"` or, for session-only paths with API key / `Bearer eliza_…`, `code: "session_auth_required"`.

Use `errorToResponse(error)` or `jsonError(message, status, code)` where a raw `Response` is needed. For MCP-style handlers that must use native `Response` (not `NextResponse`), `apiFailureResponse(error)` maps `ApiError` subclasses to the same `toJSON()` shape and status as the rest of the API. For App Router routes using `NextResponse`, `nextJsonFromCaughtError(error)` uses the same logic via shared `caughtErrorJson(error)`.
