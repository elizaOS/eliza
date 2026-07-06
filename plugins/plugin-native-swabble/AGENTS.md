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
    SwabblePlugin.swift   Native iOS/macOS implementation (SFSpeechRecognizer)
  android/src/main/java/ai/eliza/plugins/swabble/
    SwabblePlugin.kt      Native Android implementation (SpeechRecognizer)
  rollup.config.mjs       Builds IIFE + CJS bundles from tsc output
  tsconfig.json           Compiles src/ → dist/esm/
  ElizaosCapacitorSwabble.podspec  CocoaPods spec for iOS
```

## Commands

Scripts are defined in `package.json`; run them from the repo root with `bun run --cwd`:

```bash
bun run --cwd plugins/plugin-native-swabble clean           # remove build output
bun run --cwd plugins/plugin-native-swabble build           # build package artifacts
bun run --cwd plugins/plugin-native-swabble typecheck       # TypeScript typecheck
bun run --cwd plugins/plugin-native-swabble lint            # mutating Biome check
bun run --cwd plugins/plugin-native-swabble lint:check      # read-only Biome check
bun run --cwd plugins/plugin-native-swabble format          # write formatting
bun run --cwd plugins/plugin-native-swabble format:check    # read-only formatting check
bun run --cwd plugins/plugin-native-swabble test            # run package tests
bun run --cwd plugins/plugin-native-swabble prepublishOnly  # publish-time build hook
bun run --cwd plugins/plugin-native-swabble watch           # watch TypeScript sources
bun run --cwd plugins/plugin-native-swabble build:unlocked  # bun run clean && tsc && bunx rollup -c rollup.config.mjs
```

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

<!-- BEGIN: evidence-and-e2e-mandate (managed; canonical standard = repo-root AGENTS.md) -->
## ⛔ NON-NEGOTIABLE — evidence, trajectories & real end-to-end tests

> The binding, repo-wide standard is **[AGENTS.md](../../AGENTS.md)**. Read it.
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

Artifacts → attached inline in the PR (MP4 video, JPG screenshots, logs in `<details>`); attach each evidence type **or**
explicitly mark it N/A with a reason — never leave it blank. If `develop` moved and changed
behavior, **re-capture** evidence; stale proof is worse than none.

**Capture & manually review for this package — native / on-device bridge:**
- The capability run on a **real device or simulator** — not desktop Chromium against a mocked bridge (see #9967/#9580): device logs + the captured output (photo, OCR text, detection boxes, transcript, sensor reading).
- Parity vs the reference implementation where one exists (e.g. the Python/Ultralytics reference), with the numeric tolerances actually met.
- Permission-denied, no-hardware, and background/foreground lifecycle paths.
- A short recording of the on-device run; confirm the build under test is yours (versionName / a known on-screen change), not a stale install.
<!-- END: evidence-and-e2e-mandate -->
