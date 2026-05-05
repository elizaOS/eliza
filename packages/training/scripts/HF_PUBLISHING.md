# HuggingFace publishing — operator runbook

The eliza-1 training data and pipeline live on HuggingFace so a fresh
Vast.ai box can bootstrap itself without an rsync hand-off from your local
machine. This document is the operational runbook.

## What's on HF today

| Local path                                   | HF repo                              | Type    | Status  |
|----------------------------------------------|--------------------------------------|---------|---------|
| `data/final/{train_final,val,test}.jsonl`    | `elizaos/eliza-1-training`           | dataset | PENDING |
| `data/normalized/scambench.jsonl` + synth    | `elizaos/eliza-1-scambench`          | dataset | PENDING |
| `data/synthesized/{actions,prompts}/*.jsonl` | `elizaos/eliza-1-synthesized`        | dataset | PENDING |
| `scripts/`, `pyproject.toml`, docs           | `elizaos/eliza-1-pipeline`           | model   | PENDING |
| (pointer only — uses upstream)               | `mlabonne/harmless_alpaca`           | dataset | upstream |

Update the Status column to `published` once each repo lands.

## First-time HF setup

```bash
# Either log in interactively (writes ~/.cache/huggingface/token)
huggingface-cli login

# Or export the token in the current shell
export HF_TOKEN=hf_xxxxxxxxxxxxxxxxxxxxxx
# (HUGGINGFACE_HUB_TOKEN is also accepted)
```

The publishing scripts refuse to push without one of those set.

## Publish the training dataset

```bash
cd training

# Always preview first.
uv run python scripts/publish_dataset_to_hf.py \
    --dataset training --repo-id elizaos/eliza-1-training --dry-run

# Real upload.
HF_TOKEN=hf_xxx uv run python scripts/publish_dataset_to_hf.py \
    --dataset training --repo-id elizaos/eliza-1-training
```

Expected payload: ~12.4 GB (4 files: train ~11.7 GB, val ~456 MB, test ~201
MB, manifest <1 KB). On a 50 Mbit/s home upload this is ~33 minutes; on a
gigabit fiber connection ~3 minutes. The script is idempotent — files
whose SHA-256 matches the existing remote LFS blob are skipped on re-runs.

## Publish the scambench dataset

```bash
uv run python scripts/publish_dataset_to_hf.py \
    --dataset scambench --repo-id elizaos/eliza-1-scambench --dry-run

HF_TOKEN=hf_xxx uv run python scripts/publish_dataset_to_hf.py \
    --dataset scambench --repo-id elizaos/eliza-1-scambench
```

Payload: ~152 MB normalized + ~12 MB synthesized.

## Publish the synthesized examples

```bash
uv run python scripts/publish_dataset_to_hf.py \
    --dataset synthesized --repo-id elizaos/eliza-1-synthesized --dry-run

HF_TOKEN=hf_xxx uv run python scripts/publish_dataset_to_hf.py \
    --dataset synthesized --repo-id elizaos/eliza-1-synthesized
```

Payload: a few MB of action examples + action pairs + core prompts.

## Publish the abliteration calibration set (pointer-only)

This dataset just hosts a README pointing at upstream
`mlabonne/harmless_alpaca`. Run the publish so consumers see the pointer:

```bash
HF_TOKEN=hf_xxx uv run python scripts/publish_dataset_to_hf.py \
    --dataset abliteration --repo-id elizaos/eliza-1-abliteration
```

## Publish the pipeline

```bash
uv run python scripts/publish_pipeline_to_hf.py \
    --repo-id elizaos/eliza-1-pipeline --dry-run

HF_TOKEN=hf_xxx uv run python scripts/publish_pipeline_to_hf.py \
    --repo-id elizaos/eliza-1-pipeline
```

Payload: ~5-10 MB (scripts + docs only — no data, no checkpoints, no
__pycache__). Fast on any connection.

## Bootstrap a Vast box from HF

Once both repos are published, drive a fresh box end-to-end without rsyncing
from your local machine:

```bash
# Option A: use the existing provision-and-train flow with HF bootstrap.
bash scripts/train_vast.sh provision-and-train \
    --registry-key qwen3.5-9b --epochs 1 --bootstrap hf

# Option B: take it step by step.
bash scripts/train_vast.sh provision
bash scripts/train_vast.sh bootstrap-from-hf
bash scripts/train_vast.sh run
```

Override the source repos:

```bash
bash scripts/train_vast.sh bootstrap-from-hf \
    --pipeline-repo elizaos/eliza-1-pipeline \
    --data-repo elizaos/eliza-1-training
```

The remote box installs `uv` and `huggingface_hub[cli]` if missing,
downloads only the active subset of the data repo (train + val + test +
manifest), and runs `uv sync --extra train`. Your local machine can be
powered off after `bootstrap-from-hf` returns.

## Safety rails

- The dataset publisher's per-bundle allowlist refuses to upload anything
  outside the active SFT split. Historical WIP files (`train.jsonl`,
  `train_v8.jsonl`, `train_rewritten.review.jsonl`) are explicitly NOT
  reachable from any `--dataset` choice.
- The pipeline publisher excludes `__pycache__/`, `.pytest_cache/`,
  `*.pyc`, `*.so`, and `.vast_instance_id`.
- `HF_TOKEN` / `HUGGINGFACE_HUB_TOKEN` is read from env only and never
  printed to logs. `VAST_API_KEY` is similarly never echoed.
