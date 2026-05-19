# Cuttlefish agent-smoke fixtures

These fixtures are test data for `agent-smoke-riscv64.sh` and the
`cuttlefish-agent-smoke` mode of `capture-aosp-evidence.sh`. They are
**not** training data, golden inference output, or claim evidence.

| Path | Used by | Notes |
| --- | --- | --- |
| `golden-stt.wav` | Whisper STT smoke | 10 s mono S16_LE 16 kHz speech-band noise. |
| `golden-stt-transcript.txt` | Whisper STT smoke | Reference transcript for token-overlap. |
| `wakeword-stimulus.wav` | wakeword-cpp smoke | 3 s tone burst inside silence. |
| `vad-speech-silence.wav` | silero-vad smoke | 6 s alternating noise + silence. |

Wakeword GGUF (`wakeword.gguf`) is **not** committed; supply one via
`AOSP_AGENT_WAKEWORD_MODEL` or copy it into this directory.

## Reproducible regeneration

```sh
python3 packages/chip/sw/aosp-device/fixtures/scripts/generate_fixtures.py
```

The generator uses a fixed seeded LCG, so re-running produces byte-identical
outputs. Re-commit only when the test contract changes.
