# Voice Speaker Validation

Multi-speaker audio validation: diarization accuracy, speaker embedding separation, and opt-in production inference. Product entity attribution, profile persistence, LRU, and asynchronous matching are tested by their TypeScript owners in plugin-personal-assistant and plugin-local-inference; Python simulations are not production evidence.

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
