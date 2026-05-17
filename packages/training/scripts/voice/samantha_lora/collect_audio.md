# Samantha LoRA — Audio Collection Guide

This guide describes the audio corpus you (the operator) need to supply
before running the Samantha LoRA training pipeline. Read it end-to-end
before recording anything.

## What you're producing

A directory of `(WAV, transcript)` pairs that the prep script
(`prep_corpus.py`) ingests. The training script (`train_lora.py`) then
fits a LoRA adapter against the Kokoro-82M base.

The corpus must be:

- **Mono** (single channel). Stereo will be rejected by the prep script.
- **Sample rate ≥ 24 kHz.** The prep script downsamples to 24 kHz (Kokoro's
  native rate). Higher source rates are fine; lower rates are rejected.
- **PCM**, 16-bit signed integer or 32-bit float WAV. Compressed formats
  (mp3, opus, m4a) must be transcoded to WAV first.
- **Single speaker** throughout. No interruptions, no second voices, no
  laughter from another speaker, no background music with vocals.
- **Clean.** Studio-quality is ideal but not required. Acceptable: a quiet
  room with a USB condenser mic. Unacceptable: phone speakerphone, loud
  AC, traffic noise, reverb.

## How much audio

| Tier      | Duration | Quality outcome                                      |
|-----------|----------|------------------------------------------------------|
| Minimum   | 10 min   | LoRA will run; adapter likely thin / under-trained. |
| Decent    | 30 min   | Recognizable Samantha-ish voice; some artifacts.    |
| Good      | 1.5 h    | Community-validated LoRA floor; usable result.       |
| Best      | 3 h+     | Adapter close to a small full fine-tune.            |

The pipeline accepts whatever you give it (down to 10 min) but the eval
gates in `eval_voice.py` will hold the publish path closed for very small
corpora — that is intentional, not a bug.

## What to say

Variety matters more than volume. Aim for:

- **Mix of declaratives, questions, exclamations, and quiet introspection.**
  A flat reading voice produces a flat-sounding adapter.
- **Phonetic coverage.** Read a Harvard sentence list, an LJSpeech
  metadata.csv subset, or rotate through a few public-domain prompts
  (Project Gutenberg). Kokoro is English-only at the canonical voice
  prefix `af_`.
- **Per-utterance length 2–10 seconds.** Anything shorter loses prosody
  context; anything longer risks OOM during prep + slows down training.
- **Natural pauses.** Don't speed-read. The pause distribution is part
  of what the LoRA picks up.
- **No filler words you don't want the voice to learn.** Editing them
  out post-hoc is fiddly.

Avoid:

- Singing, whispering, shouting (Kokoro can't model these well; the LoRA
  will smear other styles toward them).
- Reading numbers or URLs in spelled-out form ("h-t-t-p"). Phonemizer
  handles canonical spelling fine.
- Long monotonic stretches. Kokoro's prosody predictor needs variety.

## File layout you give the pipeline

```
~/samantha-corpus/
├── transcripts.csv          # "id|text" per line, UTF-8, one row per WAV
└── wavs/
    ├── samantha_001.wav
    ├── samantha_002.wav
    └── …
```

Where:

- `id` matches the WAV filename without extension (`samantha_001`,
  `samantha_002`, …). Pipeline assumes alphanumeric + underscore.
- `text` is the **exact** spoken transcript (case-preserved, punctuation
  preserved). The phonemizer is sensitive to punctuation — a missing
  comma changes the trained pause distribution.

Validation script `validate_voice_corpus.py` (alongside this file) checks:

- `transcripts.csv` parses cleanly.
- Every `id` referenced in CSV has a `wavs/<id>.wav`.
- Every WAV in `wavs/` is referenced (no orphans).
- Each WAV is mono, ≥24 kHz, ≥0.5s, ≤30s.
- No transcript is empty / placeholder.
- Total duration meets the minimum floor (10 min).

Run before prep:

    python3 packages/training/scripts/voice/samantha_lora/validate_voice_corpus.py \
        --corpus ~/samantha-corpus

Output ends with `OK: corpus is ready for prep_corpus.py` or a list of
specific failures. Do not run `prep_corpus.py` until validation is green.

## Privacy

Per `packages/training/AGENTS.md` §7, every transcript write path runs
through the privacy filter. The prep script invokes
`packages/training/scripts/privacy_filter_trajectories.py` against the
generated training pairs before writing them. Transcripts containing PII
(names, addresses, phone numbers, etc.) will be redacted in-place — you
will see a warning and the affected utterance will be re-saved with
`[REDACTED_*]` tokens. If you want a clean corpus, scrub PII out of your
spoken content up front.

## Where to put it

Anywhere on disk. Pass the directory to `prep_corpus.py --corpus PATH`.
The training run produces output under `--run-dir` (any path); the
default in `RUNBOOK.md` is `~/eliza-training/samantha-lora-<timestamp>/`.

## Sourcing existing Samantha audio

If you have access to existing Samantha audio (the upstream
`lalalune/ai_voices/samantha` set is 58 clips / 3.5 min, already landed
under `packages/training/data/voice/same/`), pass it directly:

    python3 packages/training/scripts/voice/samantha_lora/prep_corpus.py \
        --corpus packages/training/data/voice/same \
        --run-dir ~/eliza-training/samantha-lora-baseline

The prep script accepts the existing Eliza-1 staged-corpus layout
(`metadata.csv` + `wavs/`) without modification. **3.5 min is below the
LoRA floor**; expect a thin adapter. The pipeline will still run, but
`eval_voice.py` will likely keep the publish gate closed until you add
audio.
