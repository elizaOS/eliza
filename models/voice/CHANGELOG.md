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
- `kokoro` — Kokoro samantha fine-tuned TTS (R7/I7).
- `omnivoice` — OmniVoice frozen-conditioning TTS (R6/I6).
- `vad` — Silero VAD endpoint detector.
- `wakeword` — `hey-eliza` wake-word head.
- `embedding` — Eliza-1 BPE-vocab embedding tier (gte-base derivative).
- `asr` — Qwen3-ASR streaming transcriber.

---

## speaker-encoder

### 0.1.0 — 2026-05-14

- **Initial release.** Ships with the I2 voice-profile system.
- **Parent:** none.
- **HF repo:** `elizaOS/eliza-1-voice-speaker-encoder` @ rev `TBD`.
- **GGUF assets:** populated by the publish pipeline.
- **Eval deltas:** baseline (EER 0.72% on VoxCeleb1-O).
- **Net improvement:** n/a (initial).
- **What changed:** First publish. Distilled WeSpeaker ResNet34-LM 256-dim,
  ~7 MB int8. CC-BY-4.0.

## diarizer

### 0.1.0 — 2026-05-14

- **Initial release.** Ships with the I2 voice-profile system.
- **Parent:** none.
- **HF repo:** `elizaOS/eliza-1-voice-diarizer` @ rev `TBD`.
- **GGUF assets:** populated by the publish pipeline.
- **Eval deltas:** baseline (DER 12.4% on AMI-headset).
- **Net improvement:** n/a (initial).
- **What changed:** First publish. Pyannote-segmentation-3.0 ONNX int8,
  1.54 MB. MIT.

## turn-detector

### 0.1.0 — 2026-05-14

- **Initial release.** Ships with the I1 turn-detection bundling.
- **Parent:** none.
- **HF repo:** `elizaOS/eliza-1-voice-turn-detector` @ rev `TBD`.
- **GGUF assets:** populated by the publish pipeline (65.7 MB ONNX for
  mobile; 396 MB ONNX for desktop, INT8).
- **Eval deltas:** baseline (LiveKit eval F1: 0.84 EN, 0.79 multilingual).
- **Net improvement:** n/a (initial).
- **What changed:** First publish. `livekit/turn-detector` v1.2.2-en
  (SmolLM2-135M distilled) for ≤1.7B text tiers; v0.4.1-intl (pruned
  Qwen2.5-0.5B, 14 langs) for ≥4B tiers. Apache-2.0.

## voice-emotion

### 0.1.0 — 2026-05-14

- **Initial release.** Ships with the I3 emotion pipeline.
- **Parent:** none.
- **HF repo:** `elizaOS/eliza-1-voice-emotion` @ rev `TBD`.
- **GGUF assets:** populated by the publish pipeline (~120 KB ONNX,
  Wav2Small int8).
- **Eval deltas:** baseline (CCC: V 0.65 / A 0.71 / D 0.43 on MSP-Podcast).
- **Net improvement:** n/a (initial).
- **What changed:** First publish. Wav2Small distilled from
  `audeering/wav2vec2-large-robust-12-ft-emotion-msp-dim`. Continuous V-A-D
  output. Apache-2.0 student weights (teacher is CC-BY-NC-SA-4.0 — not shipped).

## kokoro

### 0.1.0 — 2026-05-14

- **Initial release.** Ships with the I7 kokoro samantha voice-clone.
- **Parent:** none.
- **HF repo:** `elizaOS/eliza-1-voice-kokoro-samantha` @ rev `TBD`.
- **GGUF assets:** populated by the publish pipeline (kokoro 82M F16, plus
  per-voice samantha style embedding).
- **Eval deltas:** baseline (MOS expressive: 4.21 internal; RTF 0.42 M1 Air).
- **Net improvement:** n/a (initial).
- **What changed:** First publish. Voice-embedding clone from the
  `ai_voices/samantha` corpus (58 paired clips, 3.51 min, 44.1 kHz).
  Apache-2.0.

## omnivoice

### 0.1.0 — 2026-05-14

- **Initial release.** Ships with the I6 OmniVoice freeze pipeline.
- **Parent:** none.
- **HF repo:** `elizaOS/eliza-1-voice-omnivoice` @ rev `TBD`.
- **GGUF assets:** populated by the publish pipeline (omnivoice-frozen
  Q5_K_M and Q4_K_M variants).
- **Eval deltas:** baseline.
- **Net improvement:** n/a (initial).
- **What changed:** First publish. Conditioning-frozen OmniVoice on the
  samantha embedding. ELZ2 preset format v2 (`refAudioTokens` + `refText` +
  `instruct`). Apache-2.0.

## vad

### 0.1.0 — 2026-05-14

- **Initial release.** Mirrors the in-tree Silero VAD v5.1.2 weights.
- **Parent:** none.
- **HF repo:** `elizaOS/eliza-1-voice-vad-silero` @ rev `TBD`.
- **GGUF assets:** populated by the publish pipeline.
- **Eval deltas:** baseline.
- **Net improvement:** n/a (initial).
- **What changed:** First publish. Silero VAD v5.1.2 ONNX. MIT.

## wakeword

### 0.1.0 — 2026-05-14

- **Initial release.** `hey-eliza` head (the renamed `hey_jarvis` ONNX).
- **Parent:** none.
- **HF repo:** `elizaOS/eliza-1-voice-wakeword` @ rev `TBD`.
- **GGUF assets:** populated by the publish pipeline.
- **Eval deltas:** baseline (FAR ≤ 0.5/h on quiet office).
- **Net improvement:** n/a (initial).
- **What changed:** First publish.

## embedding

### 0.1.0 — 2026-05-14

- **Initial release.** Eliza-1 BPE-vocab embedding tier (used by the
  voice-profile + speaker LRU cache for query-text features).
- **Parent:** none.
- **HF repo:** `elizaOS/eliza-1-embedding` @ rev `TBD`.
- **GGUF assets:** populated by the publish pipeline.
- **Eval deltas:** baseline.
- **Net improvement:** n/a (initial).
- **What changed:** First publish.

## asr

### 0.1.0 — 2026-05-14

- **Initial release.** Qwen3-ASR streaming transcriber, GGUF Q4_K_M.
- **Parent:** none.
- **HF repo:** `elizaOS/eliza-1-asr` @ rev `TBD`.
- **GGUF assets:** populated by the publish pipeline.
- **Eval deltas:** baseline (WER 6.8% on LibriSpeech test-clean).
- **Net improvement:** n/a (initial).
- **What changed:** First publish.

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
