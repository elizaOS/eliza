# REALM-Bench (elizaOS implementation)

Real-World Planning benchmark: 11 problem types (TSP, VRP, DARP, event coordination, disaster relief, JSSP) drawn from arXiv:2502.18836.

## Development

Use a Python environment matching `pyproject.toml` and install the required dependencies.

No compilation or wheel build is required to run this suite from source.

Test from the repository root:

```bash
PYTHONPATH=packages python -m pytest packages/benchmarks/suites/realm/tests
```
