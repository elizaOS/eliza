# @elizaos/capacitor-bun-runtime

Native host package for the iOS local agent runtime work. The current Swift
implementation hosts a `JSContext` compatibility bridge on a dedicated worker
thread, installs the `__MILADY_BRIDGE__` host functions, and can load the
staged iOS agent payload from `public/agent/agent-bundle.js`. It is not yet the
full Bun engine; that still requires a signed iOS-compatible Bun runtime linked
into this pod.

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
- `milady-polyfill-prefix.js` — the polyfill prefix that maps `Bun.*` /
  `node:*` onto `__MILADY_BRIDGE__` for the compatibility JSContext path.
  Optional; the runtime ships a minimal embedded fallback that just
  version-checks the bridge.

## Usage

```ts
import { ElizaBunRuntime } from "@elizaos/capacitor-bun-runtime";

// Boots the current native host, installs the bridge, evaluates the staged
// bundle in the compatibility path, and invokes globalThis.startEliza() if
// exported.
await ElizaBunRuntime.start({});

// Round-trips a chat message through the agent's send_message handler,
// which must have been registered via bridge.ui_register_handler.
const { reply } = await ElizaBunRuntime.sendMessage({ message: "hello" });

// Generic dispatch into any handler the agent registered.
const { result } = await ElizaBunRuntime.call({
  method: "get_active_skill",
  args: { skillId: "weather" },
});

// Check ready state, current model, throughput.
const status = await ElizaBunRuntime.getStatus();

// Tear down the runtime. Releases the JSContext, cancels HTTP listeners.
await ElizaBunRuntime.stop();
```

## Bridge contract

The full host-function shape, threading rules, and lifecycle live in
`native/ios-bun-port/BRIDGE_CONTRACT.md`. This package implements the
Swift host for `v1` of that contract. Breaking changes bump the version
string emitted in `globalThis.__MILADY_BRIDGE_VERSION__`.

## Llama backend

`llama_*` host functions delegate to `LlamaBridgeImpl`, which links against the
same `LlamaCpp.xcframework` built by the iOS local-inference pipeline. The
xcframework build also emits the small `milady_llama_*` C helpers needed by the
Swift direct bridge.

## Events

The plugin emits two Capacitor events:

- `milady:ui` — every `bridge.ui_post_message(channel, payload)` call.
  Subscribe with `ElizaBunRuntime.addListener("milady:ui", handler)`.
- `milady:runtime-exit` — fired when the agent calls
  `bridge.exit(code)`. Useful for surfacing crashes to the React shell.

## Limitations (v1)

- iOS-only. Android falls back to the `WebPlugin` stub.
- Full Bun is not linked yet. The current implementation is the compatibility
  JSContext host plus native bridges.
- No `worker_threads.Worker` support in the compatibility host.
- No `child_process` — sandboxed out.
- HTTP-server bodies are buffered, not streamed.
- `bun:ffi.dlopen` is forbidden. The only FFI surface is the llama
  bridge.
