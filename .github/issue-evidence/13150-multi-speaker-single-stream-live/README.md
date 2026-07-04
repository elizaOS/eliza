# Issue 13150 - Synthetic Voice Speaker Validation Evidence

## Scope

This run makes the documented f1-f5 live-audio benchmark path reproducible from
the checkout. The WAV files are generated locally by
`packages/benchmarks/voice-speaker-validation/fixture_generator.py`; the
SpeechBrain ECAPA encoder, VAD segmenter, clustering, speaker-ID, Jill entity
creation, cache, async search, and deterministic single-stream artifact gate all
run against those generated fixtures.

This is not the full parent-issue room-mic corpus: it does not include 5-speaker
or 8-speaker WAV captures, production pyannote output, or human-reviewed real
meeting audio/video. The production-stack tests are still skipped without that
live stack.

## Validation

From `packages/benchmarks/voice-speaker-validation`:

```bash
uv venv -p python3.12 .venv
uv pip install -p .venv/bin/python -e .
.venv/bin/python fixture_generator.py --force
W3_6_RUN_ID=issue-13150-live-synthetic .venv/bin/python -m pytest tests/ -q
```

Result:

```text
43 passed, 7 skipped in 43.33s
```

The skipped tests are `tests/test_diarization_production.py`, which requires the
live production diarization stack.

## Evidence Files

- `fixture-manifest.json` - ground-truth fixture definitions.
- `fixture-review.json` - generated WAV duration, hash, RMS, peak, and segment summary.
- `fixture-waveforms.svg` - waveform/contact-sheet review for f1-f5.
- `diarization.json` - detected speaker counts, segments, accuracy, and DER.
- `speaker-id.json` - ECAPA intra/inter-cluster cosine report.
- `entity-graph.json` - Jill scenario entity and relationship artifact.
- `latency-report.json` - async speaker search and owner LRU cache metrics.
- `single-stream-gate.json` - deterministic #12493 2/3/5/8 scenario gate output.
