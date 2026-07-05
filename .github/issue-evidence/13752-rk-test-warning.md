# #13752 restricted Stripe test-key production warning

## Scope

Follow-up to merged PR #13786. Production deployments already warned for
`sk_test_` Stripe keys but accepted `rk_test_` restricted test keys without the
same warning, even though `rk_` keys are accepted by the Stripe client
configuration check.

This PR makes `rk_test_` hit the same warning predicate and operational log path
as `sk_test_`.

## Verification

Run from `/Users/shawwalters/milaidy/eliza-13752-rk-test-warning`.

- `bun install --frozen-lockfile --ignore-scripts` - pass
- `bun run --cwd packages/cloud/routing build` - pass
- `bun run --cwd packages/shared build:i18n` - pass
- `bun test src/lib/stripe.guard.test.ts` from `packages/cloud/shared` - 16/16 pass
- `bun test src/lib/config/deployment-environment.test.ts src/lib/config/deployment-environment.gates.test.ts src/lib/services/stripe-connect-payout.test.ts` from `packages/cloud/shared` - 25/25 pass
- `bunx biome check packages/cloud/shared/src/lib/config/deployment-environment.ts packages/cloud/shared/src/lib/stripe.ts packages/cloud/shared/src/lib/stripe.guard.test.ts` - pass
- `bun run --cwd packages/cloud/shared typecheck` - pass
- `git diff --check` - pass

## Evidence N/A

- Screenshots/video: N/A - backend Stripe configuration guard only.
- Live Stripe API calls: N/A - fake Stripe key fixtures intentionally avoid any
  network call while exercising the real guard and client-initialization path.
- DB artifacts/migrations: N/A - no database read/write or schema change.
- LLM trajectories: N/A - no model-backed behavior.
