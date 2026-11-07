# elizaOS Benchmark Orchestrator

Campaign runner for benchmark suites across agent harnesses, with resumable execution and result storage.

This directory is part of `packages/benchmarks`.

Runs from source with the offline dependencies in `../requirements-ci.txt`.

Test from the repository root:

```bash
PYTHONPATH="$PWD/packages" python -m pytest packages/benchmarks/orchestrator/tests --import-mode=importlib
```

Native decision reports must record the selected fixture IDs and repetition count. Publication requires exactly those case IDs, including failed attempts; missing, duplicate or unexpected results remain diagnostic. Older reports without a selection manifest require explicit evidence-backed regrading before comparison.

Results default to repository-root `test-results/benchmark-orchestrator/`. Set `BENCHMARK_RESULTS_DIR` to explicitly read or resume an existing archive. Nonempty legacy output directories are rejected until explicitly selected or archived; stores are never silently combined.
