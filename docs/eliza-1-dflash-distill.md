# Eliza-1 DFlash Drafter Distillation

## Why this exists

Every Eliza-1 tier ships a paired DFlash drafter (`dflash/drafter-<tier>.gguf`)
that speculatively proposes N tokens per step; the target text model verifies
them. DFlash acceptance rate — and therefore the speed-up — depends entirely
on how closely the drafter's next-token distribution tracks the target's, and
on the two models sharing a vocabulary byte-for-byte.

A previous audit found that DFlash drafting was **inactive in shipped bundles**
because the placeholder drafter had a 248,320-token vocab while the Eliza-1
target's vocab is 151,936 tokens. Speculative decode rejects every drafted
token under that mismatch.

The fix is one knowledge-distilled drafter per tier, trained against the exact
fine-tuned text checkpoint it ships with. The training script
`packages/training/scripts/distill_dflash_drafter.py` enforces the contract
(byte-identical tokenizers; `dflash-draft.target_checkpoint_sha256` stamped
into the drafter GGUF). This doc covers everything around it: dataset prep,
per-tier job recipes, validation, hardware needs, and status.

## Tier set

The shipped Eliza-1 tiers are: **`0_8b`**, **`2b`**, **`4b`**, **`9b`**,
**`27b`**, **`27b-256k`**, **`27b-1m`**. The training script's
`DEFAULT_STUDENT_BASE` map is the source of truth — keep it in sync if a tier
is added or removed. The student-base map is:

| Tier      | Student base          | Acceptance gate |
|-----------|-----------------------|-----------------|
| 0_8b      | Qwen/Qwen3.5-0.8B     | 0.40            |
| 2b        | Qwen/Qwen3.5-0.8B     | 0.50            |
| 4b        | Qwen/Qwen3.5-0.8B     | 0.52            |
| 9b        | Qwen/Qwen3.5-2B       | 0.55            |
| 27b       | Qwen/Qwen3.5-4B       | 0.55            |
| 27b-256k  | Qwen/Qwen3.5-4B       | 0.55            |
| 27b-1m    | Qwen/Qwen3.5-4B       | 0.55            |

## End-to-end pipeline

```
prepare_distill_dataset.py    ──► distill.jsonl + dataset.manifest.json
            │
            ▼
jobs/distill_dflash_<tier>.sh ──► drafter-<tier>.gguf
                                  drafter-<tier>.distill.json
                                  runs/<tier>-<ts>/distill.log
            │
            ▼
validate_drafter.py            ──► validation report (hash + vocab + acceptance)
            │
            ▼
publish via packages/training/scripts/manifest/stage_local_eliza1_bundle.py
```

Each step has a `--synthetic-smoke` mode that runs without GPUs or real
weights. CI exercises those smoke paths so the wiring does not bit-rot.

## How to kick off a real run

### 1. Build the dataset

```bash
cd packages/training
uv run --extra train python scripts/dflash/prepare_distill_dataset.py \
    --tier 2b \
    --target-checkpoint training/checkpoints/eliza-1-2b-text \
    --hf-dataset HuggingFaceH4/ultrachat_200k \
    --hf-split train_sft \
    --max-samples 50000 \
    --max-seq-len 2048 \
    --out-dir data/dflash-distill/2b
```

The dataset script tokenizes every record with the **target's** tokenizer.
That is the load-bearing vocab-alignment step — `distill_dflash_drafter.py`
re-asserts byte-identical tokenizer parity at training time and fails closed
on any mismatch.

For the high-signal path, add `--with-teacher-continuations` to run greedy
teacher generation per sample (GPU + slow, ~hours for 50k).

### 2. Run the distillation job

```bash
TARGET_CHECKPOINT=training/checkpoints/eliza-1-2b-text \
TARGET_GGUF=out/eliza-1-2b/text/eliza-1-2b-32k.gguf \
DATASET=data/dflash-distill/2b/distill.jsonl \
bash packages/training/scripts/dflash/jobs/distill_dflash_2b.sh
```

The job script validates inputs, logs to `packages/training/runs/<tier>-<ts>/`,
and on success leaves `drafter-<tier>.gguf` + `drafter-<tier>.distill.json`
in that directory. Override hyperparams via env vars (`EPOCHS`, `BATCH_SIZE`,
`LR`, `STUDENT_BASE`, `EXTRA_ARGS`). Pass `--help` to any job script for the
full list.

### 3. Validate the drafter

```bash
cd packages/training
uv run --extra train python scripts/dflash/validate_drafter.py \
    --tier 2b \
    --drafter-gguf runs/2b-<ts>/drafter-2b.gguf \
    --target-gguf out/eliza-1-2b/text/eliza-1-2b-32k.gguf \
    --acceptance-tokens 1024 \
    --report-out runs/2b-<ts>/validation.json
```

Exit codes: `0` ok; `3` static check failed (hash/vocab/size); `4` acceptance
below the tier gate. The static checks (`--skip-acceptance-rollout`) require
no GPU and run in a couple of seconds — they catch the vocab-mismatch class
of bug that motivated this whole effort.

### 4. Stage into a release

The bundle stager at
`packages/training/scripts/manifest/stage_local_eliza1_bundle.py` consumes
`drafter-<tier>.gguf` and writes the drafter's `target_checkpoint_sha256`
against the shipped text GGUF. Do not edit the catalog directly while
distillation is in flight — emit the diff via the catalog handoff fragment
(see `docs/eliza-1-dflash-catalog-fragment.md`).

## Hardware + wall-time requirements

These are starting-point recipes. Tune empirically — `final_kl` in the
distill manifest, and the acceptance rollout in `validate_drafter.py`, are
the signals that matter. Estimates assume APOLLO-mini optimizer + bf16
target inference.

| Tier      | Min GPU         | Dataset | Epochs | Batch | Est. wall time |
|-----------|-----------------|---------|--------|-------|----------------|
| 0_8b      | 1× 24GB         | ~50k    | 3      | 16    | ~6h            |
| 2b        | 1× 24GB         | ~50k    | 3      | 16    | ~8–10h         |
| 4b        | 1× 48GB (or 80) | ~50k    | 3      | 8     | ~12h           |
| 9b        | 1× 80GB         | ~100k   | 5      | 8     | ~24h           |
| 27b       | 2× 80GB         | ~100k   | 5      | 8     | ~72h           |
| 27b-256k  | 2× 80GB         | ~100k   | 5      | 8     | ~72h           |
| 27b-1m    | 2× 80GB         | ~100k   | 5      | 8     | ~72h           |

The 27b family shares a recipe — the context-length variants only change the
target's K-cache path (trellis / `turbo3_tcq`), not the drafter itself. In
practice we'd run one 27b job and reuse the drafter across the three context
variants, with separate validation passes (one per context to confirm the
target SHA stamps line up).

## Cron / queue integration

For now: kick these off manually from a Vast / Lambda / on-prem GPU box.
There is no scheduled distillation cron — DFlash distillation is rare (once
per text-checkpoint rebaseline), expensive, and gated by the eval harness.
When that changes, add the orchestration under
`packages/training/scripts/cloud/` next to `cloud_run.py`, not as a fresh
top-level service.

## Status

| Tier      | Synthetic-smoke verified | Real distill run | Validation passed | In a shipped bundle |
|-----------|--------------------------|------------------|-------------------|---------------------|
| 0_8b      | yes (2026-05-12)         | no               | no                | no                  |
| 2b        | yes (2026-05-12)         | no               | no                | no                  |
| 4b        | yes (2026-05-12)         | no               | no                | no                  |
| 9b        | yes (2026-05-12)         | no               | no                | no                  |
| 27b       | yes (2026-05-12)         | no               | no                | no                  |
| 27b-256k  | yes (2026-05-12)         | no               | no                | no                  |
| 27b-1m    | yes (2026-05-12)         | no               | no                | no                  |

Update this table after each real run lands.

## What is still needed to actually kick off

1. A fine-tuned Eliza-1 text checkpoint per tier (HF dir).
2. The final shipped text GGUF per tier (the bytes the drafter records as
   `dflash-draft.target_checkpoint_sha256`).
3. A conversational distillation corpus. UltraChat 200k via HF is the default;
   the Eliza-1 SFT corpus is the higher-signal alternative once available.
4. GPU time per the table above.
5. The training extras installed (`uv sync --extra train`) on a Linux box —
   the `train` extra has no macOS wheels (triton).
