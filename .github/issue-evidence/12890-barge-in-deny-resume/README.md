# Issue #12890 evidence: speaker-gated barge-in and deny-resume continuity

## Summary

- Added an optional `BargeInInterruptGate` to the barge-in controller. Confirmed ASR words still hard-stop by default, but a gate can now deny self-echo/bystander speech and resume TTS instead.
- Threaded transcript and speaker evidence through `VoiceTurnController` into the barge-in gate.
- Added deny-resume scheduler coverage proving a denied self-echo resumes exactly the buffered audio without cancelling TTS, replaying audio, or skipping buffered samples.
- Wake-word evidence remains authoritative and can hard-stop even when the gate denies ordinary speech.

## Verification

- `bunx biome check plugins/plugin-local-inference/src/services/voice/types.ts plugins/plugin-local-inference/src/services/voice/barge-in.ts plugins/plugin-local-inference/src/services/voice/barge-in.test.ts plugins/plugin-local-inference/src/services/voice/turn-controller.ts plugins/plugin-local-inference/src/services/voice/turn-controller.test.ts plugins/plugin-local-inference/src/services/voice/voice.test.ts`
  - Passed.
- `bun test plugins/plugin-local-inference/src/services/voice/barge-in.test.ts plugins/plugin-local-inference/src/services/voice/turn-controller.test.ts plugins/plugin-local-inference/src/services/voice/voice.test.ts`
  - Passed: 75 tests, 0 failed.
- `bun test plugins/plugin-local-inference/src/services/voice/e2e-harness.test.ts plugins/plugin-local-inference/src/services/voice/workbench-headless-runner.test.ts plugins/plugin-local-inference/src/services/voice/workbench-logic-services.test.ts`
  - Passed: 45 tests, 0 failed.
  - Covers `scoreBargeInInterruption`, `scorePauseContinuation`, `scoreBargeInGating`, echo rejection, ERLE, and the speaker-gated workbench scenario.
- `bun run --cwd plugins/plugin-local-inference typecheck`
  - Passed.
- `bun run --cwd plugins/plugin-local-inference voice:workbench --mock --out ../../.github/issue-evidence/12890-barge-in-deny-resume/workbench-mock`
  - Passed: 24 ran, 0 skipped.
  - `speaker-gated-barge-in` passed.
  - Barge-in gating accuracy: 1.0; cancel latency: 120 ms.
  - Echo rejection rate: 1.0; ERLE: 24 dB.
- `bun run --cwd plugins/plugin-local-inference voice:workbench --logic --out ../../.github/issue-evidence/12890-barge-in-deny-resume/workbench-logic`
  - Passed: 24 ran, 0 skipped.
  - `speaker-gated-barge-in`, `echo-self-trigger`, `echo-mistranscribed`, and `desktop-aec-echo` passed.
  - Barge-in gating accuracy: 1.0; cancel latency: 120 ms.
  - Echo rejection rate: 1.0.

## Real-audio lane

- `bun run --cwd plugins/plugin-local-inference voice:workbench --real --out ../../.github/issue-evidence/12890-barge-in-deny-resume/workbench-real`
  - N/A in this checkout: missing `ELIZA_ASR_BUNDLE` at `/Users/shawwalters/.eliza/local-inference/models/eliza-1-2b.bundle`.
  - No real-audio report was produced because the workbench exits before running without that local model artifact.

