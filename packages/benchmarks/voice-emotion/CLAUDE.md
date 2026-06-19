# Voice-Emotion Bench — Agent Guide

Speech-emotion recognition + closed-loop affect fidelity benchmark for elizaOS.
Three axes: (1) acoustic classifier intrinsic accuracy on IEMOCAP / MELD /
MSP-Podcast (7-class macro-F1, gate `>= 0.35` on MELD), (2) closed-loop emotion
fidelity through the OmniVoice TTS + ASR + classifier duet pipeline, (3) text
emotion classifier accuracy on GoEmotions projected to the same 7 Ekman classes.
Not registered in the suite orchestrator registry — driven directly via the
`voice-emotion-bench` CLI.

## Run

```bash
# Install (from this directory)
uv pip install -e '.[audio,onnx,test]'

# 1) Acoustic classifier intrinsic (real corpus — operator must stage ONNX + manifest)
voice-emotion-bench intrinsic --suite meld --model wav2small-msp-dim-int8 \
    --onnx ~/.eliza/local-inference/models/eliza-1-voice-emotion-*.bundle/voice-emotion.onnx \
    --corpus-manifest /path/to/meld-manifest.csv

# 2) Closed-loop fidelity (requires a running eliza-1 duet pair)
voice-emotion-bench fidelity --duet-host http://localhost:31337 \
    --emotions happy,sad,angry,nervous,calm,excited,whisper \
    --rounds 10

# 3) Text-emotion intrinsic on GoEmotions
voice-emotion-bench text-intrinsic --suite goemotions --model stage1-lm

# 4) TTS → audio → classifier roundtrip (W3-5)
voice-emotion-bench roundtrip --tts-backend auto --voice af_bella
```

## Smoke test (no corpora, no API keys)

The `fixture` suite exercises the full metric pipeline against a bundled
14-sample symmetric corpus (macro-F1 == 1.0 by construction):

```bash
voice-emotion-bench intrinsic --suite fixture --model wav2small-msp-dim-int8
voice-emotion-bench text-intrinsic --suite fixture --model stage1-lm
```

## Test the harness

```bash
uv pip install -e '.[test]'
pytest tests/ -v
```

## Layout

| Path | Role |
| --- | --- |
| `elizaos_voice_emotion/__main__.py` | CLI entrypoint (`voice-emotion-bench`) |
| `elizaos_voice_emotion/runner.py` | `run_intrinsic`, `run_fidelity`, `run_text_intrinsic`; fixture corpus |
| `elizaos_voice_emotion/roundtrip.py` | W3-5 TTS → audio → classifier roundtrip |
| `elizaos_voice_emotion/metrics.py` | `macro_f1`, `per_class_f1`, `confusion_matrix` |
| `elizaos_voice_emotion/projection.py` | GoEmotions 28-class → 7-class Ekman projection table |
| `elizaos_voice_emotion/classifier_adapter.py` | `ClassifierAdapter` protocol + adapters |
| `elizaos_voice_emotion/tts_adapter.py` | TTS adapter (Kokoro / MMS-TTS) |
| `elizaos_voice_emotion/vad_projection.py` | V-A-D continuous → 7-class projection |
| `EMOTION_MAP.md` | Canonical 7-class emotion set, VAD corners, pass criteria |
| `tests/` | pytest suite (runner, metrics, projection, roundtrip, real-classifier) |

## Notes

- Results write to `bench-out.json` / `bench-fidelity.json` / `bench-text.json` /
  `bench-roundtrip.json` in the working directory (not gitignored — move them or
  pass `--out` to redirect).
- Roundtrip WAV artifacts write to `artifacts/voice-emotion-roundtrip/<run-id>/`.
- Not registered in `registry/commands.py` — no orchestrator integration yet.
- MELD gate threshold: `macro_f1_meld >= 0.35`; see `EMOTION_MAP.md` §4.
- Full background: [README.md](README.md).
