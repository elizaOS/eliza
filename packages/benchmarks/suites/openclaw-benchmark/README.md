# OpenClaw-Bench

AI coding assistant benchmark evaluating four task categories: environment setup, feature implementation (weather CLI), refactoring (modular architecture), and testing (unit + integration).

This directory is part of `packages/benchmarks`.

Install the suite’s Python dependencies before running its tests.

Test from the repository root:

```bash
PYTHONPATH="$PWD/packages" python -m pytest packages/benchmarks/suites/openclaw-benchmark/tests --import-mode=importlib
```
