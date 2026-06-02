# @elizaos/plugin-polymarket-app

Adds Polymarket prediction-market discovery, orderbook reading, position viewing, and trading-readiness context to an Eliza agent.

## Purpose / role

Opt-in elizaOS plugin. Load it by adding `@elizaos/plugin-polymarket-app` to the agent's plugin list. It registers one read-only action, one provider, one service, seven REST routes, and three UI views (desktop, XR, TUI). Public market reads are always available; signed CLOB order placement is not exposed as an agent action until real signing is implemented.

## Plugin surface

### Actions
- **`PREDICTION_MARKET`** — unified prediction-market router. Dispatches to `PredictionMarketService`.
  - `action=read, kind=status` — configuration and readiness report.
  - `action=read, kind=markets` — paginated active market list from Gamma API.
  - `action=read, kind=market` — single market by `id` or `slug`.
  - `action=read, kind=orderbook` — full CLOB orderbook for a `tokenId`.
  - `action=read, kind=positions` — wallet positions from Data API.
  - Legacy read similes (still accepted): `POLYMARKET_READ`, `POLYMARKET_STATUS`, `POLYMARKET_GET_MARKETS`, `POLYMARKET_GET_ORDERBOOK`, and related read-only aliases (full list in `POLYMARKET_READ_COMPAT_SIMILES`, actions.ts).

### Providers
- **`POLYMARKET_STATUS`** (`polymarketStatusProvider`) — injects per-turn context text: public-read readiness, API base URLs, trading credential status. Active only in `finance` / `crypto` contexts.

### Services
- **`PredictionMarketService`** (type `"prediction-market"`) — extensible provider registry. Starts with `polymarket` registered. Accepts additional providers via `registerProvider()`. Accessed by the action via `runtime.getService("prediction-market")`.

### Routes (all `rawPath: true`)
| Method | Path | Notes |
|--------|------|-------|
| GET | `/api/polymarket/status` | Credential and readiness summary |
| GET | `/api/polymarket/markets` | Paginated markets (`limit`, `offset`, `active`, `closed`, `order`, `ascending`, `tag_id`) |
| GET | `/api/polymarket/market` | Single market (`id` or `slug`) |
| GET | `/api/polymarket/orderbook` | CLOB orderbook (`token_id`) |
| GET | `/api/polymarket/orders` | Returns 501 — UI/status disabled-state endpoint |
| POST | `/api/polymarket/orders` | Returns 501 — trading disabled |
| GET | `/api/polymarket/positions` | Wallet positions (`user`) |

### Views
- **`PolymarketAppView`** — desktop and XR view, path `/polymarket`.
- **`PolymarketTuiView`** — terminal (TUI) view, path `/polymarket/tui`.
- Both bundle from `dist/views/bundle.js`.

## Layout

```
src/
  index.ts              Public re-exports
  plugin.ts             Exported `polymarketPlugin` (Plugin object); wires actions, services, providers, routes, views
  actions.ts            PREDICTION_MARKET action + PredictionMarketService class + polymarketActions[]
  provider.ts           polymarketStatusProvider
  provider-text.ts      derivePolymarketStatusText() — pure env-to-text helper used by provider
  routes.ts             handlePolymarketRoute() — all HTTP route logic; fetches Gamma/CLOB/Data APIs
  polymarket-contracts.ts  All shared interfaces and API base URL constants
  orderbook.ts          derivePolymarketTopOfBook() — best-bid/ask derivation from raw CLOB levels
  client.ts             PolymarketClient — type intersection of ElizaClient with typed fetch helpers for each route (methods patched onto ElizaClient.prototype)
  polymarket-app.ts     registerOverlayApp() call; exports polymarketApp + POLYMARKET_APP_NAME
  register.ts           Side-effect import of polymarket-app (triggers overlay registration)
  register-routes.ts    registerAppRoutePluginLoader() — lazy-loads polymarketPlugin for app-route mounting
  ui.ts                 View entry re-exporting PolymarketAppView, polymarketApp, usePolymarketState
  PolymarketAppView.tsx Exports PolymarketAppView (desktop/XR), PolymarketTuiView (terminal), and interact()
  usePolymarketState.ts usePolymarketState() React hook for view state
  PolymarketTuiView.test.tsx  Unit test for PolymarketTuiView/interact
```

## Commands

```bash
bun run --cwd plugins/plugin-polymarket-app build       # tsup + vite views + tsc types
bun run --cwd plugins/plugin-polymarket-app build:js    # tsup only
bun run --cwd plugins/plugin-polymarket-app build:views # Vite view bundle only
bun run --cwd plugins/plugin-polymarket-app build:types # tsc declaration emit only
bun run --cwd plugins/plugin-polymarket-app clean       # rm -rf dist
bun run --cwd plugins/plugin-polymarket-app test        # vitest run
```

## Config / env vars

| Var | Required | Notes |
|-----|----------|-------|
| `POLYMARKET_PRIVATE_KEY` | Status only | Wallet private key for signed CLOB orders (not yet implemented) |
| `CLOB_API_KEY` | Trading only | Alias: `POLYMARKET_CLOB_API_KEY` |
| `CLOB_API_SECRET` | Trading only | Alias: `POLYMARKET_CLOB_SECRET` |
| `CLOB_API_PASSPHRASE` | Trading only | Alias: `POLYMARKET_CLOB_PASSPHRASE` |

Public reads (markets, orderbook, positions) require no credentials. The `GET /api/polymarket/status` route reports which trading vars are missing.

## How to extend

**Add a new prediction-market provider** (e.g. Manifold):
1. Implement the internal `PredictionMarketProvider` interface (name, aliases, supportedSubactions, execute).
2. In a plugin `onStart` or service extension, call `runtime.getService<PredictionMarketService>("prediction-market").registerProvider(myProvider)`.
3. Callers pass `target: "manifold"` to the `PREDICTION_MARKET` action.

**Add a new route**:
1. Add the handler case to `handlePolymarketRoute()` in `src/routes.ts`.
2. Add a `Route` entry to the `polymarketRoutes` array in `src/plugin.ts`.
3. Add a typed method to `PolymarketClient` in `src/client.ts`.

**Add a new read kind**:
1. Add the string to `READ_KINDS` in `src/actions.ts`.
2. Add a `case` to `handleReadOperation()`.
3. Add a handler function.

## Conventions / gotchas

- **Orderbook token id vs condition id.** Use the CLOB `token_id` for orderbook queries, not the Gamma `conditionId`. A market has one condition id but one or more CLOB token ids (one per outcome).
- **Signed trading is not implemented.** `POST /api/polymarket/orders` returns 501 and no order-placement agent action is exposed. Keep the action surface read-only until signed CLOB calls are real.
- **Views use a separate Vite build.** `build:js` (tsup) produces the runtime entry; `build:views` (Vite) produces `dist/views/bundle.js` consumed by the view registry. Both must run for a complete build.
- **Route handler receives Node `http.IncomingMessage` / `ServerResponse`.** The plugin.ts adapter casts `RouteRequest` / `RouteResponse` to Node types; routes.ts depends on real Node HTTP objects.
- **Context gating.** The action fires only when the agent context includes `finance`, `crypto`, `prediction-market`, or `payments`, or when the message contains recognized keywords (multilingual list in actions.ts). Outside those contexts the action is skipped.
- **API base URLs** are constants in `src/polymarket-contracts.ts` (`POLYMARKET_GAMMA_API_BASE`, `POLYMARKET_DATA_API_BASE`, `POLYMARKET_CLOB_API_BASE`). Change there to target a different environment.

See the root [AGENTS.md](../../AGENTS.md) for repo-wide architecture rules, logger conventions, and git workflow.
