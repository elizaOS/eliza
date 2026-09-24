# Voice Speaker Validation

W3-6 multi-speaker audio validation benchmark: diarization accuracy, speaker ID cosine thresholds, entity creation (Jill scenario), owner LRU cache latency, and async profile search.

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
