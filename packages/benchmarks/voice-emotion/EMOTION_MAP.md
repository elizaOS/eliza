# Emotion Channel Map — elizaOS voice-emotion roundtrip

> W3-5 deliverable. Documents how emotion labels travel through the voice
> pipeline in both directions: inbound (ASR → classifier → planner) and
> outbound (LM → TTS prosody). Updated when any channel changes.

## 1. Canonical label set

The runtime operates on a **7-class expressive emotion vocabulary** plus the
special `none` sentinel for "no emotion cue". This set is the single source
of truth for all pipeline stages:

| Label | Meaning | V-A-D corner (Plutchik-aligned) |
|---|---|---|
| `happy` | Positive affect, moderate arousal | High V, mid A |
| `sad` | Negative affect, low arousal | Low V, low A |
| `angry` | Negative affect, high arousal, high dominance | Low V, high A, high D |
| `nervous` | Negative affect, mid-high arousal, low dominance | Low V, mid A, low D |
| `calm` | Positive affect, low arousal | High V, low A |
| `excited` | Positive affect, very high arousal | High V, very high A |
| `whisper` | Delivery style (low energy), valence-agnostic | Low A, low D |
| `none` | Sentinel — no expressive cue (field-evaluator default) | — |

**Source files:**
- TypeScript: `plugins/plugin-local-inference/src/services/voice/expressive-tags.ts`
  — `EXPRESSIVE_EMOTION_TAGS` (7-class) + `EXPRESSIVE_EMOTION_ENUM` (8-class with `none`).
- Python bench: `packages/benchmarks/voice-emotion/elizaos_voice_emotion/metrics.py`
  — `EXPRESSIVE_EMOTION_TAGS` tuple (same order, same values).
- Python roundtrip: `packages/benchmarks/voice-emotion/elizaos_voice_emotion/vad_projection.py`
  — `VAD_PROJECTION_TABLE` (coefficients that exactly mirror the TS projection).

---

## 2. Inbound channel — ASR + acoustic emotion

```
mic / file → VAD gate → Qwen3-ASR (transcript)
                              │
                              ▼
                  Wav2Small ONNX (72K params, ~120KB int8)
                              │ input: 16 kHz mono Float32 PCM
                              │ output: continuous V-A-D ∈ [0,1]³
                              │
                              ▼
              projectVadToExpressiveEmotion(vad)
                              │ Plutchik-aligned deterministic projection
                              │ abstains when max score < 0.35
                              │
                              ▼
              VoiceEmotionAttribution  →  TranscriptUpdate.voiceEmotion
                              │
                              ▼
              Memory.metadata.voice.emotion  (persisted)
                              │
                              ▼
              USER_EMOTION_SIGNAL provider  (planner hint, position -5)
```

### Wav2Small model contract

- **Architecture:** LogMel-conv (built into ONNX graph) + small transformer head.
- **Input tensor:** rank-2 `[1, N_samples]`, dtype float32, 16 kHz mono PCM ∈ [-1, 1].
- **Output tensor:** rank-2 `[1, 3]` — (valence, arousal, dominance) ∈ [0, 1].
- **Min samples:** 16,000 (1.0 s). Shorter inputs are rejected.
- **Max samples:** 192,000 (12.0 s). Longer inputs are truncated to trailing window.
- **Distillation source:** `audeering/wav2vec2-large-robust-12-ft-emotion-msp-dim`
  (CC-BY-NC-SA-4.0 teacher — **never bundled**, research-only). Student ships Apache-2.0.
- **Distillation recipe:** `packages/training/scripts/emotion/distill_wav2small.py`.
- **Production slots:** `models/voice/manifest.json` → `voice-emotion` (int8 + fp32 variants).

### V-A-D → 7-class projection

The projection is **deterministic** and identical in TS and Python:

```
v, a, d = clamp(vad, 0, 1)
vC, aC, dC = v - 0.5, a - 0.5, d - 0.5

happy   = clamp(vC*1.4 + max(0,aC)*0.6 - |dC|*0.4,  0, 1)
excited = clamp(vC*0.9 + aC*1.6,                     0, 1)
calm    = clamp(max(0,vC)*1.4 - aC*1.2 - |dC|*0.3,  0, 1)
sad     = clamp(-vC*1.4 - aC*0.8 - dC*0.4,          0, 1)
angry   = clamp(-vC*1.1 + aC*1.2 + dC*1.0,          0, 1)
nervous = clamp(-vC*0.7 + aC*0.9 - dC*1.2,          0, 1)
whisper = clamp(-aC*1.4 - dC*1.4,                   0, 1)

best = argmax(scores)
confidence = scores[best]
if confidence < 0.35: abstain (return None)
```

**Abstention rate** is tracked separately from accuracy — a classifier that
abstains on hard inputs is preferable to one that force-maps everything.

---

## 3. Outbound channel — LM → TTS prosody

### Stage-1 LM emotion field-evaluator

The LM emits an `emotion` enum field (one of `EXPRESSIVE_EMOTION_ENUM`) via
the structured-decode field-evaluator registered in
`packages/core/src/runtime/builtin-field-evaluators.ts`. This is the
**text-side** emotion signal — what the LM *intends* the TTS to sound like.

### TTS prosody backends

| Backend | Emotion input mechanism | Notes |
|---|---|---|
| **OmniVoice** (primary) | `instruct` string keyword (`happy`, `sad`, etc.) | Real inference-time conditioning. `plugins/plugin-omnivoice/src/synth.ts:30-33` wires `design.emotion` → `instruct`. |
| **OmniVoice singing GGUF** | Inline tags `[happy]`, `[sad]`, etc. in the text | Tags parsed by the GGUF at inference time. `parseExpressiveTags` passes them through. |
| **Kokoro 82M** | **No inference-time emotion arg** — text-side prosody hint only | The ONNX signature `(input_ids, style, speed)` has no emotion parameter. Prosody is induced via emotionally-loaded text and speed variation. Per-emotion style vectors are an I7 (kokoro fine-tune) deliverable. |
| **ElevenLabs** | `voice_settings.style` float [0, 1] | `SpeakTask.emotion?: Emotion` maps to style. |
| **MMS-TTS (facebook/mms-tts-eng)** | No emotion control | Neutral baseline TTS. Used in the roundtrip bench as a reference path when Kokoro/OmniVoice is unavailable. |

### Kokoro prosody-prompt workaround (text-side hints)

Since Kokoro has no inference-time emotion argument, the roundtrip bench
synthesizes emotion-conditioned audio using:

1. **Emotionally-loaded text** — vocabulary with strong affective content.
2. **Speed variation** — correlates with arousal (fast → excited/angry, slow → sad/calm).
3. **Prosody text prefixes** — `[happy]`, `[sad]`, etc. are NOT parsed by the
   Kokoro ONNX model (it does not understand them). They are included in the
   text as documentation of intent, and the actual acoustic variation comes
   from (1) and (2).

This is documented as a limitation. The I7 (kokoro fine-tune) deliverable will
train per-emotion style vectors so Kokoro can express affect at synthesis time.

---

## 4. Roundtrip validation design

The closed-loop test (`tests/test_emotion_roundtrip.py`) validates:

```
intended_emotion  →  TTS (text-side prosody hint)  →  audio WAV
       ↓                                                   ↓
  ground truth                                  acoustic classifier
       ↓                                                   ↓
  comparison  ←──────────────── perceived_emotion  ←──────┘
```

### Classifier used in roundtrip bench

The runtime ships **Wav2Small** (ONNX, distilled). When the ONNX is not
available (e.g. before distillation completes), the bench uses
`superb/wav2vec2-base-superb-er` (IEMOCAP 4-class) as a **proxy classifier**
for the VAD-projection smoke path, OR runs the **pure Python VAD projection**
test with known synthetic V-A-D inputs.

The proxy classifier label mapping:

| SUPERB label | EXPRESSIVE_EMOTION_TAGS target |
|---|---|
| `neu` | `calm` |
| `hap` | `happy` |
| `ang` | `angry` |
| `sad` | `sad` |

`excited`, `nervous`, and `whisper` have no direct SUPERB equivalent —
they are tested via the VAD projection path only.

### Pass criteria

| Metric | Threshold | Notes |
|---|---|---|
| Top-1 match rate (over testable subset) | ≥ 2 / 4 basic emotions (50%) | Kokoro acoustic variation is limited; this is the practical baseline. |
| VAD projection correctness | 100% on 7 known-corner synthetic inputs | Unit test, not acoustic. |
| Pipeline smoke (real audio) | All labels produce a classification (no crash) | End-to-end execution. |
| Artifact emission | `artifacts/voice-emotion-roundtrip/<run-id>/*.wav` + `predictions.json` | Written by the bench. |

When the real Wav2Small ONNX is available, the gate tightens to the
manifest's `EMOTION_CLASSIFIER_MELD_F1_THRESHOLD = 0.35` and
`EMOTION_CLASSIFIER_IEMOCAP_F1_THRESHOLD = 0.60`.

---

## 5. Privacy and biometric handling

Voice emotion data is biometric-adjacent. Every write path that carries
`Memory.metadata.voice.emotion` must pass through the privacy filter
(`plugins/app-training/src/core/privacy-filter.ts`) before export. The
filter preserves the structural emotion metadata block for non-private users
and redacts only string PII in sibling fields. This is pinned by a test in
`plugins/app-training/test/privacy-filter.test.ts`.

---

## 6. Coordination notes

| Agent | Dependency |
|---|---|
| **W3-4** (OmniVoice simplify) | Confirm `emotion` remains an explicit input to OmniVoice synthesis (not baked into per-emotion profiles only). Current: `instruct` string carries it — roundtrip bench assumes this interface is stable. |
| **W3-11** (kokoro fine-tune) | Per-emotion style vectors for Kokoro. When delivered, the roundtrip match rate for Kokoro utterances should exceed 70% — re-run the bench after I7 lands. |
| **I3** (emotion impl) | All runtime types and channels are I3-delivered. W3-5 consumes them without modifying. |
| **I5** (versioning) | `evals.emotionClassifier` block in the manifest must be populated from a `run_intrinsic` output before strict-release gate passes. |
