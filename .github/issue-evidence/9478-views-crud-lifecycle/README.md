# 9478 VIEWS CRUD lifecycle scenario evidence

Command:

```bash
SCENARIO_USE_LLM_PROXY=1 bun --conditions eliza-source --tsconfig-override ./tsconfig.json packages/scenario-runner/src/cli.ts run plugins/plugin-app-control/test/scenarios --scenario views-crud-lifecycle --report /private/tmp/views-crud-lifecycle-report.json --run-dir /private/tmp/views-crud-lifecycle-run
```

Result:

- Scenario run `5e766926-57ba-4486-88a5-e3b867304978`
- `views-crud-lifecycle` passed, 6 turns, 0 failures
- Artifacts:
  - `report.json`
  - `matrix.json`
  - `viewer/index.html`
  - `viewer/data.js`

Live-model note:

No live LLM provider key was present in the shell where this evidence was
captured, so this is deterministic LLM proxy evidence rather than a live-model
trajectory.
