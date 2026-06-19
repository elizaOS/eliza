# Voice Speaker Validation — Agent Guide

W3-6 multi-speaker audio validation benchmark: diarization accuracy, speaker ID
cosine thresholds, entity creation (Jill scenario), owner LRU cache latency, and
async profile search. Not registered in the suite orchestrator — run directly via
pytest.

## Run

```bash
# From this directory — runs the full test suite
pip install -e .
pytest tests/ -v
```

## Test the harness

```bash
pip install -e .
pytest tests/ -v
```

Individual test modules:

```bash
pytest tests/test_diarization.py -v         # DER and speaker-count assertions
pytest tests/test_speaker_id.py -v          # intra/inter cosine thresholds
pytest tests/test_entity_creation.py -v    # Jill scenario end-to-end
pytest tests/test_owner_lru_cache.py -v    # hot-profile latency < 50 ms
pytest tests/test_async_search.py -v       # async profile search
```

## Layout

| Path | Role |
| --- | --- |
| `tests/conftest.py` | SpeechBrain ECAPA-TDNN encoder, energy-VAD diarizer, InMemoryVoiceProfileStore fixtures |
| `tests/test_diarization.py` | DER ≤ 0.45 and speaker-count correctness across all 5 fixtures |
| `tests/test_speaker_id.py` | Intra-cluster cosine ≥ 0.40, inter-cluster ≤ 0.46 (ECAPA-TDNN on TTS) |
| `tests/test_entity_creation.py` | Full Jill scenario: 2 entities, partner_of edge, no duplicates |
| `tests/test_owner_lru_cache.py` | Owner hot-profile lookup latency < 50 ms |
| `tests/test_async_search.py` | Async profile search correctness |
| `tests/test_diarization_production.py` | Production-stack diarization tests (needs live stack) |
| `tests/production_stack.py` | Production stack helpers |
| `fixtures/manifest.json` | Ground-truth segment boundaries for 5 audio fixtures (f1–f5) |
| `pyproject.toml` | Package definition and pytest config |

## Notes

- Fixtures (f1–f5 WAV files) are **not committed** — they must be generated or
  provided before running. The manifest defines expected paths and ground-truth
  boundaries.
- The diarizer in tests uses energy-VAD + ECAPA-TDNN clustering (no Hugging Face
  token required). Production uses pyannote; thresholds differ.
- Artifacts are written to `artifacts/<W3_6_RUN_ID>/` (set env var to name the
  run; defaults to `run-<epoch>`). This directory is gitignored.
- Not registered in `registry/commands.py` — no orchestrator invocation.
- Full background: [README.md](README.md).
