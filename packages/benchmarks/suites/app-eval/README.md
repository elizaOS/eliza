# App Eval Benchmarks

End-to-end evaluation suite for elizaOS app agents.

This directory is part of `packages/benchmarks`.

Install the suite’s Python dependencies before running its tests.

Test from the repository root:

```bash
PYTHONPATH="$PWD/packages" python -m pytest packages/benchmarks/suites/app-eval/tests --import-mode=importlib
```
