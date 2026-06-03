# @elizaos/plugin-browser

Adds browser automation and companion bridge management to an Eliza agent.

## Purpose / role

Owns the Eliza browser workspace (electrobun-embedded `BrowserView` on desktop, JSDOM fallback on web/mobile) and the Chrome/Safari Agent Browser Bridge companion extension surface. Loaded by the elizaOS runtime via the `browserPlugin` export. Auto-enabled when `config.features.browser` is truthy (checked by `auto-enable.ts`); disabled by default unless that config key is set.

## Plugin surface

### Actions

- **BROWSER** (`src/actions/browser.ts`) — Core browser control. Dispatches to the active `BrowserService` target. Subactions: `open`, `navigate`, `click`, `type`, `press`, `get`, `state`, `snapshot`, `screenshot`, `reload`, `back`, `forward`, `close`, `show`, `hide`, `wait`, `tab`, `realistic-click`, `realistic-fill`, `realistic-type`, `realistic-press`, `cursor-move`, `cursor-hide`, `autofill_login`. Role-gated OWNER only.
- **MANAGE_BROWSER_BRIDGE** (`src/actions/manage-browser-bridge.ts`) — Companion extension lifecycle for Chrome/Safari. Subactions: `install`, `reveal_folder`, `open_manager`, `refresh`. Role-gated OWNER only.

### Providers

- **browser_workspace** (`src/providers/workspace.ts`) — Injects live workspace mode (`desktop` / `web`) and open tab list (capped at 8 tabs) into agent context. Active when `browser` or `web` context is selected.

### Services

- **BrowserService** (`src/browser-service.ts`) — Pluggable target registry. Built-in targets: `workspace` (always registered), `bridge` (registered when `BrowserBridgeRouteService` is available), `stagehand` (registered when `ELIZA_BROWSER_STAGEHAND_COMMAND_URL` or `STAGEHAND_SERVER_URL` is configured). External plugins register additional targets via `BrowserService.registerTarget(target)`. Service type constant: `BROWSER_SERVICE_TYPE = "browser"`.
- **BrowserBridgeRouteService** (`src/service.ts`) — Interface (`BROWSER_BRIDGE_ROUTE_SERVICE_TYPE = "lifeops_browser_plugin"`) that a consumer (e.g. plugin-lifeops) implements. Owns companion pairing, sync, tab/page-context CRUD, and browser session management. The routes in this plugin call into the registered implementor.
- **Browser bridge policy** (`src/bridge-policy.ts`) — Pure token TTL / expiry, focus-window, and URL-domain helpers shared by host plugins.
- **Browser bridge readiness** (`src/bridge-readiness.ts`) — Pure companion recency, permission, pause, and readiness-state policy used by host plugins and UI surfaces that summarize bridge setup.
- **Browser bridge records** (`src/bridge-records.ts`) — Constructors for companion, tab, and page-context domain records. Host plugins persist records but should not redefine their shape/defaults.

### Routes

All under `/api/browser-bridge/` — defined in `src/plugin.ts` and handled by `src/routes/bridge.ts`:

Static: `GET /sessions`, `GET /settings`, `POST /settings`, `POST /companions/pair`, `POST /companions/auto-pair`, `GET /companions`, `POST /companions/revoke` (public), `GET /packages`, `POST /packages/open-path`, `POST /companions/sync` (public), `GET /tabs`, `GET /current-page`, `POST /sync`, `POST /sessions`.

Dynamic: `GET /sessions/:id`, `POST /sessions/:id/confirm`, `POST /sessions/:id/progress`, `POST /sessions/:id/complete`, `POST /companions/:id/revoke`, `POST /companions/sessions/:id/progress` (public), `POST /companions/sessions/:id/complete` (public), `GET|POST /packages/:browser/build|open-manager|download`.

Workspace setup routes: `src/routes/workspace-setup.ts` + `src/routes/workspace.ts`.

### Schema

`src/schema.ts` — Drizzle schema in the `browser` PostgreSQL schema (`pgSchema("browser")`). Tables: `browser_bridge_companions`, `browser_bridge_settings`, `browser_bridge_tabs`, `browser_bridge_page_contexts`. Applied via elizaOS `plugin-sql` migrator.

## Layout

```
src/
  index.ts                         Public barrel (re-exports + bundle-safety guard)
  plugin.ts                        browserPlugin export — actions, services, providers, routes, schema, autoEnable
  browser-service.ts               BrowserService + BrowserTarget interface + BROWSER_SERVICE_TYPE
  bridge-policy.ts                 Browser bridge token TTL / expiry, focus-window, and URL-domain helpers
  bridge-readiness.ts              Browser bridge readiness / permission policy helpers
  bridge-records.ts                Browser bridge companion/tab/page-context record constructors
  service.ts                       BrowserBridgeRouteService interface + BROWSER_BRIDGE_ROUTE_SERVICE_TYPE
  schema.ts                        Drizzle tables
  contracts.ts                     BrowserBridge* shared types (companions, settings, tabs, sessions)
  lifeops-session-contracts.ts     LifeOps browser session types
  packaging.ts                     Companion extension build/reveal/download helpers
  workspace.ts                     Workspace-level re-exports
  browser-capture-hooks.ts         BrowserCaptureHooks interface + global registration helpers
  browser-workspace-hooks.ts       BrowserWorkspaceHooks interface + global registration helpers
  actions/
    browser.ts                     BROWSER action
    browser-autofill-login.ts      autofill_login subaction (vault-gated)
    manage-browser-bridge.ts       MANAGE_BROWSER_BRIDGE action
  providers/
    workspace.ts                   browser_workspace provider
  routes/
    bridge.ts                      /api/browser-bridge/* route handler
    workspace-setup.ts             Workspace setup routes
    workspace.ts                   Workspace routes
    workspace-account-gate.ts      Account gate middleware
  targets/
    bridge-target.ts               `bridge` BrowserTarget — dispatches to Chrome/Safari companion
    stagehand-target.ts            `stagehand` BrowserTarget — Playwright/Stagehand fallback
  workspace/
    browser-workspace.ts           Public API surface and main command router (executeBrowserWorkspaceCommand)
    browser-workspace-types.ts     All workspace types and interfaces
    browser-workspace-state.ts     Mutable tab/session state
    browser-workspace-helpers.ts   Utilities and command normalization
    browser-workspace-desktop.ts   Desktop bridge HTTP client
    browser-workspace-jsdom.ts     JSDOM document loading and DOM setup
    browser-workspace-elements.ts  Element finding and selector parsing
    browser-workspace-forms.ts     Form interaction helpers
    browser-workspace-network.ts   Network interception and HAR
    browser-workspace-snapshots.ts Snapshots, diffs, screenshots
    browser-workspace-web.ts       Web-mode command execution
    browser-capture.ts             Frame capture loop (startBrowserCapture/stopBrowserCapture)
    index.ts                       Workspace barrel
auto-enable.ts                     Standalone shouldEnable check (no transitive plugin imports)
```

## Commands

```bash
bun run --cwd plugins/plugin-browser typecheck   # tsgo --noEmit type check
bun run --cwd plugins/plugin-browser test        # vitest run
bun run --cwd plugins/plugin-browser build       # tsup + tsc types into dist/
bun run --cwd plugins/plugin-browser clean       # rm -rf dist
```

## Config / env vars

| Variable | Required | Purpose |
|---|---|---|
| `ELIZA_BROWSER_STAGEHAND_COMMAND_URL` | no | Full URL to the Stagehand command endpoint; activates the `stagehand` target |
| `STAGEHAND_SERVER_URL` | no | Base URL for Stagehand; commands go to `<url>/api/browser-command` |
| `ELIZA_BROWSER_STAGEHAND_URL` | no | Alias for `STAGEHAND_SERVER_URL` |
| `ELIZA_BROWSER_STAGEHAND_AUTO_SETUP` | no | Set `false` to skip automatic `bun install` + build for the stagehand-server dir |
| `ELIZA_BROWSER_ALLOW_STAGEHAND_ON_MOBILE` | no | Set `true` to allow stagehand target on mobile runtimes |
| `ELIZA_MOBILE_PLATFORM` / `ELIZA_PLATFORM` / `CAPACITOR_PLATFORM` | no | Platform hint (`ios`/`android`/`mobile`) — changes target scoring |

Autofill-login vault keys (set by user via Settings → Vault → Logins, not env vars):
- `creds.<domain>.:autoallow = "1"` — enables agent autofill for that domain.

Plugin activation: `config.features.browser` must be truthy (object with `enabled !== false`, or `true`).

## How to extend

**Add a new browser target** (e.g. a Playwright-based target):
1. Create `src/targets/my-target.ts` exporting a factory that returns a `BrowserTarget` (interface in `src/browser-service.ts`).
2. Implement `id`, `name`, `description`, `kind`, `priority`, `available()`, and `execute(command)`. Throw a clear `Error` for unsupported subactions instead of silently ignoring them.
3. Register in `BrowserService.start` (in `src/browser-service.ts`) or let another plugin call `browserService.registerTarget(myTarget)` at init.

**Add a new action**:
1. Create `src/actions/my-action.ts` exporting an `Action` object.
2. Import it in `src/plugin.ts` and add to the `actions` array (wrap with `promoteSubactionsToActions` if it has subactions).
3. Export from `src/index.ts`.

**Add a new route**:
1. Add the path to `STATIC_ROUTES` or `DYNAMIC_ROUTES` in `src/plugin.ts`.
2. Add the handler branch in `src/routes/bridge.ts` → `handleBrowserBridgeRoutes`.

## Conventions / gotchas

- **Target routing is pluggable.** Do not hard-code target IDs in actions. The `BROWSER` action passes an optional `target` param; if omitted, `BrowserService.resolveTarget` picks the best available one by score and availability.
- **Bridge target availability** depends on `BrowserBridgeRouteService` being registered (by a plugin like plugin-lifeops) AND at least one companion being paired. The bridge target returns score `null` on mobile — it will not be selected there.
- **Autofill-login is vault-gated.** The agent cannot bypass the `creds.<domain>.:autoallow` flag. Do not add fallback flows that prompt the user interactively — the action is designed for autonomous use only when pre-authorized.
- **Companion auth headers.** Companion-scoped routes require `X-Browser-Bridge-Companion-Id` and `Authorization: Bearer <pairing-token>`. Legacy header names (`X-LifeOps-Browser-Companion-Id`, `x-eliza-browser-companion-id`) are not accepted.
- **Schema is in `browser` pg schema.** Do not use the `public` schema — the runtime migrator issues `CREATE SCHEMA IF NOT EXISTS browser` automatically.
- **Bundle-safety guard in `src/index.ts`.** The double-import pattern (re-export + local binding in `__bundle_safety_*`) prevents Bun's tree-shaker from collapsing barrel `init` functions to no-ops on mobile. Do not remove it.
- **`auto-enable.ts` must stay import-free.** The elizaOS auto-enable engine loads this module for every plugin at boot; it must not transitively import the plugin runtime.
- See the repo root AGENTS.md for global architecture rules (logger-only, ESM, dependency direction, etc.).
