# @elizaos/plugin-registry

Plugin discovery, manifest reading, install/uninstall lifecycle, and HTTP route handlers for plugin management in elizaOS.

## What it does

`@elizaos/plugin-registry` consolidates the plugin-management HTTP API that was previously split across `@elizaos/agent` and `@elizaos/app-core`. It provides:

- **Plugin list API** — merges bundled plugins (from the static registry), runtime-loaded plugins, and store-installed plugins into a single list with enabled/active status, validation errors, and registry metadata (version, release stream, icon, links).
- **Plugin toggle and config** — `PUT /api/plugins/:id` enables/disables a plugin and writes config env vars; changes are applied to the live runtime when possible, or a restart is scheduled.
- **Install / update / uninstall** — `POST /api/plugins/install|update|uninstall` download or remove plugins from the npm registry, update `eliza.json`, and attempt a live runtime reload.
- **Advanced lifecycle operations** — eject a plugin to a local source checkout (`/eject`), sync it with upstream (`/sync`), or restore it to the registry version (`/reinject`).
- **Secrets surface** — `GET /api/secrets` aggregates all sensitive plugin parameters across the full plugin list; `PUT /api/secrets` bulk-writes secrets to `process.env`.
- **Plugin health probes** — `POST /api/plugins/:id/test` calls a plugin's `health`/`testConnection` method or performs a live connectivity check (e.g. Telegram bot token validation).
- **Core plugin management** — `GET /api/plugins/core` and `POST /api/plugins/core/toggle` manage optional core plugins via the `plugins.allow` list in `eliza.json`.
- **Drift diagnostics** — `GET /api/plugins/diagnostics` detects mismatches between the Settings UI model and the raw config.

## Exported API

```ts
import {
  // Agent-tier route handler
  handlePluginRoutes,
  type PluginRouteContext,

  // App-core compat-tier route handler + list builder
  handlePluginsCompatRoutes,
  buildPluginListResponse,

  // Install lifecycle forwarders (lazy-load; break app-core ↔ agent cycle)
  installPlugin,
  installAndRestart,
  uninstallPlugin,
  uninstallAndRestart,
  listInstalledPlugins,

  // Types
  type InstallPhase,
  type InstallProgress,
  type InstallResult,
  type ProgressCallback,
  type UninstallResult,
} from "@elizaos/plugin-registry";
```

## Route surface

### Agent-tier (`handlePluginRoutes`)

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/plugins` | Full plugin list |
| PUT | `/api/plugins/:id` | Toggle enabled / write config |
| GET | `/api/secrets` | Aggregate sensitive params |
| PUT | `/api/secrets` | Bulk-write secrets to env |
| POST | `/api/plugins/:id/test` | Plugin health probe |
| POST | `/api/plugins/install` | Install from npm registry |
| POST | `/api/plugins/update` | Update installed plugin |
| POST | `/api/plugins/uninstall` | Uninstall plugin |
| POST | `/api/plugins/:id/eject` | Eject to local source |
| POST | `/api/plugins/:id/sync` | Sync ejected plugin |
| POST | `/api/plugins/:id/reinject` | Restore to registry version |
| GET | `/api/plugins/installed` | List runtime-installed plugins |
| GET | `/api/plugins/ejected` | List ejected plugins |
| GET | `/api/core/status` | `@elizaos/core` eject status |
| GET | `/api/plugins/core` | Core + optional-core list |
| POST | `/api/plugins/core/toggle` | Toggle optional-core plugin |

### App-core compat-tier (`handlePluginsCompatRoutes`)

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/plugins` | Plugin list (registry + manifest + runtime) |
| GET | `/api/plugins/diagnostics` | Drift diagnostics |
| PUT | `/api/plugins/:id` | Toggle / config + vault mirror |
| POST | `/api/plugins/:id/test` | Connectivity test |
| POST | `/api/plugins/:id/reveal` | Reveal raw env value from vault |

## Required config / env

This package reads no env vars of its own. Plugin-specific env vars (e.g. `OPENAI_API_KEY`, `TELEGRAM_BOT_TOKEN`) are declared by each plugin's `pluginParameters` manifest entry and are read from `process.env` when building the plugin list or handling config writes.

The optional `ELIZA_SETTINGS_DEBUG` env var enables verbose before/after logging on PUT operations.

## Dependencies

- `@elizaos/core` — `AgentRuntime`, `logger`
- `@elizaos/shared` — shared request/response schemas, plugin constants
- `@elizaos/vault` — encrypted secret storage (via `@elizaos/app-core` vault-mirror service)

The canonical plugin install implementation lives in `@elizaos/agent`. The forwarders in `src/services/plugin-installer.ts` lazy-load it at call time to avoid a static circular dependency.
