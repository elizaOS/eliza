# Cloud-GPU one-line runner — `run-on-cloud.sh`

One command to rent a GPU, run an Eliza-1 task on it, pull the evidence back into the repo, and tear the instance down. **It fails closed:** it will not provision a paid instance unless you pass `--yes-i-will-pay` *and* the relevant API-key env var is set.

This directory is part of `packages/training`.

Use a Python environment matching `pyproject.toml` and install the required dependencies.

No standalone wheel build is configured; run the Python sources directly.

Test from `packages/training`:

```bash
python -m pytest
```
