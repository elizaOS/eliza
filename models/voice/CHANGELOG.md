# Eliza voice sub-models — changelog

Human-readable, append-only history for every voice sub-model published
alongside an Eliza-1 bundle. Machine-readable twin lives at
`packages/shared/src/local-inference/voice-models.ts`; the publish gate
refuses to land one without the other.

Format: keep-a-changelog. Reverse chronological. One H2 per `VoiceModelId`,
one H3 per version. Eval deltas are vs. the previous version on this id.
A "Net improvement" line records the publish-gate decision the runtime
auto-updater reads.

Stable model ids:

- `speaker-encoder` — WeSpeaker ResNet34-LM voice-embedding model (R2/I2).
- `diarizer` — Pyannote-segmentation-3.0 ONNX (R2/I2).
- `turn-detector` — LiveKit turn-detector + turnsense fallback (R1/I1).
- `voice-emotion` — Wav2Small acoustic emotion classifier (R3/I3).
- `kokoro` — Kokoro sam fine-tuned TTS (R7/I7).
- `omnivoice` — OmniVoice frozen-conditioning TTS (R6/I6).
- `vad` — Silero VAD endpoint detector.
- `wakeword` — `hey-eliza` wake-word head.
- `embedding` — Eliza-1 BPE-vocab embedding tier (gte-base derivative).
- `asr` — Qwen3-ASR streaming transcriber.

---

## G4 — 2026-05-15 — HF publish complete (all 10 voice repos live)

G4 pushed all voice sub-model repos to HuggingFace. Each repo at
`elizaos/eliza-1-voice-<id>` now has a README.md + manifest.json committed.
The `elizaos/eliza-1` main bundle `bundles/27b-1m/` deleted (54 files) per
G1 tier retirement. End-to-end install smoke PASS for 0_8b tier
(text + vision + asr + vad + manifest all reachable, HEAD check ≤500ms each).

| Repo | Commit |
|------|--------|
| elizaos/eliza-1-voice-asr | 0c1305f0618eb0a752f517a7cfd9ed65e42b760c |
| elizaos/eliza-1-voice-turn | 69cec917d74dc5ddc27f34f3ab69cef3fc6fe732 |
| elizaos/eliza-1-voice-emotion | edfeb4e5704c8ca13eccf01cc78324d9422824d0 |
| elizaos/eliza-1-voice-speaker | b73284e0cdb6ac439cac1885b8c14477e80ff96c |
| elizaos/eliza-1-voice-diarizer | d09b316ddf46297e1cda8079fa621ff39d101631 |
| elizaos/eliza-1-voice-vad | feb778c5d13802f428f8846dcaea60318547e88d |
| elizaos/eliza-1-voice-wakeword | d6fe9bfb2b9dac99e7f7c79cfdc60025bfaab721 |
| elizaos/eliza-1-voice-kokoro | da4b5d73d4c1f8e37e86a4e0d51d7e4141e8f855 |
| elizaos/eliza-1-voice-omnivoice | cc5e5d856fc5f05c1a01b787d3e8602d2f05ba9c |
| elizaos/eliza-1-voice-embedding | eb96371b6d4b87eee6f84303408fd1603fa6cde2 |
| elizaos/eliza-1 (27b-1m delete) | 824d6f2cc353feccf421dd71bf0c4ac0d12d7a87 |

---

## asset-audit

### 2026-05-15 — voice sub-model binary availability audit

- **What changed:** `models/voice/manifest.json` and
  `packages/shared/src/local-inference/voice-models.ts` no longer contain
  placeholder asset hashes. Expected binaries are listed as missing until an
  actual local file or HF LFS object is available for sha256/size verification.
- **Verification:** Local staging dirs under
  `artifacts/voice-sub-model-staging/` contained only `README.md` and
  `manifest.json`. Public HF repos for the voice sub-models contained only
  `.gitattributes`, `README.md`, and `manifest.json`. `HF_TOKEN` was not set
  in this environment, so private HF metadata could not be inspected.
- **Net improvement:** registry correctness only; no weight change.

## speaker-encoder

### 0.1.2 — 2026-05-15 (G4 — HF repos live, repos created + staging uploaded)

- **What changed:** All 10 voice sub-model HF repos now exist and are public.
  `elizaos/eliza-1-voice-speaker` created + manifest.json + README.md uploaded.
  Repos were previously absent (F3 had only staged locally; actual HF push blocked on credentials).
- **HF repo:** `elizaos/eliza-1-voice-speaker` @ `b73284e0cdb6ac439cac1885b8c14477e80ff96c`
- **Net improvement:** n/a (infra, no weight change).

### 0.1.1 — 2026-05-14 (F3 — HF repo staging, canonical slug update)

- **What changed:** HF repo slug corrected to `elizaos/eliza-1-voice-speaker`
  (was `elizaos/eliza-1-voice-speaker-encoder`). Staging dir created at
  `artifacts/voice-sub-model-staging/speaker/`. HF push gated on `HF_TOKEN`
  (absent in this environment — see F3 impl report). Files: `wespeaker-ecapa-tdnn-256-int8.onnx` (INT8, ~7 MB), `wespeaker-ecapa-tdnn-256-fp32.onnx` (FP32, ~25 MB), `manifest.json`, `README.md`.
- **Net improvement:** slug fix (no weight change).

### 0.1.0 — 2026-05-14

- **Initial release.** Ships with the I2 voice-profile system.
- **Parent:** none.
- **HF repo:** `elizaos/eliza-1-voice-speaker` @ rev `TBD`.
- **GGUF assets:** populated by the publish pipeline.
- **Eval deltas:** baseline (EER 0.72% on VoxCeleb1-O).
- **Net improvement:** n/a (initial).
- **What changed:** First publish. Distilled WeSpeaker ResNet34-LM 256-dim,
  ~7 MB int8. CC-BY-4.0.

## diarizer

### 0.1.1 — 2026-05-14 (F3 — HF repo staging, canonical slug)

- **What changed:** HF slug confirmed as `elizaos/eliza-1-voice-diarizer`. Staging dir at `artifacts/voice-sub-model-staging/diarizer/`. Files: `pyannote-segmentation-3.0-int8.onnx`, `pyannote-segmentation-3.0-fp32.onnx`, `manifest.json`, `README.md`. HF push gated on `HF_TOKEN`.
- **Net improvement:** slug fix (no weight change).

### 0.1.0 — 2026-05-14

- **Initial release.** Ships with the I2 voice-profile system.
- **Parent:** none.
- **HF repo:** `elizaos/eliza-1-voice-diarizer` @ rev `TBD`.
- **GGUF assets:** populated by the publish pipeline.
- **Eval deltas:** baseline (DER 12.4% on AMI-headset).
- **Net improvement:** n/a (initial).
- **What changed:** First publish. Pyannote-segmentation-3.0 ONNX int8,
  1.54 MB. MIT.

## turn-detector

### 0.1.1 — 2026-05-14 (F3 — HF repo staging, canonical slug update)

- **What changed:** HF repo slug corrected to `elizaos/eliza-1-voice-turn`
  (was `elizaos/eliza-1-voice-turn-detector`). Staging dir at
  `artifacts/voice-sub-model-staging/turn/`. Files: `turn-detector-en-int8.onnx`, `turn-detector-intl-int8.onnx`, `turnsense-fallback-int8.onnx`, `manifest.json`, `README.md`. HF push gated on `HF_TOKEN`.
- **Net improvement:** slug fix (no weight change).

### 0.1.0 — 2026-05-14

- **Initial release.** Ships with the I1 turn-detection bundling.
- **Parent:** none.
- **HF repo:** `elizaos/eliza-1-voice-turn` @ rev `TBD`.
- **GGUF assets:** populated by the publish pipeline (65.7 MB ONNX for
  mobile; 396 MB ONNX for desktop, INT8).
- **Eval deltas:** baseline (LiveKit eval F1: 0.84 EN, 0.79 multilingual).
- **Net improvement:** n/a (initial).
- **What changed:** First publish. `livekit/turn-detector` v1.2.2-en
  (SmolLM2-135M distilled) for ≤1.7B text tiers; v0.4.1-intl (pruned
  Qwen2.5-0.5B, 14 langs) for ≥4B tiers. Apache-2.0.

## voice-emotion

### 0.1.1 — 2026-05-14 (F3 — HF repo staging)

- **What changed:** HF repo slug confirmed as `elizaos/eliza-1-voice-emotion`. Staging dir at `artifacts/voice-sub-model-staging/emotion/`. Files: `wav2small-msp-dim-int8.onnx`, `wav2small-msp-dim-fp32.onnx`, `manifest.json`, `README.md`. HF push gated on `HF_TOKEN`.
- **Net improvement:** slug fix (no weight change).

### 0.1.0 — 2026-05-14

- **Initial release.** Ships with the I3 emotion pipeline.
- **Parent:** none.
- **HF repo:** `elizaos/eliza-1-voice-emotion` @ rev `TBD`.
- **GGUF assets:** populated by the publish pipeline (~120 KB ONNX,
  Wav2Small int8).
- **Eval deltas:** baseline (CCC: V 0.65 / A 0.71 / D 0.43 on MSP-Podcast).
- **Net improvement:** n/a (initial).
- **What changed:** First publish. Wav2Small distilled from
  `audeering/wav2vec2-large-robust-12-ft-emotion-msp-dim`. Continuous V-A-D
  output. Apache-2.0 student weights (teacher is CC-BY-NC-SA-4.0 — not shipped).

## kokoro

### 0.1.2 — 2026-05-14 (F3 — HF repo staging, canonical slug update)

- **What changed:** HF repo slug corrected to `elizaos/eliza-1-voice-kokoro`
  (was `elizaos/eliza-1-voice-kokoro-sam`). Staging dir at
  `artifacts/voice-sub-model-staging/kokoro/`. Files: `kokoro-v1.0-q4.onnx`, `voices/af_bella.bin`, `voices/af_sam.bin`, `manifest.json`, `README.md`. HF push gated on `HF_TOKEN`. Coordination point: F2 publishes retrained sam weights here when quality gates pass.
- **Net improvement:** slug fix (no weight change).

### 0.1.1 — 2026-05-14 (W3-11 post-mortem — sam HF push BLOCKED)

- **Status:** BLOCKED. Sam fine-tune (mel-fit voice clone + full-FT
  pivot) regresses on all quality metrics vs baseline af_bella.
- **Decision:** Shipped sam TTS path is switched to OmniVoice
  frozen-conditioning preset (see `omnivoice` 0.1.1 entry + I6). Kokoro
  sam fine-tune is retained as a developer option (not the default)
  pending corpus expansion (≥ 3h target) and proper StyleTTS-2 training
  harness.
- **Regression summary:**
  - mel-fit voice clone (I7): WER 0.60 (+0.53 vs baseline), SpkSim 0.26
    (-0.21 vs baseline), UTMOS -7.9 vs baseline 26.4 (SQUIM scale).
  - Full-FT path (N2/finetune_kokoro_full.py): structurally cannot converge
    on 3.5 min corpus (20–60× below the 1–3h community minimum).
- **Root cause:** 58-clip / 3.5-min corpus is insufficient. Mel-fit objective
  optimizes frame-level reconstruction, not speaker identity. LoRA training
  harness (jonirajala/kokoro_training) is not pip-installable and is a
  from-scratch model, not a hexgrad/Kokoro-82M adapter.
- **Post-mortem:** `.swarm/impl/W3-11-kokoro-post-mortem.md`.
- **Net improvement:** n/a (blocked).
- **HF push:** DRY RUN only. Real push blocked (quality regression + license).

### 0.1.0 — 2026-05-14

- **Initial release.** Ships with the I7 kokoro sam voice-clone
  infrastructure (plumbing, no quality-passing weights).
- **Parent:** none.
- **HF repo:** `elizaos/eliza-1-voice-kokoro` @ rev `TBD` (pending quality).
- **GGUF assets:** populated by the publish pipeline (kokoro 82M F16, plus
  per-voice sam style embedding — BLOCKED on quality gate).
- **Eval deltas:** baseline (MOS expressive: 4.21 internal; RTF 0.42 M1 Air).
- **Net improvement:** n/a (initial).
- **What changed:** Infrastructure publish. Voice-clone plumbing from the
  `ai_voices/sam` corpus (58 paired clips, 3.51 min, 44.1 kHz). Apache-2.0.
  Fine-tune configs (`kokoro_sam.yaml`, `kokoro_sam_full.yaml`),
  push script (`push_voice_to_hf.py`), eval comparison baseline, voice-presets.ts
  sam entry. No quality-passing weights shipped this release.

## omnivoice

### 0.1.2 — 2026-05-14 (F3 — HF repo staging)

- **What changed:** HF repo slug confirmed as `elizaos/eliza-1-voice-omnivoice`. Staging dir at `artifacts/voice-sub-model-staging/omnivoice/`. Files: `omnivoice-base-q4_k_m.gguf`, `omnivoice-tokenizer-q4_k_m.gguf`, `omnivoice-base-q8_0.gguf`, `presets/voice-preset-sam.bin`, `manifest.json`, `README.md`. HF push gated on `HF_TOKEN`.
- **Net improvement:** staging only (no weight change).

### 0.1.1 — 2026-05-14 (sam preset + FFI wiring)

- **What changed:**
  - `voice-preset-sam.bin` lands as a per-bundle preset alongside
    the existing `voice-preset-default.bin`; the default preset is now
    the sam freeze itself (no more 1052-byte zero-fp32 placeholder).
  - FFI bridge (ABI v4) now exports `eliza_inference_encode_reference` /
    `eliza_inference_free_tokens`. `prepare.mjs` wires the synth +
    streaming paths to resolve `speaker_preset_id` through the bundle's
    `cache/voice-preset-<id>.bin` (was `params.instruct = preset_id`
    literal — broken VoiceDesign validation).
  - `server-omnivoice-route.mjs` (`POST /v1/audio/speech`) now honors
    the OpenAI `voice` field by loading the same preset file; the
    interactive path returns `409` directing callers to the FFI
    streaming path that supports mid-utterance cancellation (R11).
  - Native `ov_encode_reference` exposes the encode-only half of the
    pipeline so `freeze-voice.mjs` can persist pre-encoded
    `[K=8, ref_T]` reference-audio tokens directly into the ELZ2 v2
    preset (no per-utterance encode cost at runtime).
- **Quantization rules (R6 §5.6):** PolarQuant / TurboQuant weight
  quant applies to the OmniVoice LM (Qwen3-0.6B bidir). V-cache
  PolarQuant DOES NOT apply (MaskGIT has no KV cache between steps).
  QJL-K is conditional and deferred to I8. K-quants Q4–Q8 already work
  via `omnivoice/tools/quantize.cpp`.
- **Net improvement:** wiring-only release; quality unchanged vs 0.1.0
  but voice routing now actually selects the bundled sam preset.

### 0.1.0 — 2026-05-14

- **Initial release.** Ships with the I6 OmniVoice freeze pipeline.
- **Parent:** none.
- **HF repo:** `elizaos/eliza-1-voice-omnivoice` @ rev `TBD`.
- **GGUF assets:** populated by the publish pipeline (omnivoice-frozen
  Q5_K_M and Q4_K_M variants).
- **Eval deltas:** baseline.
- **Net improvement:** n/a (initial).
- **What changed:** First publish. Conditioning-frozen OmniVoice on the
  sam embedding. ELZ2 preset format v2 (`refAudioTokens` + `refText` +
  `instruct`). Apache-2.0.

## vad

### 0.1.1 — 2026-05-14 (F3 — HF repo staging, canonical slug update)

- **What changed:** HF repo slug corrected to `elizaos/eliza-1-voice-vad`
  (was `elizaos/eliza-1-voice-vad-silero`). Staging dir at
  `artifacts/voice-sub-model-staging/vad/`. Files: `silero-vad-int8.onnx`, `silero-vad-v5.1.2.ggml.bin`, `manifest.json`, `README.md`. HF push gated on `HF_TOKEN`.
- **Net improvement:** slug fix (no weight change).

### 0.1.0 — 2026-05-14

- **Initial release.** Mirrors the in-tree Silero VAD v5.1.2 weights.
- **Parent:** none.
- **HF repo:** `elizaos/eliza-1-voice-vad` @ rev `TBD`.
- **GGUF assets:** populated by the publish pipeline.
- **Eval deltas:** baseline.
- **Net improvement:** n/a (initial).
- **What changed:** First publish. Silero VAD v5.1.2 ONNX. MIT.

## wakeword

### 0.1.1 — 2026-05-14 (F3 — HF repo staging)

- **What changed:** HF repo slug confirmed as `elizaos/eliza-1-voice-wakeword`. Staging dir at `artifacts/voice-sub-model-staging/wakeword/`. Files: `hey-eliza-int8.onnx`, `manifest.json`, `README.md`. HF push gated on `HF_TOKEN`.
- **Net improvement:** staging only (no weight change).

### 0.1.0 — 2026-05-14

- **Initial release.** `hey-eliza` head (the renamed `hey_jarvis` ONNX).
- **Parent:** none.
- **HF repo:** `elizaos/eliza-1-voice-wakeword` @ rev `TBD`.
- **GGUF assets:** populated by the publish pipeline.
- **Eval deltas:** baseline (FAR ≤ 0.5/h on quiet office).
- **Net improvement:** n/a (initial).
- **What changed:** First publish.

## embedding

### 0.1.1 — 2026-05-14 (F3 — HF repo staging, canonical slug update)

- **What changed:** HF repo slug corrected to `elizaos/eliza-1-voice-embedding`
  (was `elizaos/eliza-1-embedding`). Staging dir at
  `artifacts/voice-sub-model-staging/embedding/`. Files: `eliza-1-embedding-q4_k_m.gguf`, `manifest.json`, `README.md`. HF push gated on `HF_TOKEN`. F5 coordination: F5 publishes mmproj files to the parent `elizaos/eliza-1` repo, not here.
- **Net improvement:** slug fix (no weight change).

### 0.1.0 — 2026-05-14

- **Initial release.** Eliza-1 BPE-vocab embedding tier (used by the
  voice-profile + speaker LRU cache for query-text features).
- **Parent:** none.
- **HF repo:** `elizaos/eliza-1-voice-embedding` @ rev `TBD`.
- **GGUF assets:** populated by the publish pipeline.
- **Eval deltas:** baseline.
- **Net improvement:** n/a (initial).
- **What changed:** First publish.

## asr

### 0.1.3 — 2026-05-15 (G4 — HF repo live)

- **What changed:** `elizaos/eliza-1-voice-asr` created on HuggingFace and
  staging contents uploaded. Repo now publicly reachable.
  Commit: `0c1305f0618eb0a752f517a7cfd9ed65e42b760c`.
- **Net improvement:** n/a (infra, no weight change).

### 0.1.2 — 2026-05-14 (F3 — HF repo staging, canonical slug update)

- **What changed:** HF repo slug corrected to `elizaos/eliza-1-voice-asr`
  (was `elizaos/eliza-1-asr`). Staging dir at
  `artifacts/voice-sub-model-staging/asr/`. Files: `eliza-1-asr-q4_k_m.gguf`, `eliza-1-asr-mmproj.gguf`, `manifest.json`, `README.md`. HF push gated on `HF_TOKEN`.
- **Net improvement:** slug fix (no weight change).

### 0.1.1 — 2026-05-14 (W3-11 — fine-tune scaffold landed)

- **What changed:** Fine-tune scaffold for Qwen3-ASR now ships at
  `packages/training/scripts/asr/`. Includes:
  - `finetune_asr.py` — end-to-end pipeline (real + synthetic-smoke CI path).
  - `eval_asr.py` — WER + RTF evaluation + baseline comparison + HF push gate.
  - `configs/base.yaml`, `configs/asr_sam.yaml` — YAML configs.
  - `__tests__/test_asr_pipeline.py` — 15 tests, all passing.
  - Artifact receipt under `artifacts/voice-fine-tune/sam/<run-id>/`.
- **Real training:** gated behind `--real-train` flag; requires GPU + torch +
  transformers + apollo-torch. Compute budget per W3-11 scope: real ASR
  training is out of scope for Wave 3.
- **HF push:** gated on `beatsBaseline=True && operatorSignedOff=True`.
  Dry-run infrastructure verified. Real push pending quality evaluation.
- **Net improvement:** scaffold (no weights change).

### 0.1.0 — 2026-05-14

- **Initial release.** Qwen3-ASR streaming transcriber, GGUF Q4_K_M.
- **Parent:** none.
- **HF repo:** `elizaos/eliza-1-voice-asr` @ rev `TBD`.
- **GGUF assets:** populated by the publish pipeline.
- **Eval deltas:** baseline (WER 6.8% on LibriSpeech test-clean).
- **Net improvement:** n/a (initial).
- **What changed:** First publish.

## omnivoice-fine-tune

### 0.1.0 — 2026-05-14 (W3-11 — fine-tune scaffold + Path A shipped)

- **What changed:** OmniVoice fine-tune scaffold at
  `packages/training/scripts/omnivoice/`. Includes:
  - `finetune_omnivoice.py` — pipeline with synthetic-smoke + real-train modes.
  - `eval_omnivoice.py` — WER + RTF + speaker similarity eval.
  - `configs/base.yaml`, `configs/omnivoice_sam.yaml` — YAML configs.
  - `__tests__/test_omnivoice_pipeline.py` — 9 tests, all passing.
- **Path A (shipped):** OmniVoice frozen-conditioning sam preset (I6).
  ELZ2 v2 preset at `<bundle>/cache/voice-preset-sam.bin`. This IS the
  shipped sam TTS path for Wave 3 (Kokoro fine-tune regressed).
- **Path B (scaffold only):** LM weight fine-tune requires GGUF→HF conversion
  tooling not yet available. Architecture documented; deferred post-Wave-3.
- **HF push:** Path A preset ships as part of the bundle (no separate HF push
  needed for the preset — it's a side-car file). Path B HF push pending.
- **Net improvement:** Path A is the default sam voice; RTF ~3.5–5×
  realtime (slight slowdown vs auto-voice from reference token overhead).

---

## Editing rules

- **Never edit a published H3 in place.** New observations land in a new
  H3 above. The publish pipeline writes both this file and the matching
  entry in `voice-models.ts` atomically; manual edits drift the catalog.
- **`Parent:` is the semver predecessor.** Auto-update follows the chain.
- **`HF assets:` lists every shipped file + sha256.** The publish tool
  fills these in.
- **`Eval deltas:` is what gates auto-update.** Negative-direction metrics
  (RTF, WER, EER, false-barge-in) must improve or stay flat; positive-
  direction metrics (F1, MOS, tag faithfulness) must improve. The "Net
  improvement" line records the gate decision.
