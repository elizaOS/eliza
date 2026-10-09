# Training optimizers — APOLLO

This directory owns the **optimizer side** of the local SFT pipeline.

This directory is part of `packages/training`.

Use a Python environment matching `pyproject.toml` and install the required dependencies.

Install the training package with `uv sync --extra train`; modules use the
`eliza_training.training` namespace.

Test from `packages/training`:

```bash
python -m pytest
```
