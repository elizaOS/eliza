"""Kokoro-82M fine-tune pipeline for the Eliza-1 voice stack.

End-to-end scripts: dataset prep, LoRA / full fine-tune, voice-style embedding
extraction, ONNX export, evaluation, and release packaging. See README.md for
the architectural rationale; every script in this directory has its own
`--help`, a `--dry-run` mode, and a contract documented at the top of the file.
"""
