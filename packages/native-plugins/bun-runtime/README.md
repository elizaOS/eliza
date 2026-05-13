# @elizaos/capacitor-bun-runtime

Native host package for the iOS local agent runtime work. The current Swift
implementation can run in two modes:

- `engine: "auto"` / `engine: "bun"`: dynamically loads the full
  `ElizaBunEngine.framework` from `@elizaos/bun-ios-runtime` when the app was
  built with `ELIZA_IOS_FULL_BUN_ENGINE=1`.
- `engine: "compat"`: hosts a `JSContext` compatibility bridge on a dedicated
  worker thread, installs the `__ELIZA_BRIDGE__` host functions, and loads the
  staged iOS agent payload from `public/agent/agent-bundle.js`.

The full Bun engine artifact is produced outside this package by the
`packages/bun-ios-runtime` build harness and an `elizaos/bun` fork.

The Android side is parked for now — the iOS path lands first; a JNI-backed
implementation will follow under the same JS surface.

## Install

```bash
bun add @elizaos/capacitor-bun-runtime
```

Capacitor 8 auto-discovers the plugin via the `capacitor.ios` block in
`package.json`. Re-run `pod install` after adding it so the
`ElizaosCapacitorBunRuntime` pod links into your iOS workspace. The pod links
`JavaScriptCore.framework` and `Network.framework`, depends on `Capacitor`, and
uses `LlamaCppCapacitor` for the native llama.cpp symbols in local builds.

## Bundle layout

The local iOS build stages these resources under `App/public/agent/`, which is
copied into the app bundle by Capacitor's `public` folder resource:

- `agent-bundle.js` — the Bun-targeted agent bundle from
  `packages/agent/dist-mobile-ios/`. Required for the full backend path.
- `pglite.wasm`, `initdb.wasm`, `pglite.data`, `vector.tar.gz`,
  `fuzzystrmatch.tar.gz` — PGlite runtime assets used by the agent bundle.
- `eliza-polyfill-prefix.js` — the polyfill prefix that maps `Bun.*` /
  `node:*` onto `__ELIZA_BRIDGE__` for the compatibility JSContext path.
  Optional; the runtime ships a minimal embedded fallback that just
  version-checks the bridge.

## Usage

```ts
import { ElizaBunRuntime } from "@elizaos/capacitor-bun-runtime";

// Auto-selects the full Bun engine when ElizaBunEngine.framework is embedded,
// otherwise falls back to the JSContext compatibility bridge.
await ElizaBunRuntime.start({ engine: "auto" });

// Require the full Bun engine. This returns { ok: false } if the framework is
// not embedded in the app bundle.
await ElizaBunRuntime.start({
  engine: "bun",
  argv: ["bun", "public/agent/agent-bundle.js", "ios-bridge", "--stdio"],
});

// Round-trips a chat message through the agent's send_message handler,
// which must have been registered via bridge.ui_register_handler.
const { reply } = await ElizaBunRuntime.sendMessage({ message: "hello" });

// Generic dispatch into any handler the agent registered.
const { result } = await ElizaBunRuntime.call({
  method: "http_request",
  args: { method: "GET", path: "/api/health" },
});

// Check ready state, current model, throughput.
const status = await ElizaBunRuntime.getStatus();

// Tear down the runtime. Releases the JSContext or full Bun engine host.
await ElizaBunRuntime.stop();
```

## Bridge contract

The full-engine ABI lives in
`packages/bun-ios-runtime/BRIDGE_CONTRACT.md`. The compatibility host still
implements the Swift `__ELIZA_BRIDGE__` v1 surface; breaking changes bump the
version string emitted in `globalThis.__ELIZA_BRIDGE_VERSION__`.

In full Bun mode, the Swift host loads `ElizaBunEngine.framework` with
`dlopen`, starts `agent-bundle.js ios-bridge --stdio`, and forwards React
requests through `ElizaBunRuntime.call({ method: "http_request", args })`.
`packages/ui/src/api/ios-local-agent-transport.ts` uses that path first when
the native plugin is available, then falls back to the foreground JSContext
ITTP kernel for compatibility builds.

## Llama backend

`llama_*` host functions delegate to `LlamaBridgeImpl`, which links against the
same `LlamaCpp.xcframework` built by the iOS local-inference pipeline. The
xcframework build also emits the small `eliza_llama_*` C helpers needed by the
Swift direct bridge.

## Events

The plugin emits two Capacitor events:

- `eliza:ui` — every `bridge.ui_post_message(channel, payload)` call.
  Subscribe with `ElizaBunRuntime.addListener("eliza:ui", handler)`.
- `eliza:runtime-exit` — fired when the agent calls
  `bridge.exit(code)`. Useful for surfacing crashes to the React shell.

## Limitations (v1)

- iOS-only. Android falls back to the `WebPlugin` stub.
- Full Bun is only used when `ElizaBunEngine.framework` is embedded. Otherwise
  `engine: "auto"` falls back to the compatibility JSContext host.
- The full Bun bridge currently buffers HTTP response bodies over stdio. It is
  correct for API calls, but token-by-token streaming needs a follow-up stream
  envelope.
- No `worker_threads.Worker` support in the compatibility host.
- No `child_process` — sandboxed out.
- `http_serve_*` is disabled on iOS. Foreground and route traffic uses
  Capacitor/engine IPC instead of a WebView-visible localhost listener.
- `bun:ffi.dlopen` is forbidden. The only FFI surface is the llama
  bridge.
