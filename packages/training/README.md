# Eliza-1 training

Training, evaluation, quantization, and publishing tools for Eliza-1. Model
choices and hardware requirements live in `scripts/training/model_registry.py`.
Generated models and private datasets stay outside version control.

Use Python 3.11 or 3.12 and uv. From this directory:

```bash
uv sync --extra train
uv run --extra train python -m pytest
```

There is no package build: training and model conversion run directly from
`scripts/`. Use the relevant script's `--help` for its inputs. Training requires
compatible accelerator hardware; publication requires Hugging Face credentials.

Preserve complete model requests and responses; reject oversized training rows
instead of truncating them. Evaluate the exported artifact before publication.
