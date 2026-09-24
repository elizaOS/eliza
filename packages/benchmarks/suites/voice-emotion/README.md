# elizaos-voice-emotion-bench

Voice-emotion classifier bench harness for elizaOS. Two axes:

1. **Voice (acoustic) classifier intrinsic accuracy** — IEMOCAP / MELD /
   MSP-Podcast. Macro-F1 across the 7-class `EXPRESSIVE_EMOTION_TAGS` set
   (projected from continuous V-A-D where the classifier outputs
   continuous). Primary metric: MELD macro-F1 (closest match to our
   conversational deployment domain).

   Gate (manifest validator: `EMOTION_CLASSIFIER_MELD_F1_THRESHOLD`):
   `macro_f1_meld >= 0.35`. The bar is intentionally low — 7-class
   conversational SER macro-F1 is 0.40-0.50 even for strong models on MELD;
   we set the gate so a real improvement does not get refused.

2. **Text-emotion classifier intrinsic accuracy** — GoEmotions test split,
   projected to the same 7-class Ekman target. Compares the eliza-1 Stage-1
   LM `emotion` field-evaluator (zero-binary option, default) against the
   Roberta-go-emotions ONNX (optional fallback under
   `voice-emotion-text` in `models/voice/manifest.json`).

## Why a separate package

Sibling to `voicebench-quality/`. The audio corpora have requirements
(soundfile, onnxruntime) that the voicebench quality suite does not, so they
ship as a dedicated package the operator can install independently.

## Running locally

```bash
cd suites/voice-emotion
uv pip install -e '.[audio,onnx,test]'

# 1) Intrinsic on a small held-out fixture (CI smoke; the real corpora live
#    under research/NDA terms and are staged by the operator).
voice-emotion-bench intrinsic --suite fixture --model wav2small-msp-dim-int8 \
    --onnx ~/.eliza/local-inference/models/eliza-1-voice-emotion-*.bundle/voice-emotion.onnx

# 2) Text-emotion intrinsic against GoEmotions test split.
voice-emotion-bench text-intrinsic --suite goemotions --model stage1-lm
```

All commands emit a JSON result document and a markdown report.

## Datasets

| Suite | Source | License | Notes |
|---|---|---|---|
| `iemocap` | USC SAIL — request | research-only | 4-class, gold-standard for SER baselines |
| `meld` | github.com/declare-lab/MELD | GPL-3.0 | 7-class dialog emotion (Friends sitcom) — closest match to our domain |
| `msp_podcast` | UTD MSP Lab — NDA | research-only NDA | continuous V-A-D regression, what audeering trains on |
| `fixture` | bundled in this package | Apache-2.0 | tiny smoke set the CI run uses |
| `goemotions` | google-research/goemotions | Apache-2.0 | 28-class text, projected to 7-class |

The corpus loaders read pre-staged manifests with `wav_path` + `label` columns;
the bench does not redistribute any corpus.

## Adapter contract

Two adapter interfaces:

```python
class AcousticEmotionAdapter(Protocol):
    def classify(self, pcm: np.ndarray, sample_rate: int) -> EmotionRead:
        """Run the acoustic classifier on one utterance and return the
        projected 7-class label + soft scores + continuous V-A-D + latency."""

class TextEmotionAdapter(Protocol):
    def classify(self, text: str) -> EmotionRead:
        """Run the text classifier on one utterance and return the projected
        7-class label + soft scores + latency."""
```

Implementations:

- `elizaos_voice_emotion/classifier_adapter.py` — `ClassifierAdapter` loads
  the production Wav2Small cls7 ONNX (or the SUPERB proxy when it is absent)
  and exercises the same 16 kHz mono Float32 contract the TS runtime uses.
- `elizaos_voice_emotion/tts_adapter.py` — synthesis backend (Kokoro /
  MMS-TTS) used by the roundtrip orchestrator in
  `elizaos_voice_emotion/roundtrip.py`.
- Text path: the eliza-1 Stage-1 LM `emotion` field-evaluator (HTTP) and the
  `SamLowe/roberta-base-go_emotions-onnx` head, projected 28 → 7 via
  `elizaos_voice_emotion/projection.py`.

## Output schema

`out.json`:

```json
{
  "schemaVersion": 1,
  "suite": "meld",
  "model": "wav2small-msp-dim-int8",
  "macroF1": 0.37,
  "perClassF1": {
    "happy": 0.42, "sad": 0.51, "angry": 0.38, ...
  },
  "confusion": [[...],[...]],
  "meanLatencyMs": 4.2,
  "n": 1248,
  "runStartedAt": "2026-05-14T02:30:00Z",
  "elapsedSeconds": 12.3
}
```

The publish pipeline (I5) consumes `out.json` and writes the
`evals.emotionClassifier` block in the bundle manifest.
