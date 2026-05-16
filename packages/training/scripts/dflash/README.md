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
0_8b, 2b, 4b, 9b, 27b
```

These IDs name the **target** text models — the bundles a user downloads from
`elizalabs/eliza-1` under `bundles/<tier>/` on Hugging Face.

DFlash drafter training is intentionally narrower:

```
2b, 4b, 9b, 27b
```

`0_8b` is target-only by design. Its bundle metadata must keep DFlash disabled,
must not require a drafter, and must not carry a DFlash acceptance gate.

## Drafter vs target

Two ideas not to conflate:

- **Target model** — the user-facing Eliza-1 text checkpoint. Named by
  catalog tier ID (e.g. `eliza-1-0_8b` is a 0.8B target). The catalog
  bundle ships it as `text/eliza-1-<tier>-<ctx>.gguf`.
- **Drafter model** — a *separate, smaller* model that proposes tokens
  for the target to verify. Lives alongside the target in the same
  bundle as `dflash/drafter-<tier>.gguf` for drafter-enabled tiers. The
  drafter's own parameter count is usually smaller than the target (e.g. a
  0.8B Qwen3.5 student drafts for a 2B target). See
  `distill_dflash_drafter.py::DEFAULT_STUDENT_BASE` for the per-tier
  student base.

The **tier ID** in every filename, env var, CLI flag, and script name
refers to the *target tier*, never the drafter's own size. So
`dflash/drafter-2b.gguf` is "the drafter that ships with the
`eliza-1-2b` target bundle" — even though that drafter's weights are a
0.8B Qwen3.5 distillation.

## Per-tier job scripts

Each `jobs/distill_dflash_<tier>.sh` script:

1. Sources `_lib.sh` for shared validation + log routing.
2. Sets `TIER` to the catalog tier (e.g. `TIER="2b"`).
3. Sets recipe defaults (`EPOCHS`, `BATCH_SIZE`, `GRAD_ACCUM`, `LR`,
   `MAX_SEQ_LEN`) — these are starting points, not gospel; tune
   empirically per release.
4. Calls `dflash_run_distill "$@"`.

The `distill_dflash_0_8b.sh` wrapper is deliberately disabled and exits
non-zero: 0.8B is the target-only no-drafter tier.

To run a script:

```bash
# Real run (requires GPU + dataset + target checkpoint + target GGUF).
TARGET_CHECKPOINT=checkpoints/eliza-1-2b/final \
TARGET_GGUF=out/eliza-1-2b/text/eliza-1-2b-128k.gguf \
DATASET=out/distill/eliza-1-2b/train.jsonl \
bash packages/training/scripts/dflash/jobs/distill_dflash_2b.sh

# Synthetic smoke (no GPU, no real models — exercises the pipeline).
bash packages/training/scripts/dflash/jobs/distill_dflash_2b.sh \
    --synthetic-smoke
```

The smoke flag exports `DFLASH_SMOKE=1`, bypasses input validation, exercises
the CLI/control-flow path, and exits zero without writing release artifacts.
This is what CI exercises.

## Adding a new tier

When the catalog adds a new canonical tier:

1. Add the tier ID to `ELIZA_1_TIERS` in
   `packages/training/scripts/manifest/eliza1_manifest.py`.
2. Add a row to `TEXT_QUANT_BY_TIER`, `CONTEXTS_BY_TIER`,
   `SUPPORTED_BACKENDS_BY_TIER`, `VOICE_QUANT_BY_TIER`,
   `REQUIRED_PLATFORM_EVIDENCE_BY_TIER` in `eliza1_platform_plan.py` /
   `eliza1_manifest.py`.
3. If the new tier is drafter-enabled, add the student base + acceptance gate
   to `distill_dflash_drafter.py::DEFAULT_STUDENT_BASE` /
   `ACCEPTANCE_GATE` / `DEFAULT_TARGET_MODEL`.
4. If the new tier is drafter-enabled, add `KNOWN_TIERS` entry in
   `prepare_distill_dataset.py` (and the validator will read the gate from
   `distill_dflash_drafter.py`).
5. If the new tier is drafter-enabled, copy one of the existing
   `jobs/distill_dflash_<tier>.sh` scripts and change the `TIER=` line + the
   hyperparameters.
6. Regenerate `ELIZA_1_GGUF_READINESS.md` with
   `uv run python -m scripts.manifest.eliza1_platform_plan` (from
   `packages/training/`).
