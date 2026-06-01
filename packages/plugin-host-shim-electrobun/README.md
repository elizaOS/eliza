# @elizaos/plugin-host-shim-electrobun

Electrobun implementation of the [`@elizaos/plugin-host-shim`](../plugin-host-shim) cross-platform contract. Enables remote-mode elizaOS plugin view bundles to communicate with their host process when running inside an Electrobun BrowserView.

## What it does

Remote-mode plugins in elizaOS serve a view bundle — a self-contained JS bundle that renders a UI inside a sandboxed webview. That bundle needs a typed, platform-agnostic way to call back into the agent host (invoke providers, trigger actions, subscribe to events).

This package provides the Electrobun side of that bridge. It reads `globalThis.__elizaosElectrobunBridge` injected by the host preload script, wraps it in the `PluginHostShim` interface, and installs it as the module-level singleton. View code imports from `@elizaos/plugin-host-shim` only — it never knows it is running under Electrobun.

Parallel platform packages exist for iOS (`-ios`), Android (`-android`), and web (`@elizaos/plugin-host-shim` web variant).

## Usage

Inside a remote-mode plugin view bundle:

```ts
import { installElectrobunShim } from "@elizaos/plugin-host-shim-electrobun";
import { getHostShim } from "@elizaos/plugin-host-shim";

// Call once at bundle entry, before any getHostShim() usage.
installElectrobunShim();

// Anywhere in view code:
const shim = getHostShim();
const result = await shim.request("provider.spotify", { query: "jazz" });
shim.on("playback.changed", (data) => { /* ... */ });
```

`installElectrobunShim()` throws immediately if `__elizaosElectrobunBridge` is missing — a clear signal the view is not running inside the expected Electrobun host context.

## Wire protocol

| Direction | Envelope shape |
|---|---|
| View → host | `{ kind: "request", id: number, method: string, params: JsonValue }` |
| Host → view (response) | `{ id: number, ok: boolean, payload?: JsonValue, error?: string }` |
| Host → view (event) | `{ event: string, data: JsonValue }` |

View asset URLs are resolved via the `views://` URL scheme: `views://<pluginName>/<relativePath>`.

## Requirements

- Must run inside an Electrobun BrowserView with the elizaOS host preload script active.
- The host preload must set `globalThis.__elizaosElectrobunBridge` before the view bundle executes.

## Building

```bash
bun run --cwd packages/plugin-host-shim-electrobun build
```

This package is `private: true` and not published to npm. It is linked as a workspace dependency and bundled into view bundles at build time.
