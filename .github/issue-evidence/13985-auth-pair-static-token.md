# #13985 — auth-pair no-DB fallback hands out the forever-valid static token

## Vulnerability
`packages/app-core/src/api/auth-pairing-routes.ts` — on a correct pairing exchange the handler mints a revocable, TTL-bound machine session **only when `getCompatDrizzleDb(state)` is non-null**. When the runtime DB is not yet up (a real window — compat routes mount before the runtime finishes booting), it fell through to `sendJsonResponse(res, 200, { token })`, returning the **raw `ELIZA_API_TOKEN`** — a **non-expiring, non-revocable** full-authority bearer. A remote device pairing during the boot window kept a permanent connection key.

This directly violates the `getCompatDrizzleDb` contract (its own docstring: *"Callers MUST treat null as 'service unavailable' — it is never authentication."*).

## Fix
Fail closed: the no-DB branch now returns `503 "Pairing not ready, retry"` instead of the static token. The pairing code's TTL gives the client headroom to retry once the runtime DB is up and a real revocable session can be minted. The DB-present branch (revocable session) and the DB-error catch (already 500, no fallback) are unchanged.

## Verification
`packages/app-core/src/api/auth-pairing-routes.test.ts` (vitest) — **8 pass / 0 fail**:
- NEW: "fails closed with 503 (never the static API token) when the runtime DB is not yet up during the boot window (#13985)" — primes a pair code, submits it with `STATE` (`current: null` → `getCompatDrizzleDb` null), asserts `status === 503`, body is **not** `{ token: <static token> }`, and no session was minted.
- Existing "mints a machine session … returns session id, not the static API token" (DB-present secure path) still passes → the fix doesn't regress the good path.

Repro before the fix: submit the valid pairing code to `POST /api/auth/pair` before the runtime DB is ready → response carried the static token. After: `503`.

## Related (out of scope, noted in the issue, LOW)
The agent standalone path (`packages/agent/src/api/auth-routes.ts`) still returns the static token by design; the app-core session-minting path is the strictly-safer one and should be the only reachable path in a full deployment.

## N/A
UI/model-trajectory/audio — N/A (server auth route). Live-LLM trajectory — N/A (no model path). Runtime traces — the boot-window behavior is proven deterministically by the vitest regression above.
