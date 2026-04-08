# ElizaCloud integration (ElizaOK dashboard)

This document explains **how** ElizaOK talks to ElizaCloud and **why** the client is shaped the way it is.

## Goals

1. **Show identity and credits** in the dashboard after SIWE, CLI login, or hosted app auth.
2. **Work from the ElizaOK server** using `fetch()` (no browser cookies to ElizaCloud).
3. **Stay aligned** with ElizaCloud’s real auth and JSON shapes so we do not fight the API.

## Two base URLs (why both exist)

| Variable | Purpose |
|----------|---------|
| `ELIZAOK_ELIZA_CLOUD_URL` | **Browser-oriented** flows: SIWE nonce/verify, CLI session create/poll, marketing links. Often the “product” hostname (e.g. elizacloud.ai). |
| `ELIZAOK_ELIZA_CLOUD_API_URL` | **Programmatic v1 API** (`/api/v1/models`, `/api/v1/user`, `/api/v1/credits/*`). Often the API host (e.g. cloud.milady.ai). |

**Why:** ElizaCloud splits marketing/auth entrypoints from the API origin. The API key returned from SIWE must be used against the **same API base** where that key is valid. If the two env vars point at different environments (staging vs prod), calls will 401/403 and the UI will show “credits syncing” or empty models.

## Authentication model (why headers matter)

ElizaCloud’s `requireAuthOrApiKey` checks, in order:

1. Wallet signature headers (not used by ElizaOK’s Cloud client).
2. **`X-API-Key`** — if present, validated as an API key.
3. **`Authorization: Bearer …`** — if it looks like a JWT, verified as Privy; otherwise validated as an API key.

**Why we send `X-API-Key` only for non-JWT credentials:**  
If we put a **Privy JWT** in `X-API-Key`, Cloud would try to validate it as an API key first and fail. So JWT-shaped tokens must use **Bearer only**.

**Why we send both Bearer and `X-API-Key` for opaque API keys:**  
Matches Cloud’s own SDK pattern and avoids edge cases where only one code path is exercised. Cloud still counts **one** successful auth path (it does not double-charge usage for both headers when `X-API-Key` wins).

## Endpoints ElizaOK uses

| Endpoint | Role |
|----------|------|
| `POST /api/v1/app-auth/connect` | Records app authorization (JWT Bearer only — never add `X-API-Key` here). |
| `GET /api/v1/app-auth/session` | Confirms session + user/app metadata (JWT Bearer only). |
| `GET /api/v1/models` | Model list for the session card. |
| `GET /api/v1/user` | Profile + `organization.credit_balance` (needs Bearer/JWT or API key; **not** cookie-only on current Cloud). |
| `GET /api/v1/credits/balance` | Canonical numeric balance (`{ balance }`). |
| `GET /api/v1/credits/summary` | Rich org summary (`organization.creditBalance`, etc.); **rate-limited** on Cloud. |

**Why both balance and summary:**  
Balance is cheap and authoritative for a single number. Summary adds org naming and extra context; we merge both into the dashboard session so we still show credits if one call fails.

## Session merge order (why explicit `credits` last)

When building the cookie session object we spread `creditSummary` and `profile`, then set **`credits:`** explicitly:

```text
credits: balanceFetch ?? summary?.credits ?? profile?.credits ?? "linked"
```

**Why:**  
`fetchElizaCloudUser` may still surface `credits: "linked"` as a placeholder when org balance is not on the user object. Putting the **balance/summary result last** in the object literal prevents that placeholder from overwriting a real balance.

## App-auth vs API key refresh

- **SIWE / CLI poll:** Session stores a real **API key** → `refreshElizaCloudSession` can refetch Cloud.
- **Hosted app-auth:** Session may keep **`apiKey` empty** (browser JWT flow) → refresh short-circuits.

**Why:**  
Storing a long-lived API key for app-auth would be a separate security/product decision. The code documents this limitation so operators are not surprised.

## 429 retry (why only credits fetches)

`GET /api/v1/credits/summary` is wrapped with rate limiting on Cloud. ElizaOK issues parallel requests (models, user, balance, summary), so summary can occasionally return **429**.

**Why one retry with capped delay:**  
Reduces flaky “credits syncing” after burst refreshes without turning the dashboard into a slow sequential client. Models/user intentionally omit retry to keep latency predictable; fix summary first because it is the rate-limited route.

## “Credits syncing” vs real errors

- **`/api/v1/credits/*` may return 403** if the Cloud account has no organization, while **`/api/v1/user` may still return 200**.  
  **Why document this:** Explains support cases where the user looks “connected” but credits never populate until org/billing exists on Cloud.

## Code map

| File | Responsibility |
|------|----------------|
| [`src/memecoin/elizacloud-api.ts`](../src/memecoin/elizacloud-api.ts) | Headers, JWT detection, parsers, `fetch*` helpers, 429 retry. |
| [`src/memecoin/server.ts`](../src/memecoin/server.ts) | HTTP routes, HTML, cookies, `buildElizaCloudApiSession`, merge logic. |
| [`src/memecoin/elizacloud-api.test.ts`](../src/memecoin/elizacloud-api.test.ts) | Unit tests for headers and parsers. |

## Tests

```bash
cd apps/elizaokbsc && bun test
```

## Related

- [`../.env.example`](../.env.example) — env template with inline comments for Cloud URLs.
- [`../CHANGELOG.md`](../CHANGELOG.md) — integration changes over time.
- [`../ROADMAP.md`](../ROADMAP.md) — planned improvements.
