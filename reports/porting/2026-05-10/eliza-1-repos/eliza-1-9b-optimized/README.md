---
library_name: gguf
tags:
  - eliza1
  - eliza-1-optimized
  - qwen3
  - q4_polar
  - qjl
  - turboquant
  - dflash
license: apache-2.0
---

# Eliza-1 9B — Eliza-1 fused stack

This repo ships a **fused-kernel** GGUF that combines every trick the
Eliza-1 local-inference stack supports in a single file. It is not a
stock llama.cpp build — loading it requires the elizaOS/llama.cpp
fork (`v1.0.0-eliza`) which provides the Q4_POLAR, QJL1_256, and TBQ
kernels.

## Optimization stack

- **Q4_POLAR** weight quantization (4-bit, Hadamard-rotated)
- **QJL1_256** 1-bit K-cache (Johnson-Lindenstrauss projection)
- **TBQ4_0** V-cache (TurboQuant)

## Status

**Placeholder.** The GGUF is not yet uploaded. W5-Pipeline produces
the file from `elizaos/eliza-1-9b`; once it lands, the publisher
(`packages/training/scripts/publish_eliza1_model.py`) ships it here.

## Loading

```bash
# Phone runtime (auto, via the local-inference catalog).
# Catalog id: eliza-1-9b-optimized

# Manual download:
huggingface-cli download elizaos/eliza-1-9b-optimized eliza-1-9b-optimized.gguf

# llama-server (with the elizaOS/llama.cpp fork):
./llama-server --hf-repo elizaos/eliza-1-9b-optimized \
  --hf-file eliza-1-9b-optimized.gguf \
  --alias eliza1 --ctx-size 8192 --flash-attn
```

## Repo layout

- `eliza-1-9b-optimized.gguf` — the fused-stack GGUF.
- `manifest.json` — drafter pairing + optimization stack metadata.
  Schema documented in `packages/training/scripts/HF_PUBLISHING.md`
  (Drafter pairing manifest section).

## Training

- Trained from: `elizaos/eliza-1-9b`
- Pipeline: `elizaos/eliza-1-pipeline`
- Scripts: `packages/training/scripts/`
