# Issue #11586 — credential-pool follow-ups

Date: 2026-07-02
Branch: `fix/11586-credential-pool-followups`

## What Changed

- Added org-scoped repository WHERE paths for pooled credential read/update/delete and pool metadata writes.
- Wired Worker chat completions to select org pooled direct-provider keys for supported direct models, with strict fallback to platform env on pool miss.
- Added 401/403/429 provider outcome writeback to pooled credential health.
- Suppressed affiliate markup/earnings on zero-rated pooled BYO-key completions while still recording pool usage.
- Kept monetized app-credit billing ahead of pooled BYO-key no-op reservations so contributed provider keys cannot bypass app-owner pricing.
- Added source-condition package exports/imports needed for cloud source typechecks to resolve `@elizaos/app-core/account-pool` and `@elizaos/agent/utils/atomic-json`.
- Applied `RATE_LIMIT_MULTIPLIER` to the Hono/Cloudflare limiter in non-production only.
- Mapped `pooled_credential` audit denials to `secret.access`.

## Human Follow-Up Split

- Staging-only provisioning proof was split to #11622 (`needs-human`) because it requires deployed staging access and logs/artifacts from the real provisioning topology.

## Verification

- `bunx @biomejs/biome check packages/cloud/shared/src/db/repositories/pooled-credentials.ts packages/cloud/shared/src/lib/services/team-credential-pool/service.ts packages/cloud/shared/src/lib/services/team-credential-pool/pool-deps.ts packages/cloud/shared/src/lib/services/team-credential-pool/registry.ts packages/cloud/shared/src/lib/services/__tests__/team-credential-pool.test.ts packages/cloud/shared/src/lib/middleware/rate-limit-hono-cloudflare.ts packages/cloud/shared/src/lib/middleware/rate-limit-config-verdict.test.ts packages/cloud/shared/src/lib/providers/language-model.ts packages/cloud/shared/src/lib/providers/language-model-cerebras-fallback.test.ts packages/cloud/api/src/middleware/org-membership.ts packages/cloud/api/__tests__/org-credentials-routes.test.ts packages/cloud/api/v1/chat/completions/route.ts packages/cloud/api/__tests__/chat-completions-streaming-credit-leak.test.ts packages/agent/package.json packages/agent/src/auth/credentials.ts packages/app-core/package.json packages/app-core/src/services/account-pool.ts packages/app-core/src/services/account-usage.ts packages/app-core/src/services/coding-account-bridge.ts`
  - Passed.
- `bun test --coverage-reporter=lcov --conditions eliza-source packages/cloud/shared/src/lib/services/__tests__/team-credential-pool.test.ts packages/cloud/shared/src/lib/middleware/rate-limit-config-verdict.test.ts packages/cloud/shared/src/lib/middleware/rate-limit-orphaned-counter.test.ts packages/cloud/shared/src/lib/middleware/rate-limit-default-key.test.ts packages/cloud/shared/src/lib/providers/language-model-cerebras-fallback.test.ts`
  - Passed: 36 tests, 136 assertions.
- `bun test --coverage-reporter=lcov --conditions eliza-source packages/cloud/api/__tests__/org-credentials-routes.test.ts`
  - Passed: 12 tests, 34 assertions.
- `bun run --cwd packages/cloud/shared typecheck`
  - Passed.
- `bun run --cwd packages/cloud/api typecheck`
  - Passed.
- `bun test --coverage-reporter=lcov --conditions eliza-source packages/cloud/api/__tests__/chat-completions-streaming-credit-leak.test.ts`
  - Passed: 11 tests, 76 assertions, including pooled BYO-key success suppressing affiliate markup while recording pool use and pooled BYO-key not bypassing monetized app billing.
- `git diff --check`
  - Passed.
- `bun install`
  - Passed after rebasing onto `origin/develop`; no lockfile change remained.
- `bun run verify`
  - Passed after rebasing onto `origin/develop` at `390c89e6fe4`.
  - Workspace phase: 483 successful tasks.
  - Final dist-path check: 28 consumer configs checked.

## Evidence Matrix

- UI screenshots/video: N/A — backend/provider/middleware changes only.
- Real-LLM trajectories: N/A — no agent prompt/action/model behavior change; provider selection is covered by direct provider-request tests.
- Backend logs: N/A locally — route tests exercise the code paths without a deployed service log sink.
- Domain artifacts: covered by DB-backed pooled credential tests that inspect rows, ciphertext preservation, usage rollups, and health metadata.
- Staging provisioning proof: N/A for this PR; split to #11622.
