# 8932 Orchestrator Scenario Evidence

Command:

```bash
bun run --cwd packages/scenario-runner test:orchestrator:pr:e2e
```

Result:

- Run id: `5aefb799-3234-457a-a022-8d699a9215e2`
- Provider: `deterministic-llm-proxy`
- Scenarios: 3 passed, 0 failed, 0 skipped
- Viewer: `viewer/index.html`
- Matrix report: `matrix.json`
- Native export: `native.jsonl` plus `native.manifest.json`

Note: the PR lane uses deterministic orchestrator action fixtures so it can run
in CI without live model secrets. The runner still executes the official
`--export-native` path; the manifest records zero trajectory rows for this lane
because no trajectory DB files are produced by the deterministic action harness.

## Live-model trajectory (`live-grilling-trajectory.json`)

The deterministic PR lane above does NOT exercise a live model. To satisfy the
"run against a live model" acceptance criterion, the grilling-happy-path loop was
also driven against the **live Cerebras `gpt-oss-120b`** (the same judge model the
scenario runner uses), via the real `OrchestratorTaskService` verification path
over a scripted ACP:

```bash
bun --conditions=eliza-source \
  plugins/plugin-agent-orchestrator/test/scenarios/_live-grilling-evidence.ts
```

Result (`live-grilling-trajectory.json`, platform `win32 x64`):

- **Round 1** — sub-agent claims done with no test output → the live model returns
  `{"passed": false, "missing": ["tests pass"]}`; the orchestrator **grills**
  (corrective re-prompt citing `tests pass`), task stays `active`. ✅
- **Round 2** — sub-agent re-reports with pasted `vitest` output → the live model
  returns `{"passed": true}`; the task is **verified `done`**. ✅

The full request/response of both live judgements is captured in the JSON. The
scenario-runner CLI itself cannot boot in the sandbox (unrelated `voice-workbench`
/ `@types/react` resolution), so this script produces the live artifact directly;
the deterministic logic is additionally covered by
`plugins/plugin-agent-orchestrator/src/__tests__/orchestrator-scenario-logic.test.ts`,
green on Windows alongside the #8875/#8924 suites:

```
$ bunx vitest run \
    src/__tests__/sub-agent-completion-finish-reason.test.ts \
    src/__tests__/parent-agent-broker.test.ts \
    src/__tests__/spend-allowance.test.ts \
    src/__tests__/orchestrator-scenario-logic.test.ts
 Test Files  4 passed (4)
      Tests  49 passed (49)
```
