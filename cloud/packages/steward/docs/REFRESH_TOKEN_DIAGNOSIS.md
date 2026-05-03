# Refresh Token Diagnosis

## Summary

Root cause is a refresh-token rotation race.

`POST /auth/refresh` currently does this in two separate steps:

1. `validateRefreshToken(raw)` does `SELECT ... WHERE token_hash = ?`
2. route handler later does `DELETE ... WHERE id = ?`
3. route handler then mints a new access token and a new refresh token

Because the validate and delete are not atomic, two concurrent refresh calls can both read the same valid refresh token before either deletes it. Both requests then succeed, both mint successor refresh tokens, and only one of those successor tokens is stored by a given client/cookie jar. The loser request later sees `401 Invalid or expired refresh token` on its next refresh and the client or middleware signs the user out.

That lines up with Shadow's symptom of getting kicked out at the 15 minute access-token boundary.

## Evidence

### 1. Code path is race-prone

File: `packages/api/src/routes/auth.ts`

Before fix, `/auth/refresh` did:

- `validateRefreshToken(body.refreshToken)` via `SELECT`
- separate `DELETE refresh_tokens WHERE id = record.id`
- `createRefreshToken(...)`

That is not safe for one-time token rotation under concurrency.

### 2. Eliza Cloud has multiple independent refresh initiators

File: `/home/shad0w/projects/eliza-cloud/packages/lib/providers/StewardProvider.tsx`

Client refresh can fire from:

- initial mount
- 1 minute interval
- `visibilitychange`
- `online`
- any `getToken()` near expiry inside SDK background refresh path

File: `/home/shad0w/projects/eliza-cloud/proxy.ts`

Server middleware also refreshes when Steward access token has `<= 180s` remaining.

That means the same browser session can easily issue concurrent refreshes from:

- client timer + middleware on navigation
- middleware on multiple parallel requests
- visibility wakeup + middleware

### 3. Both client and middleware treat refresh 401 as logout

Client SDK file: `packages/sdk/src/auth.ts`

- `refreshSession()` calls `signOut()` on any `401`

Eliza Cloud middleware file: `/home/shad0w/projects/eliza-cloud/proxy.ts`

- if `/auth/refresh` returns `401`, middleware deletes `steward-token` and `steward-refresh-token` and redirects to `/login`

So one race loser is enough to boot the user.

### 4. DB state shows leaked parallel refresh branches

Shadow user:

- user id: `75f21a43-8914-40dc-ba44-2b3a5fd8da14`
- email: `sol@shad0w.xyz`

Query result:

- active refresh tokens for this user: **50**
- tenant split:
  - `elizacloud`: 46
  - personal tenant: 4

A single browser session should normally leave one active refresh token lineage, not dozens.

There is also at least one obvious same-second duplicate issuance:

- `2026-04-22 01:12:15+00` -> 2 refresh tokens created for `elizacloud`

That is exactly what the race condition would produce.

## Hypothesis Check

### A. Does `validateRefreshToken()` sometimes return null for valid tokens?

Mostly no on hashing consistency.

- create path and validate path both use the same `hashToken()` wrapper over `hashSha256Hex()`
- schema is straightforward: `refresh_tokens.token_hash`, `user_id`, `tenant_id`, `expires_at`
- no evidence of hash mismatch bug

But yes in the broader lifecycle sense: a token that was valid a millisecond ago can become invalid by the time a concurrent refresh request reaches the server. The real bug is not hash validation itself, it is the non-atomic `SELECT` then `DELETE` rotation flow around it.

### B. Is `/auth/refresh` rate limit too aggressive?

Probably not the primary cause.

- limit is `30/min/IP`
- normal cadence should be far below that
- even with client + middleware overlap, most sessions should not hit 30/min unless there is a burst of many simultaneous requests or a retry loop

This is worth instrumenting, but it does not explain the exact 15 minute logout pattern nearly as well as the rotation race.

### C. Is there a race where client and server both rotate the same token?

Yes. This is the main issue.

There are actually two race shapes:

1. client refresh vs middleware refresh
2. middleware refresh vs middleware refresh on parallel requests

Either can produce:

- two successful refreshes from one old token
- multiple successor refresh tokens in DB
- one actor storing successor token A, another storing successor token B
- later refresh using the stale branch gets `401`
- client `signOut()` or middleware cookie deletion logs user out

### D. Does `refresh_tokens` table have stale entries or lookup bugs?

No lookup bug found.

But it does have stale and excessive active entries for Shadow, which is consistent with refresh races leaving multiple live branches behind.

### E. Is there a tenant-scoping issue from `elizacloud ` whitespace?

No evidence in DB for Shadow's current refresh tokens.

Checked values are clean:

- tenant row: `'elizacloud'`
- user_tenants row: `'elizacloud'`
- refresh_tokens tenant_id: `'elizacloud'`

No trailing whitespace or newline found on current rows.

### F. Does passkey login handle refresh differently from email or OAuth?

Not materially.

Passkey, email, OAuth, and wallet auth paths all eventually call the same refresh-token creation helper:

- `createRefreshToken(user.id, tenantId)`

The downstream `/auth/refresh` rotation path is shared, so the logout issue is not passkey-specific.

## Additional Bug Found

`packages/sdk/src/auth.ts` has `switchTenant()` sending `{ refreshToken, tenantId }` to `/auth/refresh`, but `packages/api/src/routes/auth.ts` currently ignores `tenantId` on that route.

That is a real bug, but it is not the cause of the 15 minute logout.

## Fix Plan

### P0, ship first

Make refresh-token consumption atomic in Steward.

File:

- `packages/api/src/routes/auth.ts`

Change:

- replace `SELECT` then `DELETE` rotation with atomic `DELETE ... RETURNING *`
- only one request may consume a given refresh token
- concurrent losers get `401` immediately instead of minting parallel successor tokens

I implemented this locally on branch `fix/refresh-token-root-cause`.

### P1

Add dedupe or mutexing on the client side so one tab cannot call `refreshSession()` concurrently.

Files likely:

- `packages/sdk/src/auth.ts`
- `/home/shad0w/projects/eliza-cloud/packages/lib/providers/StewardProvider.tsx`

Suggested change:

- keep a shared in-flight refresh promise in SDK
- if refresh is already running, await the same promise instead of sending another `/auth/refresh`

This will reduce needless 401s and traffic even after the server fix.

### P1

Add middleware-side refresh coalescing or a grace strategy in Eliza Cloud.

File:

- `/home/shad0w/projects/eliza-cloud/proxy.ts`

Suggested options:

- short per-request/session refresh lock keyed by old refresh token
- or, on refresh 401, avoid immediate hard logout if the request still had a recently refreshed `steward-token` in cookies on the next navigation

### P2

Instrument refresh failures.

Files:

- `packages/api/src/routes/auth.ts`
- `/home/shad0w/projects/eliza-cloud/proxy.ts`
- `packages/sdk/src/auth.ts`

Log:

- hashed refresh token prefix
- user id
- tenant id
- source (`client`, `middleware`, `visibility`, `interval`)
- reason (`consumed`, `expired`, `rate_limited`, `network`, `5xx`)

### P2

Implement refresh-token branch cleanup for users with many active tokens.

Not urgent for the immediate logout bug, but Shadow currently has an abnormal number of active tokens.

## What I Changed

Implemented the P0 server fix locally:

- branch: `fix/refresh-token-root-cause`
- file changed: `packages/api/src/routes/auth.ts`

The change makes refresh-token rotation atomic by consuming the token in one DB statement before minting successors.

## Recommended Next Step

Ship the Steward atomic-consume fix first.

If logouts still happen after that, the next most likely issue is client-side concurrent refresh calls without an in-flight mutex, but the server-side race is the clear root cause today.
