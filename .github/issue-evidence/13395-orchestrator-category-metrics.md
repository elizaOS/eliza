# Issue #13395: Orchestrator lifecycle category metrics

## Change

- `ScenarioResult` now carries the explicit scenario `category`.
- `LifecycleEvaluator.compute_metrics()` derives the surfaced category metrics from `ScenarioResult.category` instead of substring matches against `scenario_id`.
- Completion summary uses the existing dataset category value `completion_summary`; interruption uses the existing dataset category value `interrupt`.
- Added regression coverage for IDs that omit their category name and IDs that contain misleading category substrings.

## Verification

```bash
PYTHONPATH=packages pytest packages/benchmarks/orchestrator_lifecycle/tests/test_evaluator.py -v
```

Result: 15 passed.

```bash
PYTHONPATH=packages pytest packages/benchmarks/orchestrator_lifecycle/tests/ -v
```

Result: 29 passed.

```bash
PYTHONPATH=packages python -m compileall packages/benchmarks/orchestrator_lifecycle
```

Result: compiled successfully.

```bash
PYTHONPATH=packages python -m benchmarks.orchestrator_lifecycle.cli --mode simulate --max-scenarios 3 --output /tmp/olc-smoke-13395
```

Result:

- Mode: simulate
- Scenarios: 3
- Harness self-check pass rate: 100.0%
- Report: `/tmp/olc-smoke-13395/orchestrator-lifecycle-20260704_141144.json`

Smoke report guard and shape:

```json
{
  "mode": "simulate",
  "scored": false,
  "metrics": {
    "overall_score": null,
    "scenario_pass_rate": 1.0,
    "total_scenarios": 3,
    "passed_scenarios": 3,
    "clarification_success_rate": 0.0,
    "status_accuracy_rate": 1.0,
    "interruption_handling_rate": 1.0,
    "completion_summary_quality": 0.0
  },
  "scenarios": [
    { "scenario_id": "cancel_task", "category": "interrupt", "score": 1.0, "passed": true },
    { "scenario_id": "cancel_then_undo_resume", "category": "interrupt", "score": 1.0, "passed": true },
    { "scenario_id": "check_in_while_running", "category": "status", "score": 1.0, "passed": true }
  ]
}
```

```bash
git diff --check
```

Result: passed.

## Repository verify

After syncing with `origin/develop`, the required install step completed:

```bash
bun install
```

Result: passed.

The full repository verify was attempted:

```bash
bun run verify
```

Result: failed before package typecheck/lint because Turbo reported an existing
workspace build cycle:

```text
Cyclic dependency detected:
  @elizaos/plugin-local-inference#build, @elizaos/agent#build

The cycle can be broken by removing any of these sets of dependencies:
  @elizaos/agent#build -> @elizaos/plugin-local-inference#build
  @elizaos/plugin-local-inference#build -> @elizaos/agent#build
```

This PR only touches `packages/benchmarks/orchestrator_lifecycle` and the
evidence file above.

## Not captured

Real-model bridge-mode benchmark output was not captured for this harness-math
fix. The simulate report proves report shape, category propagation, category
metric math, and the unscored smoke guard only.
