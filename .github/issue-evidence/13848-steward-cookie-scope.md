# Issue #13848 - Steward Cookie Env Scoping Follow-ups

## Scope

- Env-scoped the non-HttpOnly Steward marker cookie through the existing
  `stewardCookieNames(c.env.ENVIRONMENT)` helper.
- Kept production on the historical unsuffixed names and suffixed non-production
  marker cookies, for example `steward-authed-staging`.
- Updated logout/session-delete/refresh invalid-token cleanup to clear both the
  current environment marker and the legacy marker.
- Added an explicit cutoff for the legacy access-token read fallback:
  `2026-08-04`, one 30-day refresh-cookie Max-Age after this 2026-07-05
  follow-up.
- Normalized the legacy fallback path so `readStewardCookie` returns only
  `string | null`.

## Verification

- `bun install --frozen-lockfile --ignore-scripts`
- `bun test packages/cloud/shared/src/lib/auth/steward-cookies.test.ts`
- `bun run --cwd packages/shared test -- src/steward-session-client/index.test.ts`
- `bun run --cwd packages/cloud/routing build`
- `bun run --cwd packages/shared build:i18n`
- `bun run --cwd packages/logger build`
- `bun run --cwd packages/contracts build`
- `bun run --cwd packages/core build:node`
- `bun test packages/cloud/api/__tests__/steward-session-delete-clears-both-cookie-eras.test.ts`
- `bunx biome check packages/cloud/shared/src/lib/auth/steward-cookies.ts packages/cloud/shared/src/lib/auth/steward-cookies.test.ts packages/cloud/shared/src/lib/auth/workers-hono-auth.ts packages/cloud/api/auth/steward-session/route.ts packages/cloud/api/auth/steward-refresh/route.ts packages/cloud/api/auth/steward-nonce-exchange/route.ts packages/cloud/api/auth/logout/route.ts packages/cloud/api/__tests__/steward-session-delete-clears-both-cookie-eras.test.ts packages/shared/src/steward-session-client/index.ts packages/shared/src/steward-session-client/index.test.ts`
- `git diff --check`
- `bun run --cwd packages/shared typecheck`
- `bun run --cwd packages/cloud/shared typecheck`

## Known Unrelated Verification Failure

- `bun run --cwd packages/cloud/api typecheck` fails in
  `__tests__/my-agents-claim-affiliate-characters.test.ts` because the imported
  route default can return `Response | Promise<Response>` while the test fixture
  expects `Promise<Response>`. None of the changed Steward auth files are named
  in that failure.

## Evidence N/A

- Screenshots/video: N/A - backend cookie naming/auth-session helper change, no
  rendered UI changed.
- Live LLM trajectories: N/A - no agent/action/provider/prompt/model behavior
  changed.
- DB/migration artifacts: N/A - no schema, migration, or DB write path changed.
