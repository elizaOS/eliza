# Issue 13358 - VoiceCodeBench Exact-Token ASR Gate

## Scope

Added `packages/training/scripts/asr/voice_code_bench_gate.py`, a pure-Python
VoiceCodeBench runtime-download contract and metric helper for exact
structured-token ASR recovery. Raw audio remains outside git.

## Source Review

Hugging Face `besimple-ai/voice-code-bench` checked on 2026-07-04:

- Task: Automatic Speech Recognition.
- Modalities: audio, tabular, text.
- License: MIT.
- Dataset size: default subset, test split, 300 rows.
- Observed fields include `audio_id`, `duration`, `domain`, `scenario`,
  `difficulty`, `transcripts`, `entities`, `entity_types`, and `entity_count`.

## Validation

- `pytest packages/training/scripts/asr/__tests__/test_voice_code_bench_gate.py -q`
- `python -m compileall packages/training/scripts/asr/voice_code_bench_gate.py`
- `git diff --check`

## Evidence Boundary

This PR adds the gate contract and deterministic metric math only. #13358 still
requires a real ASR/Eliza-1 run over downloaded VoiceCodeBench rows with source
revision, row count, content hashes, provider/model metadata, score JSON, logs,
and manually reviewed failures before any score is publishable.
