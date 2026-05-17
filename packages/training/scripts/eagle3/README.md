# EAGLE3 training pipeline

This directory contains the local EAGLE3 drafter pipeline:

1. `prepare_distill_dataset.py` normalizes chat/text JSONL into
   `eagle3_distill.jsonl` and records target token ids with the target
   tokenizer.
2. `capture_features.py` runs the target checkpoint with hidden states enabled
   and writes one `.pt` feature file per row plus `features.index.jsonl`.
3. `train_eagle3_drafter.py` trains a PyTorch projection drafter over captured
   hidden states and writes `eagle3-drafter.pt`, config, and run manifest.

Native GGUF export is delegated to an external converter command via
`--convert-native-gguf --gguf-converter ... --native-gguf-out ...`. The script
does not write substitute GGUFs.

## Synthetic smoke

From `packages/training`:

```bash
uv run python scripts/eagle3/prepare_distill_dataset.py \
  --tier 0_8b --synthetic-smoke --out-dir /tmp/eagle3/dataset

uv run python scripts/eagle3/capture_features.py \
  --tier 0_8b --synthetic-smoke \
  --dataset /tmp/eagle3/dataset/eagle3_distill.jsonl \
  --out-dir /tmp/eagle3/features

uv run python scripts/eagle3/train_eagle3_drafter.py \
  --tier 0_8b --synthetic-smoke \
  --features-manifest /tmp/eagle3/features/features.manifest.json \
  --out-dir /tmp/eagle3/train
```

Or run the wrapper:

```bash
bash scripts/eagle3/jobs/eagle3_0_8b_smoke.sh --synthetic-smoke
```

## Real local run

```bash
SOURCE_JSONL=/data/eagle3/chat.jsonl \
TARGET_CHECKPOINT=/models/eliza-1-0_8b \
DEVICE=mps \
bash scripts/eagle3/jobs/eagle3_0_8b_smoke.sh
```

For native export:

```bash
SOURCE_JSONL=/data/eagle3/chat.jsonl \
TARGET_CHECKPOINT=/models/eliza-1-0_8b \
GGUF_CONVERTER='python /path/to/convert_eagle3_to_gguf.py --model {model} --config {config} --out {out}' \
NATIVE_GGUF_OUT=/models/eliza-1-0_8b/eagle3/drafter.gguf \
bash scripts/eagle3/jobs/eagle3_0_8b_smoke.sh --convert-native-gguf
```
