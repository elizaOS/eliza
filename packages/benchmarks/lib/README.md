# Benchmark infrastructure

Shared Python retry, pricing, telemetry, result history and corpus utilities.
Transport clients belong to `harnesses/`; workload policy belongs to its suite.
Cross-package callers use the public `benchmarks.lib` API where available.

From the repository root with `requirements-ci.txt` installed:

```bash
PYTHONPATH=packages python -m pytest packages/benchmarks/lib
```
