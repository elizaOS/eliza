# Voice Speaker Validation

W3-6 multi-speaker audio validation benchmark for the elizaOS voice pipeline. Tests the
diarization, speaker identification, entity creation, LRU cache latency, and async profile
search components of `plugin-local-inference`'s `OmniVoice` stack against five synthetic
audio fixtures spanning 1–3 speakers.

The diarizer uses energy-based VAD + SpeechBrain ECAPA-TDNN clustering (no Hugging Face
token required). Production targets pyannote; thresholds are documented per test file.

## Quick Start

```bash
# Install dependencies
pip install -e .

# Run full suite (requires audio fixtures in fixtures/)
pytest tests/ -v

# Run a single module
pytest tests/test_diarization.py -v
```

See [AGENTS.md](AGENTS.md) for the full layout, per-module commands, and notes on
fixture generation and artifact output.
