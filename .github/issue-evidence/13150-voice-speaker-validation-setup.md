# Issue 13150 - Voice Speaker Validation Setup Evidence

## Scope

This change repairs the documented editable install path for
`packages/benchmarks/voice-speaker-validation` so the benchmark dependencies can
load before the live audio evidence run.

## Validation

- `python3 -m pip install -e .`
  - Before the fix, setuptools failed to load the invalid backend
    `setuptools.backends.legacy:build`.
  - After switching to `setuptools.build_meta` and declaring the flat-layout
    modules explicitly, editable install succeeds.
- `python3 - <<'PY' ... import torch, torchaudio, speechbrain ... PY`
  - `torch 2.4.1`
  - `torchaudio 2.4.1`
  - `speechbrain 1.1.0`
- `python3 -m pytest tests/test_single_stream_gate.py -q`
  - 6 passed.
- `git diff --check`
  - clean.

## Remaining Blocker

`python3 -m pytest tests/test_diarization.py -q` now gets past dependency
imports and SpeechBrain model loading, then fails because the benchmark fixture
WAV files referenced by `fixtures/manifest.json` are absent from the checkout:

- `fixtures/f1_sam_solo.wav`
- `fixtures/f2_two_speaker.wav`
- `fixtures/f3_three_speaker.wav`
- `fixtures/f4_long_dialogue.wav`
- `fixtures/f5_jill_scenario.wav`

The live multi-speaker evidence requested by issue #13150 still requires those
audio fixtures or an approved replacement corpus.
