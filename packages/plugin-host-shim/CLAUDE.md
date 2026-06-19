# @elizaos/plugin-host-shim

Cross-platform contract that view JavaScript (shipped by a remote-mode elizaOS plugin) uses to talk to its host environment.

## Purpose / role

This package defines the `PluginHostShim` interface and the module-level singleton that holds an active shim instance. It does **not** contain any platform-specific wiring — instead, one of four platform packages installs an implementation at runtime:

- `@elizaos/plugin-host-shim-electrobun` — Electrobun BrowserView via `globalThis.__elizaosElectrobunBridge`
- `@elizaos/plugin-host-shim-ios` — iOS WKWebView bridge
- `@elizaos/plugin-host-shim-android` — Android WebView bridge
- `@elizaos/plugin-host-shim` (`./web` export) — web/XR iframe via `window.parent.postMessage`

View bundle code always imports from `@elizaos/plugin-host-shim` (the contract); the platform package is imported once, early in the bundle, to install the concrete implementation.

## Layout

```
packages/plugin-host-shim/
  src/
    index.ts      PluginHostShim interface, getHostShim(), installHostShim(), resetHostShim()
    web.ts        Web/XR iframe implementation (installWebShim()); exported as the ./web subpath
  dist/           Compiled output (tsc --noCheck); two entry points: index.js + web.js
  package.json    Exports "." and "./web"
  tsconfig.json
  tsconfig.build.json
```

## Key exports / surface

### `@elizaos/plugin-host-shim` (main entry)

| Export | Kind | Description |
|---|---|---|
| `PluginHostShim` | interface | Contract every platform shim must satisfy |
| `getHostShim()` | function | Returns the active shim; throws if none installed |
| `installHostShim(shim)` | function | Called once by the platform package to register its implementation |
| `resetHostShim()` | function | Resets to `null`; test-only — never call in production |

### `@elizaos/plugin-host-shim/web` (subpath export)

| Export | Kind | Description |
|---|---|---|
| `installWebShim(options?)` | function | Builds and installs the web/XR iframe shim; calls `installHostShim()` internally |

### `PluginHostShim` interface

```ts
interface PluginHostShim {
  resolveViewUrl(pluginName: string, relativePath: string): URL;
  request<T extends JsonValue = JsonValue>(method: string, params: JsonValue): Promise<T>;
  on(event: string, handler: (data: JsonValue) => void): () => void;
}
```

`request` method convention — `method` follows `surface.target`:
- `provider.<name>` — invoke a provider's `get`
- `action.<name>` — invoke an action's handler
- `event.<name>` — emit an event into the runtime

`on` returns an unsubscribe function.

## Wire envelope (web shim)

The `./web` shim communicates with the parent frame via `window.parent.postMessage`:

```
{ kind: "elizaos.shim.request",  id, method, params }   // view → parent
{ kind: "elizaos.shim.response", id, ok, payload?, error? }  // parent → view
{ kind: "elizaos.shim.event",    event, data }           // parent → view
```

The parent frame is expected to forward requests to the agent HTTP API at `/api/plugins/remote/:name/invoke`.

## Commands

```bash
bun run --cwd packages/plugin-host-shim build       # tsc --noCheck (emits dist/)
bun run --cwd packages/plugin-host-shim typecheck   # tsgo --noEmit (full type check)
bun run --cwd packages/plugin-host-shim test        # bun test src/
bun run --cwd packages/plugin-host-shim lint        # biome check src/
bun run --cwd packages/plugin-host-shim lint:fix    # biome check --write src/
bun run --cwd packages/plugin-host-shim clean       # rm -rf dist
```

## Dependencies

- `@elizaos/plugin-remote-manifest` (workspace) — provides `JsonValue` type used in all method signatures

## How to extend

### Implement a new platform shim

1. Create a new package (e.g. `packages/plugin-host-shim-<platform>`).
2. Depend on `@elizaos/plugin-host-shim` (`workspace:*`).
3. Import `installHostShim` and `PluginHostShim` from `@elizaos/plugin-host-shim`.
4. Build an object satisfying `PluginHostShim` (implement `resolveViewUrl`, `request`, `on`).
5. Call `installHostShim(shim)` once, early in the view bundle initialization.
6. Export an `install<Platform>Shim()` function so view bundle authors have a single import to call.

See `packages/plugin-host-shim-electrobun/src/index.ts` for a concrete reference.

## Conventions / gotchas

- **One shim per page.** `installHostShim` overwrites the singleton; calling it twice from two different platform packages in the same page will silently discard the first one.
- **`resetHostShim()` is test-only.** Calling it in production leaves `getHostShim()` in a throwing state for the rest of the page lifetime.
- **View bundles must be served at `/api/views/:id/bundle.js`** (or the platform-equivalent URL). The `resolveViewUrl` method in each shim knows the per-platform asset URL scheme — use it rather than constructing URLs manually.
- **`installWebShim` options:** `parentOrigin` defaults to `"*"` for dev convenience; pin it to the dashboard origin in production. `viewsBasePath` defaults to `"/api/views"`.
- `JsonValue` comes from `@elizaos/plugin-remote-manifest`, not from a local definition — do not redefine it.
- This package is `"private": true` and lives only in the monorepo workspace. It is not published to npm independently.
- For repo-wide conventions (logging, ESM, architecture rules, naming), see the root `AGENTS.md`.
