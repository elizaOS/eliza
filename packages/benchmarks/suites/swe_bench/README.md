# SWE-bench

Software engineering benchmark (Lite / Verified / Full / Multilingual): generates unified-diff patches for real GitHub issues and evaluates them with the official SWE-bench Docker harness.

## Development

Use a Python environment matching `pyproject.toml` and install the required dependencies.

Build from this directory:

```bash
python -m pip wheel --no-deps . --wheel-dir dist
```

Test from this directory:

```bash
python -m pytest
```
