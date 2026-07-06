# @elizaos/capacitor-bun-runtime

Capacitor plugin that bridges the React UI to an embedded Bun-shape JS runtime on iOS and Android, letting an Eliza agent run locally on a mobile device.

## Purpose / role

This is a **Capacitor 8 native plugin**, not an elizaOS runtime plugin. It exposes a small TypeScript surface so a React/Capacitor app can start, message, and stop a local Eliza agent process on iOS or Android. It does not register elizaOS actions, providers, services, or evaluators — it is infrastructure that hosts the agent runtime on-device.

On **iOS** the plugin either starts a full `ElizaBunEngine.xcframework` (production store path, `engine: "bun"`) or falls back to a `JavaScriptCore` JSContext compatibility bridge for development/sideload builds (`engine: "compat"`). `engine: "auto"` selects whichever is available.

On **Android** the plugin delegates to the host app's `ElizaAgentService` foreground service over a loopback API; there is no JSContext fallback — `engine` is always `"bun"` on Android.

## Plugin surface (TypeScript API)

All methods live on the `ElizaBunRuntime` singleton exported from `src/index.ts`.

| Method | Description |
|--------|-------------|
| `start(options)` | Boot the on-device runtime. Returns `{ ok, error?, bridgeVersion? }`. |
| `sendMessage({ message, conversationId? })` | Send a chat message; returns `{ reply }`. |
| `getStatus()` | Returns readiness, active engine, loaded model, token throughput, bridge version. |
| `stop()` | Tear down the runtime and release native resources. |
| `call({ method, args? })` | Dispatch an arbitrary RPC call to a handler the agent registered via `bridge.ui_register_handler`. Returns `{ result }`. |
| `getLocalTtsStatus()` | Query whether the on-device Kokoro TTS engine is ready. |
| `getLocalTtsDiagnostics(options?)` | Probe TTS bundle directory and model availability. |
| `synthesizeLocalTts(options)` | Run on-device TTS; returns base64 WAV audio. |

**Capacitor events** (subscribe with `ElizaBunRuntime.addListener`):

| Event | When fired |
|-------|-----------|
| `eliza:ui` | Every `bridge.ui_post_message(channel, payload)` call from the agent. |
| `eliza:runtime-exit` | When the agent calls `bridge.exit(code)` (crash/clean shutdown). |

## Layout

```
plugins/plugin-native-bun-runtime/
  src/
    index.ts              Plugin registration + ElizaBunRuntime singleton export
    definitions.ts        All TypeScript interfaces (StartOptions, GetStatusResult, etc.)
    web.ts                Browser fallback (all methods return ok:false or throw unavailable)
    bridge-contract.test.ts  Unit tests for the JS public surface (web fallback only)
  ios/Sources/ElizaBunRuntimePlugin/
    ElizaBunRuntimePlugin.swift   Capacitor @objc plugin class
    ElizaBunRuntime.swift         Runtime state machine (engine selection, lifecycle)
    FullBunEngineHost.swift       Full ElizaBunEngine.xcframework host
    BridgeInstaller.swift         Installs __ELIZA_BRIDGE__ host functions into JSContext
    JSContextHelpers.swift        JSContext utilities
    SandboxPaths.swift            iOS sandbox path helpers
    bridge/
      HTTPBridge.swift            fetch / HTTP client bridge functions
      HTTPServerBridge.swift      http_serve_* (disabled on iOS)
      FSBridge.swift              File system bridge functions
      LlamaBridge.swift           llama_* dispatch surface
      LlamaBridgeImpl.swift       Links against LlamaCpp.xcframework
      SqliteBridge.swift          sqlite bridge functions
      SqliteBridgeInstaller.swift sqlite + sqlite-vec bootstrap
      SqliteVecLoader.swift       Loads sqlite-vec extension
      UIBridge.swift              ui_post_message / ui_register_handler
      LogBridge.swift             Structured logger bridge
      ProcessBridge.swift         argv / env_get / env_keys / exit
      PathsBridge.swift           Path resolution helpers
      CryptoBridge.swift          Crypto helpers
      ElizaSqliteVecBridge.m      ObjC shim for sqlite-vec C symbols
    kokoro/
      KokoroCoreMlEngine.swift    On-device TTS engine (Kokoro CoreML)
      KokoroCoreMlModel.swift     CoreML model loader
      KokoroCoreMlConfiguration.swift  Engine configuration
      KokoroCoreMlLatinPhonemizer.swift    Latin phonemizer
      KokoroCoreMlChinesePhonemizer.swift  Chinese phonemizer
      KokoroCoreMlJapanesePhonemizer.swift Japanese phonemizer
      KokoroCoreMlHindiPhonemizer.swift    Hindi phonemizer
      KokoroCoreMlPhonemizer.swift         Base phonemizer protocol
      KokoroCoreMlPronunciationDicts.swift Pronunciation dictionaries
      KokoroCoreMlSupport.swift            Shared Kokoro utilities
  android/src/main/java/ai/elizaos/plugins/bunruntime/
    ElizaBunRuntimePlugin.kt  Android Capacitor plugin; delegates to ElizaAgentService
  ElizaosCapacitorBunRuntime.podspec  CocoaPods spec; reads build env vars
  rollup.config.mjs   JS bundle config
  tsconfig.json
```

## Commands

Scripts are defined in `package.json`; run them from the repo root with `bun run --cwd`:

```bash
bun run --cwd plugins/plugin-native-bun-runtime clean           # remove build output
bun run --cwd plugins/plugin-native-bun-runtime build           # build package artifacts
bun run --cwd plugins/plugin-native-bun-runtime typecheck       # TypeScript typecheck
bun run --cwd plugins/plugin-native-bun-runtime lint            # mutating Biome check
bun run --cwd plugins/plugin-native-bun-runtime lint:check      # read-only Biome check
bun run --cwd plugins/plugin-native-bun-runtime format          # write formatting
bun run --cwd plugins/plugin-native-bun-runtime format:check    # read-only formatting check
bun run --cwd plugins/plugin-native-bun-runtime test            # run package tests
bun run --cwd plugins/plugin-native-bun-runtime prepublishOnly  # publish-time build hook
bun run --cwd plugins/plugin-native-bun-runtime watch           # watch TypeScript sources
bun run --cwd plugins/plugin-native-bun-runtime build:unlocked  # bun run clean && tsc && bunx rollup -c rollup.config.mjs
```

## Config / env vars

These are build-time environment variables read by the CocoaPods spec (`ElizaosCapacitorBunRuntime.podspec`), not runtime env vars:

| Variable | Effect |
|----------|--------|
| `ELIZA_IOS_FULL_BUN_ENGINE=1` | Includes `ElizaBunEngine` framework and omits `JavaScriptCore`; required for iOS store / production local-mode builds. |
| `ELIZA_IOS_INCLUDE_LLAMA=1` | Links `LlamaCpp.xcframework` and `LlamaCppCapacitor`; enables `llama_*` bridge functions. |

Runtime options passed to `start()`:

| Field | Type | Notes |
|-------|------|-------|
| `engine` | `"auto" \| "bun" \| "compat"` | `"auto"` default; `"bun"` fails closed if framework missing |
| `bundlePath` | string (optional) | Override default `public/agent/agent-bundle.js` |
| `polyfillPath` | string (optional) | Override default `eliza-polyfill-prefix.js` |
| `env` | `Record<string, string>` (optional) | Env vars exposed to the agent via `env_get` |
| `argv` | string[] (optional) | Defaults to `["bun", "public/agent/agent-bundle.js"]` |

## How to extend

**Add a new bridge function (iOS):**
1. Create or edit a `*Bridge.swift` file under `ios/Sources/ElizaBunRuntimePlugin/bridge/`. Each bridge module is a class with an `install(into ctx: JSContext)` method.
2. Inside `install(into:)`, register the function with `ctx.installBridgeFunction(name:)` (the `JSContext` extension defined in `JSContextHelpers.swift`). For a brand-new bridge module, also construct it and call its `install(into: ctx)` from `BridgeInstaller.install(into:...)`, then add it to `BridgeKit`.
3. If the function is llama-specific, guard it behind `#if ELIZA_IOS_INCLUDE_LLAMA`.

**Add a method to the public TS API:**
1. Add the interface to `src/definitions.ts`.
2. Add an unavailable/throw implementation to `ElizaBunRuntimeWeb` in `src/web.ts`.
3. Add the native implementations to `ElizaBunRuntimePlugin.swift` (iOS) and `ElizaBunRuntimePlugin.kt` (Android).
4. Run `bun run --cwd plugins/plugin-native-bun-runtime build` to rebuild JS.

## Conventions / gotchas

- This is **not** a standard elizaOS runtime plugin. It does not export a `Plugin` object with actions/providers. It is a Capacitor plugin used by the mobile Capacitor app shell.
- iOS store builds **must** use `engine: "bun"` and link `ElizaBunEngine.xcframework` via `ELIZA_IOS_FULL_BUN_ENGINE=1`. The JSContext compat path is development/sideload only.
- `http_serve_*` is disabled on iOS. Route traffic from the React UI goes through `ElizaBunRuntime.call({ method: "http_request", args })` instead of a localhost listener.
- `bun:ffi.dlopen` is forbidden inside the sandbox. The only FFI surface is the llama bridge.
- `child_process` is sandboxed out on iOS.
- Android has no JSContext fallback — `engine` is always `"bun"` and the runtime is managed by `ElizaAgentService`.
- The bridge contract ABI is documented at `packages/native/bun-runtime/BRIDGE_CONTRACT.md`. Breaking changes bump `__ELIZA_BRIDGE_VERSION__`.
- After adding this package to an iOS project, run `pod install` so `ElizaosCapacitorBunRuntime` links into the Xcode workspace.
- The `dist/` directory is gitignored build output. Run `build` before publishing.
- See root [AGENTS.md](../../AGENTS.md) for repo-wide architecture rules, naming conventions, and logger standards.

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
