# #9958 Android Native Bridge Matrix Refresh

Command:

```bash
bun run voice:matrix -- --run --platform android --out .github/issue-evidence/9958-voice-matrix-android-native-run
```

Result:

- `pass=2`
- `fail=0`
- `pending=0`
- `skip=2`

Manual review:

- Reviewed `voice-matrix.json`; Android TalkMode and Swabble native bridge
  Gradle contracts passed, with both command executions exiting 0.
- Reviewed `voice-matrix.md`; the selected Android bridge rows match the JSON
  pass counts.
- Reviewed `index.html`; it renders the same bridge pass rows and the refreshed
  strict Stage-B missing-report skip.

This is native bridge contract evidence, not Android device voice-roundtrip
coverage. `android.device.voice-roundtrip` remains an explicit hardware skip
until a current APK/device runner is available.
