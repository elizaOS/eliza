# ASR fine-tune scaffold — frozen during Gemma cutover

This directory contains the fine-tune scaffold for the **eliza-1 ASR model** while ASR artifacts are frozen.

This directory is part of `packages/training/scripts`.

Use a Python environment matching `pyproject.toml` and install the required dependencies.

No standalone wheel build is configured; run the Python sources directly.

Test from this directory:

```bash
python -m pytest
```
