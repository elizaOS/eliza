# @elizaos/plugin-host-shim-ios

iOS (WKWebView) implementation of the `PluginHostShim` contract. Bridges remote-mode plugin view bundles running in a `WKWebView` to the in-process Bun runtime (`plugin-capacitor-bridge`) via `WKScriptMessageHandler`.

## Purpose / role

This package is one of four platform shim packages in the host-shim ecosystem:

| Package | Platform |
|---|---|
| `@elizaos/plugin-host-shim-ios` (this) | iOS — WKWebView + WKScriptMessageHandler |
| `@elizaos/plugin-host-shim-android` | Android WebView |
| `@elizaos/plugin-host-shim-electrobun` | Desktop — Electrobun BrowserView |
| `@elizaos/plugin-host-shim` (`./web`) | Web/XR iframe via `window.postMessage` |

View bundle code always imports from `@elizaos/plugin-host-shim` (the cross-platform contract); this package is imported exactly once, early in the bundle, to install the iOS concrete implementation by calling `installHostShim(shim)` from `@elizaos/plugin-host-shim`.

The package is `"private": true` — it is not published to npm and lives only in the monorepo workspace.

## Layout

```
packages/plugin-host-shim-ios/
  src/
    index.ts          Full implementation — installIosShim(), wire-envelope handling
  dist/               Compiled output (tsc --noCheck via tsconfig.build.json)
  package.json        Single "." export → dist/index.js
  tsconfig.json       Check-only (noEmit: true)
  tsconfig.build.json Build tsconfig (noCheck + emit)
```

## Key exports / surface

### `@elizaos/plugin-host-shim-ios`

| Export | Kind | Description |
|---|---|---|
| `installIosShim()` | function | Creates and installs the iOS shim; throws if `window.webkit.messageHandlers.elizaosBridge` is absent |

`installIosShim()` returns the installed `PluginHostShim` instance (from `@elizaos/plugin-host-shim`).

Call it once at the top of the iOS view bundle entry file — before any view code calls `getHostShim()`.

```ts
import { installIosShim } from "@elizaos/plugin-host-shim-ios";
installIosShim();
```

After installation, view code uses the contract package as usual:

```ts
import { getHostShim } from "@elizaos/plugin-host-shim";
const shim = getHostShim();
const result = await shim.request("provider.myProvider", { key: "value" });
shim.on("plugin.event", (data) => { /* ... */ });
```

## Wire envelope

Messages flow over the `elizaosBridge` `WKScriptMessageHandler`. The JSON shape is the same as the Electrobun preload bridge:

```
View → Swift:     { kind: "request",  id, method, params }
Swift → View:     { kind: "response", id, ok, payload?, error? }
Swift → View:     { kind: "event",    event, data }
```

Swift delivers responses and events back to the view by calling `window.__elizaosIosDeliver(data)` via `evaluateJavaScript`. The shim installs that global at setup time.

### Asset URL scheme

`resolveViewUrl(pluginName, relativePath)` returns:

```
app-resource://plugin/<encodedName>/<relativePath>
```

The iOS host app must register a custom URL scheme handler for `app-resource://` that serves files from the app sandbox.

## Commands

```bash
bun run --cwd packages/plugin-host-shim-ios build       # tsc --noCheck (emits dist/)
bun run --cwd packages/plugin-host-shim-ios typecheck   # tsgo --noEmit (full type check)
bun run --cwd packages/plugin-host-shim-ios test        # bun test src/
bun run --cwd packages/plugin-host-shim-ios lint        # biome check src/
bun run --cwd packages/plugin-host-shim-ios lint:fix    # biome check --write src/
bun run --cwd packages/plugin-host-shim-ios clean       # rm -rf dist
```

## Dependencies

- `@elizaos/plugin-host-shim` (workspace) — provides `PluginHostShim`, `installHostShim()`
- `@elizaos/plugin-remote-manifest` (workspace) — provides the `JsonValue` type used in `request` / `on` signatures

## How to extend

### Modify request handling

All request/response/event dispatch lives in `src/index.ts` in `installIosShim()`. The `pending` map tracks in-flight `request` calls by numeric `id`; `subscribers` tracks `on` listeners by event name. Both dispatch paths are inside `window.__elizaosIosDeliver`.

### Add a new shim method

1. Add the method to the `PluginHostShim` interface in `@elizaos/plugin-host-shim/src/index.ts`.
2. Implement it in the `shim` object inside `installIosShim()` in `src/index.ts`.
3. Implement it in all other platform shims (android, electrobun, web).

## Conventions / gotchas

- **Swift prerequisite.** `installIosShim()` throws immediately if `window.webkit.messageHandlers.elizaosBridge` is not present. The `WKWebView` must be configured with an `elizaosBridge` `WKScriptMessageHandler` before the view bundle runs.
- **`window.__elizaosIosDeliver` is overwritten on each call.** Only one shim should be installed per page — calling `installIosShim()` twice replaces the deliver callback silently.
- **`app-resource://` scheme must be registered.** The iOS host app is responsible for registering the custom URL scheme handler; this package only constructs the URL.
- **No Node.js or Bun APIs.** This code runs in a `WKWebView` — DOM-only environment. The `lib` in `tsconfig.json` is `["ES2022", "DOM"]`.
- For repo-wide conventions (logging, ESM, architecture rules, naming), see the root `AGENTS.md`.
