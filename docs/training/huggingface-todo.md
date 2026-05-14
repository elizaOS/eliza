# HuggingFace hygiene TODO (needs a write-capable `elizaos` token)

These are known issues on the `elizaos` (and one `shaw`) HuggingFace repos that
back the eliza-1 training pipeline. None of them can be fixed from this repo
alone — each requires a HuggingFace token with **write** access to the relevant
namespace, plus (for the dataset issues) a re-push or a dataset-card edit on the
Hub. Tracked here so the fixes don't get lost.

## 1. `elizaos/eliza-1-training` dataset viewer is broken

- **Symptom:** the dataset viewer fails with `DatasetGenerationError` /
  `CastError` on the `metadata` field. The auto-inferred schema disagrees
  across shards/rows (`metadata` is sometimes a struct with different keys,
  sometimes effectively empty), so the Hub's Arrow cast fails.
- **Fix (pick one, both need a write token):**
  - **Re-push with a consistent schema** — normalize every row so `metadata`
    is the *same* struct (same field set, same types; use `null` for absent
    keys rather than dropping the key), then re-upload. This is the durable
    fix.
  - **Pin the schema in the dataset card** — add a `configs:` / `features:`
    block to the dataset `README.md` front-matter that declares `metadata` as
    a string (and the row stores JSON-encoded metadata), or as the exact
    struct, so the viewer stops auto-inferring. Cheaper, but the underlying
    rows stay heterogeneous.
- **Note:** the legacy flat `ElizaRecord` columns this dataset currently uses
  (`roomName`, `agentId`, `memoryEntries`, `currentMessage`, `expectedResponse`,
  `availableActions`, `metadata`) are still the public shape; `metadata.split`
  is *source* metadata, not necessarily the HF split name. Don't "fix" the
  viewer by reshuffling splits — only the `metadata` cast needs to be made
  consistent.

## 2. `shaw/scambench-training` README still points at `lalalune/`

- **Symptom:** the dataset card for `shaw/scambench-training` still has
  `load_dataset("lalalune/scambench-training", ...)` examples (the repo was
  moved/renamed from `lalalune/` to `shaw/`).
- **Fix:** edit the dataset `README.md` on the Hub, replace every
  `lalalune/scambench-training` with `shaw/scambench-training`. Needs write
  access to `shaw/scambench-training`. Pure docs fix, no re-push.

## 3. `elizaos/eliza-1-assets` has no model card and inconsistent provenance

- **Symptom A — missing card:** `README.md` on `elizaos/eliza-1-assets`
  returns "Entry not found" (no model/dataset card at all).
- **Symptom B — provenance mismatch:** the repo carries a `LICENSE.asr` that
  references **whisper-tiny.en**, while `bundle-assets.json` / `lineage.json`
  in the same repo say the ASR component is **Qwen3-ASR-0.6B**. One of these is
  wrong; the lineage/bundle metadata is the intended source, so the stray
  whisper-tiny.en `LICENSE.asr` should be removed/replaced with the correct
  Qwen3-ASR-0.6B license + attribution.
- **Fix (needs write to `elizaos/eliza-1-assets`):**
  - Add a real `README.md` describing what `eliza-1-assets` is (shared
    bundle assets: ASR model, drafters, etc.), with provenance and licenses
    per component.
  - Reconcile the ASR provenance: confirm whether the shipped ASR is
    `Qwen3-ASR-0.6B` (per `bundle-assets.json` / `lineage.json`) and fix the
    `LICENSE.asr` / any whisper-tiny.en references accordingly. (For larger
    tiers the ASR is `Qwen3-ASR-1.7B`; the card should list both if both ship.)

## 4. Planned model repos referenced in dataset cards don't exist yet

- **Symptom:** dataset cards (and some docs) still reference per-tier repos
  like `elizaos/eliza-1-2b`, `elizaos/eliza-1-9b`, `elizaos/eliza-1-27b`, and
  `elizaos/eliza-1-pipeline` as if they were the canonical destinations.
- **Reality:** the canonical destination is the consolidated bundle repo
  **`elizaos/eliza-1`** with per-tier subdirectories under
  `bundles/<tier>/...`. Seven tiers are published there as of 2026-05-14
  (`0_6b, 0_8b, 2b, 4b, 9b, 27b, 27b-256k`; `27b-1m` is planned).
  `elizaos/eliza-1-pipeline` does NOT exist yet; the publish scripts
  (`publish_pipeline_to_hf.py`, `push_pipeline_to_hf.py`) auto-create it
  on first run via `huggingface_hub.create_repo`.
- **Fix:** update dataset cards (and any docs that still cite per-tier
  repos) to point at `elizaos/eliza-1/bundles/<tier>/...`. Needs write
  to the `elizaos` org.

## What this repo *can* do without a token

- Keep `docs/training/optimization-pipeline.md` and `docs/training/architecture.md`
  honest about which repos exist and which slug is canonical (`eliza-1-0_6b`,
  not `eliza-1-lite-0_6b`).
- Make `packages/training/scripts/push_model_to_hf.py` write a consistent
  `metadata` struct + a `configs:`/`features:` block into the generated
  dataset/model cards so future pushes don't reintroduce issue #1 — owned by
  the `packages/training/` agent, noted here for cross-reference.
