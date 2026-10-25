# Turn-detector fine-tune pipeline

Eliza-1 ships a bundled semantic end-of-turn (EOT) detector — one of three Tier-3 EOU classifiers the runtime resolves at voice-session start (`plugins/plugin-local-inference/src/services/voice/eot-classifier.ts`).

This directory is part of `packages/training`.

Use a Python environment matching `pyproject.toml` and install the required dependencies.

No standalone wheel build is configured; run the Python sources directly.

Test from `packages/training`:

```bash
python -m pytest
```
