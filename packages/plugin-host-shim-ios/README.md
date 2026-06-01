# @elizaos/plugin-host-shim-ios

iOS (WKWebView) implementation of the elizaOS `PluginHostShim` contract.

## What it does

Remote-mode elizaOS plugins can ship a view bundle — a small JS app that runs inside a platform-native webview. On iOS that webview is a `WKWebView`. This package provides the glue:

1. **Swift side:** The iOS host app registers an `elizaosBridge` `WKScriptMessageHandler` on the `WKWebView` and forwards messages into the in-process Bun runtime (`plugin-capacitor-bridge` → `RemotePluginBridge`). Responses and events come back via `evaluateJavaScript("window.__elizaosIosDeliver(...)")`.
2. **JS side (this package):** `installIosShim()` wires `window.webkit.messageHandlers.elizaosBridge` into a `PluginHostShim` that view bundle code uses through the contract package `@elizaos/plugin-host-shim`.

## Wire envelope

```
View → Swift  { kind: "request",  id, method, params }
Swift → View  { kind: "response", id, ok, payload?, error? }
Swift → View  { kind: "event",    event, data }
```

Same JSON shape as the Electrobun preload bridge, so view code is portable across platforms.

## Usage in a view bundle

```ts
// Entry point of the iOS view bundle — call before any other shim access.
import { installIosShim } from "@elizaos/plugin-host-shim-ios";
installIosShim();

// Anywhere in the view bundle:
import { getHostShim } from "@elizaos/plugin-host-shim";
const shim = getHostShim();

const data = await shim.request("provider.myProvider", { key: "value" });
const unsub = shim.on("plugin.event", (payload) => console.log(payload));
```

`installIosShim()` throws if `window.webkit.messageHandlers.elizaosBridge` is not present — make sure the Swift `WKWebView` is configured before the bundle runs.

## Asset URL scheme

`resolveViewUrl(pluginName, relativePath)` returns URLs of the form:

```
app-resource://plugin/<name>/<path>
```

The iOS host app must register a custom URL scheme handler for `app-resource://` that serves files from the app sandbox.

## Related packages

| Package | Purpose |
|---|---|
| `@elizaos/plugin-host-shim` | Cross-platform contract (`PluginHostShim` interface) |
| `@elizaos/plugin-host-shim-android` | Android WebView implementation |
| `@elizaos/plugin-host-shim-electrobun` | Desktop Electrobun BrowserView implementation |
| `@elizaos/plugin-remote-manifest` | Provides the `JsonValue` type |

## Development

```bash
bun run --cwd packages/plugin-host-shim-ios build       # compile to dist/
bun run --cwd packages/plugin-host-shim-ios typecheck   # full type check
bun run --cwd packages/plugin-host-shim-ios test        # run tests
bun run --cwd packages/plugin-host-shim-ios lint        # biome check
```
