# eliza-adapter

Python bridge that connects benchmark runners (Python) to the elizaOS agent runtime (TypeScript) over HTTP.

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
