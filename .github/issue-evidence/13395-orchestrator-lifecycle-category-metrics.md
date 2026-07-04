# Issue 13395 - Orchestrator Lifecycle Category Metrics

## Scope

Fix lifecycle benchmark category metrics so they use the scenario's explicit
`category` field instead of substring matching against `scenario_id`.

## Validation

```bash
PYTHONPATH=packages python3 -m pytest packages/benchmarks/orchestrator_lifecycle/tests/test_evaluator.py -q
```

Result:

```text
13 passed in 0.09s
```

```bash
PYTHONPATH=packages python3 -m pytest packages/benchmarks/orchestrator_lifecycle/tests/ -q
```

Result:

```text
27 passed in 0.32s
```

Smoke report:

```bash
PYTHONPATH=packages python3 -m benchmarks.orchestrator_lifecycle.cli \
  --mode simulate \
  --max-scenarios 3 \
  --output /tmp/olc-13395-smoke
```

Result:

```text
Mode: simulate
Scenarios: 3
Harness self-check pass rate: 100.0%
Report: /tmp/olc-13395-smoke/orchestrator-lifecycle-20260704_141739.json
```

Inspected report snippet:

```json
{
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
  "scenario_categories": [
    ["cancel_task", "interrupt", 1.0],
    ["cancel_then_undo_resume", "interrupt", 1.0],
    ["check_in_while_running", "status", 1.0]
  ]
}
```

The status metric includes `check_in_while_running` through its structural
`category: "status"` field even though the scenario ID does not contain
`status`.
