# Issue #13395 — orchestrator lifecycle category metrics

Date: 2026-07-04

## Change

- `ScenarioResult` now carries the scenario `category` from the loaded dataset.
- Lifecycle category metrics are computed from `ScenarioResult.category` instead
  of substrings in `scenario_id`.
- The regression test covers `check_in_while_running`, whose category is
  `status` even though its ID does not contain `status`.

## Verification

- `pytest packages/benchmarks/orchestrator_lifecycle/tests/test_evaluator.py -q`
  - 13 tests passed.
- `PYTHONPATH=packages/benchmarks/eliza-adapter pytest packages/benchmarks/orchestrator_lifecycle/tests/ -q`
  - 27 tests passed.
- `python3 -m compileall -q packages/benchmarks/orchestrator_lifecycle`
  - Passed.
- `PYTHONPATH=. python3 -m benchmarks.orchestrator_lifecycle.cli --mode simulate --max-scenarios 3 --output /tmp/olc-13395-smoke`
  - Passed as smoke-only harness validation.

## Smoke Report Inspection

Report inspected:
`/tmp/olc-13395-smoke/orchestrator-lifecycle-20260704_111209.json`

The report is `scored: false` because simulate mode is not a benchmark result.
The inspected scenarios include:

- `cancel_task`, category `interrupt`, score `1.0`
- `cancel_then_undo_resume`, category `interrupt`, score `1.0`
- `check_in_while_running`, category `status`, score `1.0`

Inspected metrics:

- `status_accuracy_rate: 1.0`
- `interruption_handling_rate: 1.0`
- `overall_score: null` as expected for simulate mode.

## Not Captured

- Real-model bridge-mode benchmark output was not captured for this local
  harness-math fix. The simulate report proves report shape and category math
  only; real provider evidence remains required before publishing benchmark
  results.
