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

Scripts that exist in `package.json`:

```bash
bun run --cwd plugins/plugin-native-bun-runtime build   # clean + tsc + rollup
bun run --cwd plugins/plugin-native-bun-runtime clean   # remove dist/
bun run --cwd plugins/plugin-native-bun-runtime watch   # tsc --watch
bun run --cwd plugins/plugin-native-bun-runtime test    # vitest run
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
