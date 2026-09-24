# hermes-adapter

Bridge adapter connecting the elizaOS benchmark suite to [hermes-agent](https://github.com/NousResearch/hermes-agent) (NousResearch).

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
