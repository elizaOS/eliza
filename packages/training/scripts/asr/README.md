# ASR fine-tune scaffold — frozen during Gemma cutover

This directory contains the fine-tune scaffold for the **eliza-1 ASR model** while ASR artifacts are frozen.

This directory is part of `packages/training`.

Use a Python environment matching `pyproject.toml` and install the required dependencies.

No standalone wheel build is configured; run the Python sources directly.

Test from `packages/training`:

```bash
python -m pytest
```
