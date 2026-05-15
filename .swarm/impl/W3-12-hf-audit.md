# W3-12 — HuggingFace Audit Report

**Agent:** W3-12 (eliza-1 HF feature-complete)
**Date:** 2026-05-14
**HF repo audited:** `elizaos/eliza-1` (https://huggingface.co/elizaos/eliza-1)

---

## 1. Executive Summary

The `elizaos/eliza-1` HuggingFace repo is a **single monorepo** containing all
tier bundles under `bundles/<tier>/`. This is correct per the catalog design.

**Critical blocker found and fixed:** `ELIZA_1_HF_REPO` was set to `"elizalabs/eliza-1"`
across the entire codebase, but the actual HF org is `elizaos`. Every download URL
produced by the runtime would have 404'd. Fixed in commit `cd79fe1186`.

**Tier completeness:** 6 of 7 catalog tiers are present on HF. The 27b-1m tier
is missing (hardware-gated).

**Voice assets:** Core TTS (omnivoice + kokoro) and ASR are present. Voice
sub-models (wakeword, turn-detector, speaker-encoder, emotion classifier) are
absent from per-tier manifests and their separate repos do not exist yet.

---

## 2. HF Bundle Tier Inventory

### Expected catalog tiers (from `catalog.ts` ELIZA_1_TIER_IDS)
`0_8b`, `2b`, `4b`, `9b`, `27b`, `27b-256k`, `27b-1m`

### Actual HF bundles found
`0_8b`, `2b`, `4b`, `9b`, `27b`, `27b-256k` ✓ (6/7)

**Extra legacy bundles** (not in catalog, do not interfere):
- `0_6b` — legacy Qwen3-0.6B tier (retired, has `sft/` + `drafter/` safetensors)
- `1_7b` — legacy Qwen3-1.7B tier (retired)

---

## 3. Per-Tier Gap Analysis

### eliza-1-0_8b — PUBLISHED, gaps in voice sub-models and vision

| Asset | Status | Notes |
|-------|--------|-------|
| `text/eliza-1-0_8b-32k.gguf` | ✓ PRESENT | Q4_K_M, 32k ctx |
| `dflash/drafter-0_8b.gguf` | ✓ PRESENT | |
| `asr/eliza-1-asr.gguf` | ✓ PRESENT | |
| `asr/eliza-1-asr-mmproj.gguf` | ✓ PRESENT | ASR audio projector |
| `vad/silero-vad-int8.onnx` | ✓ PRESENT | |
| `vad/silero-vad-v5.1.2.ggml.bin` | ✓ PRESENT | |
| `tts/omnivoice-base-Q4_K_M.gguf` | ✓ PRESENT | |
| `tts/omnivoice-tokenizer-Q4_K_M.gguf` | ✓ PRESENT | |
| `tts/kokoro/model_q4.onnx` | ✓ PRESENT | |
| `tts/kokoro/voices/af_bella.bin` | ✓ PRESENT | Single voice only |
| `cache/voice-preset-default.bin` | ✓ PRESENT | 1052 bytes (placeholder, not real samantha) |
| `vision/mmproj-0_8b.gguf` | ✗ MISSING | Catalog: `hasVision: true` — BLOCKER |
| `tts/kokoro/voices/af_samantha.bin` | ✗ MISSING | I7 eval regressed; samantha push blocked |
| Wakeword | ✗ MISSING | Not in manifest; repo not created |
| Turn-detector | ✗ MISSING | Not in manifest; repo not created |
| Speaker-encoder | ✗ MISSING | Not in manifest; repo not created |
| Emotion classifier | ✗ MISSING | Not in manifest; repo not created |

**Quantization configs:** polarquant, qjl, turboquant, fused_turboquant ✓ PRESENT

### eliza-1-2b — PUBLISHED, gaps

| Asset | Status | Notes |
|-------|--------|-------|
| `text/eliza-1-2b-32k.gguf` | ✓ PRESENT | |
| `dflash/drafter-2b.gguf` | ✓ PRESENT | |
| `asr/eliza-1-asr.gguf` | ✓ PRESENT | |
| `vad/silero-vad-int8.onnx` | ✓ PRESENT | |
| `tts/omnivoice-base-Q4_K_M.gguf` | ✓ PRESENT | |
| `tts/kokoro/model_q4.onnx` | ✓ PRESENT | |
| `tts/kokoro/voices/` | ✓ PRESENT | 10 voices (af_bella, af_nicole, af_sarah, af_sky, am_adam, am_michael, bf_emma, bf_isabella, bm_george, bm_lewis) |
| `vision/mmproj-2b.gguf` | ✗ MISSING | Catalog: `hasVision: true` — BLOCKER |
| `cache/voice-preset-default.bin` | ✓ PRESENT | Placeholder |
| Embedding | ✗ MISSING | Catalog: `hasEmbedding: false` for 2b ✓ correct |
| Wakeword/Turn/Speaker/Emotion | ✗ MISSING | Not in manifest |

### eliza-1-4b — PUBLISHED, mostly complete

| Asset | Status | Notes |
|-------|--------|-------|
| `text/eliza-1-4b-64k.gguf` | ✓ PRESENT | |
| `text/eliza-1-4b-128k.gguf` | ✓ PRESENT | Long context variant |
| `vision/mmproj-4b.gguf` | ✓ PRESENT | |
| `embedding/eliza-1-embedding.gguf` | ✓ PRESENT | |
| `tts/omnivoice-base-Q4_K_M.gguf` | ✓ PRESENT | |
| `tts/kokoro/model_q4.onnx` | ✓ PRESENT | |
| `tts/kokoro/voices/af_bella.bin` | ✓ PRESENT | Single voice |
| Wakeword/Turn/Speaker/Emotion | ✗ MISSING | Not in manifest |

### eliza-1-9b — PUBLISHED, complete on main assets

| Asset | Status | Notes |
|-------|--------|-------|
| `text/eliza-1-9b-64k.gguf` | ✓ PRESENT | |
| `text/eliza-1-9b-128k.gguf` | ✓ PRESENT | |
| `vision/mmproj-9b.gguf` | ✓ PRESENT | |
| `tts/omnivoice-base-Q8_0.gguf` | ✓ PRESENT | Higher quality quant |
| `tts/kokoro/model_q4.onnx` | ✓ PRESENT | |
| `tts/kokoro/voices/` | ✓ PRESENT | 10 voices |
| Embedding | ✗ MISSING in manifest | File may exist, not in manifest.files.embedding |
| Wakeword/Turn/Speaker/Emotion | ✗ MISSING | Not in manifest |

### eliza-1-27b — PUBLISHED, no kokoro (by design)

| Asset | Status | Notes |
|-------|--------|-------|
| `text/eliza-1-27b-128k.gguf` | ✓ PRESENT | |
| `text/eliza-1-27b-256k.gguf` | ✓ PRESENT | |
| `vision/mmproj-27b.gguf` | ✓ PRESENT | |
| `tts/omnivoice-base-Q8_0.gguf` | ✓ PRESENT | |
| No kokoro | ✓ BY DESIGN | Large tiers omit kokoro per catalog policy |
| Wakeword/Turn/Speaker/Emotion | ✗ MISSING | Not in manifest |

### eliza-1-27b-256k — PUBLISHED, complete

| Asset | Status | Notes |
|-------|--------|-------|
| `text/eliza-1-27b-256k.gguf` | ✓ PRESENT | |
| `vision/mmproj-27b-256k.gguf` | ✓ PRESENT | |
| `tts/omnivoice-base-Q8_0.gguf` | ✓ PRESENT | |
| Wakeword/Turn/Speaker/Emotion | ✗ MISSING | Not in manifest |

### eliza-1-27b-1m — NOT PUBLISHED (hardware-gated)

| Asset | Status | Notes |
|-------|--------|-------|
| ALL | ✗ MISSING | Bundle not created. 160 GB RAM requirement. |

**Gating reason:** Production training of a 27B model at 1M context requires an
H200 cluster (≥2x H200 80GB or equivalent). This is a hardware/compute blocker,
not a code blocker. The tier is marked `"pending"` in `ELIZA_1_TIER_PUBLISH_STATUS`.

**Next step:** Provision H200 cluster, run:
```bash
python packages/training/scripts/manifest/stage_eliza1_bundle_assets.py \
  --tier 27b-1m \
  --source-weights <path-to-27b-1m-weights>
```

---

## 4. Voice Sub-Model Repository Status

The voice sub-models (speaker-encoder, diarizer, turn-detector, voice-emotion,
kokoro, omnivoice, vad, wakeword, embedding, asr) are designed to live in
separate HF repos per `packages/shared/src/local-inference/voice-models.ts`.

**Status of each planned repo (checked 2026-05-14):**

| Repo | Status | Notes |
|------|--------|-------|
| `elizaos/eliza-1-voice-speaker-encoder` | 401/UNKNOWN | Not created or private |
| `elizaos/eliza-1-voice-diarizer` | 401/UNKNOWN | Not created or private |
| `elizaos/eliza-1-voice-turn-detector` | 401/UNKNOWN | Not created or private |
| `elizaos/eliza-1-voice-emotion` | 401/UNKNOWN | Not created or private |
| `elizaos/eliza-1-voice-kokoro-samantha` | 401/UNKNOWN | I7: created private, push DRY-RUN only; eval regressed |
| `elizaos/eliza-1-voice-omnivoice` | 401/UNKNOWN | Not created or private |
| `elizaos/eliza-1-voice-vad-silero` | 401/UNKNOWN | Not created or private |
| `elizaos/eliza-1-voice-wakeword` | 401/UNKNOWN | Not created or private |
| `elizaos/eliza-1-embedding` | 401/UNKNOWN | Not created or private |
| `elizaos/eliza-1-asr` | 401/UNKNOWN | Not created or private |

**Note:** HF returns HTTP 401 for both private repos and non-existent repos
when unauthenticated. The public HF API lists no models under the `elizaos`
org except `elizaos/eliza-1` itself. The voice sub-model weights are stored
inside the main bundle (e.g. `bundles/0_8b/asr/`, `bundles/0_8b/tts/`).

The separate voice repo design in `voice-models.ts` is aspirational — the
actual published path is the consolidated bundle approach (assets in the main
`elizaos/eliza-1` repo under `bundles/<tier>/`).

---

## 5. Manifest Field Gaps (per-tier)

Running against the live HF manifests, the following optional fields are
consistently **absent** from all tier manifests:

- `files.wakeword` — no wake-word ONNX in any bundle
- `files.turn_detector` — no turn-detector ONNX in any bundle  
- `files.speaker_encoder` — no speaker-encoder ONNX in any bundle
- `files.emotion` — no emotion classifier ONNX in any bundle

These were defined in Wave 2 (I1/I2/I3) but the publish pipeline step
(`stage_eliza1_bundle_assets.py`) has not run the corresponding staging
steps with these models. The staging script has flags:
`--include-voice-ladder`, `--turn-license`, `--skip-turn-detector` —
but the actual ONNX models are not available locally to stage.

**Root cause:** The voice sub-models (speaker encoder, diarizer, turn-detector,
emotion) are ONNX models that need to be downloaded from upstream sources
(WeSpeaker, Pyannote, LiveKit, audeering/Wav2Small), quantized/exported,
and then pushed. This requires Python + model weights. The CI/publishing
environment has not run these steps yet.

---

## 6. GGUF Quant Ladder Status

### Text model quantization (present in HF)
Each bundle ships exactly one Q4_K_M variant of the primary text GGUF.
The catalog defines Q6_K and Q8_0 as `"planned"` — these are NOT present
on HF yet. The downloader defaults to Q4_K_M so this is not a blocker for
first-run.

### OmniVoice quant ladder
- Small tiers (0_8b/2b/4b): Q4_K_M only (catalog expects Q3_K_M/Q4_K_M/Q5_K_M)
- Large tiers (9b/27b/27b-256k): Q8_0 only (catalog expects Q3_K_M through Q8_0)

The runtime defaults to Q4_K_M (small) or Q8_0 (large) which matches what's
published. Q3_K_M, Q5_K_M, Q6_K variants are `"planned"`.

---

## 7. Fixes Applied (this session)

### Critical fix: elizalabs → elizaos repo slug
**Before:** `ELIZA_1_HF_REPO = "elizalabs/eliza-1"` — downloads would 404
**After:** `ELIZA_1_HF_REPO = "elizaos/eliza-1"` — correct URL

Files fixed: `catalog.ts`, `voice-models.ts`, `types.ts`, `voice-presets.ts`
(shared + plugin), `embedding-presets.ts` (agent + plugin), 
`stage-default-models.mjs`, linux `catalog.ts` + test, `model_registry.py`,
`eliza1_manifest.py`, test fixtures.

### Catalog publish status
`ELIZA_1_TIER_PUBLISH_STATUS` now marks `eliza-1-27b-1m: "pending"` so the
recommender excludes it from first-run recommendations.

### Test fixes
- `catalog.test.ts`: voiceBackends expectations updated to match omnivoice-first
  policy (Wave 2 changed small tier defaults to omnivoice-first)
- Linux agent test: updated hfRepo expectation to `elizaos/eliza-1`

---

## 8. What Needs to Happen Next (Gating Items)

### P0 — Blockers for "just works" install

1. **0_8b and 2b vision mmproj missing:** `vision/mmproj-0_8b.gguf` and
   `vision/mmproj-2b.gguf` are absent. Catalog marks these tiers `hasVision: true`.
   The downloader will skip vision gracefully if the manifest doesn't list it,
   but the manifest also doesn't list vision for these tiers, so this is consistent
   (the manifest is authoritative — vision is functionally disabled on 0_8b/2b).
   
   **Decision needed:** Either (a) quantize the 0_8b/2b VL projectors and push
   them, updating manifests, or (b) set `hasVision: false` in catalog for 0_8b/2b
   until the projectors are ready.

2. **27b-1m bundle entirely absent:** Hardware-gated (H200). Marked pending.

3. **Voice sub-model repos not created:** Speaker-encoder, diarizer, turn-detector,
   emotion ONNX models not published. These are optional for TTS/ASR to work;
   the core pipeline (text + omnivoice + ASR + VAD) works without them.

### P1 — Quality gaps

4. **No samantha voice preset:** `cache/voice-preset-samantha.bin` is absent from
   all bundles; only `voice-preset-default.bin` (1052-byte placeholder) exists.
   The I7 kokoro samantha fine-tune regressed on all quality metrics. OmniVoice
   samantha freeze from I6 is not pushed. Default voice is af_bella.

5. **Kokoro voice variety limited on small tiers:** 0_8b and 4b only have af_bella.
   2b and 9b have the full 10-voice set.

6. **No embedding on 9b in manifest:** The `embedding/` file exists on 9b HF but
   the manifest `files.embedding` is empty. May need manifest update.

### P2 — Missing quant variants (non-blocking)

7. Multiple quant levels (Q3_K_M, Q5_K_M, Q6_K) planned but not yet published.
   Runtime defaults to Q4_K_M/Q8_0 which are present.
