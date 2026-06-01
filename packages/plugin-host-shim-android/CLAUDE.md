# @elizaos/plugin-host-shim-android

Android WebView implementation of the `PluginHostShim` contract for elizaOS remote-mode plugin views.

## Purpose / role

This package provides the Android-side wire adapter that connects a remote-mode plugin's view bundle (running inside a `WebView`) to the in-process Bun runtime. It implements the `PluginHostShim` interface defined in `@elizaos/plugin-host-shim` using Android's `JavascriptInterface` mechanism: the Kotlin side exposes `globalThis.ElizaosAndroidBridge` via `addJavascriptInterface`, and this package installs `globalThis.__elizaosAndroidDeliver` as the reverse callback.

Consumed by: the Android host app (Kotlin/Java), which calls `installAndroidShim()` from the bootstrapped view bundle before any plugin view code runs.

## Layout

```
packages/plugin-host-shim-android/
  src/
    index.ts           Single entry — exports installAndroidShim()
  dist/                Compiled output (tsc, ESNext, DOM lib)
  package.json
  tsconfig.json        Typecheck config (noEmit, strict, DOM lib)
  tsconfig.build.json  Build config (extends tsconfig.json, noEmit:false)
```

## Key exports

```ts
import { installAndroidShim } from "@elizaos/plugin-host-shim-android";
```

### `installAndroidShim(): PluginHostShim`

Reads `window.ElizaosAndroidBridge` (must be set before calling), wires up the bidirectional JSON message channel, registers `window.__elizaosAndroidDeliver` as the host→view delivery hook, and calls `installHostShim(shim)` from `@elizaos/plugin-host-shim` so `getHostShim()` works in view bundle code.

Throws if `window.ElizaosAndroidBridge` is absent (configuration error on the Kotlin side).

The returned `PluginHostShim` includes a `resolveViewUrl(pluginName, relativePath)` method that returns `https://appassets.androidplatform.net/plugins/<name>/<path>` — the URL scheme served by Android's `WebViewAssetLoader`. This is not a standalone export; access it via the returned shim object.

### Message wire format

- **view → host (request):** `bridge.postMessage(JSON.stringify({ kind: "request", id, method, params }))`
- **host → view (response):** `__elizaosAndroidDeliver(JSON.stringify({ kind: "response", id, ok, payload?, error? }))`
- **host → view (event):** `__elizaosAndroidDeliver(JSON.stringify({ kind: "event", event, data }))`

## Sibling packages

| Package | Role |
|---|---|
| `@elizaos/plugin-host-shim` | Defines `PluginHostShim` interface + `installHostShim` / `getHostShim` |
| `@elizaos/plugin-host-shim-ios` | iOS WKWebView implementation |
| `@elizaos/plugin-host-shim-electrobun` | Electrobun desktop implementation |
| `@elizaos/plugin-remote-manifest` | Provides `JsonValue` type |

## Commands

```bash
bun run --cwd packages/plugin-host-shim-android build       # tsc compile → dist/
bun run --cwd packages/plugin-host-shim-android clean       # rm -rf dist
bun run --cwd packages/plugin-host-shim-android typecheck   # tsgo --noEmit
bun run --cwd packages/plugin-host-shim-android test        # bun test src/
bun run --cwd packages/plugin-host-shim-android lint        # biome check src
bun run --cwd packages/plugin-host-shim-android lint:fix    # biome check --write src
```

## Config / env vars

None. All configuration is implicit in the WebView setup on the Kotlin side:
- `webView.addJavascriptInterface(bridge, "ElizaosAndroidBridge")` must be called before the view bundle executes.
- `WebViewAssetLoader` must be configured to serve plugin assets under `https://appassets.androidplatform.net/plugins/`.

## How to extend

**Change the asset URL scheme:** Update `resolveViewUrl` in `src/index.ts`. The Kotlin `WebViewAssetLoader` path prefix must match.

**Add a new message kind:** Add a discriminated-union branch in `window.__elizaosAndroidDeliver` alongside the existing `isResponse` / `isEvent` guards. Define a matching type guard following the existing pattern.

**Add a new shim method:** Add it to the `shim` object literal, update the `PluginHostShim` interface in `@elizaos/plugin-host-shim`, then implement both the view-side call (JSON into `bridge.postMessage`) and the Kotlin-side handler.

## Conventions / gotchas

- **DOM lib required.** `tsconfig.json` includes `"lib": ["ES2022", "DOM"]` because this code runs inside a WebView, not in Node/Bun. Do not remove the DOM lib.
- **Private package.** `"private": true` — not published to npm; bundled into the Android host app's JS entry point.
- **`installAndroidShim` must run before any `getHostShim()` calls.** The Kotlin side must invoke the view bundle's bootstrap entry (which calls `installAndroidShim()`) before plugin view code executes.
- **Request IDs are sequential integers per shim instance.** `nextId` is module-local; a new shim instance resets the counter, so do not create multiple shim instances in one WebView session.
- **JSON-only wire.** All data crossing the bridge is serialized as JSON strings. `JsonValue` from `@elizaos/plugin-remote-manifest` enforces this at the type level.
