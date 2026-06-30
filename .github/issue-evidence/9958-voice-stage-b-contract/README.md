# #9958 Voice Stage-B Contract Evidence

This evidence slice was captured on the follow-up branch for #9958 after
replacing the Stage-B placeholder command with
`packages/scripts/voice-stage-b-eval.mjs`.

Command:

```bash
bun run voice:matrix -- --run --platform stt.stage-b.evaluation --out .github/issue-evidence/9958-voice-stage-b-contract
```

Result:

- `stt.stage-b.evaluation` is an explicit `skip` on this host.
- The skip reason is that `ELIZA_VOICE_STAGE_B_REPORT` is not set to a reviewed
  iOS + Android + fused ASR Stage-B JSON report.
- This is not platform coverage; it proves the matrix no longer contains the old
  placeholder command and now requires a real report before Stage-B can go green.

Artifacts:

- `voice-matrix.json`
- `voice-matrix.md`
- `index.html`
