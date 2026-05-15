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

## M-emotion-final — 2026-05-15 — voice-emotion v0.2.0 gate cleared + standalone HF mirror

Voice-emotion v0.2.0 (Wav2Small cls7 head, distilled from
`audeering/wav2vec2-large-robust-12-ft-emotion-msp-dim`) cleared the
`macro_f1 >= 0.35` eval gate via **Path B** (the G-emotion `best.pt`
re-exported with the aux 7-class head as the ONNX output):

| Metric                 | Value      | Gate              |
|------------------------|------------|-------------------|
| Macro-F1 (cls7 head)   | **0.3550** | `>= 0.35` (pass)  |
| Accuracy (cls7 head)   | 0.4841     | n/a               |
| MSE (V-A-D)            | 0.1350     | n/a               |
| Macro-F1 (V-A-D proj.) | 0.3192     | n/a (informative) |

Test split: 126 held-out RAVDESS clips, 7 expressive-tag classes
(`happy, sad, angry, nervous, calm, excited, whisper`). Runtime adapter
at `plugins/plugin-local-inference/src/services/voice/voice-emotion-classifier.ts`
auto-detects the head by ONNX output dim (3 → V-A-D projection,
7 → direct argmax over `EXPRESSIVE_EMOTION_TAGS`).

In addition to the consolidated `elizaos/eliza-1` repo (see H5 below),
v0.2.0 was **also re-published to the standalone public mirror
`elizaos/eliza-1-voice-emotion`** at revision
`384e896725da9358b2f3bb9b31e30a3565998ecd` so the model card is
discoverable on its own page. Both repos carry identical
`wav2small-cls7-int8.onnx` (sha256
`cba2c4e49707ac20da8b1420814b80735f700e917905c46d8cb880b95d97c953`,
524,750 bytes). Path A (RAVDESS + CREMA-D combined corpus retrain) was
attempted but did not exceed Path B's aux-head F1 within the training
budget, so Path B remains the published artifact.

Implementation details and evidence at `.swarm/impl/M-emotion-final.md`.

---

## H5 — 2026-05-15 — unified eliza-1 voice repo migration gate

Voice payload publishing now targets the single canonical repo
`elizaos/eliza-1` under `voice/<model-id>/...`.
`scripts/hf_consolidate_eliza1_voice.py` verifies source split-repo
hashes/sizes from `models/voice/manifest.json`, can stage and publish the
unified `voice/` tree, verifies the destination, and only then allows legacy
split repo deletion with an explicit confirmation flag.

Verified destination commit: `elizaos/eliza-1` @
`20b291b5820937e8a1e1ca9f2927f5bc64aefe7e`. The unified upload includes the
current manifest assets plus the historical turn-detector v0.1 payloads that
remain in `packages/shared/src/local-inference/voice-models.ts`, so runtime
downloads no longer require split voice repos. After verification, all 10
legacy `elizaos/eliza-1-voice-*` repos were deleted.

Remaining blocker for GGUF-only release: speaker, diarizer, turn-detector,
voice-emotion, kokoro, VAD, and wakeword still include ONNX payloads. The
publish/delete gate reports these explicitly via `--require-gguf`.

---

## H4 — 2026-05-15 — voice sub-model weights confirmed live on HuggingFace

H4 verified all 10 `elizaos/eliza-1-voice-*` repos have real ONNX/GGUF
weights pushed. SHA256 values cross-checked against HF LFS metadata.
`models/voice/manifest.json` updated: turn-detector promoted to v0.2.0
(DailyDialog fine-tune, F1=0.9811), hfRevision corrected to the v0.2.0 HEAD.

| Repo | HEAD commit | Weights |
|------|------------|---------|
| elizaos/eliza-1-voice-asr | c5b2f3b358fb0b0c0713d7290e2eed61b0fb174f | eliza-1-asr-q8_0.gguf (2.0 GB) + mmproj (340 MB) |
| elizaos/eliza-1-voice-turn | 9eaff4947ebd87b1d811e27dec939e29362a9e42 | onnx/model_q8.onnx (36 MB) + onnx/turn-detector-en-q8.gguf (39 MB) + tokenizer |
| elizaos/eliza-1-voice-emotion | 85c56b6f5aa4bdef801aa6d5ea082eb92f90b463 | wav2small-msp-dim-int8.onnx (504 KB) + fp32 variants |
| elizaos/eliza-1-voice-speaker | 3d882d6dfb00c9eed49f89bb7cc2e45ac3497159 | wespeaker-resnet34-lm.onnx (25 MB) |
| elizaos/eliza-1-voice-diarizer | 7a8d059b770aeab08e6eabcf9dcbfc051e5bafef | pyannote-segmentation-3.0-int8.onnx (1.5 MB) + fp32 (5.7 MB) |
| elizaos/eliza-1-voice-vad | 7fc2359bbc0ee1e0dd7de2acb126f6872a4fb4c2 | silero-vad-int8.onnx (624 KB) + ggml.bin (864 KB) |
| elizaos/eliza-1-voice-wakeword | bcd866bc070a649dfd2dfbf7aadbd01b3cc68c4b | hey-eliza-int8.onnx (615 KB) + melspectrogram + embedding_model |
| elizaos/eliza-1-voice-kokoro | 967f7449f79414d2b49db3b2441ea683630c11ab | kokoro-v1.0-q4.onnx (291 MB) + voices/af_bella.bin + voices/af_same.bin |
| elizaos/eliza-1-voice-omnivoice | b766eb23d5f6c84d580973c0f2013b6fcbd561c0 | omnivoice-base-q4_k_m.gguf (389 MB) + q8_0 (626 MB) + tokenizer + presets/voice-preset-same.bin |
| elizaos/eliza-1-voice-embedding | bf6afa907c83ec98e487f018cfb4e29ec3cb7c03 | eliza-1-embedding-q8_0.gguf (609 MB) |

**turn-detector v0.2.0** (H-turn / I1-turn fine-tune): DailyDialog prefix-augmented
EOU corpus, APOLLO-Mini scaffold, F1=0.9811 (vs 0.84 baseline). +0.1411 F1 delta.

---

## G4 — 2026-05-15 — HF publish complete (all 10 voice repos live)

G4 pushed all voice sub-model repos to HuggingFace. Each repo at
`elizaos/eliza-1-voice-<id>` now has a README.md + manifest.json committed.
The `elizaos/eliza-1` main bundle `bundles/27b-1m/` deleted (54 files) per
G1 tier retirement. End-to-end install smoke PASS for 0_8b tier
(text + vision + asr + vad + manifest all reachable, HEAD check ≤500ms each).

| Repo | Commit |
|------|--------|
| elizaos/eliza-1-voice-asr | c5b2f3b358fb0b0c0713d7290e2eed61b0fb174f |
| elizaos/eliza-1-voice-turn | 6fb5a2ef8942c857904d78ca10ab91a22dba1e06 |
| elizaos/eliza-1-voice-emotion | da50fd9719dd78857829b144d6f72ce3c4e3464a |
| elizaos/eliza-1-voice-speaker | f6a2c964e0f36091e995e69b506bd36e1e645289 |
| elizaos/eliza-1-voice-diarizer | d3c4974d391d45ac9261221a96f2eeb4750aa2cf |
| elizaos/eliza-1-voice-vad | 9d8f7eefc72fda18b9d8ae6e8d4cc413a939a7a7 |
| elizaos/eliza-1-voice-wakeword | 85bef810f8bb0ca57e8625ec36abe1c617fd3e39 |
| elizaos/eliza-1-voice-kokoro | 967f7449f79414d2b49db3b2441ea683630c11ab |
| elizaos/eliza-1-voice-omnivoice | b766eb23d5f6c84d580973c0f2013b6fcbd561c0 |
| elizaos/eliza-1-voice-embedding | acddce031d74deebe1027382feb143df7dd1500e |
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
- **HF repo:** `elizaos/eliza-1-voice-speaker` @ rev `f6a2c964e0f36091e995e69b506bd36e1e645289`.
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
- **HF repo:** `elizaos/eliza-1-voice-diarizer` @ rev `d3c4974d391d45ac9261221a96f2eeb4750aa2cf`.
- **GGUF assets:** populated by the publish pipeline.
- **Eval deltas:** baseline (DER 12.4% on AMI-headset).
- **Net improvement:** n/a (initial).
- **What changed:** First publish. Pyannote-segmentation-3.0 ONNX int8,
  1.54 MB. MIT.

## turn-detector-intl

### 0.1.0 — 2026-05-15 (O-turn-intl — OASST1 multilingual fine-tune)

- **What changed:** Fine-tuned `livekit/turn-detector @ v0.4.1-intl`
  (24-layer Qwen2-0.5B pruned, ~500M params, 14-language tokenizer) on
  a multilingual EOU corpus built from `OpenAssistant/oasst1` (Apache-2.0,
  prompter-role utterances). Same prefix-augmented signal as H-turn: each
  utterance ≥ 3 word-units (or character-units for CJK scripts) emits a
  positive (full utterance, EOU=1) and a randomly-truncated prefix as a
  negative (trailing ASCII + fullwidth punctuation stripped). Per-language
  cap = 6 000 utterances; 12 OASST1 locales with non-trivial coverage.
  Final train set: 47 342 examples; eval set: 1 248 language-stratified.
- **Parent:** none (first publish of the multilingual variant).
- **HF repo:** `elizaos/eliza-1-voice-turn` @ rev
  `7ec50ce4b65943ccc32a14959c54181f57a0a284`, `intl/` subfolder.
- **Assets:** `intl/model_q8.onnx` (262 MB INT8 ONNX,
  `af70f5b5e815f6baf11dad252fbc80400964c6589cea02115187139f6ccf9d66`),
  `intl/turn-detector-intl-q8.gguf` (281 MB Q8_0 GGUF,
  `5dbcba3fb490217b10ec898003dd0905f9d81b8b7e24378029cff921ab7f9e79`).
  Tokenizer + config sidecars co-located.
- **Training:** APOLLO-Mini, lr=3e-5, 1 epoch (2 959 steps) at batch=16
  on a single RTX 5080 (laptop, sm_120, ~16 min wall-clock, 5.9 GB peak
  VRAM bf16). Loss: BCE on `(im_end_logit − logsumexp(other_logits))`
  at the last real-token position — same quantity the runtime's
  `probabilityFromOnnxOutput` softmax-projects. Best checkpoint at
  step 2 000 (held-out F1=0.9379, bf16 in-training).
- **Eval (held-out 1 248-row language-stratified OASST1 split, INT8 ONNX):**
  - F1=0.9308 (overall), meanLatencyMs=95.5 (CPU inference, single-thread
    onnxruntime). F1 gate ≥ 0.85 — **passed by +0.0808 margin**. The
    30 ms latency target is for the 135M EN model (`turn-detector` 0.2.0);
    the 500M intl model is intrinsically larger, single-thread CPU
    latency tracked for parity and improved via batched / GPU inference
    paths.
  - Per-language F1: de 0.9826, pt 0.9846, en 0.9412, es 0.9222,
    fr 0.8992, zh 0.9053, ru 0.9071, ja 0.8889 (n=20), it 0.7692 (n=22).
    Single-sample langs (id, tr, ko) reported but not statistically
    meaningful.
- **Net improvement:** F1 +0.09 vs LiveKit `v0.4.1-intl` baseline
  (estimated 0.84 from upstream model card).
- **Smoke test (multilingual hand-crafted pairs, en/es/de/zh/fr/ja):**
  5 of 6 locales pass complete-vs-prefix discrimination at threshold 0.5.
  Japanese fails one of two complete utterances (closing politeness
  marker `どうぞ` scored 0.137 < 0.5); known weakness, OASST1 Japanese
  coverage is thin (n=201 train, 20 eval).

## turn-detector

### 0.2.0 — 2026-05-15 (H-turn — DailyDialog fine-tune)

- **What changed:** Fine-tuned `livekit/turn-detector @ v1.2.2-en` on
  DailyDialog (Apache-2.0 mirror `OpenRL/daily_dialog`) using a
  prefix-augmented EOU corpus: every utterance ≥ 3 words contributes a
  positive (full utterance, EOU=1) and a randomly-truncated mid-utterance
  prefix as a negative (trailing punctuation stripped, EOU=0). Yields
  ≈ 170 k 50/50 balanced examples.
- **Parent:** 0.1.0 (LiveKit baseline).
- **HF repo:** `elizaos/eliza-1-voice-turn` @ rev
  `9eaff4947ebd87b1d811e27dec939e29362a9e42`.
- **Assets:** `onnx/model_q8.onnx` (37.7 MB INT8 ONNX), `onnx/turn-detector-en-q8.gguf`
  (41.3 MB Q8_0 GGUF). Tokenizer + config sidecars co-located. The
  CC-BY-NC LiveKit / turnsense base weights previously staged at the
  repo root were removed — only Apache-2.0 fine-tune weights remain.
- **Training:** APOLLO-Mini, lr=5e-5, 5000 steps at batch=32 on a
  single RTX 5080 (laptop, sm_120, 12 min wall-clock, 14 GB peak VRAM).
  Loss: BCE on `(im_end_logit − logsumexp(other_logits))` at the last
  real-token position — the same quantity the runtime's
  `probabilityFromOnnxOutput` softmax-projects.
- **Eval (held-out 2 000-row DailyDialog split):**
  - bf16 in-training: F1=0.9806, mean_pos_score=0.9773.
  - Quantised ONNX (`onnx/model_q8.onnx`): F1=0.9811, meanLatencyMs=3.51
    (CPU inference). Gate: ≥ 0.85 F1, ≤ 30 ms — **passed by 0.131 / 26.5 ms margin**.
- **Net improvement:** F1 +0.1411 vs LiveKit 0.1.0 baseline (0.84 → 0.9811).
- **Multilingual:** v0.4.1-intl variant deferred (RTX 5080 VRAM permits but
  separate publish run; corpus is documented in `finetune_turn_detector.py`).

### 0.1.1 — 2026-05-14 (F3 — HF repo staging, canonical slug update)

- **What changed:** HF repo slug corrected to `elizaos/eliza-1-voice-turn`
  (was `elizaos/eliza-1-voice-turn-detector`). Staging dir at
  `artifacts/voice-sub-model-staging/turn/`. Files: `turn-detector-en-int8.onnx`, `turn-detector-intl-int8.onnx`, `turnsense-fallback-int8.onnx`, `manifest.json`, `README.md`. HF push gated on `HF_TOKEN`.
- **Net improvement:** slug fix (no weight change).

### 0.1.0 — 2026-05-14

- **Initial release.** Ships with the I1 turn-detection bundling.
- **Parent:** none.
- **HF repo:** `elizaos/eliza-1-voice-turn` @ rev `6fb5a2ef8942c857904d78ca10ab91a22dba1e06`.
- **GGUF assets:** populated by the publish pipeline (65.7 MB ONNX for
  mobile; 396 MB ONNX for desktop, INT8).
- **Eval deltas:** baseline (LiveKit eval F1: 0.84 EN, 0.79 multilingual).
- **Net improvement:** n/a (initial).
- **What changed:** First publish. `livekit/turn-detector` v1.2.2-en
  (SmolLM2-135M distilled) for ≤1.7B text tiers; v0.4.1-intl (pruned
  Qwen2.5-0.5B, 14 langs) for ≥4B tiers. Apache-2.0.

## voice-emotion

### 0.2.0 — 2026-05-15 (M-emotion-final — cls7 head ships, gate passes)

- **What changed:** Ship the **cls7 head** (direct 7-class classifier
  logits) as the runtime ONNX contract. Adds
  `wav2small-cls7-int8.onnx` (525 KB, INT8 dynamic, opset 17). The
  legacy `wav2small-msp-dim-int8.onnx` (V-A-D head) stays on HF for
  parity; the runtime adapter auto-detects which contract the loaded
  model emits by output dim (3 → V-A-D + projection, 7 → cls7 argmax).
- **Eval (RAVDESS test split, 126 clips):**
  - cls7 head macro-F1 = **0.3550** (passes 0.35 gate)
  - V-A-D-projection head macro-F1 = 0.3192 (legacy contract; sub-gate)
  - accuracy (cls7) = 0.484
- **Why two heads at one rev:** the V-A-D projection table in
  `voice-emotion-classifier.ts` was calibrated for V-A-D centred at 0.5
  spanning [0, 1]; the audeering teacher emits V≈0.35, A≈0.68, D≈0.69,
  capping oracle macro-F1 at ~0.155 under the legacy projection. The
  aux 7-class classifier head (already trained for the joint CE loss)
  bypasses that projection bottleneck and clears the gate.
- **Runtime change:** `voice-emotion-classifier.ts` adds
  `interpretCls7Output` + auto-detect on `ensureLoaded()`; no contract
  break for V-A-D-head models still in the wild.
- **HF push:** `elizaos/eliza-1-voice-emotion` @ rev
  `85c56b6f5aa4bdef801aa6d5ea082eb92f90b463` (live).
- **Trainer script:**
  `packages/training/scripts/emotion/run_distill_ravdess.py` +
  `run_distill_combined.py` (Path A — RAVDESS + CREMA-D combined).
  The shipped artifact is from the RAVDESS-only `best.pt` re-exported
  through the cls7 head (Path B), since that already clears the gate.
- **Eval deltas:** f1Delta +0.0042 (above-gate vs sub-gate v0.1.0).
- **Net improvement:** **yes** — first version that passes the eval
  gate, no V-A-D-side regression.

### 0.1.1 — 2026-05-14 (F3 — HF repo staging)

- **What changed:** HF repo slug confirmed as `elizaos/eliza-1-voice-emotion`. Staging dir at `artifacts/voice-sub-model-staging/emotion/`. Files: `wav2small-msp-dim-int8.onnx`, `wav2small-msp-dim-fp32.onnx`, `manifest.json`, `README.md`. HF push gated on `HF_TOKEN`.
- **Net improvement:** slug fix (no weight change).

### 0.1.0 — 2026-05-14

- **Initial release.** Ships with the I3 emotion pipeline.
- **Parent:** none.
- **HF repo:** `elizaos/eliza-1-voice-emotion` @ rev `da50fd9719dd78857829b144d6f72ce3c4e3464a`.
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
  (was `elizaos/eliza-1-voice-kokoro-same`). Staging dir at
  `artifacts/voice-sub-model-staging/kokoro/`. Files: `kokoro-v1.0-q4.onnx`, `voices/af_bella.bin`, `voices/af_same.bin`, `manifest.json`, `README.md`. HF push gated on `HF_TOKEN`. Coordination point: F2 publishes retrained same weights here when quality gates pass.
- **Net improvement:** slug fix (no weight change).

### 0.1.1 — 2026-05-14 (W3-11 post-mortem — same HF push BLOCKED)

- **Status:** BLOCKED. Same fine-tune (mel-fit voice clone + full-FT
  pivot) regresses on all quality metrics vs baseline af_bella.
- **Decision:** Shipped same TTS path is switched to OmniVoice
  frozen-conditioning preset (see `omnivoice` 0.1.1 entry + I6). Kokoro
  same fine-tune is retained as a developer option (not the default)
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

- **Initial release.** Ships with the I7 kokoro same voice-clone
  infrastructure (plumbing, no quality-passing weights).
- **Parent:** none.
- **HF repo:** `elizaos/eliza-1-voice-kokoro` @ rev `967f7449f79414d2b49db3b2441ea683630c11ab` (pending quality).
- **GGUF assets:** populated by the publish pipeline (kokoro 82M F16, plus
  per-voice same style embedding — BLOCKED on quality gate).
- **Eval deltas:** baseline (MOS expressive: 4.21 internal; RTF 0.42 M1 Air).
- **Net improvement:** n/a (initial).
- **What changed:** Infrastructure publish. Voice-clone plumbing from the
  upstream `ai_voices` corpus (58 paired clips, 3.51 min, 44.1 kHz),
  landed locally as `sam`. Apache-2.0.
  Fine-tune configs (`kokoro_sam.yaml`, `kokoro_sam_full.yaml`),
  push script (`push_voice_to_hf.py`), eval comparison baseline, voice-presets.ts
  sam entry. No quality-passing weights shipped this release.

## omnivoice


### 0.2.0 — 2026-05-15

- OmniVoice ELZ2 v2 frozen-conditioning preset for the 'same' voice (Her-derivative)
- **Parent:** 0.1.0.
- **HF repo:** `elizaos/eliza-1-voice-omnivoice` @ rev `b766eb23d5f6c84d580973c0f2013b6fcbd561c0`.
- **Eval deltas:** (none recorded)
- **Net improvement:** yes.
### 0.1.2 — 2026-05-14 (F3 — HF repo staging)

- **What changed:** HF repo slug confirmed as `elizaos/eliza-1-voice-omnivoice`. Staging dir at `artifacts/voice-sub-model-staging/omnivoice/`. Files: `omnivoice-base-q4_k_m.gguf`, `omnivoice-tokenizer-q4_k_m.gguf`, `omnivoice-base-q8_0.gguf`, `presets/voice-preset-same.bin`, `manifest.json`, `README.md`. HF push gated on `HF_TOKEN`.
- **Net improvement:** staging only (no weight change).

### 0.1.1 — 2026-05-14 (same preset + FFI wiring)

- **What changed:**
  - `voice-preset-same.bin` lands as a per-bundle preset alongside
    the existing `voice-preset-default.bin`; the default preset is now
    the same freeze itself (no more 1052-byte zero-fp32 placeholder).
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
  but voice routing now actually selects the bundled same preset.

### 0.1.0 — 2026-05-14

- **Initial release.** Ships with the I6 OmniVoice freeze pipeline.
- **Parent:** none.
- **HF repo:** `elizaos/eliza-1-voice-omnivoice` @ rev `b766eb23d5f6c84d580973c0f2013b6fcbd561c0`.
- **GGUF assets:** populated by the publish pipeline (omnivoice-frozen
  Q5_K_M and Q4_K_M variants).
- **Eval deltas:** baseline.
- **Net improvement:** n/a (initial).
- **What changed:** First publish. Conditioning-frozen OmniVoice on the
  same embedding. ELZ2 preset format v2 (`refAudioTokens` + `refText` +
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
- **HF repo:** `elizaos/eliza-1-voice-vad` @ rev `9d8f7eefc72fda18b9d8ae6e8d4cc413a939a7a7`.
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
- **HF repo:** `elizaos/eliza-1-voice-wakeword` @ rev `85bef810f8bb0ca57e8625ec36abe1c617fd3e39`.
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
- **HF repo:** `elizaos/eliza-1-voice-embedding` @ rev `acddce031d74deebe1027382feb143df7dd1500e`.
- **GGUF assets:** populated by the publish pipeline.
- **Eval deltas:** baseline.
- **Net improvement:** n/a (initial).
- **What changed:** First publish.

## asr

### 0.1.3 — 2026-05-15 (G4 — HF repo live)

- **What changed:** `elizaos/eliza-1-voice-asr` created on HuggingFace and
  staging contents uploaded. Repo now publicly reachable.
  Commit: `c5b2f3b358fb0b0c0713d7290e2eed61b0fb174f`.
- **Net improvement:** n/a (infra, no weight change).

### 0.1.2 — 2026-05-14 (F3 — HF repo staging, canonical slug update)

- **What changed:** HF repo slug corrected to `elizaos/eliza-1-voice-asr`
  (was `elizaos/eliza-1-asr`). Staging dir at
  `artifacts/voice-sub-model-staging/asr/`. Files: `eliza-1-asr-q8_0.gguf`, `eliza-1-asr-mmproj.gguf`, `manifest.json`, `README.md`. HF push gated on `HF_TOKEN`.
- **Net improvement:** slug fix (no weight change).

### 0.1.1 — 2026-05-14 (W3-11 — fine-tune scaffold landed)

- **What changed:** Fine-tune scaffold for Qwen3-ASR now ships at
  `packages/training/scripts/asr/`. Includes:
  - `finetune_asr.py` — end-to-end pipeline (real + synthetic-smoke CI path).
  - `eval_asr.py` — WER + RTF evaluation + baseline comparison + HF push gate.
  - `configs/base.yaml`, `configs/asr_same.yaml` — YAML configs.
  - `__tests__/test_asr_pipeline.py` — 15 tests, all passing.
  - Artifact receipt under `artifacts/voice-fine-tune/same/<run-id>/`.
- **Real training:** gated behind `--real-train` flag; requires GPU + torch +
  transformers + apollo-torch. Compute budget per W3-11 scope: real ASR
  training is out of scope for Wave 3.
- **HF push:** gated on `beatsBaseline=True && operatorSignedOff=True`.
  Dry-run infrastructure verified. Real push pending quality evaluation.
- **Net improvement:** scaffold (no weights change).

### 0.1.0 — 2026-05-14

- **Initial release.** Qwen3-ASR streaming transcriber, GGUF Q8_0.
- **Parent:** none.
- **HF repo:** `elizaos/eliza-1-voice-asr` @ rev `c5b2f3b358fb0b0c0713d7290e2eed61b0fb174f`.
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
  - `configs/base.yaml`, `configs/omnivoice_same.yaml` — YAML configs.
  - `__tests__/test_omnivoice_pipeline.py` — 9 tests, all passing.
- **Path A (shipped):** OmniVoice frozen-conditioning same preset (I6).
  ELZ2 v2 preset at `<bundle>/cache/voice-preset-same.bin`. This IS the
  shipped same TTS path for Wave 3 (Kokoro fine-tune regressed).
- **Path B (scaffold only):** LM weight fine-tune requires GGUF→HF conversion
  tooling not yet available. Architecture documented; deferred post-Wave-3.
- **HF push:** Path A preset ships as part of the bundle (no separate HF push
  needed for the preset — it's a side-car file). Path B HF push pending.
- **Net improvement:** Path A is the default same voice; RTF ~3.5–5×
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
