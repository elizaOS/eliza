# Codex Adapter

Benchmark harness adapter for the Codex CLI. Requires an installed, authenticated CLI for live runs.

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
