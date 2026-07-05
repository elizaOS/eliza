# #13890 Steward Session Redis-Outage Fallback Limiter

## Change

- `POST /api/auth/steward-session` keeps its normal Redis-backed strict per-IP
  limiter.
- If Redis throws at request time, the route uses an explicit in-isolate
  fallback bucket (`X-RateLimit-Policy: redis-unavailable-local`) instead of
  returning `rate_limit_unavailable` before auth validation.
- Top-up/payment routes keep the existing hard fail-closed behavior.

## Verification Run Locally

- `bun test packages/cloud/api/auth/steward-session/steward-session-rate-limit.test.ts packages/cloud/api/v1/topup/topup-rate-limit.test.ts packages/cloud/shared/src/lib/middleware/rate-limit-fail-closed.test.ts`
  - 7 pass / 0 fail.
  - Real route proof: missing token reaches normal `400 missing_token` under a
    throwing Redis dependency.
  - Real route proof: valid Steward token mints staging-scoped cookies under a
    throwing Redis dependency.
  - Abuse proof: 10 invalid-token attempts reach auth validation; the 11th is
    blocked by the local fallback bucket with `429 rate_limit_exceeded`.
  - Money-surface proof: `/api/v1/topup/10` still returns
    `503 rate_limit_unavailable` and never reaches the top-up handler.
- `bunx @biomejs/biome check packages/cloud/shared/src/lib/middleware/rate-limit-hono-cloudflare.ts packages/cloud/shared/src/lib/middleware/rate-limit-fail-closed.test.ts packages/cloud/api/auth/steward-session/route.ts packages/cloud/api/auth/steward-session/steward-session-rate-limit.test.ts packages/cloud/api/v1/topup/topup-rate-limit.test.ts`
- `node packages/shared/scripts/generate-keywords.mjs --target ts`
- `git diff --check`

## Broader Checks

- `bun run --cwd packages/cloud/api build` was attempted and failed on
  pre-existing unrelated type errors:
  - `packages/cloud/api/__tests__/my-agents-claim-affiliate-characters.test.ts`
    expects `default.fetch(...)` to return `Promise<Response>` but the route
    type allows `Response | Promise<Response>`.
  - `packages/cloud/shared/src/lib/auth/workers-hono-auth.ts:129` references
    missing `readCookie`.
- `bun run --cwd packages/cloud/shared typecheck` was attempted and failed on
  the same existing `workers-hono-auth.ts:129` missing `readCookie` error.

## Evidence Matrix

- Real cloud-stack request/response trace: covered by route-level Hono tests
  with the real route and middleware; full `bun run cloud:mock` was not run in
  this worktree because the current host has been disk constrained and the
  change has no DB migration or external-provider dependency.
- Structured backend logs: fallback path logs through the shared logger at
  `[RateLimit] Redis unavailable; using local fallback limiter`; unit tests mock
  the logger to keep output deterministic.
- DB state / migrations: N/A - no database schema, repository, billing, usage,
  or migration changes.
- Auth / role-gating denied path: covered by invalid-token spray test and
  top-up fail-closed regression; origin/JWT validation logic is unchanged.
- Model trajectories: N/A - no model-backed endpoint or agent action changed.
- Screenshots/video: N/A - backend rate-limit middleware only; no rendered UI.
