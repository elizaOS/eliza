---
library_name: gguf
tags:
  - milady-ai
  - milady-drafter
  - qwen3
  - q4_polar
  - qjl
  - turboquant
  - dflash
license: apache-2.0
---

# Qwen3.6 27B drafter (2B) — Milady fused stack

This repo ships a **fused-kernel** GGUF that combines every trick the
milady local-inference stack supports in a single file. It is not a
stock llama.cpp build — loading it requires the milady-ai/llama.cpp
fork (`v0.1.0-milady`) which provides the Q4_POLAR, QJL1_256, and TBQ
kernels.

## Optimization stack

- **Q4_POLAR** drafter weights
- f16 KV cache (drafter contexts are short; KV compression is not the bottleneck)
- Pairs with milady-ai/qwen3.6-27b-milady-optimized

## Status

**Placeholder.** The GGUF is not yet uploaded. W5-Pipeline produces
the file from `Qwen/Qwen3-2B`; once it lands, the publisher
(`packages/training/scripts/publish_milady_model.py`) ships it here.

## Loading

```bash
# Phone runtime (auto, via the local-inference catalog).
# Catalog id: qwen3.6-27b-milady-drafter

# Manual download:
huggingface-cli download milady-ai/qwen3.6-27b-milady-drafter qwen3.6-27b-milady-drafter.gguf

# llama-server (with the milady fork):
./llama-server --hf-repo milady-ai/qwen3.6-27b-milady-drafter \
  --hf-file qwen3.6-27b-milady-drafter.gguf \
  --alias milady --ctx-size 8192 --flash-attn
```

## Repo layout

- `qwen3.6-27b-milady-drafter.gguf` — the fused-stack GGUF.
- `manifest.json` — drafter pairing + optimization stack metadata.
  Schema documented in `packages/training/scripts/HF_PUBLISHING.md`
  (Drafter pairing manifest section).

## Training

- Trained from: `Qwen/Qwen3-2B`
- Pipeline: `elizaos/eliza-1-pipeline`
- Scripts: `packages/training/scripts/`
