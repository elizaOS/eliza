# Issue 8912 Evidence: Browser + Computer-Use Progress Streaming

Date: 2026-06-22

## What This Proves

- `BROWSER` emits a compact `streamProgress` callback:
  `Step 1: screenshot — capture seeded scenario tab`.
- `COMPUTER_USE_AGENT` emits per-step progress from the real loop helper:
  `Step 1: finish — scenario complete`.
- `COMPUTER_USE` relays approval requests to the originating callback with
  inline approve/deny choices:
  `cua:approval_8912:approve=Approve` and
  `cua:approval_8912:deny=Deny`.
- Telegram compact progress editing and Telegram approval callback resolution
  are covered by `plugins/plugin-telegram/src/messageManager.edit-react.test.ts`.

## Scenario Artifact

Command:

```bash
SCENARIO_USE_LLM_PROXY=1 SCENARIO_LLM_PROXY_STRICT=1 \
  bun --conditions eliza-source --tsconfig-override ../../tsconfig.json \
  src/cli.ts run test/scenarios/deterministic-browser-computeruse-progress.scenario.ts \
  --lane pr-deterministic \
  --runId 8912-browser-computeruse-progress \
  --report-dir ../../.github/issue-evidence/8912-browser-computeruse-progress \
  --run-dir ../../.github/issue-evidence/8912-browser-computeruse-progress \
  --export-native ../../.github/issue-evidence/8912-browser-computeruse-progress/native.jsonl
```

Result: 1 passed, 0 failed, 0 skipped.

Files:

- `matrix.json` — aggregate scenario report.
- `deterministic-browser-computeruse-progress.json` — per-scenario report.
- `viewer/index.html` — scenario run viewer.
- `viewer-screenshot.png` — screenshot of the viewer.
- `native.jsonl` / `native.manifest.json` — native export placeholders; this
  scenario performs no LLM calls, so there are zero native model-boundary rows.

## Verification Commands

```bash
bun run --cwd plugins/plugin-computeruse test
bun run --cwd plugins/plugin-browser test
bun run --cwd plugins/plugin-telegram test -- src/messageManager.edit-react.test.ts
bun run --cwd plugins/plugin-computeruse typecheck
bun run --cwd plugins/plugin-browser typecheck
bunx tsc --noEmit -p plugins/plugin-telegram/tsconfig.json
bunx @biomejs/biome check plugins/plugin-computeruse/src/actions/progress.ts plugins/plugin-computeruse/src/actions/use-computer-agent.ts plugins/plugin-computeruse/src/actions/use-computer.ts plugins/plugin-computeruse/src/actions/window-handlers.ts plugins/plugin-computeruse/src/__tests__/computer-use-agent.test.ts plugins/plugin-computeruse/src/__tests__/computer-use-approval-relay.test.ts plugins/plugin-browser/src/actions/browser.ts plugins/plugin-browser/src/actions/browser.test.ts plugins/plugin-telegram/src/messageManager.ts plugins/plugin-telegram/src/messageManager.edit-react.test.ts packages/scenario-runner/test/scenarios/deterministic-browser-computeruse-progress.scenario.ts
```

Observed results:

- Computer-use plugin suite: 38 files passed, 368 tests passed, 1 skipped.
- Browser plugin suite: 14 files passed, 67 tests passed.
- Telegram targeted suite: 1 file passed, 7 tests passed.
- Typechecks and targeted Biome check passed.

Note: the full Telegram plugin suite currently has an unrelated stale
`command-registration.test.ts` expectation for `/think high`; current command
code and the existing deterministic slash-command scenario both route `/think`
through the agent pipeline.
