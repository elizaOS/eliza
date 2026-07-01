# Issue #10893 - useModel Provider Fallback

## Scope

- Issue: https://github.com/elizaOS/eliza/issues/10893
- Change: default `AgentRuntime.useModel` resolution now tries the next registered model provider when the preferred provider fails with a provider-fallback-eligible error.
- Eligible failures: existing rate-limit/session-limit classifier, plus transient 5xx/network-style provider failures.
- Guardrails: explicit provider calls still use the pinned provider, non-retryable provider errors still surface, and fallback is skipped once a streaming attempt has emitted visible output.

## Evidence

- `bun run --cwd packages/core prebuild`
  - Result: pass. Regenerated the missing validation keyword data required for core tests/typecheck.
- `bun test packages/core/src/runtime/__tests__/use-model-provider-fallback.test.ts`
  - Result: pass. 4 tests, covering rate-limit fallback, 5xx fallback, non-retryable stop, and explicit-provider stop.
- `bun test packages/core/src/services/__tests__/failure-reply-prompt.test.ts`
  - Result: pass. 19 tests, including new provider-fallback classifier coverage.
- `bunx biome check packages/core/src/runtime.ts packages/core/src/services/message.ts packages/core/src/services/message/fallback-reply.ts packages/core/src/runtime/__tests__/use-model-provider-fallback.test.ts packages/core/src/services/__tests__/failure-reply-prompt.test.ts`
  - Result: pass.
- `bun run --cwd packages/core typecheck`
  - Result: pass.
- `git fetch origin && git rebase origin/develop`
  - Result: pass after resolving `packages/core/src/runtime.ts` against the upstream provider-failover loop added on `develop`.
- `bun install`
  - Result: pass. `bun.lock` install churn was discarded because it was unrelated to this issue.
- `bun run verify`
  - Result: blocked by an unrelated existing formatting failure in `packages/cloud/shared/src/lib/services/app-credits.ts` during `@elizaos/cloud-shared#lint`.
  - The failing file is outside this issue's scope and was not modified by this branch. The worktree was clean after the failed verify run.

## Artifact Matrix

- Real-LLM trajectory: N/A. This change is covered by deterministic `AgentRuntime.useModel` tests with simulated provider failures; no live provider credentials are required to verify the fallback decision.
- Backend/frontend logs: N/A. No server route or UI path changed.
- Screenshots/video: N/A. No UI changed.
- Per-platform capture: N/A. No native/mobile/desktop surface changed.
