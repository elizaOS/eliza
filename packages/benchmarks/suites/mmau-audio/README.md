# Audio MMAU — Massive Multi-task Audio Understanding

Audio MMAU (Sakshi et al., ICLR 2025): 10,000 audio clips across speech, sound, and music domains, 27 reasoning skills, all multiple-choice.

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
