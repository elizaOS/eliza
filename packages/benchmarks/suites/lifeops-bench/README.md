# LifeOpsBench

Multi-turn, tool-use benchmark for life-assistant agents.

The [quality sub-suite](quality/README.md) owns the deterministic classifier and
scheduler regression gates. These do not measure cross-framework agent quality.

## Development

Use a Python environment matching `pyproject.toml` and install the required dependencies.

No compilation or wheel build is required to run this suite from source.

Test from this directory:

```bash
python -m pytest
```
