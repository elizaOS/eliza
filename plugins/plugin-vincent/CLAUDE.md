# @elizaos/plugin-vincent

Vincent OAuth + Hyperliquid/Polymarket trading dashboard plugin for elizaOS agents.

## Purpose / role

Adds a Vincent trading integration to an Eliza agent: server-side OAuth (PKCE) against `heyvincent.ai`, REST API routes for connection state and strategy management, and a full-screen React dashboard view (plus XR and TUI variants). Loaded as a named plugin — register `vincentPlugin` from `@elizaos/plugin-vincent` in the agent's plugin list. No default auto-enable; opt-in per agent config.

## Plugin surface

Registered in `vincentPlugin` (exported from `src/plugin.ts`):

**Routes** (`rawPath: true` — paths are preserved without prefix):

| Method | Path | Purpose |
|--------|------|---------|
| POST | `/api/vincent/start-login` | Begin PKCE OAuth: register app with Vincent, generate verifier/challenge, return `authUrl` |
| GET | `/callback/vincent` | OAuth redirect target: exchange code for tokens, persist to config, return HTML close-tab page |
| GET | `/api/vincent/status` | Check connection state (`connected`, `connectedAt`, `tradingVenues`) |
| POST | `/api/vincent/disconnect` | Clear stored Vincent tokens |
| GET | `/api/vincent/trading-profile` | Fetch P&L profile (returns `null` profile until Vincent exposes data) |
| GET | `/api/vincent/strategy` | Current strategy config |
| POST | `/api/vincent/strategy` | Update strategy config (name, params, intervalSeconds, dryRun) |

**Views** (rendered by the agent UI):

| id | viewType | componentExport | bundlePath |
|----|----------|-----------------|------------|
| `vincent` | default | `VincentAppView` | `dist/views/bundle.js` |
| `vincent` | `xr` | `VincentAppView` | `dist/views/bundle.js` |
| `vincent` | `tui` | `VincentTuiView` | `dist/views/bundle.js` |

**Overlay app**: self-registers `vincentApp` via `registerOverlayApp` at import time (see `src/register.ts` → `src/vincent-app.ts`). Category: `trading`.

**Client extensions** (`src/client.ts`): monkey-patches `ElizaClient.prototype` with `vincentStartLogin`, `vincentStatus`, `vincentDisconnect`, `vincentStrategy`, `vincentUpdateStrategy`, `vincentTradingProfile`. Exported as typed `vincentClient`.

No actions, providers, services, or evaluators are registered.

## Layout

```
src/
  index.ts                     Package re-exports (everything public)
  plugin.ts                    vincentPlugin object — routes + views declarations
  register.ts                  Side-effect: self-registers overlay app at import time
  register-routes.ts           registerAppRoutePluginLoader (lazy plugin load)
  register-terminal-view.tsx   Registers the Vincent TUI view with @elizaos/tui terminal registry
  routes.ts                    handleVincentRoute — all OAuth + API route logic
  vincent-contracts.ts         Shared TS types/interfaces for all Vincent API shapes
  vincent-app.ts               vincentApp OverlayApp descriptor + registerOverlayApp call
  vincent-view-bundle.ts       Vite views-bundle entry — re-exports VincentAppView, VincentTuiView, and interact
  client.ts                    ElizaClient prototype extensions (vincentClient)
  VincentAppView.tsx           Full-screen overlay React component
  VincentAppView.helpers.ts    Shared helper utilities for VincentAppView
  VincentAppView.interact.ts   interact() capability handler for TUI agent-driven interaction
  VincentConnectionCard.tsx    OAuth connect/disconnect card
  TradingStrategyPanel.tsx     Strategy config UI panel
  TradingProfileCard.tsx       P&L analytics card
  WalletStatusCard.tsx         Agent wallet addresses + balances card
  useVincentDashboard.ts       Aggregated data hook (polls every 15 s when connected)
  useVincentState.ts           OAuth login-flow state hook (open external URL, poll for connection)
  ui.ts                        Re-exports of all UI components
  VincentTuiView.test.tsx      Unit tests for VincentTuiView
  components/
    VincentSpatialView.tsx     Spatial/XR view component using @elizaos/ui/spatial vocabulary
```

## Commands

```bash
bun run --cwd plugins/plugin-vincent build           # full build (JS + views + types)
bun run --cwd plugins/plugin-vincent build:js        # tsup JS bundle only
bun run --cwd plugins/plugin-vincent build:views     # Vite views bundle only
bun run --cwd plugins/plugin-vincent build:types     # tsc type declarations only
bun run --cwd plugins/plugin-vincent clean           # rm -rf dist
bun run --cwd plugins/plugin-vincent test            # vitest run
bun run --cwd plugins/plugin-vincent test:e2e:manual # real E2E tests (require live Vincent)
```

## Config / env vars

This plugin reads its state from the elizaOS config file via `@elizaos/agent/config/config`. No bare env vars are read directly. The plugin stores and reads the following fields inside the runtime config object (typed as `ElizaConfig`):

| Config key | Type | Description |
|------------|------|-------------|
| `config.vincent.accessToken` | `string` | Vincent OAuth access token |
| `config.vincent.refreshToken` | `string \| null` | OAuth refresh token |
| `config.vincent.clientId` | `string` | OAuth dynamic client ID |
| `config.vincent.connectedAt` | `number` | Unix timestamp of connection |
| `config.trading.strategy` | `VincentStrategyName` | `dca`, `rebalance`, `threshold`, or `manual` |
| `config.trading.params` | `Record<string, unknown>` | Strategy-specific params |
| `config.trading.intervalSeconds` | `number` | Execution interval |
| `config.trading.dryRun` | `boolean` | Dry-run flag |

All config persistence goes through `saveElizaConfig` / `loadElizaConfig` from `@elizaos/agent/config/config`.

The external OAuth endpoint is hardcoded: `https://heyvincent.ai`. No env override.

## How to extend

**Add a new API route:**

1. Add a handler branch in `src/routes.ts` inside `handleVincentRoute`.
2. Add a `Route` entry in the `vincentRoutes` array in `src/plugin.ts` (set `rawPath: true`).
3. Add any new request/response types to `src/vincent-contracts.ts`.
4. Add the corresponding client method to `src/client.ts` by extending `vincentPrototype`.

**Add a new view:**

1. Create the React component in `src/`.
2. Export it from `src/ui.ts` and `src/vincent-view-bundle.ts` (the Vite views bundle entry).
3. Add a view descriptor to the `views` array in `src/plugin.ts`.

## Conventions / gotchas

- **`rawPath: true` is required on all routes.** Without it the runtime adds a plugin-name prefix that breaks the OAuth redirect URI.
- **`/callback/vincent` is marked `public: true`** — this route must be reachable by the external browser before OAuth is complete.
- **PKCE code verifiers are in-memory only** (`pendingLogins` Map). Pending logins expire after 10 minutes; expired entries are swept on each `start-login` and each `/callback/vincent` call. A server restart during an OAuth flow requires starting login again.
- **OAuth redirect URI is always `http://<host>/callback/vincent`** using the `Host` header from the inbound request. This is intentionally HTTP/loopback since the redirect lands on the local agent server.
- **Views bundle is built separately** via `vite.config.views.ts`. The `build:views` step must run for the dashboard UI to work; `build:js` alone is insufficient.
- **Client prototype patching** in `src/client.ts` mutates `ElizaClient.prototype` at import time — import order matters if multiple plugins do this.
- **`interact()` in `VincentAppView.interact.ts`** provides TUI capabilities (`terminal-vincent-state`, `terminal-vincent-start-login`, `terminal-vincent-disconnect`, `terminal-vincent-update-strategy`) for agent-driven terminal interaction. It is split from `VincentAppView.tsx` to keep that file Fast-Refresh-compatible; the views bundle re-exports it via `vincent-view-bundle.ts`.
- Dependencies: `@elizaos/agent`, `@elizaos/app-core`, `@elizaos/core`, `@elizaos/shared`, `@elizaos/ui`, React 19, lucide-react.
