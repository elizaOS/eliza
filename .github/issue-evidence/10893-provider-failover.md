# Issue #10893 — CLI SDK Provider Failover

## Scope

- Runtime-only change in `packages/core/src/runtime.ts`.
- `AgentRuntime.useModel` now tries the next registered provider when the
  preferred provider throws a recognized rate-limit/session-limit exhaustion
  error.
- Explicit provider calls remain pinned to that provider, preserving
  per-action model routing behavior.

## Validation

- `bun test packages/core/src/runtime/__tests__/model-provider-failover.test.ts`
- `bun test packages/core/src/services/__tests__/failure-reply-prompt.test.ts`
- `bun test packages/core/src/runtime/__tests__/streaming-use-model.test.ts`
- `bun run --cwd packages/core typecheck`
- `bun run --cwd packages/core build:node`
- `bun run biome check packages/core/src/runtime.ts packages/core/src/runtime/__tests__/model-provider-failover.test.ts .github/issue-evidence/10893-provider-failover.md`
- `git diff --check`

## Evidence Matrix

- Backend/runtime logs: covered by the focused `AgentRuntime.useModel` unit
  tests above, including exhausted preferred provider, non-retriable error, and
  explicit provider pinning.
- Real-LLM trajectory: N/A — this fix is verified with deterministic provider
  handlers because reproducing a live subscription-exhausted CLI SDK account is
  not available in the local environment.
- Frontend screenshots/video: N/A — no UI surface changed.
- Console/network logs: N/A — no browser or network flow changed.
