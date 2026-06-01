# @elizaos/plugin-host-shim

Cross-platform contract for remote-mode elizaOS plugin views.

## What it is

When an elizaOS plugin runs in **remote mode**, its UI is a JavaScript bundle loaded inside a platform webview (Electrobun BrowserView, iOS WKWebView, Android WebView, or a web iframe). This package defines the uniform `PluginHostShim` interface that the view bundle uses to communicate with the host agent — regardless of platform.

The contract covers three operations:

- **`resolveViewUrl`** — convert a relative plugin asset path to an absolute URL the platform can load.
- **`request`** — send a host-mediated RPC call (to a provider, action, or event sink in the agent runtime).
- **`on`** — subscribe to host-pushed events; returns an unsubscribe function.

## How it works

This package provides the interface and a module-level singleton slot. One of four platform-specific packages installs a concrete implementation before the view bundle runs:

| Platform | Package |
|---|---|
| Electrobun desktop | `@elizaos/plugin-host-shim-electrobun` |
| iOS WKWebView | `@elizaos/plugin-host-shim-ios` |
| Android WebView | `@elizaos/plugin-host-shim-android` |
| Web / XR iframe | `@elizaos/plugin-host-shim` (`./web` subpath) |

## Usage inside a view bundle

```ts
// 1. Install the platform shim once, early in the bundle entry point.
//    Only one of these imports is needed — choose the right one for the target.
import { installElectrobunShim } from "@elizaos/plugin-host-shim-electrobun";
installElectrobunShim();

// For web/XR iframes, use the built-in web shim instead:
// import { installWebShim } from "@elizaos/plugin-host-shim/web";
// installWebShim({ parentOrigin: "https://your-dashboard.example.com" });

// 2. Anywhere else in the bundle, get the shim and use it.
import { getHostShim } from "@elizaos/plugin-host-shim";

const shim = getHostShim();
const ctx = await shim.request("provider.get", { name: "spotify" });
shim.on("plugin.event", (payload) => { /* handle */ });
```

## RPC method convention

Methods passed to `request` follow the `surface.target` pattern:

- `provider.<name>` — invoke a named provider's `get` handler
- `action.<name>` — invoke a named action's handler
- `event.<name>` — emit a named event into the agent runtime

## Web shim wire format

The `./web` implementation uses `window.parent.postMessage` with the following envelope:

```
{ kind: "elizaos.shim.request",  id, method, params }   // view → parent
{ kind: "elizaos.shim.response", id, ok, payload?, error? }  // parent → view
{ kind: "elizaos.shim.event",    event, data }           // parent → view
```

The parent frame forwards requests to the agent at `/api/plugins/remote/:name/invoke`.

## Building a new platform shim

1. Depend on `@elizaos/plugin-host-shim` (`workspace:*`).
2. Import `installHostShim` and `PluginHostShim`.
3. Implement the three interface methods for the target platform's bridge/IPC mechanism.
4. Call `installHostShim(shim)` once.
5. Export an `install<Platform>Shim()` function for view bundle authors.

See `packages/plugin-host-shim-electrobun/src/index.ts` for a full example.
