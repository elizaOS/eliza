# Issue #12868 Evidence: packages/core Test/Support Comment Cleanup

## Scope

Changed only tracked JS/TS-family files under the #12868 test/support/config slice:

- `packages/core/test/live/*`
- `packages/core/scripts/*`
- `packages/core/playwright.config.ts`
- `packages/core/vitest.config.ts`

Mechanical audit after edits:

```text
sourceFiles: 387
missingHeaders: 0
```

JSON config files in the issue slice were intentionally left unchanged because JSON cannot carry comments safely.

## Diffstat

```text
12 files changed, 12 insertions(+)
```

Full diffstat is attached at `.github/issue-evidence/12868-core-comments-diffstat.txt`.

## Verification

```bash
bun run check:comment-only
```

Result:

```text
[assert-comment-only-diff] OK — 12 source file(s) changed; every code token identical to origin/develop. Comments only.
```

```bash
git diff --check
```

Result: PASS.

```bash
bunx @biomejs/biome check packages/core/playwright.config.ts packages/core/scripts/perf-settings.ts packages/core/scripts/run-e2e-smoke.mjs packages/core/test/live/coordinator-scenario-live.ts packages/core/test/live/coordinator-scenario-preflight.ts packages/core/test/live/orchestrator-failover-review.ts packages/core/test/live/orchestrator-live-failover.ts packages/core/test/live/orchestrator-task-thread-integration.ts packages/core/test/live/orchestrator-task-thread-restart.ts packages/core/test/live/research-task-thread-live.ts packages/core/test/live/task-agent-live-smoke.ts packages/core/vitest.config.ts
```

Result:

```text
Checked 12 files in 26ms. No fixes applied.
```

## Root Verify

Command:

```bash
bun run verify
```

Result: FAIL on unrelated existing lint errors outside this change. The command passed `check:agents-claude`, type-safety ratchet, error-policy ratchet, and then failed in the root turbo lint lane at `@elizaos/tui#lint` on existing TUI lint diagnostics, including:

```text
src/components/editor.ts:56:5 lint/suspicious/noControlCharactersInRegex
src/keys.ts:555:7 lint/suspicious/noControlCharactersInRegex
test/truncated-text.test.ts:47:40 lint/suspicious/noControlCharactersInRegex
ERROR @elizaos/tui#lint
```

The verify run also executed write-mode lint tasks; unrelated auto-fixes outside this issue scope were restored before staging.

## Other Evidence Rows

- Live LLM trajectory: N/A — comments-only change, zero functional diff machine-checked by `scripts/assert-comment-only-diff.mjs`.
- Screenshots/video/audio: N/A — comments-only change, no UI/runtime behavior changed.
- Backend/frontend logs: N/A — comments-only change.
