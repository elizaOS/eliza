# EOT LoRA — Operator Runbook

End-to-end recipe for training an EOT classifier LoRA that hot-swaps
onto the already-loaded eliza-1 chat model. Zero extra weights, zero
extra RAM, zero extra download.

Why bother — the LiveKit GGUF baseline already works. The LoRA path
wins on **memory cost at runtime**: the chat model is loaded anyway
for conversation; adding a 5-10 MB adapter is free vs. carrying a
separate 66-396 MB turn-detector GGUF. The accuracy story matters
too — a LoRA trained on on-distribution data can beat a generic
turn-detector on the voice-assistant use case.

## Time / GPU / disk

| Step                    | Wall time (24 GB GPU)     | Notes                                      |
|-------------------------|---------------------------|--------------------------------------------|
| dataset audit           | minutes                   | Read `DATASETS.md`; pick mix.              |
| prep_eot_corpus.py      | 5-30 min per 100k turns   | CPU-bound (tokenize + privacy filter).     |
| train_eot_lora.py 2b    | 30-90 min @ 2000 steps    | RTX 4090: 45 min.                          |
| train_eot_lora.py 4b    | 60-180 min @ 2000 steps   | RTX 4090: 90 min; drop --batch-size 2 on 16 GB cards. |
| eval_eot_lora.py        | 5-20 min per classifier   | GPU; loads base + adapter + LiveKit GGUF.  |
| publish (optional)      | <1 min                    | HF upload.                                 |

Disk: ~3 GB per training run (checkpoints + processed corpus +
TensorBoard logs). The adapter itself is 5-10 MB.

VRAM at defaults (rank 8, batch tier-default, seq 512):
- 2B target → ~12 GB
- 4B target → ~20 GB (fits 24 GB consumer GPU)

For 16 GB cards (RTX 4080 / 5080 / 4060 Ti 16 GB): pass
`--batch-size 2 --gradient-accumulation 2` to keep effective batch
size constant.

## Prerequisites

```bash
# Required for training:
pip install torch transformers peft bitsandbytes
# Required for corpus prep (preferred):
pip install pyarrow
# Required for eval (LiveKit baseline):
pip install llama-cpp-python
# Optional (APOLLO benchmarking — not used by default for LoRA):
pip install apollo-torch
```

HF auth (for downloading base models + uploading adapters):

```bash
huggingface-cli login   # or: export HF_TOKEN=hf_...
```

## End-to-end commands

```bash
# 0. Pick a workspace.
RUN=~/eliza-training/eot-lora-$(date +%Y%m%d-%H%M%S)
mkdir -p "$RUN"

# 1. Dataset audit — read this, decide the mix.
$EDITOR packages/training/scripts/voice/eot/DATASETS.md

# 2. Stage your conversation sources. Examples:
#    - download daily_dialog: huggingface-cli download li2017dailydialog/daily_dialog --local-dir "$RUN/sources/daily_dialog"
#    - extract subtitles to plain text under "$RUN/sources/opensubtitles/"
#    - copy local scenarios JSONL under "$RUN/sources/scenarios.jsonl"

# 3. Prep the corpus (privacy filter runs on every transcript write).
python3 packages/training/scripts/voice/eot/prep_eot_corpus.py \
    --source daily_dialog:"$RUN/sources/daily_dialog/train.jsonl" \
    --source scenarios:"$RUN/sources/scenarios.jsonl" \
    --source subtitles:"$RUN/sources/opensubtitles/en.txt" \
    --out "$RUN/corpus/train.parquet" \
    --neg-ratio 1.0 \
    --seed 42

# Optionally a held-out eval split from a different source:
python3 packages/training/scripts/voice/eot/prep_eot_corpus.py \
    --source candor:"$RUN/sources/candor/holdout.jsonl" \
    --out "$RUN/corpus/eval.parquet" \
    --neg-ratio 1.0 \
    --seed 43

# 4. Train one tier at a time. Start with the smallest.
python3 packages/training/scripts/voice/eot/train_eot_lora.py \
    --tier 2b \
    --corpus "$RUN/corpus/train.parquet" \
    --out-dir "$RUN/outputs/2b" \
    --epochs 1 \
    --batch-size 4

# 5. Eval against LiveKit baseline + heuristic.
LIVEKIT_GGUF=~/.eliza/local-inference/models/voice/turn-detector/onnx/turn-detector-en-q8.gguf
python3 packages/training/scripts/voice/eot/eval_eot_lora.py \
    --eval-corpus "$RUN/corpus/eval.parquet" \
    --lora-adapter "$RUN/outputs/2b/checkpoint-final" \
    --lora-base "google/gemma-4-E2B" \
    --livekit-gguf "$LIVEKIT_GGUF" \
    --out "$RUN/reports/eval-2b.json"

# exit 0 = gates passed → publishable
# exit 1 = gates failed → read $RUN/reports/eval-2b.json, iterate

# 6. (Optional) publish adapter to HF. The HF_TOKEN at
#    ~/.huggingface/token must have write scope to the elizaos org.
huggingface-cli upload elizaos/eliza-1-voice-eot \
    "$RUN/outputs/2b/checkpoint-final" \
    "2b/" \
    --repo-type model
```

Repeat steps 4-5 for tier `4b`.

## Failure modes

### `prep_eot_corpus.py` reports 0 records

Your sources didn't match any reader. Check the file extension —
`.jsonl` → JSONL turns, `.srt` → subtitle, anything else → plain
dialog (one turn per line). Verify the JSONL is one conversation per
line with a `turns` or `messages` field.

### Training OOMs

Drop `--batch-size` first, then `--seq-len`. For 16 GB cards: try
`--batch-size 2 --gradient-accumulation 2 --seq-len 384`.

### `eval_eot_lora.py` LiveKit baseline AUROC near 0.5

The eval corpus is not turn-aligned. Check `prep_eot_corpus.py`
stats output — the positive/negative ratio should be roughly the
`--neg-ratio` you passed. If it's wildly skewed, your source format
isn't being read correctly.

### LoRA AUROC below the gate

Likely causes (in order of frequency):
1. Eval corpus is out-of-distribution vs training corpus → re-prep
   eval from a held-out source.
2. Training corpus is too small → add more sources (see DATASETS.md).
3. Privacy filter is too aggressive → check `privacy_dropped` stat
   from prep; if high, tune or replace the canonical filter.
4. LoRA rank is too low for the signal → bump to `--lora-rank 16`
   (modify `LoraConfig` in `train_eot_lora.py`; this raises adapter
   size from 5-10 MB to 10-20 MB).

## Recovery — partial run

The trainer saves only `checkpoint-final/` at the end. To checkpoint
mid-run for recovery on long jobs, modify `train_eot_lora.py` to save
every N steps (HuggingFace `trainer.save_steps` if you migrate to the
`Trainer` API). Default loop is intentionally simple.

## Runtime integration (future, deferred)

After publishing the adapter to `elizaos/eliza-1-voice-eot`, the
runtime wiring at
`plugins/plugin-local-inference/src/services/voice/eot-classifier-ggml.ts`
needs an additional code path: when the bundle ships
`voice/eot-lora/eliza-1-<tier>-eot-lora.bin`, the resolver should
prefer hot-swapping the LoRA onto the already-loaded chat model
(via llama.cpp's `--lora` flag) over standing up the separate
LiveKit GGUF process.

That integration is a follow-up PR — not in scope for this LoRA
training pipeline. The pipeline produces the adapter; the runtime
wiring consumes it. Until both land, the canonical EOT path remains
the LiveKit GGUF binding.
