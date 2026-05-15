# DFlash drafter distillation — tier naming convention

The DFlash drafter pipeline distills a small "drafter" model that proposes
N tokens per step for the target Eliza-1 text model to verify. The
acceptance window must be ≥ the per-tier gate (see
`distill_dflash_drafter.py::ACCEPTANCE_GATE`) before the drafter is
publish-eligible.

## Source of truth: catalog tier IDs

The catalog at `packages/shared/src/local-inference/catalog.ts`
(`ELIZA_1_TIER_IDS`) is the canonical, user-facing tier identifier set.
Today this is:

```
0_8b, 2b, 4b, 9b, 27b, 27b-256k
```

These IDs name the **target** text models — the bundles a user downloads
from `elizaos/eliza-1` under `bundles/<tier>/` on Hugging Face. Every other surface in
this repo (DFlash distill scripts, manifest plan, readiness doc, gates
table) MUST refer to the same set.

## Release policy

`scripts/dflash/release_policy.py` is the source of truth for which
active tiers require DFlash.

- `0_8b` is **DFlash-disabled**. It must not ship a fake
  `dflash/drafter-0_8b.gguf`. The release evidence is
  `dflash/dflash-disabled-0_8b.release-policy.json` plus
  `dflash/target-meta.json` recording that runtime should fail open to
  normal target decoding.
- `2b`, `4b`, `9b`, `27b`, and `27b-256k` are
  **DFlash-required**. They fail closed unless the drafter is smaller
  than the target, tokenizer-compatible, stamped with
  `dflash-draft.target_checkpoint_sha256`, validated against the same
  target GGUF, and accompanied by `dflash/target-meta.json`.

The 0_8b decision is intentional: the current smoke already shows the
0.8B candidate is not smaller than its target, lacks the target
checkpoint stamp, and has no target-meta proof. More importantly, a
0.8B-class drafter doubles resident model pressure on the low-memory
devices this tier exists for while offering weak or negative speedup.

## Drafter vs target

Two ideas not to conflate:

- **Target model** — the user-facing Eliza-1 text checkpoint. Named by
  catalog tier ID (e.g. `eliza-1-0_8b` is a 0.8B target). The catalog
  bundle ships it as `text/eliza-1-<tier>-<ctx>.gguf`.
- **Drafter model** — a *separate, smaller* model that proposes tokens
  for the target to verify. Lives alongside the target in the same
  bundle as `dflash/drafter-<tier>.gguf`. The drafter's own parameter
  count is usually smaller than the target (e.g. a 0.8B Qwen3.5 student
  drafts for a 2B target). See
  `distill_dflash_drafter.py::DEFAULT_STUDENT_BASE` for the per-tier
  student base.

The **tier ID** in every filename, env var, CLI flag, and script name
refers to the *target tier*, never the drafter's own size. So
`dflash/drafter-2b.gguf` is "the drafter that ships with the
`eliza-1-2b` target bundle" — even though that drafter's weights are a
0.8B Qwen3.5 distillation.

## Per-tier job scripts

Each required-tier `jobs/distill_dflash_<tier>.sh` script:

1. Sources `_lib.sh` for shared validation + log routing.
2. Sets `TIER` to the catalog tier (e.g. `TIER="0_8b"`).
3. Sets recipe defaults (`EPOCHS`, `BATCH_SIZE`, `GRAD_ACCUM`, `LR`,
   `MAX_SEQ_LEN`) — these are starting points, not gospel; tune
   empirically per release.
4. Calls `dflash_run_distill "$@"`.

To run a script:

```bash
# Real run (requires GPU + dataset + target checkpoint + target GGUF).
TARGET_CHECKPOINT=checkpoints/eliza-1-2b/final \
TARGET_GGUF=out/eliza-1-2b/text/eliza-1-2b-32k.gguf \
DATASET=out/distill/eliza-1-2b/train.jsonl \
bash packages/training/scripts/dflash/jobs/distill_dflash_2b.sh

# Synthetic smoke (no GPU, no real models — exercises the pipeline).
bash packages/training/scripts/dflash/jobs/distill_dflash_2b.sh \
    --synthetic-smoke
```

The smoke flag exports `DFLASH_SMOKE=1` and bypasses input validation;
the script validates CLI/control-flow only and exits zero without
writing release artifacts. This is what CI exercises.

For the disabled 0_8b tier, run:

```bash
bash packages/training/scripts/dflash/jobs/distill_dflash_0_8b.sh
```

This writes `dflash-disabled-0_8b.release-policy.json` and no GGUF.

## Adding a new tier

When the catalog adds a new tier (e.g. someone publishes
`eliza-1-1m_5b`):

1. Add the tier ID to `ELIZA_1_TIERS` in
   `packages/training/scripts/manifest/eliza1_manifest.py`.
2. Add a row to `TEXT_QUANT_BY_TIER`, `CONTEXTS_BY_TIER`,
   `SUPPORTED_BACKENDS_BY_TIER`, `VOICE_QUANT_BY_TIER`,
   `REQUIRED_PLATFORM_EVIDENCE_BY_TIER` in `eliza1_platform_plan.py` /
   `eliza1_manifest.py`.
3. Add the tier to `release_policy.py`, then choose one status:
  `DFLASH_REQUIRED_TIERS` with a student base + acceptance gate, or
  `DFLASH_DISABLED_TIERS` with an explicit fail-open reason.
4. Add `KNOWN_TIERS` entry in `prepare_distill_dataset.py` if the tier
   is DFlash-required.
5. Copy one of the existing `jobs/distill_dflash_<tier>.sh` scripts and
   change the `TIER=` line + the hyperparameters.
6. Regenerate `ELIZA_1_GGUF_READINESS.md` with
   `uv run python -m scripts.manifest.eliza1_platform_plan` (from
   `packages/training/`).
