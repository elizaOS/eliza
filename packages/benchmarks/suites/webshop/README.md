# elizaos-webshop

elizaOS adapter for the **WebShop** benchmark (Yao et al., NeurIPS 2022).

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
