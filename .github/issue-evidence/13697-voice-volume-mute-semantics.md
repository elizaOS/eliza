# Evidence — #13697 voice volume/mute semantics

## What changed

- Added `plugins/plugin-native-talkmode/README.md` policy for iOS, Android,
  Electrobun desktop, and browser volume/mute behavior.
- Added `plugins/plugin-native-talkmode/src/audio-policy-contract.test.ts` to
  pin the native-source invariants behind that policy:
  - iOS must stay on `AVAudioSession` `.playAndRecord` + `.voiceChat`.
  - Android TTS/PCM must stay on `USAGE_VOICE_COMMUNICATION` /
    `MODE_IN_COMMUNICATION`.
  - Android recognizer-earcon muting must not include `STREAM_VOICE_CALL`.

## Verification run locally

```bash
$ bun run --cwd plugins/plugin-native-talkmode test
Test Files  2 passed (2)
Tests       7 passed (7)

$ bunx @biomejs/biome check plugins/plugin-native-talkmode/README.md \
    plugins/plugin-native-talkmode/src/audio-policy-contract.test.ts \
    .github/issue-evidence/13697-voice-volume-mute-semantics.md
Checked 1 file. No fixes applied.

$ git diff --check
passed
```

Additional checks:

```bash
$ bun run --cwd plugins/plugin-native-talkmode typecheck
blocked: pre-existing package resolution failure in origin/develop path
plugins/plugin-native-talkmode/src/web.ts:
Cannot find module '@elizaos/native-plugin-shared-types'

$ (cd plugins/plugin-native-talkmode/ios && swift test)
blocked: this host Swift toolchain cannot import XCTest
```

## Evidence rows

- Real device / simulator audio proof: N/A for this slice. This host has not
  run hardware silent-switch, Android stream-mute, or desktop system-mute audio
  captures. The policy and contract tests prevent silent source drift; the
  issue still requires real audio-lane evidence before final human approval.
- Real-LLM trajectory: N/A — no agent prompt/model/action behavior changed.
- Screenshots/video: N/A — no UI changed.
- Domain artifact reviewed by hand: README policy and source-contract test.

## Follow-up design slice merged into this branch

This branch also pins the headless TalkMode policy contract in
`plugins/plugin-native-talkmode/src/volumeMutePolicy.ts` with deterministic tests
in `plugins/plugin-native-talkmode/src/volumeMutePolicy.test.ts`:

- voice capture is input-side state and continues when output is muted or set to
  volume 0;
- the capture indicator stays `recording` while capture remains live under muted
  output;
- TTS follows the platform output lane and continues progressing silently under
  mute / volume 0 instead of pausing or canceling;
- restoring output volume makes the same in-flight utterance audible again;
- stale TTS finish events cannot clear the current utterance.

Additional verification:

```bash
$ bun test plugins/plugin-native-talkmode/src/audio-policy-contract.test.ts \
    plugins/plugin-native-talkmode/src/volumeMutePolicy.test.ts
11 pass / 53 expects

$ bunx @biomejs/biome check plugins/plugin-native-talkmode/README.md \
    plugins/plugin-native-talkmode/src/audio-policy-contract.test.ts \
    plugins/plugin-native-talkmode/src/volumeMutePolicy.ts \
    plugins/plugin-native-talkmode/src/volumeMutePolicy.test.ts \
    plugins/plugin-native-talkmode/src/index.ts \
    .github/issue-evidence/13697-voice-volume-mute-semantics.md
pass

$ git diff --check
pass
```
