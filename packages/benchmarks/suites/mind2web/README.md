# Mind2Web benchmark for elizaOS

Web agent benchmark based on [OSU-NLP-Group/Mind2Web](https://github.com/OSU-NLP-Group/Mind2Web).

## Development

Use a Python environment matching `pyproject.toml` and install the required dependencies.

No compilation or wheel build is required to run this suite from source.

Test from the repository root:

```bash
PYTHONPATH=packages python -m pytest packages/benchmarks/suites/mind2web/tests
```
