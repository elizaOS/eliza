# SWE-bench

Software engineering benchmark (Lite / Verified / Full / Multilingual): generates unified-diff patches for real GitHub issues and evaluates them with the official SWE-bench Docker harness.

## Development

Use a Python environment matching `pyproject.toml` and install the required dependencies.

No compilation or wheel build is required to run this suite from source.

Test from the repository root:

```bash
PYTHONPATH=packages python -m pytest packages/benchmarks/suites/swe_bench/tests
```
