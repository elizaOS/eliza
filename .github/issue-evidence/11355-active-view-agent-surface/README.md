# Issue 11355 Evidence: Active-View Agent Surface Trajectory

## Scope

Keyless strict scenario-runner coverage for the active-view planner -> element id -> VIEWS interact loop.

Live-model capture is N/A for this run: this environment had no provider credentials available (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GOOGLE_GENERATIVE_AI_API_KEY`, etc.), so the committed artifact is the deterministic strict LLM-proxy lane requested for PR gating.

## Commands

```bash
bun run --cwd packages/agent test -- src/runtime/conversation-compactor-runtime.test.ts
```

Result: passed, 1 file / 43 tests.

```bash
SCENARIO_USE_LLM_PROXY=1 SCENARIO_LLM_PROXY_STRICT=1 \
  bun --conditions eliza-source --tsconfig-override ../../tsconfig.json src/cli.ts run test/scenarios \
  --scenario deterministic-active-view-agent-surface \
  --lane pr-deterministic \
  --report ../../.github/issue-evidence/11355-active-view-agent-surface/report.json \
  --report-dir ../../.github/issue-evidence/11355-active-view-agent-surface/viewer \
  --run-dir ../../.github/issue-evidence/11355-active-view-agent-surface/run \
  --export-native ../../.github/issue-evidence/11355-active-view-agent-surface/native.jsonl
```

Result: passed, 1 scenario / 0 failures.

## Manual Review

Reviewed `report.json`: the scenario passed; shell navigate accepted `scenario-active-ledger`; shell element report accepted `ledger-title` and `save-ledger`; planner selected `VIEWS` twice with `action=interact`; final checks passed for `actionCalled`, `selectedActionArguments`, and exact `serverInteract` domain effects.

Reviewed `native.jsonl`: 16 native rows, all from the passed scenario; planner rows show `promptOptimization.transformations=["active-view-awareness:scenario-active-ledger"]` and tool calls for `agent-fill` on `ledger-title` and `agent-click` on `save-ledger`.

Reviewed viewer artifacts:

- `viewer/matrix.json`
- `viewer/001-deterministic-active-view-agent-surface.json`
- `run/matrix.json`
- `run/viewer/data.js`
