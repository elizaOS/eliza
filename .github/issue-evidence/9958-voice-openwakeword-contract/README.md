# Issue 9958 openWakeWord Evidence Contract

This bundle proves the `wake.openwakeword.real-head` matrix cell no longer runs a
broad workbench command as a stand-in for real wake-context evidence.

Command:

```bash
bun run voice:matrix -- --run --platform wake.openwakeword.real-head --out .github/issue-evidence/9958-voice-openwakeword-contract
```

Result:

- `pass=0`
- `fail=0`
- `pending=0`
- `skip=1`

The skip is expected on this host because `ELIZA_VOICE_OPENWAKEWORD_REPORT` is
not set. A future hardware run must provide a reviewed report using schema
`eliza_voice_openwakeword_eval_v1` and covering:

- `idle-wake`
- `already-listening-wake-inert`
- `mid-transcription-wake`

Manual review:

- Reviewed `voice-matrix.json`; the selected cell is a skip with the explicit
  missing-report reason and points at `packages/scripts/voice-openwakeword-eval.mjs`.
- Reviewed `voice-matrix.md`; the rendered summary matches the JSON counts.
- Reviewed `index.html`; it renders the same selected cell, dimensions, command,
  and missing-report reason.

This is not live openWakeWord hardware coverage. It is the contract evidence
that prevents the wakeword residual in #9958 from going green without reviewed
real-head artifacts.
