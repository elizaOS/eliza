# @elizaos/plugin-capacitor-bridge

Capacitor WebSocket bridge enabling stock iOS and Android Eliza builds to run local GGUF inference through the device's native llama.cpp Capacitor plugin.

## Purpose / role

This package is the agent-side half of the native Capacitor inference path. It is NOT a standard elizaOS plugin that exports a `Plugin` object; instead it exports lower-level bootstrap utilities consumed by the agent bundle at startup. On stock (non-AOSP) mobile builds, llama.cpp is exposed to the WebView through a Capacitor native plugin; this package bridges that native layer back to the elizaOS runtime's model-handler system.

It is loaded explicitly by the agent bundle CLI — not auto-enabled. Android and iOS entry points differ (see Layout below).

## Plugin surface

This package has no `Plugin` object. It registers model handlers directly on `AgentRuntime`:

| Export | Description |
|---|---|
| `ensureMobileDeviceBridgeInferenceHandlers(runtime)` | Registers `TEXT_SMALL`, `TEXT_LARGE`, and `TEXT_EMBEDDING` model handlers on the runtime. Android path only (iOS uses native IPC). Gated by `ELIZA_DEVICE_BRIDGE_ENABLED=1`. |
| `attachMobileDeviceBridgeToServer(httpServer)` | Attaches the WebSocket upgrade handler at `/api/local-inference/device-bridge` to an existing Node `http.Server`. |
| `getMobileDeviceBridgeStatus()` | Returns `MobileDeviceBridgeStatus`: enabled, connected devices, loaded model path, pending request counts. |
| `loadMobileDeviceBridgeModel(modelPath, modelId?)` | Imperatively load a GGUF into the connected Android device. |
| `unloadMobileDeviceBridgeModel()` | Unload the current model from the connected Android device. |
| `mobileDeviceBridge` | Singleton `MobileDeviceBridge` instance managing WebSocket connections and correlating async RPC frames. |
| `runAndroidBridgeCli()` | Android CLI entry point — sets env vars, installs fs shim, boots elizaOS runtime, and optionally wires device-bridge handlers. |
| `runIosBridgeCli(argv?)` | iOS CLI entry point — reads argv env envelope, installs fs shim, boots runtime via `@elizaos/agent/runtime` and `@elizaos/agent/api`, and serves JSON-RPC over Bun host IPC. |
| `installMobileFsShim(workspaceRoot)` | Patches `node:fs` and `node:fs/promises` in-place to sandbox all paths inside `workspaceRoot`. Blocks path traversal, system dirs, and native binary writes. Idempotent. |
| `isMobileFsShimInstalled()` | Returns `true` if the shim has been applied. |
| `getMobileWorkspaceRoot()` | Returns the workspace root the shim is locked to. |
| `sandboxedPath(path)` | Validates an externally assembled absolute path against the sandbox and returns it (or throws `EACCES`). |

Package exports:
- `.` — main entry (re-exports all of the above)
- `./android/bridge` — `runAndroidBridgeCli()`
- `./ios/bridge` — `runIosBridgeCli()`
- `./mobile-device-bridge-bootstrap` — bridge bootstrap functions and `MobileDeviceBridgeStatus` type
- `./shared/fs-shim` — filesystem sandbox utilities

## Layout

```
src/
  index.ts                          Re-exports from android/, ios/, mobile-device-bridge-bootstrap, shared/
  mobile-device-bridge-bootstrap.ts  MobileDeviceBridge class + ensureMobileDeviceBridgeInferenceHandlers
                                      Model path resolution: env vars → registry → manifest.json → first .gguf
                                      Auto-download from elizaos/eliza-1 on HuggingFace (respects ELIZA_DISABLE_MODEL_AUTO_DOWNLOAD)
                                      Recommended models: eliza-1-0_8b (TEXT_SMALL), eliza-1-2b (TEXT_LARGE), eliza-1-embedding (TEXT_EMBEDDING)
  android/
    bridge.ts                       Android CLI entry: env setup, fs shim install, startEliza({ serverOnly: true }), device-bridge wiring
  ios/
    bridge.ts                       iOS CLI entry: argv env hydration, fs shim, bootElizaRuntime(), dispatchRoute in-process handler
                                    Native llama state, catalog models, download management, host IPC call protocol
  shared/
    fs-shim.ts                      installMobileFsShim() — patches live node:fs module; blocks system dirs, native binaries, require of file paths
    fs-sandbox.ts                   Low-level wrap helpers (wrapMobileFsPath, wrapMobileFsOpen, wrapMobileFsTwoPaths) and modeForMobileFsOpenFlags
    fs-proxy.ts                     Sandboxed re-export of node:fs for use inside ios/bridge.ts
    fs-promises-proxy.ts            Sandboxed re-export of node:fs/promises

android/                            Native Capacitor manifest fragment + Kotlin computer-use services
                                    (merged into the host app at Capacitor sync time; not built by tsup).
  src/main/AndroidManifest.xml      Service/permission declarations; checked by pre-build script
  src/main/java/ai/elizaos/computeruse/
    ScreenCaptureService.kt         MediaProjection foreground service
    ElizaAccessibilityService.kt    Cross-app view tree + gesture dispatch
    Camera2Source.kt                Camera2 frame source
    ComputerUsePlugin.kt            Capacitor plugin entry
    AospPrivilegedBridge.kt         AOSP privileged-mode bridge
    UsageStatsHelper.kt             PACKAGE_USAGE_STATS reader
  src/main/res/xml/accessibility_service_config.xml

scripts/
  check-android-manifest.mjs        Pre-build: validates AndroidManifest.xml has no stray tools:* attrs
```

## Commands

All scripts are in this package's `package.json`.

```bash
bun run --cwd plugins/plugin-capacitor-bridge build           # tsup build (runs check:android-manifest first)
bun run --cwd plugins/plugin-capacitor-bridge check:android-manifest  # validate AndroidManifest.xml
bun run --cwd plugins/plugin-capacitor-bridge dev             # tsup --watch
bun run --cwd plugins/plugin-capacitor-bridge typecheck       # tsc --noEmit
bun run --cwd plugins/plugin-capacitor-bridge lint            # biome check --write --unsafe
bun run --cwd plugins/plugin-capacitor-bridge lint:check      # biome check (read-only)
bun run --cwd plugins/plugin-capacitor-bridge format          # biome format --write
bun run --cwd plugins/plugin-capacitor-bridge format:check    # biome format (read-only)
bun run --cwd plugins/plugin-capacitor-bridge clean           # rm -rf dist .turbo node_modules
```

## Config / env vars

### Bridge enable/auth (Android path)
| Var | Required | Description |
|---|---|---|
| `ELIZA_DEVICE_BRIDGE_ENABLED` | Yes (must be `1`) | Enables the WebSocket device bridge. Without this, `ensureMobileDeviceBridgeInferenceHandlers` returns without registering bridge handlers. |
| `ELIZA_DEVICE_PAIRING_TOKEN` | Yes when bridge enabled | Token required in both WebSocket query string (`?token=`) and device `register` frame. Rejects connections without it. |
| `ELIZA_DEVICE_BRIDGE_TOKEN` | Alias | Fallback for `ELIZA_DEVICE_PAIRING_TOKEN`. |
| `ELIZA_LOCAL_LLAMA` | Optional | Set to `1` to disable the bridge (AOSP builds running llama.cpp inline). |

### Model resolution (Android and iOS)
| Var | Description |
|---|---|
| `ELIZA_LOCAL_CHAT_MODEL_PATH` | Absolute path to a GGUF for chat slots (TEXT_SMALL / TEXT_LARGE). |
| `ELIZA_LOCAL_EMBEDDING_MODEL_PATH` | Absolute path to a GGUF for TEXT_EMBEDDING. |
| `ELIZA_LOCAL_MODEL_PATH` | Fallback path used when neither slot-specific var is set. |
| `ELIZA_DISABLE_MODEL_AUTO_DOWNLOAD` | Set to `1` to disable auto-download from HuggingFace. |
| `ELIZA_LOCAL_EMBEDDING_DIMENSIONS` | Override embedding vector size (default: model-id lookup or 1024). |
| `TEXT_EMBEDDING_DIMENSIONS` | Fallback for embedding dimension override. |

### Timeouts
| Var | Default | Description |
|---|---|---|
| `ELIZA_DEVICE_LOAD_TIMEOUT_MS` | 600000 | ms to wait for model load / formatChat. |
| `ELIZA_DEVICE_GENERATE_TIMEOUT_MS` | 600000 | ms to wait for generate / unload. |
| `ELIZA_DEVICE_EMBED_TIMEOUT_MS` | 600000 | ms to wait for embed. |

### Android-specific
| Var | Description |
|---|---|
| `ELIZA_PLATFORM` | Set to `android` by `runAndroidBridgeCli` (default if not pre-set). |
| `ELIZA_MOBILE_PLATFORM` | Set to `android`. |
| `ELIZA_ANDROID_LOCAL_BACKEND` | Set to `1`. |
| `ELIZA_API_BIND` | Set to `127.0.0.1` (loopback-only). |
| `ELIZA_STATE_DIR` | Per-user state root; used for model registry, assignments, and log file path. |

### iOS-specific
| Var | Description |
|---|---|
| `MOBILE_WORKSPACE_ROOT` | Writable workspace root for the fs sandbox. Set by native Swift host. |
| `ELIZA_IOS_APP_SUPPORT_DIR` | App support dir (also accepted via `--eliza-ios-app-support-dir` argv). |
| `ELIZA_IOS_AGENT_BUNDLE` | Path to bundled agent JS (also via `--eliza-ios-agent-bundle` argv). |
| `ELIZA_IOS_AGENT_ASSET_DIR` | Asset directory (derived from bundle path). |
| `ELIZA_IOS_LLAMA_CONTEXT_SIZE` | Override llama context size (default: 4096). |
| `ELIZA_IOS_LLAMA_USE_GPU` | `1`/`true` force Metal on; `0`/`false` force CPU. Auto-detects otherwise. |
| `ELIZA_IOS_BRIDGE_TRANSPORT` | Set to `bun-host-ipc`. |

## How to extend

### Add a new RPC message type (Android device bridge)

1. Add the new inbound frame variant to `DeviceOutbound` and the outbound command to `AgentOutbound` in `src/mobile-device-bridge-bootstrap.ts`.
2. Add a `Map<string, Pending<...>>` for the new pending type inside `MobileDeviceBridge`.
3. Handle the result in `handleDeviceMessage()`.
4. Add a public method on `MobileDeviceBridge` calling `sendToPrimary()`.
5. Export the method wrapper from the module if needed by callers.

### Add a new iOS host call

Add a new branch in `runIosBridgeCli()` (in `src/ios/bridge.ts`) that calls `callIosHost(method, payload, timeoutMs)`. Handle the native result in `tryHandleHostResultLine()` — it dispatches based on `parsed.type === "host_result"`.

### Add a new sandboxed fs operation

If a new `node:fs` function needs sandboxing, add it to the appropriate array (`syncOnePath`, `callbackOnePath`, or `promisesOnePath`) and to the write-set if it mutates the filesystem, inside `patchFsModule()` in `src/shared/fs-shim.ts`.

## Conventions / gotchas

- **Install fs shim first.** `installMobileFsShim()` must be called before any other module that touches `node:fs`. In both `android/bridge.ts` and `ios/bridge.ts` it is the first action before any elizaOS import.
- **iOS rejects WebSocket registration.** The `MobileDeviceBridge` closes connections with code `4003` if the registering device's platform is `ios`. iOS uses native IPC (`ios/bridge.ts`), not the WebSocket bridge.
- **WebSocket endpoint is `/api/local-inference/device-bridge`.** Connections without the correct `?token=` query param are closed with code `4001`.
- **Model path resolution order:** env var → registry assignments.json → manifest.json → first `.gguf` in models dir → auto-download.
- **Registry and assignments** live at `$ELIZA_STATE_DIR/local-inference/registry.json` and `.../assignments.json`.
- **Auto-download dedup:** concurrent calls for the same model share one in-flight HuggingFace fetch via `inflightDownloads` map.
- **Android symlink aliasing:** `/data/user/0/<pkg>` and `/data/data/<pkg>` refer to the same directory. `setupAndroidBridgeEnvironment()` resolves `HOME` via `realpathSync` and remaps all env vars to the canonical prefix before installing the fs shim.
- **Pre-build manifest check:** `scripts/check-android-manifest.mjs` runs before every build and exits non-zero if `tools:*` attributes appear in the manifest without the `xmlns:tools` declaration.
- **No Plugin object.** This package does not follow the standard elizaOS plugin shape. It cannot be passed to `character.plugins`. It is imported and called directly by the agent bundle entry point.
- **ws is a runtime dep.** The `ws` package is loaded dynamically (`await import("ws")`) so the module can be bundled for environments where WebSocket is not needed.
