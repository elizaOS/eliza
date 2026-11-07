# openclaw-adapter

Python bridge that runs benchmark turns through OpenClaw's embedded agent and native plugin loop.

## Development

Use Python 3.11+ and install the shared support package with this harness
from the repository root:

```bash
python -m pip install ./packages/benchmarks ./packages/benchmarks/harnesses/openclaw
```

No compilation or wheel build is required to run this suite from source.

Test from this directory:

```bash
python -m pytest
```
