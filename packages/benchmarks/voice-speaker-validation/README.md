# Voice Speaker Validation

W3-6 multi-speaker audio validation benchmark for the elizaOS voice pipeline. Tests the
diarization, speaker identification, entity creation, LRU cache latency, async profile
search, and deterministic voice-profile lifecycle gates for `plugin-local-inference`'s
`OmniVoice` stack.

The diarizer uses energy-based VAD + SpeechBrain ECAPA-TDNN clustering (no Hugging Face
token required). Production targets pyannote; thresholds are documented per test file.

## Quick Start

```bash
# Install dependencies
pip install -e .

# Run full suite (requires audio fixtures in fixtures/)
pytest tests/ -v

# Generate deterministic synthetic WAV fixtures explicitly
python fixture_generator.py

# Run a single module
pytest tests/test_diarization.py -v

# Run the #12493 single-stream artifact gate without WAV fixtures/model downloads
pytest tests/test_single_stream_gate.py -v

# Run the no-audio lifecycle gate from #12494
pytest tests/test_voice_profile_lifecycle.py -v
python voice_profile_lifecycle.py
```

See [AGENTS.md](AGENTS.md) for the full layout, per-module commands, and notes on
fixture generation and artifact output.
