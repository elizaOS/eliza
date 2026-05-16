# ASR Bench Non-Publish Structure Fixture

This directory is a deterministic corpus-shape fixture for the ASR WER workflow.
The WAV files are short generated tones, not speech and not TTS. They only prove
that five WAV+.txt pairs can be carried through scripts without downloading
models.

Do not use this directory as publish evidence. The 0_8b ASR WER publish gate
requires at least five explicit real microphone or field recordings with matching
transcripts, run through:

```sh
bun plugins/plugin-local-inference/native/verify/asr_bench.ts \
  --bundle ~/.eliza/local-inference/models/eliza-1-0_8b.bundle \
  --wav-dir <real-recorded-wav-txt-dir> \
  --real-recorded \
  --min-real-recorded-utterances 5
```
