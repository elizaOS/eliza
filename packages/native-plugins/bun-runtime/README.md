# @elizaos/capacitor-bun-runtime

Embedded Bun-shape JavaScript runtime for iOS. Hosts a `JSContext` on a
dedicated worker thread, installs the `__MILADY_BRIDGE__` host functions
documented in `native/ios-bun-port/BRIDGE_CONTRACT.md`, and loads an agent
bundle (`agent-bundle-ios.js`) from the app bundle resources.

The Android side is parked for now — the iOS path lands first; a JNI-backed
implementation will follow under the same JS surface.

## Install

```bash
bun add @elizaos/capacitor-bun-runtime
```

Capacitor 8 auto-discovers the plugin via the `capacitor.ios` block in
`package.json`. Re-run `pod install` after adding it so the
`ElizaosCapacitorBunRuntime` pod links into your iOS workspace. The pod
links `JavaScriptCore.framework` and `Network.framework` and depends on
`Capacitor`.

## Bundle layout

The runtime expects the following resources inside the app `.app` bundle
(add them to the Xcode `App` target):

- `agent-bundle-ios.js` — the compiled agent bundle. Required.
- `milady-polyfill-prefix.js` — the polyfill prefix that maps `Bun.*` /
  `node:*` onto `__MILADY_BRIDGE__`. Optional; the runtime ships a
  minimal embedded fallback that just version-checks the bridge.

## Usage

```ts
import { ElizaBunRuntime } from "@elizaos/capacitor-bun-runtime";

// Boots the JSContext, installs the bridge, evaluates the agent bundle,
// and invokes globalThis.startEliza() if exported.
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

`llama_*` host functions currently return canned responses so the
end-to-end JS path can be exercised. The wiring point for the real
backend (via `LlamaCppCapacitor`) is documented inline in
`ios/Sources/ElizaBunRuntimePlugin/bridge/LlamaBridge.swift`. M09 of the
iOS Bun port replaces the stub with the real call.

## Events

The plugin emits two Capacitor events:

- `milady:ui` — every `bridge.ui_post_message(channel, payload)` call.
  Subscribe with `ElizaBunRuntime.addListener("milady:ui", handler)`.
- `milady:runtime-exit` — fired when the agent calls
  `bridge.exit(code)`. Useful for surfacing crashes to the React shell.

## Limitations (v1)

- iOS-only. Android falls back to the `WebPlugin` stub.
- No `worker_threads.Worker` support — single-threaded JSContext.
- No `child_process` — sandboxed out.
- HTTP-server bodies are buffered, not streamed.
- `bun:ffi.dlopen` is forbidden. The only FFI surface is the llama
  bridge.
