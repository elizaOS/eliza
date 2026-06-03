# @elizaos/plugin-hyperscape

Hyperscape game session resolvers — spectate-and-steer Eliza agent sessions with live data from the Hyperscape API.

## Purpose / role

This plugin integrates Hyperscape game sessions into an Eliza agent. It provides session lifecycle hooks (launch preparation, viewer auth, live session resolution, run refresh) that the elizaOS app-manager calls when the agent is running a Hyperscape app. It is an opt-in plugin; enable it by listing `@elizaos/plugin-hyperscape` in the agent's character plugin array.

The plugin registers three UI views (standard, XR, TUI) and exports route-module functions consumed by the elizaOS app-manager. It has no actions, providers, evaluators, or service classes.

## Plugin surface

### Views (registered in the Plugin object)

| id | path | viewType | componentExport | description |
|----|------|----------|-----------------|-------------|
| `hyperscape` | `/hyperscape` | default | `HyperscapeOperatorSurface` | Desktop/web operator surface |
| `hyperscape` | `/hyperscape` | `xr` | `HyperscapeOperatorSurface` | XR variant |
| `hyperscape` | `/hyperscape/tui` | `tui` | `HyperscapeTuiView` | Terminal operator surface |

### Route module exports (app-manager lifecycle hooks)

All exported from `src/routes.ts` and re-exported from `src/index.ts`.

| export | signature | purpose |
|--------|-----------|---------|
| `prepareLaunch` | `(ctx) => Promise<AppLaunchPreparation>` | Attempts wallet-auth against the Hyperscape API before the viewer opens |
| `resolveViewerAuthMessage` | `(ctx) => Promise<AppViewerAuthMessage \| null>` | Builds the `HYPERSCAPE_AUTH` postMessage credential for viewer auto-login |
| `collectLaunchDiagnostics` | `(ctx) => Promise<AppLaunchDiagnostic[]>` | Returns an error diagnostic when postMessage auth is requested but credentials are missing |
| `resolveLaunchSession` | `(ctx) => Promise<AppSessionState \| null>` | Fetches live session state from the Hyperscape API on launch |
| `refreshRunSession` | `(ctx) => Promise<AppSessionState \| null>` | Polls live session state during an active run |
| `stopRun` | `() => Promise<void>` | Clean teardown return (Hyperscape is stateless on the host side) |

### UI components and registration

`src/ui/index.ts` registers operator surfaces at startup via `@elizaos/app-core/ui-compat`:

| registration call | panel id / plugin id | component |
|-------------------|----------------------|-----------|
| `registerOperatorSurface` | `@elizaos/plugin-hyperscape` | `HyperscapeOperatorSurface` |
| `registerOperatorSurface` | `@hyperscape/plugin-hyperscape` | `HyperscapeOperatorSurface` (alias) |
| `registerDetailExtension` | `hyperscape-embedded-agents` | `HyperscapeDetailExtension` |

### TUI interact capabilities

`HyperscapeOperatorSurface.tsx` exports a top-level `interact` function for terminal surface automation:

- `terminal-hyperscape-state` — returns current TUI view metadata
- `terminal-hyperscape-command` — sends an operator message (`runId`, `content` required)
- `terminal-hyperscape-control` — sends a pause/resume control (`runId`, `action` required)

## Layout

```
src/
  index.ts                          Plugin entry; Plugin object (views) + re-exports
  routes.ts                         All app-manager lifecycle route hooks; Hyperscape API fetch logic
  ui/
    index.ts                        Registers operator surfaces + detail extension at import time
    HyperscapeOperatorSurface.tsx   Main operator surface (web + XR + TUI views, pause/resume, relay)
    HyperscapeDetailExtension.tsx   Detail-panel wrapper; renders HyperscapeOperatorSurface in "detail" variant
assets/
  hero.png                          App hero image referenced in package.json elizaos.app.heroImage
```

## Commands

Scripts from `package.json` — use these exact invocations:

```bash
bun run --cwd plugins/plugin-hyperscape build          # full build: JS + views + types
bun run --cwd plugins/plugin-hyperscape build:js       # tsup bundle only
bun run --cwd plugins/plugin-hyperscape build:views    # Vite views bundle (dist/views/bundle.js)
bun run --cwd plugins/plugin-hyperscape build:types    # tsc declarations only
bun run --cwd plugins/plugin-hyperscape clean          # rm -rf dist
```

The views bundle is built separately by `vite.config.views.ts` (Vite 8) and must be built before the plugin can serve UI at runtime.

## Config / env vars

All resolved via `runtime.getSetting(key)` first, then `process.env[key]`.

| var | required | purpose |
|-----|----------|---------|
| `HYPERSCAPE_API_URL` | recommended | Base URL of the Hyperscape API server (absolute http/https). Falls back to `HYPERSCAPE_CLIENT_URL` when absent. |
| `HYPERSCAPE_CLIENT_URL` | fallback | Viewer client origin; used as API base when `HYPERSCAPE_API_URL` is not set. Useful in local dev where API and client share an origin. |
| `HYPERSCAPE_AUTH_TOKEN` | optional | Bearer token for viewer auto-login. Populated automatically by the wallet-auth flow in `prepareLaunch` if absent. |
| `HYPERSCAPE_CHARACTER_ID` | optional | Hyperscape character ID to follow. Also populated automatically by the wallet-auth flow when the API returns one. |
| `EVM_PRIVATE_KEY` | optional | Used by `prepareWalletAuthFromRuntime` to derive an EVM address for wallet-auth when the runtime agent has no stored wallet address. |

If neither `HYPERSCAPE_API_URL` nor `HYPERSCAPE_CLIENT_URL` is set, all live session resolution is skipped silently and the viewer loads without pre-populated session state.

## How to extend

### Add a new route hook

1. Add the async function to `src/routes.ts` with a signature matching the corresponding `@elizaos/shared` type.
2. Export it from `src/routes.ts`. It is automatically re-exported by `src/index.ts` via `export * from "./routes.js"`.
3. Register it in the elizaOS app-manager config where this plugin's route module is referenced.

### Add a UI component

1. Create the component in `src/ui/`.
2. Export it from `src/ui/index.ts`.
3. If it should be a new view, add a view entry to the `views` array in `src/index.ts` with a unique `id`, `path`, `componentExport` name, and `bundlePath` pointing to `dist/views/bundle.js`.
4. Ensure the component is exported from the Vite views entry so the bundle includes it.

### Add a new TUI capability

Add a new `if (capability === "...")` branch to the `interact` function in `HyperscapeOperatorSurface.tsx` and document the expected `params` shape inline.

## Conventions / gotchas

- **No actions, providers, evaluators, or service classes.** This plugin is pure app-manager integration. Do not add elizaOS actions or providers here; they belong in a separate plugin.
- **Dual operator surface registration.** Both `@elizaos/plugin-hyperscape` and `@hyperscape/plugin-hyperscape` plugin IDs are registered as operator surfaces to support alternate plugin ID configs. Keep both registrations in sync.
- **`runtimePlugin` in package.json elizaos.app** is set to `@hyperscape/plugin-hyperscape` (the external namespace). This is intentional and distinct from the npm name `@elizaos/plugin-hyperscape`.
- **Views bundle is separate.** `build:views` produces `dist/views/bundle.js` via Vite; `build:js` produces the main ESM bundle via tsup. Both must be present for the plugin to work at runtime. The views bundle is referenced by `bundlePath` in each view definition.
- **Wallet auth is best-effort.** `prepareWalletAuthFromRuntime` silently skips all failures — network errors, missing credentials, API unavailability. The session will still load; it just won't have pre-populated auth.
- **`stopRun` returns cleanly by design.** Hyperscape holds no server-side state on the elizaOS host; the iframe unmount is sufficient teardown.
- **Fetch timeout constants:** `FETCH_TIMEOUT_MS = 8000` for live data, `HYPERSCAPE_WALLET_AUTH_TIMEOUT_MS = 5000` for wallet-auth. Adjust in `src/routes.ts` if the Hyperscape API is slow to respond.
