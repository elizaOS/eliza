# #13985 — auth-pair no-DB boot window must fail closed and remain retryable

## Vulnerability
`POST /api/auth/pair` minted a revocable, TTL-bound machine session only after
`getCompatDrizzleDb(state)` returned a runtime DB. During the boot window, the
compat route is mounted but the DB can still be unavailable; the old branch fell
through to returning the raw `ELIZA_API_TOKEN`, a non-expiring and non-revocable
full-authority bearer.

## Fix
The DB readiness check now happens before the pairing code is consumed. When the
DB is not ready, the handler returns retryable `503` and leaves the code valid.
Once the runtime DB is up, the same code can be retried and exchanged for the
normal revocable machine-session id. The static token is never emitted.

## Verification
- `packages/app-core/src/api/auth-pairing-routes.test.ts`: 8 pass / 0 fail.
- New regression covers the no-DB boot window: valid pair code returns `503`,
  no machine session is minted, response does not contain `ELIZA_API_TOKEN`, and
  retrying the same code with DB available returns the session id.

## N/A
UI screenshots/video/audio/model trajectories — N/A; server auth route only.
Runtime trace is represented by the real handler test above with mocked
auth/session store dependencies.
