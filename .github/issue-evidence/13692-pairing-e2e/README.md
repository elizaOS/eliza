# #13692 — production device-pairing auth path: real no-mock e2e

**Issue:** The auth path real users hit — a non-loopback client blocked by the
pairing wall completing `GET /api/auth/pair-code` → `POST /api/auth/pair` and
receiving a revocable machine session — had **zero automated e2e on any
surface**. Every lane bypasses it (`ELIZA_PAIRING_DISABLED=1`), and the only
route coverage was 5 unit tests that **mock** `AuthStore`, the session layer,
and the DB — so they prove the route *branches* but never that a minted session
authenticates subsequent requests, nor that revocation works.

## What this adds

`packages/app-core/src/api/auth-pairing-flow.test.ts` — a real end-to-end that
drives the whole flow over a **real TCP HTTP server** against a **real
`AuthStore` backed by a real, migrated PGlite database**. Nothing is mocked:
the route, the store, the session lifecycle, and the DB are all the production
code paths.

Covered:

| Behavior | Assertion |
|---|---|
| loopback code disclosure | `GET /api/auth/pair-code` from loopback → 200 + rotating code |
| pairing wall (proxied/remote) | same route with `x-forwarded-for` → 403 |
| remote wall via status probe | `GET /api/auth/status` (proxied, no auth) → `required:true, pairingEnabled:true` |
| wrong code | `POST /api/auth/pair` bad code → 403 |
| **mint + authenticate (the crux)** | correct code → 200 `{token:<sessionId>}`; that bearer makes a proxied `GET /api/auth/status` → `authenticated:true` |
| session is a real DB row | `store.findSession(id)` → machine-kind, `paired-device` label, `revokedAt:null` |
| **revocable** | `store.revokeSession(id)`; same bearer → `authenticated:false`, `findActiveSession` → null |
| single-use replay | replaying a consumed code → 403 |
| per-IP rate limit | 6th attempt in the window → 429 |
| pairing disabled | `ELIZA_PAIRING_DISABLED=1` → code 503, pair 403 |

## Evidence

- `verbose-run.txt` — full `vitest --reporter=verbose` output. Shows the **real
  route** minting real rotating pair codes (`9KLB-XRQR-ED7C`, …) and the **real
  PGlite DB** (`[PLUGIN:SQL]` logs) — 7/7 passing, ~1.8s test time.

Run it:

```bash
bun run --cwd packages/app-core test -- src/api/auth-pairing-flow.test.ts
```

## Why it counts

The pre-existing unit test substitutes a mock for the exact thing under test
(the session→auth→DB round trip), which the repo standard explicitly does not
count as coverage. This suite makes the real path reachable in-process (migrated
PGlite + real HTTP) and asserts the property users depend on: **a paired session
authenticates real requests and stops the moment it is revoked.**
