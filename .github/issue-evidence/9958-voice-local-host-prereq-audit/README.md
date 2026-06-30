# #9958 Local Host Voice Prereq Audit

Generated during the #9958 PR refresh on 2026-06-30 UTC.

This is blocker evidence, not pass evidence. It records the real local host
state after the prereq inspector was tightened to reject placeholder bundle
directories that do not contain the catalog primary text GGUF.

## Commands and Results

```bash
bun run voice:interactive -- --list-active
```

- Output: `voice-interactive-prereq.txt`
- Result: exit 0 status report, but a real interactive turn is unavailable.
- Key finding: `/Users/shawwalters/.local/state/eliza/local-inference/models/eliza-1-2b.bundle`
  exists but is not fully installed because
  `text/eliza-1-2b-128k.gguf` is missing.

```bash
ELIZA_INFERENCE_LIB_DIR=/Users/shawwalters/.local/state/eliza/local-inference/lib \
ELIZA_ASR_BUNDLE=/Users/shawwalters/.eliza/local-inference/models/eliza-1-0_8b.bundle \
ELIZA_KOKORO_MODEL_DIR=/Users/shawwalters/.eliza/local-inference/models/eliza-1-0_8b.bundle/tts/kokoro \
bun run --cwd plugins/plugin-local-inference test:kokoro:real
```

- Output: `kokoro-real-smoke-with-asr.log`
- Exit: `kokoro-real-smoke-with-asr.exit` = `1`
- Key finding: real Kokoro synthesized non-empty 24 kHz PCM, but the ASR
  intelligibility gate failed: transcript was empty, WER `1.00` against
  `Hello, this is a native Kokoro voice test.`

```bash
ELIZA_INFERENCE_LIB_DIR=/Users/shawwalters/.local/state/eliza/local-inference/lib \
LLAMA_LOG_LEVEL=ERROR GGML_LOG_LEVEL=ERROR \
bun -e '<direct ASR fixture probe>'
```

- Output: `asr-direct-fixture-probe.log`
- Exit: `asr-direct-fixture-probe.exit` = `1`
- Key finding: fused ABI v12 loaded and decoded the checked-in fixture
  `utt-01.wav`, but transcript was `The.` for reference
  `turn on the kitchen lights` (`WER 0.8`, `pass: false`).

## Residual Impact

This host cannot honestly certify the remaining #9958 local desktop voice path
yet. The current blockers are missing complete catalog Eliza-1 bundle assets for
the production path and failing ASR correctness on the only staged ASR bundle.
