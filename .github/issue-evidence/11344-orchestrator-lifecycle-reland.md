# Issue #11344 - Orchestrator Lifecycle Wiring Re-land

## Current State

- `origin/develop` contains merged PR #11368 (`b3ebe69adc36dd7e39d3ee10966e0d3e654e3734`), which re-landed the TASKS archive/reopen/pause durable lifecycle wiring that #11271 had reverted.
- `plugins/plugin-agent-orchestrator/src/actions/tasks.ts` now routes `control` `archive` / `reopen` / `pause`, `ARCHIVE_CODING_TASK`, and `REOPEN_CODING_TASK` through `runTaskLifecycleControl`.
- `runTaskLifecycleControl` calls `OrchestratorTaskService.archiveTask`, `reopenTask`, or `pauseTask`; `UNSUPPORTED_OPERATION` remains only for true ACP-only mode where no task service is registered.
- The #11284 pause/resume comment now matches the code: the pause branch above it does call `pauseTask`.
- `plugins/plugin-agent-orchestrator/__tests__/unit/archive-reopen-lifecycle.test.ts` exists on develop and covers archive, reopen, pause, missing task id, task not found, and ACP-only unsupported mode.
- This PR restores `.github/issue-evidence/orchestrator-hardening-audit-2026-07.md`, the evidence doc deleted by #11271, and updates its status note to mark #11344 fixed by #11368.

## Verification

Source inspection:

```bash
git show origin/develop:plugins/plugin-agent-orchestrator/src/actions/tasks.ts | rg -n "runTaskLifecycleControl|archiveTask|reopenTask|pauseTask|pause branch"
git ls-tree -r --name-only origin/develop | rg "archive-reopen-lifecycle.test.ts|control-resume-clears-paused.test.ts"
```

Expected evidence observed:

- `runControl` routes `archive`, `reopen`, and `pause` to `runTaskLifecycleControl`.
- `runTaskLifecycleControl` calls `archiveTask`, `reopenTask`, and `pauseTask`.
- `archive-reopen-lifecycle.test.ts` and `control-resume-clears-paused.test.ts` are present.

Runtime verification:

```bash
bunx vitest run --config vitest.config.ts __tests__/unit/archive-reopen-lifecycle.test.ts __tests__/unit/control-resume-clears-paused.test.ts --testTimeout 60000
```

Result: 2 files passed, 11 tests passed.

Manual artifact review:

- Opened the restored audit markdown and checked that the status note and remaining-work section no longer list archive/reopen/pause wiring as in flight or dead.
- No UI, screenshots, video, live LLM trajectory, DB rows, audio, wallet, or on-chain artifacts apply: this is a restored repository evidence artifact plus existing Node action wiring verification.
