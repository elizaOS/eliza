# Auth API consistency: rationale and design

This document explains **why** Eliza Cloud splits cookie sessions, API keys, and edge behavior the way it does. For mechanics (headers, helpers, lists of routes), see [api-authentication.md](./api-authentication.md).

---

## Problem we were solving

1. **Edge vs handler mismatch**  
   The proxy historically let any request with `X-API-Key` or `Bearer eliza_...` skip session auth and reach the route. Many handlers used `requireAuth()` / `requireAuthWithOrg()`, which **only read cookies**. So API-key clients passed the edge, then got an opaque **401** from the handler. That is hard to debug and looks like a broken product.

2. **Two audiences**  
   - **Browsers**: cookie session after login.
   - **Scripts, CI, mobile backends**: API keys (and sometimes Bearer JWT).  
   The platform needs both without pretending they are the same security story.

3. **Not every “logged-in” action should accept API keys**  
   Some flows are intentionally **human-in-the-browser** (invite accept, promo redeem, Stripe redirect, CLI key issuance after web login). Allowing API keys there increases scripted abuse or confusing semantics (e.g. completing CLI login with an API key).

---

## Strategy (two layers)

### Layer 1 — Handlers: `requireAuth*` vs `requireAuthOrApiKey*`

- **`requireAuth` / `requireAuthWithOrg`**  
  **Why:** Cookie-only. No `NextRequest` header inspection. Use when the operation is tied to an interactive session or when you must **not** treat a programmatic key as equivalent to the user clicking in the UI (e.g. signup-code redeem: **why** block API keys — scripted brute force against one-time codes).

- **`requireAuthOrApiKey` / `requireAuthOrApiKeyWithOrg`**  
  **Why:** One code path for “this org/user is allowed” whether the caller is the dashboard (cookies) or automation (key/Bearer/wallet rules). **Why org variant:** Credits and org-scoped resources must resolve an active organization; anonymous or org-less users get a clear **403**, not a silent wrong org.

Choosing the wrong helper is a product bug, not just a style issue: it directly determines whether CLI and integrations work.

### Layer 2 — Edge (`proxy.ts`): public paths, session auth, API-key bypass, session-only

**Why validate API keys only in handlers, not at the edge?**  
Keys are looked up in the database with org and permission logic. The edge middleware is optimized for session JWT caching and routing. Duplicating full key validation at the edge would add latency, coupling, and deployment risk. **Tradeoff:** invalid keys still “pass” the edge but fail fast in the handler with a normal 401.

**Why `sessionOnlyPaths` / `sessionOnlyPathPatterns`?**  
For routes that **must** stay cookie-shaped, we fail **at the edge** with `session_auth_required` when the client sends API-key-style credentials. **Why:** Clear, consistent error for integrators (“use a browser session here”) instead of a generic handler 401 after a successful edge bypass.

**Why wallet passthrough is separate from “programmatic auth”?**  
Wallet-signed flows on specific prefixes are verified in handlers. Session-only rejection applies to **API key** and **`Bearer eliza_`** only, so we do not accidentally block wallet top-up or wallet linking flows that use different headers.

---

## CLI session: why `publicPaths` was narrowed

**Before:** `/api/auth/cli-session` as a prefix made **every** subpath “public” at the edge, including `POST .../:sessionId/complete`. The session-only regex for `complete` never ran.

**Why that mattered:** `complete` is where the browser finishes login and the server issues API key material. It should not be treated as an unauthenticated public route for the purpose of API-key bypass semantics.

**After:** Only these match as public (via patterns):

- `POST /api/auth/cli-session` — create polling session (**why public:** CLI starts flow without cookies).
- `GET /api/auth/cli-session/:sessionId` — poll status (**why public:** CLI waits for user to log in on the web).

`POST .../:sessionId/complete` goes through normal `/api/*` auth and session-only rules. **Why:** Session completion is a **browser cookie** action; rejecting API keys at the edge matches the handler’s `requireAuthWithOrg()`.

---

## API key management accepts API keys — intentionally

**Why allow `GET/POST/PATCH/DELETE` on `/api/v1/api-keys` with a key?**  
Teams rotate and automate keys from CI. **Caveat (documented):** use a **different** key to revoke or rotate a key than the key being revoked — otherwise you lock yourself out in one request. **Why we still do it:** operational reality for orgs with many keys; the alternative (session-only key CRUD) blocks legitimate automation.

**Why keep `/api/v1/api-keys/explorer` session-only?**  
That route exists to support the **in-app API Explorer** UX (often returns or ensures a named explorer key). Exposing it to arbitrary API-key callers would be odd and increases risk of unexpected key material exposure.

---

## Crypto payments split (`GET` vs `POST`)

**Why `GET` list (and `GET` by id) accept API keys but `POST` create does not?**  
Listing and reading status are useful for dashboards and scripts. **Creating** a new crypto checkout is tightly coupled to a user initiating payment in product flows; keeping **POST** session-only reduces scripted creation of payment intents while still allowing observability via **GET**.

---

## Related files

| Concern | Location |
|--------|----------|
| Edge: public, protected, session-only, API-key bypass | `proxy.ts` |
| Cookie vs API key vs wallet resolution | `packages/lib/auth.ts` |
| Canonical error codes including `session_auth_required` | `packages/lib/api/errors.ts` |
| CORS allow lists | `packages/lib/cors-constants.ts` |
| Operator-facing API auth summary | [api-authentication.md](./api-authentication.md) |

---

## Future improvements (see [ROADMAP.md](./ROADMAP.md))

Optional next steps: OpenAPI tags per surface, stricter alignment of error envelopes across all routes, scoped API keys (e.g. “cannot manage keys”) — each needs explicit product and threat-model decisions.
