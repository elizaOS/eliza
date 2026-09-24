# Voice Speaker Validation

W3-6 multi-speaker audio validation benchmark: diarization accuracy, speaker ID cosine thresholds, entity creation (Jill scenario), owner LRU cache latency, and async profile search.

## Development

Use a Python environment matching `pyproject.toml` and install the required dependencies.

No compilation or wheel build is required to run this suite from source.

Test from this directory:

```bash
python -m pytest
```

Production coverage is opt-in: `PRODUCTION_SPEAKER_STACK=1 python -m pytest
tests/test_diarization_production.py`. Stage `VOICE_CLASSIFIER_LIB` and
`VOICE_DIARIZER_GGUF` for the default native backend, or explicitly select
`PYANNOTE_BACKEND=onnx`. Missing assets or inference failures fail an opted-in
run; skipped default cases do not count as production validation.
