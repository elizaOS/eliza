# eliza-adapter

Python bridge that connects benchmark runners (Python) to the elizaOS agent runtime (TypeScript) over HTTP.

## Development

Use a Python environment matching `pyproject.toml` and install the required dependencies.

No compilation or wheel build is required to run this suite from source.

Test from this directory:

```bash
python -m pytest
```

The default Bun launcher explicitly selects `eliza-source` exports so packages supporting that condition execute their checkout sources. The Node/tsx fallback uses built packages; build them first and retain build provenance when comparing results. `ELIZA_BENCH_SERVER_CMD` overrides must explicitly select their intended source or build resolution.
