# Mind2Web benchmark for elizaOS

Web agent benchmark based on [OSU-NLP-Group/Mind2Web](https://github.com/OSU-NLP-Group/Mind2Web).

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
