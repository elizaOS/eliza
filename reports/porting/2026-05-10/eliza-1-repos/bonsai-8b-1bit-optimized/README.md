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

# Bonsai 8B 1-bit + Eliza-1 fused stack — Eliza-1 fused stack

This repo ships a **fused-kernel** GGUF that combines every trick the
Eliza-1 local-inference stack supports in a single file. It is not a
stock llama.cpp build — loading it requires the elizaOS/llama.cpp
fork (`v1.0.0-eliza`) which provides the Q4_POLAR, QJL1_256, and TBQ
kernels.

## Optimization stack

- **Q4_POLAR** weight quantization (4-bit, Hadamard-rotated)
- **QJL1_256** 1-bit K-cache (Johnson-Lindenstrauss projection)
- **TBQ4_0** V-cache (TurboQuant)
- **DFlash** speculative decoding via elizaos/bonsai-8b-1bit-drafter

## Status

**Placeholder.** The GGUF is not yet uploaded. W5-Pipeline produces
the file from `apothic/bonsai-8B-1bit-turboquant`; once it lands, the publisher
(`packages/training/scripts/publish_eliza1_model.py`) ships it here.

## Loading

```bash
# Phone runtime (auto, via the local-inference catalog).
# Catalog id: bonsai-8b-1bit-optimized

# Manual download:
huggingface-cli download elizaos/bonsai-8b-1bit-optimized bonsai-8b-1bit-optimized.gguf

# llama-server (with the elizaOS/llama.cpp fork):
./llama-server --hf-repo elizaos/bonsai-8b-1bit-optimized \
  --hf-file bonsai-8b-1bit-optimized.gguf \
  --alias eliza1 --ctx-size 8192 --flash-attn
```

## Repo layout

- `bonsai-8b-1bit-optimized.gguf` — the fused-stack GGUF.
- `manifest.json` — drafter pairing + optimization stack metadata.
  Schema documented in `packages/training/scripts/HF_PUBLISHING.md`
  (Drafter pairing manifest section).

## Training

- Trained from: `apothic/bonsai-8B-1bit-turboquant`
- Pipeline: `elizaos/eliza-1-pipeline`
- Scripts: `packages/training/scripts/`
