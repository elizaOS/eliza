# @elizaos/plugin-host-shim-android

Android WebView bridge for elizaOS remote-mode plugin views.

## What it does

elizaOS plugins can ship view bundles — JavaScript that renders a UI inside a native WebView. On Android, the view bundle needs a way to call back into the Bun runtime (to invoke providers, actions, and listen for events) without an HTTP server. This package supplies that bridge.

It implements the cross-platform `PluginHostShim` interface using Android's `JavascriptInterface` mechanism:

1. The Kotlin host exposes `ElizaosAndroidBridge` on the WebView via `addJavascriptInterface`.
2. The view bundle calls `installAndroidShim()` from this package during its bootstrap phase.
3. `installAndroidShim()` registers `window.__elizaosAndroidDeliver` as the delivery hook for host→view messages, and wraps `ElizaosAndroidBridge.postMessage(...)` for view→host requests.
4. Plugin view code then uses `getHostShim()` from `@elizaos/plugin-host-shim` — the same API on every platform.

## Installation

This package is `private` and is not published to npm. It is bundled into the Android host app's JavaScript entry point as part of the elizaOS Android build.

Add it as a workspace dependency:

```json
"dependencies": {
  "@elizaos/plugin-host-shim-android": "workspace:*"
}
```

## Usage in a view bundle

```ts
// android-bootstrap.ts (entry point bundled into the WebView)
import { installAndroidShim } from "@elizaos/plugin-host-shim-android";

installAndroidShim(); // must run before any plugin view code

// Plugin view code then uses the platform-agnostic API:
import { getHostShim } from "@elizaos/plugin-host-shim";
const shim = getHostShim();
const result = await shim.request("provider.get", { name: "myProvider" });
shim.on("plugin.stateChanged", (data) => console.log(data));
```

## Kotlin-side requirements

```kotlin
// Configure WebViewAssetLoader for plugin assets
val assetLoader = WebViewAssetLoader.Builder()
    .addPathHandler("/plugins/", PluginAssetHandler(...))
    .build()

// Expose the bridge before loading the view bundle
webView.addJavascriptInterface(ElizaosAndroidBridgeImpl(runtime), "ElizaosAndroidBridge")
webView.loadUrl("https://appassets.androidplatform.net/views/index.html")
```

The bridge object must implement:
- `@JavascriptInterface fun postMessage(message: String)` — receives JSON-encoded request envelopes from the view and routes them to the Bun runtime.

The Kotlin side must call back into the WebView via:
```kotlin
webView.evaluateJavascript("window.__elizaosAndroidDeliver(${json})", null)
```

## Wire format

All messages are JSON strings passed through the `JavascriptInterface`.

| Direction | Format |
|---|---|
| view → host | `{ kind: "request", id: number, method: string, params: JsonValue }` |
| host → view | `{ kind: "response", id: number, ok: boolean, payload?: JsonValue, error?: string }` |
| host → view | `{ kind: "event", event: string, data: JsonValue }` |

## Related packages

- [`@elizaos/plugin-host-shim`](../plugin-host-shim) — cross-platform interface definition
- [`@elizaos/plugin-host-shim-ios`](../plugin-host-shim-ios) — iOS WKWebView implementation
- [`@elizaos/plugin-host-shim-electrobun`](../plugin-host-shim-electrobun) — Electrobun desktop implementation
- [`@elizaos/plugin-remote-manifest`](../plugin-remote-manifest) — shared manifest types
