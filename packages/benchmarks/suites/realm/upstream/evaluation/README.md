# REALM-Bench evaluation

Upstream task definitions, framework adapters, and metrics for planning quality,
optimality, coordination, constraint satisfaction, resource use, and disruption
handling. Attribution and licensing are recorded in
[ATTRIBUTION.md](../ATTRIBUTION.md).

No separate build is required. Install pytest and pytest-asyncio plus the owning suite's Python dependencies
and test its integration from the repository root:

```bash
PYTHONPATH=packages python -m pytest packages/benchmarks/suites/realm/tests
```

Benchmark execution belongs to the [owning suite](../../README.md); this
subdirectory does not contain the standalone run_evaluation.py launcher.
