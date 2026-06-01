# @elizaos/capacitor-swabble

Capacitor plugin that adds wake-word detection and live speech transcription to Eliza agents across iOS, Android, browser, and desktop (Electrobun/Whisper.cpp).

## Purpose / role

This is a Capacitor native plugin — not an elizaOS `Plugin` object with actions/providers/evaluators. It exposes a typed JavaScript API (`Swabble`) that Eliza agent UI code calls directly to start microphone capture, detect trigger phrases, and stream transcripts. It is opt-in: nothing loads it automatically. The consuming app registers it via Capacitor's plugin system.

Platforms:
- **iOS/macOS** — native Swift using `Speech` + `AVFoundation` frameworks (`ios/Sources/SwabblePlugin/SwabblePlugin.swift`).
- **Android** — Kotlin `SpeechRecognizer` API (`android/src/main/java/ai/eliza/plugins/swabble/SwabblePlugin.kt`).
- **Browser** — Web Speech API, limited (no timing data, no device selection).
- **Desktop (Electrobun)** — delegates to `window.__ELIZA_ELECTROBUN_RPC__` bridge; sends audio chunks to a Whisper.cpp backend for high-quality transcription with precise timing.

## Plugin surface

This is a Capacitor plugin, not an elizaOS runtime plugin. It does not register actions, providers, evaluators, services, or routes. Instead it exports a single object:

| Export | Description |
|--------|-------------|
| `Swabble` | Registered Capacitor plugin instance typed as `SwabblePlugin` |
| `SwabblePlugin` (interface) | Full API surface — see `src/definitions.ts` |
| All event/config interfaces | Re-exported from `src/definitions.ts` |

### `SwabblePlugin` methods

| Method | Description |
|--------|-------------|
| `start(options)` | Start wake-word detection + transcription |
| `stop()` | Stop all capture and reset state |
| `isListening()` | Query current active state |
| `getConfig()` | Return the current `SwabbleConfig` |
| `updateConfig(options)` | Hot-update config while running |
| `checkPermissions()` | Query microphone + speech recognition permissions |
| `requestPermissions()` | Prompt user for microphone access |
| `getAudioDevices()` | List available audio input devices |
| `setAudioDevice(options)` | Select audio input device (native only; throws on web) |

### Events (via `addListener`)

| Event | Payload type | Description |
|-------|-------------|-------------|
| `wakeWord` | `SwabbleWakeWordEvent` | Fired when a trigger phrase is detected followed by a command |
| `transcript` | `SwabbleTranscriptEvent` | Fired on interim and final transcript updates |
| `stateChange` | `SwabbleStateEvent` | State transitions: `idle` / `listening` / `processing` / `error` |
| `audioLevel` | `SwabbleAudioLevelEvent` | RMS level + peak, emitted ~10 Hz |
| `error` | `SwabbleErrorEvent` | Error with `code`, `message`, and `recoverable` flag |

## Layout

```
plugins/plugin-native-swabble/
  src/
    index.ts              Entry — registers "Swabble" via Capacitor + lazy-loads web impl
    definitions.ts        All TypeScript interfaces: SwabblePlugin, SwabbleConfig, event types
    web.ts                Browser/desktop WebPlugin implementation (WakeWordGate + audio capture)
  ios/Sources/SwabblePlugin/
    SwabblePlugin.swift   Native iOS/macOS implementation (Speech framework + Whisper.cpp)
  android/src/main/java/ai/eliza/plugins/swabble/
    SwabblePlugin.kt      Native Android implementation (SpeechRecognizer)
  rollup.config.mjs       Builds IIFE + CJS bundles from tsc output
  tsconfig.json           Compiles src/ → dist/esm/
  ElizaosCapacitorSwabble.podspec  CocoaPods spec for iOS
```

## Commands

Scripts that exist in `package.json`:

```bash
bun run --cwd plugins/plugin-native-swabble build    # tsc → dist/esm, then rollup → dist/plugin.js + dist/plugin.cjs.js
bun run --cwd plugins/plugin-native-swabble clean    # remove dist/
bun run --cwd plugins/plugin-native-swabble watch    # tsc --watch (no rollup)
```

`build` requires `tsc` to complete before rollup reads `dist/esm/index.js`. Do not run rollup standalone.

## Config / env vars

No environment variables. Configuration is passed at runtime via `SwabbleConfig`:

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `triggers` | `string[]` | Yes | Wake-word phrases to detect (e.g. `["eliza"]`) |
| `minPostTriggerGap` | `number` | No | Seconds of silence required after trigger (native only; web ignores this) |
| `minCommandLength` | `number` | No | Minimum command length in characters (default: 1) |
| `locale` | `string` | No | Speech recognition locale (default: `"en-US"`) |
| `sampleRate` | `number` | No | Audio sample rate in Hz (default: 16000) |
| `modelSize` | `"tiny"\|"base"\|"small"\|"medium"\|"large"` | No | Whisper.cpp model (desktop only) |

## How to extend

**Add a new event:** Define the payload interface in `src/definitions.ts`, add an `addListener` overload to `SwabblePlugin`, implement `this.notifyListeners("eventName", payload)` in `src/web.ts`, and mirror in the native implementations.

**Add a new method:** Add the signature to `SwabblePlugin` in `src/definitions.ts`, implement in `SwabbleWeb` in `src/web.ts` (and in the native Swift/Kotlin files for iOS/Android), then rebuild.

**Add Electrobun desktop support for a method:** In `src/web.ts`, call `this.invokeDesktopRequest({ rpcMethod: "swabble<MethodName>", ipcChannel: "swabble:<methodName>", params })`. The Electrobun main process must handle the corresponding IPC channel.

## Conventions / gotchas

- **Web Speech API limitations:** `postGap` is always `-1` on web (no word-level timing). Segment `start` and `duration` fields are also `-1`. `setAudioDevice` throws on web.
- **Desktop bridge detection:** The web implementation checks `window.__ELIZA_ELECTROBUN_RPC__` to decide whether to delegate to the Electrobun native bridge. If the bridge is absent it falls back to Web Speech API.
- **Audio capture on desktop:** Even in native IPC mode, the web layer captures raw audio in the renderer and sends base64-encoded PCM chunks via `rpc.request.swabbleAudioChunk` to the main process for Whisper.cpp processing.
- **Build order is strict:** `rollup.config.mjs` reads `dist/esm/index.js` and throws if it is missing. Always run `tsc` before rollup (the `build` script does this with `clean && tsc && rollup`).
- **Peer dependency:** `@capacitor/core ^8.3.1` must be present in the consuming app's dependencies.
- **iOS frameworks:** The podspec links `Speech` and `AVFoundation`. iOS deployment target is 15.0+.
- **Shared types:** `@elizaos/native-plugin-shared-types` (workspace dep) provides `SpeechRecognition*` browser type shims used in `src/web.ts`.
- **No elizaOS runtime integration:** This plugin has no `Plugin` export, no actions, and no providers. It is a Capacitor hardware-access plugin, not an elizaOS behavior plugin. Wire it into agent UI via direct `Swabble.*` calls.
