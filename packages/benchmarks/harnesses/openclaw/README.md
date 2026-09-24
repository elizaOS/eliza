# openclaw-adapter

Python bridge that runs benchmark turns through OpenClaw's embedded agent and native plugin loop.

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
