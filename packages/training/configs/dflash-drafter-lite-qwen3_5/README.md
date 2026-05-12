# dflash-drafter-lite-qwen3_5 — from-scratch student config

`config.json` here is the **student config** for the ~0.6B-param Qwen3.5-architecture
DFlash drafter that serves the Qwen3.5/3.6 eliza-1 tiers (`eliza-1-2b`, `eliza-1-9b`,
`eliza-1-27b`). It is a *config only* — no weights. `scripts/distill_dflash_drafter.py
--student-config <this dir>` initialises a random model from it and knowledge-distills
it onto `Qwen/Qwen3.5-0.8B-Base`'s logits.

## Why this exists

The Qwen3.5/3.6 text backbones use the **248320-vocab Qwen3.5 tokenizer** and the
`qwen3_5` hybrid (Gated-DeltaNet linear-attention + periodic full-attention) architecture.
A speculative-decode drafter must share the target's tokenizer, so a `Qwen3-0.6B` drafter
(151936 vocab) is wrong. The smallest published Qwen3.5 backbone is
`Qwen/Qwen3.5-0.8B`, so this lite
drafter is produced by KD from `Qwen/Qwen3.5-0.8B` (the smallest published Qwen3.5).

## Geometry (vs `Qwen/Qwen3.5-0.8B-Base` `text_config`)

| field | 0.8B-Base | this student | rationale |
|---|---|---|---|
| `vocab_size` | 248320 | **248320** | tokenizer parity — non-negotiable |
| `hidden_size` | 1024 | **1024** | unchanged (the embedding table dominates a 0.6B model anyway) |
| `head_dim` | 256 | **256** | KV-cache shape parity with the target family |
| `num_attention_heads` / `num_key_value_heads` | 8 / 2 | **8 / 2** | GQA shape parity |
| `full_attention_interval` | 4 | **4** | hybrid linear/full-attn ratio parity |
| `intermediate_size` | 3584 | **3584** | unchanged |
| `num_hidden_layers` | 24 | **16** | the one knob we turn — 24→16 layers ≈ 0.75B→~0.59B params |
| `layer_types` | 18 linear + 6 full (4:1) | **12 linear + 4 full (4:1)** | same pattern, fewer repeats |
| `mtp_num_hidden_layers` | 1 | 1 | kept for arch consistency (the MTP head is dropped at GGUF-conversion time) |
| vision tower | present | present in config, **not instantiated** | `distill_dflash_drafter.py` builds the text-only causal LM from `text_config`; the vision tower is never allocated and never converted to GGUF |

## Usage

```bash
uv run --extra train python scripts/distill_dflash_drafter.py \
  --tier 9b \
  --target-base Qwen/Qwen3.5-0.8B-Base \
  --student-config configs/dflash-drafter-lite-qwen3_5 \
  --dataset data/final-eliza1-fullcorpus/train.jsonl \
  --epochs 1 --batch-size 8 --grad-accum 4 --max-seq-len 2048 \
  --out-dir out/dflash-drafter-lite-qwen3_5
```

When a fine-tuned `eliza-1-9b`/`eliza-1-27b` text GGUF ships, re-stamp the drafter GGUF
with that text GGUF's sha256:

```bash
uv run --extra train python scripts/distill_dflash_drafter.py --tier 9b --stamp-only \
  --drafter-gguf out/.../drafter-9b.gguf --target-gguf out/.../eliza-1-9b-32k.gguf \
  --out-dir /tmp/ignored
```
