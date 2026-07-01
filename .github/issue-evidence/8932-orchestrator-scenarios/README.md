# 8932 Orchestrator Scenario Evidence

Command:

```bash
bun run --cwd packages/scenario-runner test:orchestrator:pr:e2e
```

Result:

- Run id: `471802ef-d3e8-4d34-8420-a5b27e75c32f`
- Provider: `deterministic-llm-proxy`
- Scenarios: 3 passed, 0 failed, 0 skipped (the lane also runs the unrelated
  `orchestrator-view-cloud-deploy` scenario; the three #8932 scenarios are the
  evidence here)
- Viewer: `viewer/index.html`
- Matrix report: `matrix.json`
- Native export: `native.jsonl` (**3 `eliza_native_v1` rows**) plus
  `native.manifest.json` (`counts.rows: 3`, `passedRows: 3`)

Note: the PR lane uses the deterministic LLM proxy so it can run in CI without
live model secrets. It executes the official `--export-native` path, and the
manifest now records **3 non-empty trajectory rows** (previously zero). The
orchestrator's grill is a real `runtime.useModel(TEXT_SMALL)` call inside
`verifyGoalCompletion`; that call is now recorded as a one-stage trajectory
(`recordVerifierBoundary`), which the native-export classifier tags as
`task_type: goal_verification`, `domain: agent-orchestrator`. The three rows are:

- `orchestrator-evidence-bundle` — 1 row: the verifier prompt carries the git
  diff + test stdout + verified URL, verdict `passed: true`.
- `orchestrator-grilling-happy-path` — 2 rows: round 1 verdict `passed: false`
  ("did not paste the required test output" → the grill fires), round 2 verdict
  `passed: true` after pasted proof.

Each row carries `scenarioStatus: passed` so the training-prep scorer treats it
as a gold row, not a repair row. This is the keyless, reproducible resolution of
the original "native JSONL is empty" gap.

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

## Runs on Windows · desktop app · browser (`desktop-dashboard-windows.png`)

`bun run dev` was booted on Windows and the dashboard opened in a headless
Chromium (the desktop app renders the same web UI):

- API server ready on `http://127.0.0.1:31337`; dashboard served `HTTP 200` on
  `http://localhost:2138/`.
- `[boot] @elizaos/plugin-agent-orchestrator loaded in 749ms` — the orchestrator
  plugin (carrying the #8875/#8924 changes now on develop) loaded into the live
  app; `Agent ready (129.5s)`.
- The dashboard rendered cleanly (screenshot `desktop-dashboard-windows.png`,
  `1440×900`, title `Eliza`, 0 page errors). `GET /api/agents` → `200`.
- Screen recording `desktop-dashboard-windows.webm` captures the live UI being
  interactive: load → hover the run-mode options → open **Advanced**, which
  navigates to the "Connect your own agent" setup (server address / access token).

In this dev runtime the orchestrator registers its stub surface (no terminal
support → `/api/orchestrator/*` routes are intentionally not mounted; see the
plugin's gating), so the orchestrator *logic* is exercised by the unit suites and
the live-model trajectory above rather than those HTTP routes.
