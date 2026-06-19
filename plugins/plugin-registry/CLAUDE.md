# @elizaos/plugin-registry

Plugin discovery, manifest reading, install/uninstall lifecycle, and HTTP route handlers for plugin management in elizaOS.

## Purpose / role

This package consolidates all plugin-management HTTP surfaces that were previously split across `@elizaos/agent` and `@elizaos/app-core`. It exposes two route-handler entry points plus thin forwarder functions for install/uninstall operations. It is a library package — not a runtime-loaded `Plugin` object — consumed by the agent HTTP server and by app-core's compat layer. Its `package.json` `agentConfig.pluginParameters` is empty (`{}`) because no runtime env vars are read directly by this package.

## Plugin surface

This package exports functions; it does not export a `Plugin` object with actions/providers/evaluators. Instead it exposes:

### Route handlers

- `handlePluginRoutes(ctx: PluginRouteContext): Promise<boolean>` — agent-tier handler for `/api/plugins/*`, `/api/secrets`, `/api/core/*`. Owned by `src/api/plugin-routes.ts`. Handles:
  - `GET /api/plugins` — full plugin list with registry metadata, enabled/active status, validation
  - `PUT /api/plugins/:id` — toggle enabled state or write config values; triggers live runtime mutation or schedules restart
  - `GET /api/secrets` / `PUT /api/secrets` — aggregate all sensitive plugin params
  - `POST /api/plugins/:id/test` — calls plugin's `health`/`healthCheck`/`testConnection` probe
  - `POST /api/plugins/install` — download from npm registry + auto-enable + apply/restart
  - `POST /api/plugins/update` — re-download newer version + apply/restart
  - `POST /api/plugins/uninstall` — remove package + apply/restart
  - `POST /api/plugins/:id/eject` — eject registry-installed plugin to local source checkout
  - `POST /api/plugins/:id/sync` — sync ejected plugin with upstream
  - `POST /api/plugins/:id/reinject` — restore ejected plugin to registry version
  - `GET /api/plugins/installed` — list runtime-installed (non-bundled) plugins
  - `GET /api/plugins/ejected` — list ejected plugins with upstream metadata
  - `GET /api/core/status` — whether `@elizaos/core` is ejected or npm-resolved
  - `GET /api/plugins/core` — core + optional-core plugins with loaded/enabled status
  - `POST /api/plugins/core/toggle` — toggle optional-core plugins via allow-list

- `handlePluginsCompatRoutes(req, res, state: CompatRuntimeState): Promise<boolean>` — app-core compat-tier handler for `/api/plugins/*` (agent-per-instance path). Owned by `src/api/app-plugins-routes.ts`. Handles:
  - `GET /api/plugins` — filtered plugin list from registry + manifest + runtime sources
  - `GET /api/plugins/diagnostics` — drift diagnostic between Settings model and config
  - `PUT /api/plugins/:id` — persist enable toggle + config values; vault mirror for sensitive fields
  - `POST /api/plugins/:id/test` — connectivity test (Telegram has a live HTTP probe; others return loaded status)
  - `POST /api/plugins/:id/reveal` — reveal raw env value from vault (allowlisted prefixes only; wallet prefixes require elevated auth)

- `buildPluginListResponse(runtime: AgentRuntime | null): { plugins: CompatPluginRecord[] }` — builds the compat plugin list by merging registry entries, manifest discovery, runtime-loaded plugins, and install records. Reconciles enabled-state drift between `plugins.entries` and `connectors`/`streaming` compat sections on first call per process.

### Install forwarders (lazy-load to break `app-core ↔ agent` cycle)

All implementations live in `@elizaos/agent`; these are thin async wrappers with a shared module cache:

- `installPlugin` — download + record in `plugins.installs`
- `installAndRestart` — install then schedule runtime restart
- `uninstallPlugin` — remove + clean install record
- `uninstallAndRestart` — uninstall then schedule restart
- `listInstalledPlugins` — read install records

## Layout

```
src/
  index.ts                     Public barrel — all exports
  api/
    plugin-routes.ts           handlePluginRoutes — agent-tier HTTP handler (~1946 lines)
    app-plugins-routes.ts      handlePluginsCompatRoutes + buildPluginListResponse (~1762 lines)
  services/
    plugin-installer.ts        Lazy forwarders to @elizaos/agent install functions
```

## Commands

```bash
bun run --cwd plugins/plugin-registry typecheck   # tsgo --noEmit type check
bun run --cwd plugins/plugin-registry build       # tsup JS + tsc --noCheck types
bun run --cwd plugins/plugin-registry clean       # rm -rf dist
```

## Config / env vars

This package reads no env vars directly. Plugin configuration env vars (e.g. `OPENAI_API_KEY`, `TELEGRAM_BOT_TOKEN`) are read from `process.env` when building the plugin list or validating config; they are declared by each individual plugin's `pluginParameters` manifest, not by this package.

Env vars consumed indirectly at route-handler call time:

- `ELIZA_SETTINGS_DEBUG` — if truthy, logs detailed before/after config state on PUT operations in the **agent-tier handler** only (via `isElizaSettingsDebugEnabled()` from `@elizaos/shared`; used in `src/api/plugin-routes.ts`)
- `TELEGRAM_BOT_TOKEN` / `TELEGRAM_API_ROOT` — read in the Telegram plugin test probe inside `handlePluginsCompatRoutes`

## How to extend

### Add a new route to the agent-tier handler

1. Open `src/api/plugin-routes.ts`.
2. Add a new `if (method === "..." && pathname === "/api/...")` block before the final `return false`.
3. Destructure any new helpers you need from `ctx: PluginRouteContext`. For a new helper, add it to the `PluginRouteContext` interface and wire it in `@elizaos/agent`'s server where `handlePluginRoutes` is called.
4. Return `true` to signal the request was handled.

### Add a new route to the compat-tier handler

1. Open `src/api/app-plugins-routes.ts`.
2. Add a route block before the final `return false`.
3. Use `ensureRouteAuthorized(req, res, state)` for auth gating. Use `ensureCompatSensitiveRouteAuthorized` for wallet-class secrets.
4. Return `true` when handled.

### Add a new install forwarder

1. Open `src/services/plugin-installer.ts`.
2. Add a new `export async function` that calls `(await load()).<agentFunctionName>(...)`.
3. Export the function from `src/index.ts`.

## Conventions / gotchas

- **No `Plugin` object.** This package is a library, not a loaded elizaOS plugin. Do not add an `export const plugin: Plugin = { ... }` unless elizaOS adds a plugin-registry loading hook.
- **Lazy load in `plugin-installer.ts`.** The `import("@elizaos/agent")` is intentionally deferred to break the `app-core ↔ agent` circular module dependency. Do not convert it to a static import.
- **`PluginRouteContext` is injected by the caller.** All route helpers (masking, broadcast, restart scheduling) come from the agent's `server.ts`; this file never reaches across into agent internals directly.
- **`buildPluginListResponse` reconciles drift once per process.** The `_enabledStateReconciled` flag means `reconcilePluginEnabledStates()` runs only on the first call. In tests, reset it if you need a clean state.
- **Registry metadata lookup is multi-candidate.** `registryLookupCandidates` tries `npmName`, `name`, `id`, `@elizaos/plugin-<id>`, and `@elizaos/app-<id>` to handle legacy `app-*` package names.
- **Vault mirror on PUT.** `handlePluginsCompatRoutes` calls `mirrorPluginSensitiveToVault` after saving config. Vault failures surface as `vaultMirrorFailures` in the response; they do not roll back the config write.
- **In-flight deduplication.** `GET /api/plugins` in the agent-tier handler uses a `WeakMap` keyed on `state` to coalesce concurrent list-build calls. Any code touching `pluginsListInFlight` must preserve this behaviour.
