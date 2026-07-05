# 14245 ACP commit-lock heartbeat

Date: 2026-07-05

## What changed

- Kept the detached commit-lock heartbeat child alive by leaving its own interval referenced. The parent still `unref()`s the detached child, so the wrapper process is not kept alive after release.
- Added a regression in `acp-git-commit-race.test.ts` where session A owns the real commit lock and sleeps in a pre-commit hook for longer than `ACP_COMMIT_LOCK_STALE_MS`, while session B attempts to commit in the same worktree. Both commits must land linearly and preserve both staged file sets.

## Verification

```bash
bun run --cwd plugins/plugin-agent-orchestrator test -- src/__tests__/acp-git-commit-race.test.ts
```

Result: passed. Vitest reported `1 passed` test file and `5 passed` tests.

```bash
bunx @biomejs/biome check plugins/plugin-agent-orchestrator/src/services/acp-service.ts plugins/plugin-agent-orchestrator/src/__tests__/acp-git-commit-race.test.ts
```

Result: passed. Biome reported `Checked 2 files in 61ms. No fixes applied.`

## Non-applicable evidence

- UI screenshots/video: N/A - ACP git wrapper behavior has no UI surface.
- Live-LLM trajectory: N/A - this fix is deterministic git wrapper concurrency behavior, not agent model/action selection.
- Backend/frontend logs: N/A - the regression drives the real generated git wrapper against a real git repository and asserts the resulting git history/tree.

## Blocker observed

Direct root-level Bun test invocation did not reach the test body:

```bash
bun test plugins/plugin-agent-orchestrator/src/__tests__/acp-git-commit-race.test.ts
```

Result: failed before tests with `SyntaxError: export 'syncBrandEnvToEliza' not found in '@elizaos/core'`. The package-local Vitest command above is the passing focused verification for this plugin.
