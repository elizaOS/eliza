# Nl2RepoBench

Long-horizon, 0-to-1 repository generation benchmark (arXiv:2512.12730).

This directory is part of `packages/benchmarks`.

Install the suite’s Python dependencies before running its tests.

Test from the repository root:

```bash
PYTHONPATH="$PWD/packages" python -m pytest packages/benchmarks/suites/nl2repo/tests --import-mode=importlib
```
