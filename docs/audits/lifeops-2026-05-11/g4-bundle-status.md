# Wave-6 G4 — Eliza-1 bundle status after real Qwen weight pull (2026-05-11)

Snapshot of what is actually on this host after the G4 sub-agent task. The
canonical `eliza-1-status.md` in this directory was written against a prior
Linux build-host state where bundles had been fully staged. On this Mac
checkout the `~/.eliza/local-inference/models/` tree was empty before this
pass — this document records what we pulled, validated, and what is still
missing.

## Per-bundle table

All bundles live under `~/.eliza/local-inference/models/eliza-1-<size>.bundle/`.
SHA256 columns show the value embedded in `manifest.json` and the upstream HF
LFS pointer; these match byte-for-byte for the rows marked ✓.

| Bundle ID         | Size    | releaseState   | publishEligible | final.weights | Real weights | Source repo (HF)            | Source file                       | SHA256 (head)    | DFlash drafter | preRelease | Notes |
|-------------------|---------|----------------|-----------------|---------------|--------------|-----------------------------|-----------------------------------|------------------|----------------|------------|-------|
| `eliza-1-0.6b`    | 0.6b    | local-standin  | false           | false         | ✓            | `Qwen/Qwen3-0.6B-GGUF`      | `Qwen3-0.6B-Q8_0.gguf` (640 MB)   | `9465e63a…`      | **missing**    | **true**   | weights pulled from HF; sha matches LFS pointer + historical bundle record. |
| `eliza-1-1.7b`    | 1.7b    | local-standin  | false           | false         | ✓            | `Qwen/Qwen3-1.7B-GGUF`      | `Qwen3-1.7B-Q8_0.gguf` (1.84 GB)  | `061b54da…`      | **missing**    | **true**   | weights pulled from HF; sha matches LFS pointer + historical bundle record. |
| `eliza-1-9b`      | 9b      | local-standin  | false           | false         | ✓            | `unsloth/Qwen3.5-9B-GGUF`   | `Qwen3.5-9B-Q4_K_M.gguf` (5.68 GB)| `03b74727…`      | **missing**    | **true**   | weights pulled from HF; sha matches LFS pointer + historical bundle record. Vision mmproj also missing. |
| `eliza-1-27b`     | 27b     | local-standin  | false           | false         | ✓            | `batiai/Qwen3.6-27B-GGUF`   | `Qwen-Qwen3.6-27B-Q4_K_M.gguf` (16.55 GB) | `f741bb17…`      | **missing**    | **true**   | weights pulled from HF on 2026-05-11 (Wave-7 H1-redo); sha matches upstream LFS `x-linked-etag`. `text/eliza-1-27b-64k.gguf` is a hardlink to `source/Qwen-Qwen3.6-27B-Q4_K_M.gguf` (same inode `329833689`, link count 4 — shared with the 27b-1m sibling). Real disk footprint ≈ 16.5 GB across both bundles. |
| `eliza-1-27b-1m`  | 27b-1m  | local-standin  | false           | false         | ✓ (shared)   | `batiai/Qwen3.6-27B-GGUF`   | same Q4_K_M file as 27b           | `f741bb17…`      | **missing**    | **true**   | sibling of 27b — `source/Qwen-Qwen3.6-27B-Q4_K_M.gguf` and `text/eliza-1-27b-1m.gguf` are both hardlinks to the same physical file (inode `329833689`, link count 4). 1M context window is rope-scaling config, not separate weights. Manifest carries `contextWindow: 1048576`. |

`preRelease = true` for every bundle on this host (no row clears
`releaseState=final && publishEligible && final.weights` — they all stay
local-standin).

## DFlash drafter situation

Drafters are **distilled artifacts**, not pulled from Hugging Face:

- `qwen3.5-9b-dflash-q8_0.gguf` (sha `4f76ecff…`, 1.13 GB) was distilled
  on a CUDA host via `packages/training/scripts/distill_dflash_drafter.py`
  per `ELIZA_1_RELEASE_ASSET_STATUS.md` §Drafter. It is NOT in any public
  HF repo and there is no copy on this Mac.
- The 0.6B / 1.7B tiers have never had a paired drafter — `ELIZA_1_PRODUCTION_READINESS_REVIEW.md`
  lists drafter distillation against the final text checkpoint as the
  remaining release item.
- Reusing the prior `qwen3.5-4b-dflash-drafter-q4` local stand-in is not
  appropriate: the drafter's `dflash-draft.target_checkpoint_sha256`
  GGUF metadata key MUST match the target text checkpoint's sha256
  (validated by `_read_drafter_target_checkpoint_sha256` /
  `matchesTargetCheckpoint` in `stage_local_eliza1_bundle.py`).

Recommended unblock path: schedule a CUDA-host job per
`packages/training/AGENTS.md` to distill 0.6b / 1.7b / 9b / 27b drafters
against each bundle's current text checkpoint, stamping the matching
`target_checkpoint_sha256`. Until then, the bench harness runs without
`--model-draft` for these tiers and accepts the speculative-decode
throughput hit.

## Hugging Face sync state

Anonymous queries against `https://huggingface.co/api/models?author=<org>`:

- `?author=elizaos` → returns exactly **one** model: `elizaos/eliza-1-assets`
  (public, created 2026-05-11). Contains an empty `1_7b/` scaffold
  (`asr/`, `cache/`, `evidence/`, `licenses/`, `tts/`, `vad/` directories
  + a 999-byte `lineage.json`). **No GGUF weights, no manifest, no
  drafter**. The other four tiers (`0_6b`, `9b`, `27b`, `27b-1m`) are not
  present anywhere on Hugging Face under the `elizaos` org.
- `?author=elizaOS` (capital S) → returns `[]`.
- The four upstream Qwen GGUF repos used as source weights are all public
  and reachable (`Qwen/Qwen3-0.6B-GGUF`, `Qwen/Qwen3-1.7B-GGUF`,
  `unsloth/Qwen3.5-9B-GGUF`, `batiai/Qwen3.6-27B-GGUF`).

Conclusion: **no eliza-1-* bundle is published on Hugging Face yet**. The
`elizaos/eliza-1-assets` repo is a placeholder scaffold. The publish
orchestrator in `packages/training/scripts/publish/` will refuse to upload
until the per-bundle release gates clear, which is correct.

No HF push attempted — per task constraint and `AGENTS.md` Cmd #8.

## Manifest changes in this pass

Created the bench-harness `manifest.json` (the `packages/benchmarks/lib/src/eliza-1-bundle.ts`
schema) for five bundles:

- `~/.eliza/local-inference/models/eliza-1-0_6b.bundle/manifest.json` — Wave-6 G4.
- `~/.eliza/local-inference/models/eliza-1-1_7b.bundle/manifest.json` — Wave-6 G4.
- `~/.eliza/local-inference/models/eliza-1-9b.bundle/manifest.json` — Wave-6 G4.
- `~/.eliza/local-inference/models/eliza-1-27b.bundle/manifest.json` — **Wave-7 H1-redo (2026-05-11)**.
- `~/.eliza/local-inference/models/eliza-1-27b-1m.bundle/manifest.json` — **Wave-7 H1-redo (2026-05-11)** — same physical Q4_K_M as 27b via hardlink; manifest adds `contextWindow: 1048576`.

Each carries `sha256` matching the upstream LFS pointer and pins the
`sourceModel.repo` / `file` / `revision` provenance fields. Validation
through `read_eliza_one_bundle` + `bundle_is_pre_release` passes — all
three correctly resolve as `preRelease=True`.

No `eliza-1.manifest.json` (the rich publish-format manifest from
`packages/training/scripts/manifest/eliza1_manifest.py`) was written: that
schema requires evidence blocks (`evals/`, `evidence/`, `licenses/`,
quant sidecars, kernel verification reports) which need a built fork +
real evals. The bench-harness reader does not consume that file — only
the simple `manifest.json` — so the simpler form is what the
benchmark/lifeops pipeline needs to function.

## What couldn't be fetched (and why)

| Asset                                          | Reason                                                                                                                                                                       |
|------------------------------------------------|------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| ~~`eliza-1-27b` weights (Qwen-Qwen3.6-27B-Q4_K_M.gguf, 16.55 GiB)~~ | **Resolved 2026-05-11 (Wave-7 H1-redo)** — pulled after disk cleanup (~58 GiB free at start, ~53 GiB free after hardlinked layout). |
| ~~`eliza-1-27b-1m` weights~~                    | **Resolved** — shares the same physical Q4_K_M file as 27b via hardlink (zero extra disk). |
| DFlash drafters for any tier                   | Distilled artifacts, not on HF. Requires a CUDA host run of `distill_dflash_drafter.py`. |
| Vision mmproj for 9b / 27b                     | Fork-converted artifacts; not on HF as a single drop-in file. |
| Push to `elizaos/eliza-1-<tier>` HF repos      | Explicitly out of scope per task constraint — no operator approval, and no bundle clears the publish gate anyway. |

## Verification commands run

```bash
huggingface-cli download Qwen/Qwen3-0.6B-GGUF Qwen3-0.6B-Q8_0.gguf --local-dir <bundle>/source
huggingface-cli download Qwen/Qwen3-1.7B-GGUF Qwen3-1.7B-Q8_0.gguf --local-dir <bundle>/source
huggingface-cli download unsloth/Qwen3.5-9B-GGUF Qwen3.5-9B-Q4_K_M.gguf --local-dir <bundle>/source
# Wave-7 H1-redo:
huggingface-cli download batiai/Qwen3.6-27B-GGUF Qwen-Qwen3.6-27B-Q4_K_M.gguf \
  --local-dir ~/.eliza/local-inference/models/eliza-1-27b.bundle/source
ln <27b>/source/Qwen-Qwen3.6-27B-Q4_K_M.gguf <27b>/text/eliza-1-27b-64k.gguf
ln <27b>/source/Qwen-Qwen3.6-27B-Q4_K_M.gguf <27b-1m>/source/Qwen-Qwen3.6-27B-Q4_K_M.gguf
ln <27b-1m>/source/Qwen-Qwen3.6-27B-Q4_K_M.gguf <27b-1m>/text/eliza-1-27b-1m.gguf
shasum -a 256 <bundle>/source/<file>   # matches HF LFS pointer for all five
python3 -c "from eliza_lifeops_bench.eliza_1_bundle import read_eliza_one_bundle, bundle_is_pre_release; ..."
# → 0.6b, 1.7b, 9b, 27b, 27b-1m all read cleanly; all preRelease=True (correct per AGENTS.md Cmd #8)
```
