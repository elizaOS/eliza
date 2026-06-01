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
    src/main/java/ai/       Android native implementation
  ElizaosCapacitorTalkmode.podspec   CocoaPods spec (requires AVFoundation + Speech frameworks)
  rollup.config.mjs          Builds IIFE (dist/plugin.js) and CJS (dist/plugin.cjs.js) from ESM
  tsconfig.json
  package.json
```

## Commands

Only scripts defined in this package's `package.json`:

```bash
bun run --cwd plugins/plugin-native-talkmode build         # clean + tsc + rollup (ESM + CJS + IIFE)
bun run --cwd plugins/plugin-native-talkmode build:docs    # clean + docgen + tsc + rollup
bun run --cwd plugins/plugin-native-talkmode clean         # remove dist/
```

API reference generation (`build:docs`) uses `@capacitor/docgen` targeting `TalkModePlugin` and writes to `README.md` and `dist/docs.json`.

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
| `stt.engine` | `"whisper"` \| `"web"` | STT backend preference |
| `stt.modelSize` | `"tiny"` \| `"base"` \| `"small"` \| `"medium"` \| `"large"` | Whisper model |
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
4. Implement it in the Android Java source under `android/src/main/java/ai/`.
5. Run `bun run --cwd plugins/plugin-native-talkmode build` to verify TS compiles.

**Add a new event:**
1. Define the event payload interface in `src/definitions.ts`.
2. Add an `addListener` overload to `TalkModePlugin` in `src/definitions.ts`.
3. Call `this.notifyListeners("eventName", payload)` in the web and native implementations.

## Conventions / gotchas

- **Not an elizaOS Plugin object.** There is no `actions`, `providers`, `services`, or `evaluators` array. It is a Capacitor plugin registered with `registerPlugin("TalkMode", { web: loadWeb })`. Import `TalkMode` from `@elizaos/capacitor-talkmode` in UI/app code.
- **ElevenLabs on web is blocked by CORS.** The web implementation always falls back to `SpeechSynthesis`; `usedSystemTts` will always be `true` in the browser. ElevenLabs streaming TTS only works in native (iOS/Android) and Electrobun contexts.
- **iOS native frameworks required.** The CocoaPods spec declares `AVFoundation` and `Speech` frameworks. iOS 13.0+ minimum deployment target.
- **Web STT auto-restarts.** `recognition.onend` restarts the recogniser if the session is still enabled, preventing silent dropout on Chrome's 60-second recognition limit.
- **`speak()` on web always forces `lang` to `en-US` unless `directive.language` is set** — this prevents browser-locale drift (e.g. numbers read in Chinese on Chinese-locale systems).
- **Silence detection is stateful.** On iOS, `silenceWindow` (default 0.7 s) drives a `Task` timer that finalises in-flight transcripts. Adjust via `silenceWindowMs` in config.
- **Peer dep:** `@capacitor/core ^8.3.1` is required at the app level.
- See the root [AGENTS.md](../../AGENTS.md) for repo-wide architecture rules, logger conventions, and git workflow.
