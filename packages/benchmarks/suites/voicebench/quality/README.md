# elizaOS VoiceBench (quality)

Vendored implementation of VoiceBench (Chen et al. 2024): 8 task suites covering 6,783 spoken instructions, measuring response quality (score in [0, 1]) for voice-input language assistants.

## Development

Install the shared Python support package from the repository root with `python -m pip install ./packages/benchmarks` before installing this suite.

Use a Python environment matching `pyproject.toml` and install the required dependencies.

No compilation or wheel build is required to run this suite from source.

Test from this directory:

```bash
python -m pytest
```
