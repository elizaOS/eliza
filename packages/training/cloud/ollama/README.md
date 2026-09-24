# Ollama Modelfiles for the Eliza-1 series

Three Modelfiles, one per published size, all pulling GGUF artifacts from the public consolidated `elizaos/eliza-1` bundle repo on HuggingFace.

This directory is part of `packages/training`.

Use a Python environment matching `pyproject.toml` and install the required dependencies.

No standalone wheel build is configured; run the Python sources directly.

Test from this directory:

```bash
python -m pytest
```
