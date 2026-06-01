# @elizaos/plugin-host-shim-electrobun

Electrobun (Bun + native webview) implementation of the `PluginHostShim` cross-platform contract. Wires remote-mode plugin view bundles to the Electrobun preload bridge and onward to `RemotePluginBridge` in the host process.

## Purpose / role

Remote-mode elizaOS plugins serve a view bundle that runs inside a sandboxed webview. This package is the Electrobun-specific glue: it reads `globalThis.__elizaosElectrobunBridge` (injected by the `app-core/platforms/electrobun` host preload script), wraps it in the typed `PluginHostShim` interface from `@elizaos/plugin-host-shim`, and installs it as the module singleton. View bundle code can then call `getHostShim()` from `@elizaos/plugin-host-shim` without knowing which platform it runs on.

Parallel implementations for other platforms live in sibling packages:
- `@elizaos/plugin-host-shim-ios`
- `@elizaos/plugin-host-shim-android`
- `@elizaos/plugin-host-shim` (also exports a `web.ts` iframe variant)

## Layout

```
packages/plugin-host-shim-electrobun/
  src/
    index.ts          Single entry point — exports installElectrobunShim()
  dist/               Compiled output (tsc, not bundled)
  tsconfig.json       Typecheck config (lib: ES2022 + DOM)
  tsconfig.build.json Build config (noCheck, emits .js + .d.ts)
  package.json
```

## Key exports

```ts
import { installElectrobunShim } from "@elizaos/plugin-host-shim-electrobun";
```

| Export | Description |
|---|---|
| `installElectrobunShim()` | Reads `globalThis.__elizaosElectrobunBridge`, builds the `PluginHostShim`, installs it as the singleton via `installHostShim`, and returns it. Throws if the bridge global is absent. |

`PluginHostShim` surface (defined in `@elizaos/plugin-host-shim`):

| Method | Description |
|---|---|
| `resolveViewUrl(pluginName, relativePath)` | Returns a `URL` object with scheme `views://<pluginName>/<relativePath>` — the URL scheme Electrobun uses for plugin assets. |
| `request(method, params)` | Sends a `{ kind:"request", id, method, params }` envelope over the bridge and awaits the `response` reply. |
| `on(event, handler)` | Subscribes to `event` envelopes from the host. Returns an unsubscribe function. |

## Wire envelope

The Electrobun bridge exchanges plain JSON objects over the preload channel:

- Host → view response: `{ id: number; ok: boolean; payload?: JsonValue; error?: string }`
- Host → view event: `{ event: string; data: JsonValue }`
- View → host request: `{ kind: "request"; id: number; method: string; params: JsonValue }`

Method names follow the `surface.target` convention from the remote-plugin wire spec (e.g., `provider.spotify`, `action.search`, `event.ready`).

## Commands

```bash
bun run --cwd packages/plugin-host-shim-electrobun build       # tsc compile → dist/
bun run --cwd packages/plugin-host-shim-electrobun typecheck   # tsgo --noEmit
bun run --cwd packages/plugin-host-shim-electrobun test        # bun test src/
bun run --cwd packages/plugin-host-shim-electrobun lint        # biome check src
bun run --cwd packages/plugin-host-shim-electrobun lint:fix    # biome check --write src
bun run --cwd packages/plugin-host-shim-electrobun clean       # rm -rf dist
```

## Config / env vars

None. The Electrobun bridge is injected by the host preload at runtime via `globalThis.__elizaosElectrobunBridge`. No environment variables are read by this package.

## How to extend

This package has one function and one runtime assumption (the bridge global). Common extension scenarios:

**Add a new method to the shim contract:**
1. Add the method signature to `PluginHostShim` in `packages/plugin-host-shim/src/index.ts`.
2. Implement it in the `shim` object in `src/index.ts` here, using `bridge.postMessage` / `bridge.addListener` as needed.
3. Implement the same method in the sibling platform packages.

**Support a new envelope kind:**
- Add a new `bridge.addListener(kind, ...)` call in `installElectrobunShim`.
- Add a corresponding type guard (pattern: `isResponse`, `isEvent` at the bottom of `src/index.ts`).

## Conventions / gotchas

- **Call `installElectrobunShim()` before any `getHostShim()` call.** The singleton starts null; `getHostShim()` throws if nothing has been installed.
- **Must run inside an Electrobun BrowserView.** The function throws immediately if `__elizaosElectrobunBridge` is undefined, which happens in any non-Electrobun context (browser, Node, Bun CLI, iOS, Android). Platform detection is intentionally fail-fast.
- **`private: true` package** — not published to npm. It is bundled into view bundles at app build time.
- **DOM lib required** — `tsconfig.json` includes `"lib": ["ES2022", "DOM"]` because view bundles run in a webview. Do not strip the DOM lib.
- **No elizaOS Plugin object** — this is not a plugin loaded by `AgentRuntime`. It is a build-time library linked into remote-plugin view bundles.
