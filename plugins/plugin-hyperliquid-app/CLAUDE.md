# @elizaos/plugin-hyperliquid-app

Native Hyperliquid perpetual-market integration for elizaOS agents: status, markets, positions, and open orders via read-only routes and a conversational action.

## Purpose / role

Adds Hyperliquid perpetual-market capabilities to an Eliza agent. Registers an action (`PERPETUAL_MARKET`), a service (`PerpetualMarketService`), eleven HTTP routes under `/api/hyperliquid/`, and three UI views (standard, XR, TUI). Loaded opt-in via `registerAppRoutePluginLoader`; see `src/register-routes.ts`. Execution (order placement) is intentionally disabled — only read operations are implemented.

## Plugin surface

### Actions
| Name | File | Description |
|---|---|---|
| `PERPETUAL_MARKET` | `src/actions/perpetual-market.ts` | Routes to a registered perpetual market provider. `action=read` with `kind` (status/markets/market/positions/funding). `action=place_order` returns a disabled-execution notice. Similes cover many legacy `HYPERLIQUID_*` names for retrieval compat. |

### Services
| Name / type | File | Description |
|---|---|---|
| `PerpetualMarketService` (`perpetual-market`) | `src/actions/perpetual-market.ts` | Provider registry; starts with the Hyperliquid provider registered. Expose `registerProvider()` to add more perpetual venues. |

### Routes (registered in `src/plugin.ts`)
All routes are `rawPath: true`. POST routes always return 501 (execution disabled).

| Method | Path | Description |
|---|---|---|
| GET | `/api/hyperliquid/status` | Credential and readiness status |
| GET | `/api/hyperliquid/markets` | All perpetual markets from Hyperliquid Info API |
| GET | `/api/hyperliquid/funding` | Current funding rates and asset contexts from Hyperliquid Info API |
| GET | `/api/hyperliquid/positions` | Account positions (requires account address) |
| GET | `/api/hyperliquid/orders` | Open orders (requires account address) |
| POST | `/api/hyperliquid/orders/open` | Disabled — returns 501 |
| POST | `/api/hyperliquid/orders/close` | Disabled — returns 501 |
| POST | `/api/hyperliquid/leverage` | Disabled — returns 501 |
| POST | `/api/hyperliquid/margin` | Disabled — returns 501 |
| POST | `/api/hyperliquid/bridge` | Disabled — returns 501 |
| POST | `/api/hyperliquid/tpsl` | Disabled — returns 501 |

### Views (registered in `src/plugin.ts`)
| id | viewType | Component |
|---|---|---|
| `hyperliquid` | default | `HyperliquidAppView` |
| `hyperliquid` | `xr` | `HyperliquidAppView` |
| `hyperliquid` | `tui` | `HyperliquidTuiView` |

## Layout

```
src/
  index.ts                  Public package exports
  plugin.ts                 Plugin object: actions, services, routes, views, dispose
  register.ts               Side-effect: imports hyperliquid-app (registers overlay app)
  register-routes.ts        Side-effect: calls registerAppRoutePluginLoader
  register-terminal-view.tsx  Exports registerHyperliquidTerminalView / setHyperliquidTerminalSnapshot
  hyperliquid-app.ts        Overlay app definition + registerOverlayApp call
  hyperliquid-app.test.ts   Tests for overlay app registration
  hyperliquid-app-view-bundle.ts  View bundle entry helpers
  hyperliquid-contracts.ts  All shared types + string constants (HYPERLIQUID_API_BASE etc.)
  routes.ts                 handleHyperliquidRoute — actual HTTP logic + Hyperliquid Info API client
  routes.contract.test.ts   Contract-level route tests
  routes.real.test.ts       Real-API route integration tests
  client.ts                 Extends ElizaClient prototype with hyperliquidStatus/Markets/Positions/Orders
  ui.ts                     Public re-export barrel (HyperliquidAppView, interact, useHyperliquidState, hyperliquidApp)
  useHyperliquidState.ts    React hook; calls all four read endpoints, manages loading/error state
  useHyperliquidState.test.ts  Tests for the hook
  HyperliquidAppView.tsx    React UI components: HyperliquidAppView (standard + XR) and HyperliquidTuiView (TUI)
  HyperliquidAppView.interact.ts  Interaction helpers for HyperliquidAppView
  HyperliquidTuiView.test.tsx  Unit test for TUI view
  HyperliquidVisualCopy.test.ts  Visual copy tests
  components/
    HyperliquidSpatialView.tsx   Spatial/XR view component; exports HyperliquidSpatialView, HyperliquidSnapshot, HyperliquidStatusSnapshot
    HyperliquidSpatialView.test.tsx  Tests for spatial view
    contract.ts              Component contract definitions
  __fixtures__/              Test fixtures
  actions/
    perpetual-market.ts     PERPETUAL_MARKET action + PerpetualMarketService + provider pattern
__tests__/
  perpetual-market.test.ts  Action-level tests
  smoke.test.ts             Smoke tests
  app-core-shim.ts          Test shim for @elizaos/app-core
```

## Commands

```bash
bun run --cwd plugins/plugin-hyperliquid-app build        # tsup JS + vite views + tsc types
bun run --cwd plugins/plugin-hyperliquid-app build:js     # tsup only
bun run --cwd plugins/plugin-hyperliquid-app build:views  # vite views bundle
bun run --cwd plugins/plugin-hyperliquid-app build:types  # tsc declarations
bun run --cwd plugins/plugin-hyperliquid-app test         # vitest run
bun run --cwd plugins/plugin-hyperliquid-app clean        # rm -rf dist
```

## Config / env vars

All resolved in `routes.ts::resolveHyperliquidConfig`. None are required for public market reads.

| Env var | Required | Description |
|---|---|---|
| `HYPERLIQUID_ACCOUNT_ADDRESS` or `HL_ACCOUNT_ADDRESS` | No | EVM address for account-specific reads (positions, orders). Must be `0x`-prefixed 40-char hex. |
| `STEWARD_EVM_ADDRESS` | No | Managed-vault EVM address (takes priority over env account). |
| `ELIZA_MANAGED_EVM_ADDRESS` | No | Fallback managed EVM address. |
| `STEWARD_API_URL` | No | Presence flags vault as configured even without address. |
| `ELIZA_WALLET_BACKEND` | No | Set to `steward` to flag vault configured. |
| `EVM_PRIVATE_KEY` | No | Local signer private key (0x-prefixed 64-char hex). Enables `credentialMode=local_key`. |
| `HYPERLIQUID_PRIVATE_KEY` or `HL_PRIVATE_KEY` | No | Aliases for local signer key. |
| `HYPERLIQUID_AGENT_KEY` or `HL_AGENT_KEY` | No | Optional API-wallet delegation key. |

The action (`PERPETUAL_MARKET`) calls the agent's local API via `resolveDesktopApiPort(process.env)` and authenticates with `resolveApiToken(process.env)` from `@elizaos/shared`.

## How to extend

**Add a new action:** Create `src/actions/<name>.ts`, export an `Action` object, import it in `src/plugin.ts`, and append to the `actions` array.

**Add a perpetual market provider (e.g. dYdX):** Implement the `PerpetualMarketProvider` interface defined in `src/actions/perpetual-market.ts` and call `service.registerProvider(provider)` inside a plugin `init` hook or custom service. The provider receives `op` (`read` | `place_order`) and `options`, and returns `ActionResult`.

**Add a new route:** Extend `src/routes.ts::handleHyperliquidRoute` with a new pathname branch, and declare the route in `src/plugin.ts::hyperliquidRoutes`.

**Add a new view:** Build the component in a new TSX file, export it from `src/ui.ts`, and add a view entry to `src/plugin.ts::views`. Vite picks up exports via `vite.config.views.ts`.

## Conventions / gotchas

- **Execution is permanently disabled** in this read-only app. All POST routes return 501. The `place_order` action op always returns an error explaining why. This is intentional.
- **Route handler bridging:** The elizaOS `Route` type uses `RouteRequest`/`RouteResponse`; the route logic expects Node `http.IncomingMessage`/`http.ServerResponse`. `plugin.ts` casts via `toHttpIncomingMessage`/`toHttpServerResponse` — keep these guards if adding routes.
- **`funding` kind is wired through `metaAndAssetCtxs`.** The action reads `/api/hyperliquid/funding` and can optionally filter by `coin` / `asset` / `symbol`.
- **Context gating:** `PERPETUAL_MARKET` only fires when `state` contains a `finance`, `crypto`, `trading`, or `payments` selected context, OR when the message contains recognized keywords in ~8 languages. Do not remove the keyword list without updating tests.
- **`HyperliquidClient`** is created by patching `ElizaClient.prototype` at import time (`src/client.ts`). Import `"./client"` as a side effect before calling the extended methods.
- **Overlay app registration** (`src/hyperliquid-app.ts`) happens as a side effect when `src/register.ts` is imported. The plugin entrypoint exports `src/register.ts` so this is automatic when the plugin loads.
- **Terminal view registration** (`src/register-terminal-view.tsx`) must be called explicitly via `registerHyperliquidTerminalView()` to wire the TUI view into the terminal registry.
- Upstream API: `https://api.hyperliquid.xyz/info` (POST, public). No API key required for market/position reads.
- See root `AGENTS.md` for repo-wide architecture rules, logger conventions, ESM/naming standards, and git workflow.
