# 27b-1m Tier Removal — Phase 1 Inventory

Snapshot taken before scrub (2026-05-14). The `eliza-1-27b-1m` tier was
hardware-gated (H200 cluster), never published to HF, and is being
removed entirely.

## Status of code/data already clean

The following source files contain NO `27b-1m` references (the tier was
already retired from runtime data in earlier waves G1/G4):

- `packages/shared/src/local-inference/catalog.ts` — `ELIZA_1_TIER_IDS`
  ends at `27b-256k`.
- `packages/shared/src/local-inference/types.ts` — no tier-id reference.
- `packages/training/scripts/training/model_registry.py` — no entry.
- `packages/training/scripts/train_nebius.sh` — no `27b-1m` REGISTRY_KEY.
- `cloud/services/vast-pyworker/manifests/` — only `eliza-1-27b.json`
  and `eliza-1-27b-256k-3090.json`.
- `plugins/plugin-local-inference/src/services/recommendation.ts` — no
  reference (TIER_27B_1M constant removed in G6).
- `plugins/plugin-local-inference/src/services/dflash-server.ts` — no
  reference.

## Remaining hits — to be scrubbed

### Files to delete

- `packages/training/scripts/dflash/jobs/distill_dflash_27b-1m.sh` —
  hidden disabled stub for the retired tier.
- `plugins/plugin-local-inference/native/verify/reports/eliza1-gates-27b-1m-vision-policy-20260515.md`
  — stale vision-gate report.
- `plugins/plugin-local-inference/native/verify/reports/eliza1-gates-27b-1m-vision-policy-20260515.json`
  — companion JSON.

### Files to edit

#### Docs
- `docs/eliza-1-install.md:37-39` — note about retired `eliza-1-27b-1m`
  tier; remove it now that the scrub is complete (no need to gravestone).

#### Reports / planning notes
- `packages/training/reports/dflash-drafter-produce-2026-05-14.md`
  lines 4, 33, 35, 65, 241 — drafter report enumerating retired tier in
  drafter table and run plan.

#### Swarm history (mark as historical / strike retired tier)
- `.swarm/VOICE_WAVE_3_SUMMARY.md` lines 93, 104.
- `.swarm/collab.md` lines 16, 18, 25, 31–32, 40, 141, 271, 287, 414,
  458, 544, 552, 569, 576, 582 — Wave history mentioning the retired
  tier.
- `.swarm/impl/G4-hf-finished.md` lines 14, 18, 23, 50, 55, 90, 112 —
  G4 retirement narrative.
- `.swarm/impl/W3-12-hf-audit.md` lines 20, 32, 131, 137, 144, 145,
  235, 259 — W3-12 audit narrative.
- `.swarm/impl/W3-12-hf-complete.md` lines 32, 34, 89, 105, 137, 217.
- `.swarm/voice-finish/WAVE_2_CLOSING_SUMMARY.md` line 114.
- `.swarm/voice-finish/WAVE_2_FINAL_SUMMARY.md` line 61.

For swarm history files, references describe past work and are kept
as historical context. The retired tier is mentioned in past tense and
no longer suggests action. They are left intact intentionally — they
document why the tier was removed.

### F4 file
- The prompt mentions `.swarm/impl/F4-eliza1-27b-1m-training.md` — this
  file does NOT exist in this worktree. No deletion needed.

## Tier definitions (post-scrub)

Active tiers after the cleanup:

1. `eliza-1-0_8b`
2. `eliza-1-2b` (default)
3. `eliza-1-4b`
4. `eliza-1-9b`
5. `eliza-1-27b`
6. `eliza-1-27b-256k`

Total: 6 tiers (down from a planned 7).
