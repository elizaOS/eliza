# @elizaos/plugin-clawville

elizaOS app plugin that connects Eliza agents to ClawVille, a sea-themed 3D agent game.

## Purpose / role

Adds the ClawVille game as an embedded app inside an Eliza agent runtime. When the app is launched, the plugin connects the agent to `https://api.clawville.world`, establishes a persistent bot identity keyed on `eliza:<agentId>`, and exposes a set of HTTP routes that proxy game commands back to the ClawVille backend. The plugin is **opt-in** — it must be registered via `createAppClawvillePlugin()` or its default export.

## Plugin surface

This plugin registers **no actions, providers, evaluators, or services** in the standard elizaOS sense. Instead it uses the `app` plugin type with:

| Registration point | ID / name | What it does |
|---|---|---|
| `plugin.app` | `ClawVille` | App manifest (`launchType: "connect"`, `launchUrl`, `capabilities`) |
| `plugin.views[0]` | `clawville` (standard) | `ClawvilleOperatorSurface` React component, path `/clawville` |
| `plugin.views[1]` | `clawville` (xr) | Same component in XR viewType |
| `plugin.views[2]` | `clawville` (tui) | `ClawvilleTuiView` terminal surface, path `/clawville/tui` |
| UI operator surface | `@elizaos/plugin-clawville` | `ClawvilleOperatorSurface` — registered via `registerOperatorSurface` |
| UI detail extension | `clawville-control` | `ClawvilleDetailExtension` — registered via `registerDetailExtension` |

HTTP routes (handled by `handleAppRoutes`):

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/apps/clawville/viewer` | Fetches `clawville.world/game`, rewrites asset URLs to absolute, injects embed bootstrap script, serves with CSP `frame-ancestors` |
| `GET` | `/api/apps/clawville/session/:sessionId` | Session state poll — perception + telemetry for the side panel |
| `POST` | `/api/apps/clawville/session/:sessionId/message` | NL command router — interprets free text and dispatches to move/visit-building/chat |
| `POST` | `/api/apps/clawville/session/:sessionId/move` | Proxy to `POST /api/agent/:sessionId/move` |
| `POST` | `/api/apps/clawville/session/:sessionId/visit-building` | Proxy to `POST /api/agent/:sessionId/visit-building` |
| `POST` | `/api/apps/clawville/session/:sessionId/chat` | Proxy to `POST /api/agent/:sessionId/chat` |
| `POST` | `/api/apps/clawville/session/:sessionId/buy` | Returns 400 — buy is not exposed by the current ClawVille API |

## Layout

```
plugins/plugin-clawville/
├── package.json                    # elizaos.app manifest, build scripts
├── src/
│   ├── index.ts                    # Plugin factory (createAppClawvillePlugin), re-exports
│   ├── clawville-auth.ts           # Config resolution, ClawVille fetch helpers
│   │                               #   resolveClawvilleConfig, clawvilleConnect,
│   │                               #   clawvillePerception, proxyClawvilleRequest,
│   │                               #   stashClawvilleSession
│   ├── routes.ts                   # All HTTP route logic
│   │                               #   resolveLaunchSession — /connect on first launch
│   │                               #   refreshRunSession — perception poll for panel refresh
│   │                               #   handleAppRoutes — main request dispatcher
│   │                               #   collectLaunchDiagnostics — diagnostic checks
│   └── ui/
│       ├── index.ts                # Registers operator surface + detail extension
│       ├── ClawvilleOperatorSurface.tsx  # Main game operator panel
│       └── ClawvilleDetailExtension.tsx  # Side-panel detail widget
├── vite.config.views.ts            # Vite config for building UI views bundle
└── assets/
    └── hero.png                    # App card hero image
```

## Commands

Only scripts defined in this package's `package.json`:

```bash
bun run --cwd plugins/plugin-clawville build          # build:js + build:views + build:types
bun run --cwd plugins/plugin-clawville build:js       # tsup (ESM output)
bun run --cwd plugins/plugin-clawville build:views    # Vite views bundle (dist/views/bundle.js)
bun run --cwd plugins/plugin-clawville build:types    # tsc --noCheck declaration emit
bun run --cwd plugins/plugin-clawville clean          # rm -rf dist
```

No test script is defined in this package.

## Config / env vars

All settings are optional; production defaults work out of the box. Settings are read from `runtime.getSetting(key)` first, then `process.env[key]`.

| Env var | Default | Purpose |
|---|---|---|
| `CLAWVILLE_API_URL` | `https://api.clawville.world` | ClawVille backend base URL. Override for staging/local dev. |
| `CLAWVILLE_VIEWER_URL` | `https://clawville.world/game` | Source URL for the embedded viewer HTML. |
| `CLAWVILLE_SESSION_ID` | _(auto-stashed)_ | Set by `stashClawvilleSession` after first `/connect`. Avoids reconnect on every panel refresh. |
| `CLAWVILLE_BOT_UUID` | _(auto-stashed)_ | Opaque bot primary key from ClawVille's `openclaw_bots` table. |
| `CLAWVILLE_WALLET_ADDRESS` | _(auto-stashed)_ | Base58 Solana public key of the pet's custodial wallet. |

No API keys are required. ClawVille uses a runtime-trust model — the plugin is the trust boundary.

## How to extend

**Add an action (game command):**
1. Add a new subroute string to the `ClawvilleSubroute` union in `src/routes.ts`.
2. Add a branch in `parseSessionSubroute` to recognise the path segment.
3. Handle the new subroute in `proxyCommand` — either proxy it via `proxyClawvilleRequest` or return a structured error.
4. Add it to `buildCommandResult`'s `resultMessage` switch.
5. Register the route in `handleAppRoutes`.

**Add a building:**
Buildings are declared in the `BUILDINGS` const array in `src/routes.ts`. Each entry has an `id`, `label`, and `aliases` array used for NL command resolution. Add a new entry there.

**Add a UI panel:**
Add a new React component under `src/ui/`, export it from `src/ui/index.ts`, and register it with `registerDetailExtension` or `registerOperatorSurface` from `@elizaos/ui`.

**Add a view:**
Add a new entry to the `views` array in `createAppClawvillePlugin()` in `src/index.ts`. The `bundlePath` must point to a component exported from `dist/views/bundle.js` (built by `build:views`).

## Conventions / gotchas

- **Runtime-trust auth**: There are no API keys. ClawVille trusts any request arriving from this plugin. Do not add auth tokens speculatively.
- **Session stashing**: `stashClawvilleSession` stores session state onto the runtime via `setSetting`. If the runtime does not implement `setSetting`, it fails silently — `refreshRunSession` will reconnect via `resolveLaunchSession`.
- **Viewer rewrite**: `buildEmbeddedViewerHtml` fetches the live ClawVille page and rewrites relative asset URLs to absolute. A live network connection to `clawville.world` is required at plugin startup.
- **`buy` subroute**: The buy command always returns HTTP 400. It exists in the route table for API shape completeness but the ClawVille backend does not expose a buy endpoint for agents.
- **Views bundle**: `src/ui/` is built by Vite (`build:views`), not tsup. Components exported from the views bundle must be listed by `componentExport` name in the `views` array.
- **ESM only**: `"type": "module"` in package.json. All imports must use `.js` extensions.
- Logging uses `logger` from `@elizaos/core` with `[ClawVille]` prefix. See root AGENTS.md for logger conventions.
