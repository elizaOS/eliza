# #9958 Voice Matrix Full Probe Refresh

Command:

```bash
bun run voice:matrix -- --out .github/issue-evidence/9958-voice-matrix-full-probe
```

Result:

- `pass=0`
- `fail=0`
- `pending=8`
- `skip=8`

Manual review:

- Reviewed `voice-matrix.json`; the full probe now records the strict
  `wake.openwakeword.real-head` validator command and the
  `ELIZA_VOICE_OPENWAKEWORD_REPORT` missing-report skip reason.
- Reviewed `voice-matrix.md`; the rendered table matches the JSON and no longer
  shows the old broad workbench placeholder for openWakeWord.
- Reviewed `index.html`; it renders the same refreshed validator commands and
  explicit missing-report reasons for openWakeWord and Stage-B.
- Reviewed the iOS live row; without `ELIZA_VOICE_IOS_READY=1`, it now says the
  runner must boot an iOS simulator and install the current app build with voice
  assets before capture.

Hardware-unavailable cells remain explicit skips. They are not platform
coverage.
