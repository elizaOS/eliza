# Benchmark tests

Tests for benchmark infrastructure, scoring, and orchestration; these do not measure model quality.

No separate build. With Python 3.11+ and benchmark dependencies installed,
run tests from the repository root:

```bash
PYTHONPATH=packages python3 -m pytest packages/benchmarks/tests
```
