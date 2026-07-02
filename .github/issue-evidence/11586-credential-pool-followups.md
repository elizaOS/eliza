# Issue #11586 — credential-pool follow-ups

Date: 2026-07-02
Branch: `fix/11586-credential-pool-followups`

## What Changed

- Added org-scoped repository WHERE paths for pooled credential read/update/delete and pool metadata writes.
- Wired Worker chat completions to select org pooled direct-provider keys for supported direct models, with strict fallback to platform env on pool miss.
- Added 401/403/429 provider outcome writeback to pooled credential health.
- Applied `RATE_LIMIT_MULTIPLIER` to the Hono/Cloudflare limiter in non-production only.
- Mapped `pooled_credential` audit denials to `secret.access`.

## Human Follow-Up Split

- Staging-only provisioning proof was split to #11622 (`needs-human`) because it requires deployed staging access and logs/artifacts from the real provisioning topology.

## Verification

- `bunx @biomejs/biome check packages/cloud/shared/src/db/repositories/pooled-credentials.ts packages/cloud/shared/src/lib/services/team-credential-pool/service.ts packages/cloud/shared/src/lib/services/team-credential-pool/pool-deps.ts packages/cloud/shared/src/lib/services/team-credential-pool/registry.ts packages/cloud/shared/src/lib/services/__tests__/team-credential-pool.test.ts packages/cloud/shared/src/lib/middleware/rate-limit-hono-cloudflare.ts packages/cloud/shared/src/lib/middleware/rate-limit-config-verdict.test.ts packages/cloud/shared/src/lib/providers/language-model.ts packages/cloud/shared/src/lib/providers/language-model-cerebras-fallback.test.ts packages/cloud/api/src/middleware/org-membership.ts packages/cloud/api/__tests__/org-credentials-routes.test.ts packages/cloud/api/v1/chat/completions/route.ts`
  - Passed.
- `bun test packages/cloud/shared/src/lib/services/__tests__/team-credential-pool.test.ts packages/cloud/shared/src/lib/middleware/rate-limit-config-verdict.test.ts packages/cloud/shared/src/lib/middleware/rate-limit-orphaned-counter.test.ts packages/cloud/shared/src/lib/middleware/rate-limit-default-key.test.ts packages/cloud/shared/src/lib/providers/language-model-cerebras-fallback.test.ts`
  - Passed: 36 tests, 136 assertions.
- `bun test packages/cloud/api/__tests__/org-credentials-routes.test.ts`
  - Passed: 12 tests, 34 assertions.
- `bun run --cwd packages/cloud/shared typecheck`
  - Passed.
- `bun run --cwd packages/cloud/api typecheck`
  - Passed.
- `bun test packages/cloud/api/__tests__/chat-completions-streaming-credit-leak.test.ts`
  - Passed: streaming provider-error reservation tests.
- `git diff --check`
  - Passed.
- `bun install`
  - Passed after rebasing onto `origin/develop`; no lockfile change remained.
- `bun run verify`
  - Failed before package typecheck/lint on the repo-wide type-safety ratchet:
    - `as unknown as`: 77 current > 76 baseline.
    - `?? {}` in core/agent/app-core: 380 current > 377 baseline.
    - `?? 0` in core/agent/app-core: 376 current > 375 baseline.
  - The reported files are outside this change set.

## Evidence Matrix

- UI screenshots/video: N/A — backend/provider/middleware changes only.
- Real-LLM trajectories: N/A — no agent prompt/action/model behavior change; provider selection is covered by direct provider-request tests.
- Backend logs: N/A locally — route tests exercise the code paths without a deployed service log sink.
- Domain artifacts: covered by DB-backed pooled credential tests that inspect rows, ciphertext preservation, usage rollups, and health metadata.
- Staging provisioning proof: N/A for this PR; split to #11622.
