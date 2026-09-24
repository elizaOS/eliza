# Benchmark viewer

Static browser UI for normalized benchmark results, served by the orchestrator.

No separate build. With Python 3.11+ and benchmark dependencies installed,
run tests from the repository root:

```bash
PYTHONPATH=packages python3 -m pytest packages/benchmarks/tests
```

Start the viewer from the repository root:

```bash
PYTHONPATH=packages python3 -m benchmarks.orchestrator serve-viewer
```
