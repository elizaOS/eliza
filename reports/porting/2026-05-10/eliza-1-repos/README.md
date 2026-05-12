# Eliza-1 HF publishing scaffold (placeholder repos)

This directory holds README + `manifest.json` placeholders for the
Eliza-1 fused-kernel HuggingFace repos. Each subdirectory becomes a real
`elizaos/*` HF repo once W5-Pipeline drops the corresponding fused GGUF
into it; the publisher (`packages/training/scripts/publish_eliza1_model.py`)
refuses to push a zero-byte GGUF, so the placeholders cannot accidentally
ship.

Historical note: this directory was formerly `milady-ai-repos/` and the
repos lived under the `milady-ai` HF namespace. The canonical namespace
is now `elizaos/eliza-1-*` (the `milady-ai` GitHub/HF org was transferred
to `elizaos`). The `-milady-optimized` / `-milady-drafter` bundle infix
has been dropped — bundles are named `<base>-optimized` / `<base>-drafter`.

See `UPLOAD.md` for the per-repo upload commands and
`packages/training/scripts/HF_PUBLISHING.md` for the manifest schema.
