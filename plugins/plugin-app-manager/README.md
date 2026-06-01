# @elizaos/plugin-app-manager

App lifecycle library for elizaOS. Provides hosted-app discovery, launch, run-state tracking, and the `/api/apps/*` HTTP route surface used by the elizaOS dashboard.

## What this package does

This is a **library**, not a registerable `Plugin` object. It is wired into `@elizaos/agent`'s HTTP server and provides:

- **App catalog** — queries `@elizaos/plugin-registry` for apps that have an `appInterface` in their registry metadata. Applies curated ordering and deduplication.
- **Launch** — installs the app's npm plugin (if not already installed), resolves a viewer URL (for iframe embedding), builds a session state, and creates a run record.
- **Run management** — tracks active runs in memory and on disk (`<stateDir>/apps/runs.v2.json`). Supports attach/detach viewer, heartbeat-based stale-run sweeping, and per-run event history.
- **REST routes** — the `handleAppsRoutes` function implements all `/api/apps/*` endpoints consumed by the dashboard UI.

## Capabilities added to an Eliza agent

When `@elizaos/agent` wires this package in, the agent's API server gains:

- Browse and search the elizaOS app catalog (`GET /api/apps`, `GET /api/apps/search`)
- Launch apps with automatic plugin install (`POST /api/apps/launch`)
- Track running apps with health and session state (`GET /api/apps/runs`)
- Stop apps by name or run ID (`POST /api/apps/stop`, `POST /api/apps/runs/:runId/stop`)
- Send messages and control commands into running apps (`POST /api/apps/runs/:runId/message`, `.../control`)
- Manage favorites (`GET/PUT /api/apps/favorites`)
- Load local app packages by directory (`POST /api/apps/load-from-directory`)
- Manage app permissions (`GET/PUT /api/apps/permissions/:slug`)

## Required env / config

| Variable | Default | Description |
|---|---|---|
| `ELIZA_APPS_REGISTRY_REFRESH_TIMEOUT_MS` | `5000` | Timeout (ms) for registry refresh during `listInstalled`. Minimum 250. |
| `ELIZA_ENABLE_LEGACY_APPS_WORKSPACE_DISCOVERY` | `false` | Set to `1`/`true` to also look in `apps/app-<slug>` directories for hero images. |
| `BOT_NAME` / `BOT_PASSWORD` | — | Substituted into `{BOT_NAME}` / `{RS_SDK_BOT_NAME}` template vars in app URLs. |
| `NODE_ENV` | — | `"production"` selects the production Hyperscape client URL. |

The run store path defaults to `<stateDir>/apps/runs.v2.json` where `stateDir` is resolved by `@elizaos/agent/config/paths`. Override per instance with `new AppManager({ stateDir: '/custom/path' })`.

## How to enable

This package is consumed by `@elizaos/agent`. No manual registration is needed in a standard elizaOS setup. If you are embedding the agent in a custom server, import and wire it:

```ts
import { AppManager, handleAppsRoutes } from "@elizaos/plugin-app-manager";

const appManager = new AppManager({ stateDir: myStateDir });
appManager.startStaleRunSweeper(() => agentRuntime);

// In your HTTP request handler:
const handled = await handleAppsRoutes({
  req, res, method, pathname, url,
  appManager,
  getPluginManager: () => pluginManager,
  parseBoundedLimit: (raw, fallback = 20) => Math.min(parseInt(raw ?? "", 10) || fallback, 100),
  readJsonBody, json, error,
  runtime: agentRuntime,
  favoriteApps: myFavoritesStore, // optional
});
```

Call `appManager.stopStaleRunSweeper()` on shutdown.

## Run store versioning

Active runs are persisted as `runs.v2.json`. On startup the `AppManager` reads and normalizes existing runs, automatically migrating from `runs.v1.json` if no v2 file exists. Corrupt files are renamed to `<name>.corrupt-<timestamp>.json` and ignored.
