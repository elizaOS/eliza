# @elizaos/capacitor-talkmode

Capacitor plugin for voice conversations: STT → chat orchestration → TTS, across browser, iOS, Android, and Electrobun (desktop).

## Purpose / role

Provides a unified `TalkMode` Capacitor plugin that Eliza agents can call to run full voice conversation sessions. On native (iOS/Android/Electrobun), it uses platform STT and ElevenLabs streaming TTS with PCM/MP3 playback; on web it falls back to the Web Speech API for both STT and TTS. This is a Capacitor plugin, not an elizaOS `Plugin` object — it is imported directly into UI/app code via `@elizaos/capacitor-talkmode`, not registered through the elizaOS plugin registry.

## Plugin surface

This is a Capacitor plugin exposing a single `TalkMode` object. It does not register elizaOS actions, providers, services, or evaluators. The surface is:

| Method / Event | Description |
|---|---|
| `TalkMode.start(options?)` | Start a voice session; accepts `TalkModeConfig` |
| `TalkMode.stop()` | Stop the voice session and release resources |
| `TalkMode.isEnabled()` | Query whether a session is active |
| `TalkMode.getState()` | Return current `TalkModeState` and `statusText` |
| `TalkMode.updateConfig(options)` | Patch config mid-session |
| `TalkMode.speak(options)` | Speak a string via TTS; returns `SpeakResult` |
| `TalkMode.stopSpeaking()` | Interrupt current TTS playback |
| `TalkMode.isSpeaking()` | Query TTS speaking status |
| `TalkMode.checkPermissions()` | Read microphone + speech-recognition permission status |
| `TalkMode.requestPermissions()` | Prompt for microphone + speech-recognition permissions |
| Event: `stateChange` | `TalkModeStateEvent` — state machine transitions |
| Event: `transcript` | `TalkModeTranscriptEvent` — interim and final STT results |
| Event: `speaking` | `TTSSpeakingEvent` — TTS utterance started |
| Event: `speakComplete` | `TTSCompleteEvent` — TTS utterance finished or interrupted |
| Event: `playbackStart` | `TalkModePlaybackStartEvent` — native PCM/MP3 playback started |
| Event: `error` | `TalkModeErrorEvent` — recoverable or fatal error |

**Session modes** (`TalkModeSessionMode`): `idle`, `compose`, `push-to-talk`, `hands-free`, `passive`.

**State machine** (`TalkModeState`): `idle` → `listening` → `processing` → `speaking` → `error`.

## Layout

```
plugins/plugin-native-talkmode/
  src/
    index.ts           Capacitor registerPlugin call; exports TalkMode singleton + all types
    definitions.ts     All TypeScript interfaces and types (TalkModePlugin, TTSConfig, etc.)
    web.ts             Web fallback: Web Speech API STT + SpeechSynthesis TTS
  ios/
    Sources/TalkModePlugin/
      TalkModePlugin.swift   Native iOS: AVSpeechSynthesizer + SFSpeechRecognizer + ElevenLabs PCM/MP3
  android/
    src/main/java/ai/eliza/plugins/talkmode/TalkModePlugin.kt   Android native implementation (Kotlin)
  ElizaosCapacitorTalkmode.podspec   CocoaPods spec (requires AVFoundation + Speech frameworks)
  rollup.config.mjs          Builds IIFE (dist/plugin.js) and CJS (dist/plugin.cjs.js) from ESM
  tsconfig.json
  package.json
```

## Commands

Scripts are defined in `package.json`; run them from the repo root with `bun run --cwd`:

```bash
bun run --cwd plugins/plugin-native-talkmode clean           # remove build output
bun run --cwd plugins/plugin-native-talkmode build           # build package artifacts
bun run --cwd plugins/plugin-native-talkmode build:docs      # generate docs and build artifacts
bun run --cwd plugins/plugin-native-talkmode typecheck       # TypeScript typecheck
bun run --cwd plugins/plugin-native-talkmode lint            # mutating Biome check
bun run --cwd plugins/plugin-native-talkmode lint:check      # read-only Biome check
bun run --cwd plugins/plugin-native-talkmode format          # write formatting
bun run --cwd plugins/plugin-native-talkmode format:check    # read-only formatting check
bun run --cwd plugins/plugin-native-talkmode test            # run package tests
bun run --cwd plugins/plugin-native-talkmode prepublishOnly  # publish-time build hook
bun run --cwd plugins/plugin-native-talkmode build:unlocked  # bun run clean && tsc && bunx rollup -c rollup.config.mjs
bun run --cwd plugins/plugin-native-talkmode docgen          # docgen --api TalkModePlugin --output-readme README.md --output-json dist/docs.json
```

## Config / env vars

Config is passed at runtime via `TalkMode.start({ config })` or `TalkMode.updateConfig({ config })`. No process-level env vars are read by this package. The key config fields:

| Field | Type | Notes |
|---|---|---|
| `tts.apiKey` | `string` | ElevenLabs API key — required for ElevenLabs TTS on native |
| `tts.voiceId` | `string` | ElevenLabs voice ID |
| `tts.modelId` | `string` | ElevenLabs model (default on iOS: `eleven_flash_v2_5`) |
| `tts.outputFormat` | `string` | e.g. `"pcm_24000"`, `"mp3_44100"` |
| `tts.interruptOnSpeech` | `boolean` | Stop TTS when mic detects speech |
| `tts.voiceAliases` | `Record<string,string>` | Alias → voiceId mapping |
| `stt.engine` | `"native"` \| `"web"` | STT backend preference |
| `stt.modelSize` | `"tiny"` \| `"base"` \| `"small"` \| `"medium"` \| `"large"` | Legacy compatibility field; ignored by current recognizers |
| `stt.language` | `string` | BCP-47 language code (e.g. `"en"`) |
| `stt.sampleRate` | `number` | Audio sample rate in Hz (default 16000) |
| `silenceWindowMs` | `number` | Silence gap before finalising transcript (ms) |
| `mode` | `TalkModeSessionMode` | Initial session mode |
| `sessionKey` | `string` | Chat session key passed to the orchestration layer |

The `speak()` call also accepts a `TTSDirective` for per-utterance overrides (voice, speed, stability, language, seed, etc.).

## How to extend

**Add a new method to the plugin surface:**
1. Declare the method signature in `src/definitions.ts` on `TalkModePlugin`.
2. Implement it in `src/web.ts` (web fallback).
3. Implement it in `ios/Sources/TalkModePlugin/TalkModePlugin.swift` (register in `pluginMethods`).
4. Implement it in the Android Kotlin source at `android/src/main/java/ai/eliza/plugins/talkmode/TalkModePlugin.kt`.
5. Run `bun run --cwd plugins/plugin-native-talkmode build` to verify TS compiles.

**Add a new event:**
1. Define the event payload interface in `src/definitions.ts`.
2. Add an `addListener` overload to `TalkModePlugin` in `src/definitions.ts`.
3. Call `this.notifyListeners("eventName", payload)` in the web and native implementations.

## Conventions / gotchas

- **Not an elizaOS Plugin object.** There is no `actions`, `providers`, `services`, or `evaluators` array. It is a Capacitor plugin registered with `registerPlugin("TalkMode", { web: loadWeb })`. Import `TalkMode` from `@elizaos/capacitor-talkmode` in UI/app code.
- **ElevenLabs on web is blocked by CORS.** The web implementation always falls back to `SpeechSynthesis`; `usedSystemTts` will always be `true` in the browser. ElevenLabs streaming TTS only works in native (iOS/Android) and Electrobun contexts.
- **iOS native frameworks required.** The CocoaPods spec declares `AVFoundation` and `Speech` frameworks. iOS 13.0+ minimum deployment target.
- **Web STT auto-restarts.** `recognition.onend` restarts the recogniser if the session is still enabled (`state === "listening"`), preventing silent dropout when the browser ends a recognition run.
- **`speak()` on web always forces `lang` to `en-US` unless `directive.language` is set** — this prevents browser-locale drift (e.g. numbers read in Chinese on Chinese-locale systems).
- **Silence detection is stateful.** On iOS, `silenceWindow` (default 0.7 s) drives a `Task` timer that finalises in-flight transcripts. Adjust via `silenceWindowMs` in config.
- **Peer dep:** `@capacitor/core ^8.3.1` is required at the app level.
- See the root [AGENTS.md](../../AGENTS.md) for repo-wide architecture rules, logger conventions, and git workflow.

<!-- BEGIN: evidence-and-e2e-mandate (managed; canonical standard = repo-root PR_EVIDENCE.md) -->
## ⛔ NON-NEGOTIABLE — evidence, trajectories & real end-to-end tests

> The binding, repo-wide standard is **[PR_EVIDENCE.md](../../PR_EVIDENCE.md)**. Read it.
> Nothing in this package is *done* until it is *proven* done — a reviewer must confirm it
> works **without reading the code**, from the artifacts you attach. This applies to **every**
> feature, fix, refactor, and chore here. "Tests pass" is not proof; "CI is green" is not proof.

- **Record AND read model trajectories.** Capture the *actual* inputs and outputs of the model
  from a **live** LLM — not the deterministic proxy, not a mock: the prompt, the
  providers/context, the raw model output, every tool/action call, and the result. Then **open
  the trajectory and review it by hand.** A captured-but-unread trajectory is not evidence
  (`packages/scenario-runner/bin/eliza-scenarios run <scenario> --report <out>`).
- **Real, full-featured E2E — no larp.** Every feature ships detailed end-to-end tests that
  drive the *real* path end to end. Not the happy "front door" only: cover error paths,
  edge/empty/invalid input, concurrency, roles/permissions, and adversarial input. A test that
  asserts against a mock/stub/fixture standing in for the thing under test **does not count**.
  If the real model/device/chain/connector/account is hard to reach, **make it reachable — that
  is the work**, not an excuse to mock. If the existing tests here are shallow or mocked, fixing
  them is part of your change.
- **Screenshots + logs at every phase**, plus a **complete walkthrough video/run-through** of
  the entire feature or view, start to finish (`bun run test:e2e:record`).
- **Manually review every artifact the change touches** — never just the green check: client
  logs (console + network), server logs (`[ClassName] …`), the model trajectories in and out,
  before/after full-page screenshots, **and the domain artifacts listed below for this package.**
- **No residuals. No shortcuts.** The goal is not "done" — it is *everything* done. Clear every
  blocker by the **hard path**: build the real architecture, stand up the real
  model/device/service, actually test it. Never leave a TODO, a stub, a stepping-stone, or a
  "follow-up." When unsure, research thoroughly, weigh the options, and ship the best,
  highest-effort, production-ready version. Keep going until every possibility is exhausted.

Artifacts → `.github/issue-evidence/<issue#>-<slug>.<ext>`; attach each evidence type **or**
explicitly mark it N/A with a reason — never leave it blank. If `develop` moved and changed
behavior, **re-capture** evidence; stale proof is worse than none.

**Capture & manually review for this package — native / on-device bridge:**
- The capability run on a **real device or simulator** — not desktop Chromium against a mocked bridge (see #9967/#9580): device logs + the captured output (photo, OCR text, detection boxes, transcript, sensor reading).
- Parity vs the reference implementation where one exists (e.g. the Python/Ultralytics reference), with the numeric tolerances actually met.
- Permission-denied, no-hardware, and background/foreground lifecycle paths.
- A short recording of the on-device run; confirm the build under test is yours (versionName / a known on-screen change), not a stale install.
<!-- END: evidence-and-e2e-mandate -->
