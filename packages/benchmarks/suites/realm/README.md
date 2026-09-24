# REALM-Bench (elizaOS implementation)

Real-World Planning benchmark: 11 problem types (TSP, VRP, DARP, event coordination, disaster relief, JSSP) drawn from arXiv:2502.18836.

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
