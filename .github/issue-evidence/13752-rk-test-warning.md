# #13752 restricted Stripe test-key production warning

## Scope

Follow-up to merged PR #13786. Production deployments already warned for
`sk_test_` Stripe keys but accepted `rk_test_` restricted test keys without the
same warning, even though `rk_` keys are accepted by the Stripe client
configuration check.

This PR makes `rk_test_` hit the same warning predicate and operational log path
as `sk_test_`.

## Verification

Run from `/tmp/wt-13833` after rebasing onto `origin/develop`.

- `bun install --frozen-lockfile --ignore-scripts` - blocked locally because the current lockfile wants dependency resolution changes; reran `bun install --no-save --ignore-scripts` only to hydrate `node_modules`, then restored/verified no tracked lockfile change.
- `bun run --cwd packages/cloud/routing build` - pass
- `bun run --cwd packages/logger build` - pass
- `bun run --cwd packages/shared build:i18n` - pass
- `bun test src/lib/stripe.guard.test.ts` from `packages/cloud/shared` - 16/16 pass
- `bun test src/lib/config/deployment-environment.test.ts src/lib/config/deployment-environment.gates.test.ts src/lib/services/stripe-connect-payout.test.ts` from `packages/cloud/shared` - 25/25 pass
- `bunx biome check packages/cloud/shared/src/lib/config/deployment-environment.ts packages/cloud/shared/src/lib/stripe.ts packages/cloud/shared/src/lib/stripe.guard.test.ts .github/issue-evidence/13752-rk-test-warning.md` - pass
- `bun run --cwd packages/cloud/shared typecheck` - fails on current `origin/develop` before this patch with duplicate `readAliasedEnv` imports in `plugins/plugin-elizacloud/src/services/cloud-managed-gateway-relay.ts`; not introduced by this PR.
- `git diff --check origin/develop` - pass

## Warning-path evidence

The deterministic Worker-binding test `production + rk_test_ initializes but emits the same test-key warning` captures `console.warn` during `getStripe()` initialization with `STRIPE_SECRET_KEY=rk_test_...` and `ENVIRONMENT=production`, asserts the client initializes, and asserts the emitted warning contains `sk_test_/rk_test_`. This proves the real guard/log path fires without a live Stripe API call.

Observed local test output also included:

```text
[Stripe] STRIPE_SECRET_KEY is a TEST-mode key (sk_test_/rk_test_) in a production deployment. Checkouts will not move real money. Verify the environment's Stripe secrets (#13752).
```

## Evidence N/A

- Screenshots/video: N/A - backend Stripe configuration guard only.
- Live Stripe API calls: N/A - fake Stripe key fixtures intentionally avoid any
  network call while exercising the real guard and client-initialization path.
- DB artifacts/migrations: N/A - no database read/write or schema change.
- LLM trajectories: N/A - no model-backed behavior.
