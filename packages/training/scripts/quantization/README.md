# Post-Training Quantization

This directory holds the post-training quantization passes used to shrink the fine-tuned Eliza checkpoints before they leave the training rig.

This directory is part of `packages/training/scripts`.

Use a Python environment matching `pyproject.toml` and install the required dependencies.

No standalone wheel build is configured; run the Python sources directly.

Test from this directory:

```bash
python -m pytest
```
