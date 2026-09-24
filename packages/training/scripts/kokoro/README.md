# Kokoro-82M fine-tune pipeline

End-to-end fine-tuning pipeline for the [`hexgrad/Kokoro-82M`](https://huggingface.co/hexgrad/Kokoro-82M) TTS model (StyleTTS-2 + iSTFTNet) on LJSpeech-format datasets.

This directory is part of `packages/training`.

Use a Python environment matching `pyproject.toml` and install the required dependencies.

No standalone wheel build is configured; run the Python sources directly.

Test from `packages/training`:

```bash
python -m pytest
```
