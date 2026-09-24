# Terminal-Bench for elizaOS

Terminal proficiency benchmark: evaluates AI agents on 241 real-world terminal tasks (algorithms, system-administration, ML, debugging, and more) vendored from the Laude Institute's [Terminal-Bench](https://www.tbench.ai/) (Apache-2.0).

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

Before full-corpus runs or dataset tests, run `python3 scripts/fetch-corpus-assets.py`
from this directory. It explicitly downloads missing large inputs and protected
bytecode fixtures, verifying their revision, byte counts, and SHA-256 values
against `corpus-manifest.json`. Normal installation does not fetch them.
