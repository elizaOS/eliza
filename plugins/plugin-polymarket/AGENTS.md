# @elizaos/plugin-polymarket

Adds Polymarket prediction-market discovery, orderbook reading, position viewing, and trading-readiness context to an Eliza agent.

## Purpose / role

Opt-in elizaOS plugin. Load it by adding `@elizaos/plugin-polymarket` to the agent's plugin list. It registers one action, one provider, one service, seven REST routes, and one adaptive UI view (a single spatial component that renders as DOM in GUI, scaled DOM in XR, and terminal lines in TUI). Public market reads are always available; signed CLOB order placement is disabled in this app integration and exposed only as readiness reporting.

## Plugin surface

### Actions
- **`PREDICTION_MARKET`** — unified prediction-market router. Dispatches to `PredictionMarketService`.
  - `action=read, kind=status` — configuration and readiness report.
  - `action=read, kind=markets` — paginated active market list from Gamma API.
  - `action=read, kind=market` — single market by `id` or `slug`.
  - `action=read, kind=orderbook` — full CLOB orderbook for a `tokenId`.
  - `action=read, kind=positions` — wallet positions from Data API.
  - `action=place_order` — reports trading readiness; actual order signing is disabled.
  - Legacy similes (still accepted): `POLYMARKET_READ`, `POLYMARKET_STATUS`, `POLYMARKET_GET_MARKETS`, `POLYMARKET_GET_ORDERBOOK`, `POLYMARKET_PLACE_ORDER`, `POLYMARKET_BUY`, `POLYMARKET_SELL`, and ~14 others (full list in `POLYMARKET_READ_COMPAT_SIMILES` / `POLYMARKET_PLACE_ORDER_COMPAT_SIMILES`, actions.ts).

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
| GET | `/api/polymarket/orders` | Returns 501 — trading disabled |
| POST | `/api/polymarket/orders` | Returns 501 — trading disabled |
| GET | `/api/polymarket/positions` | Wallet positions (`user`) |

### Views

One declaration in `plugin.ts` (`modalities: ["gui", "xr", "tui"]`, `componentExport: "PolymarketView"`, path `/polymarket`) drives all three surfaces from a single source — no per-modality duplicate component:

- **`PolymarketSpatialView`** (`src/components/PolymarketSpatialView.tsx`) — the one presentational component, authored with `@elizaos/ui/spatial` primitives. Renders DOM in GUI, scaled DOM in XR, and real terminal lines in TUI. Purely a snapshot + action-callback in, primitives out.
- **`PolymarketView`** (`src/PolymarketView.tsx`) — the thin data wrapper that owns live state (`usePolymarketState`) and renders `<SpatialSurface><PolymarketSpatialView/></SpatialSurface>`. This is the view-registry `componentExport`, bundled into `dist/views/bundle.js` via `polymarket-view-bundle.ts`.
- **TUI** — `register-terminal-view.tsx` registers the same `PolymarketSpatialView` in the agent terminal registry. The bundle also re-exports the `interact` capability handler (`polymarket-view.interact.ts`) for agent-facing terminal capabilities.

## Layout

```
src/
  index.ts                    Public re-exports
  plugin.ts                   Exported `polymarketPlugin` (Plugin object); wires actions, services, providers, routes, views
  actions.ts                  PREDICTION_MARKET action + PredictionMarketService class + polymarketActions[]
  provider.ts                 polymarketStatusProvider
  provider-text.ts            derivePolymarketStatusText() — pure env-to-text helper used by provider
  routes.ts                   handlePolymarketRoute() — all HTTP route logic; fetches Gamma/CLOB/Data APIs
  polymarket-contracts.ts     All shared interfaces and API base URL constants
  orderbook.ts                derivePolymarketTopOfBook() — best-bid/ask derivation from raw CLOB levels
  client.ts                   PolymarketClient — type intersection of ElizaClient with typed fetch helpers for each route (methods patched onto ElizaClient.prototype)
  register.ts                 appRegister entry: registers the PolymarketView app-shell page (native) + the terminal view
  register-routes.ts          registerAppRoutePluginLoader() — lazy-loads polymarketPlugin for app-route mounting
  register-terminal-view.tsx  registerPolymarketTerminalView() + setPolymarketTerminalSnapshot() — mounts PolymarketSpatialView in the terminal
  PolymarketView.tsx          PolymarketView — the single GUI/XR data wrapper; owns live state, renders <SpatialSurface><PolymarketSpatialView/>
  polymarket-view.helpers.ts  loadPolymarketTuiState() and postPolymarketCommand() — async helpers used by the interact handler
  polymarket-view.interact.ts interact() — terminal capability handler; re-exported by polymarket-view-bundle
  polymarket-view-bundle.ts   Vite view-bundle entry: re-exports PolymarketView + interact
  usePolymarketState.ts       usePolymarketState() React hook for view state
  components/
    PolymarketSpatialView.tsx  The single spatial/terminal view component (PolymarketSpatialView, PolymarketSnapshot)
  __fixtures__/
    contract.ts               Test fixture contracts
    polymarket-real.recorded.json  Recorded API responses for tests
  actions.test.ts             Unit tests for actions
  PolymarketView.test.tsx     Render + interact tests for the unified PolymarketView (gui/xr/tui)
  routes.contract.test.ts     Contract tests for routes
  routes.real.test.ts         Live API integration tests (gated on POLYMARKET_LIVE_TEST=1)
  routes.test.ts              Unit tests for routes
  routes.positions.test.ts    Keyless tests for the positions surface
  components/
    PolymarketSpatialView.test.tsx  Tests for PolymarketSpatialView
```

## Commands

```bash
bun run --cwd plugins/plugin-polymarket build       # tsup + vite views + tsc types
bun run --cwd plugins/plugin-polymarket build:js    # tsup only
bun run --cwd plugins/plugin-polymarket build:views # Vite view bundle only
bun run --cwd plugins/plugin-polymarket build:types # tsc declaration emit only
bun run --cwd plugins/plugin-polymarket clean       # rm -rf dist
bun run --cwd plugins/plugin-polymarket test        # vitest run
```

## Config / env vars

| Var | Required | Notes |
|-----|----------|-------|
| `POLYMARKET_PRIVATE_KEY` | Trading readiness only | Wallet private key presence check for signed CLOB order readiness |
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
- **Signed trading is disabled.** `POST /api/polymarket/orders` returns 501. The `place_order` action reports readiness only; it does not place trades.
- **One adaptive view, no rich-DOM duplicate.** The single `PolymarketSpatialView` (spatial primitives) is the only view component — there is no separate desktop/operator/`*AppView` DOM copy. The wrapper `PolymarketView` is the `componentExport`; `register-terminal-view.tsx` registers the same spatial component for TUI. Do not reintroduce a parallel DOM-only view.
- **Views use a separate Vite build.** `build:js` (tsup) produces the runtime entry; `build:views` (Vite) produces `dist/views/bundle.js` consumed by the view registry. Both must run for a complete build. The Vite entry is `src/polymarket-view-bundle.ts` (not `PolymarketView.tsx` directly); `interact` is re-exported from `polymarket-view.interact.ts` through that bundle.
- **Route handler receives Node `http.IncomingMessage` / `ServerResponse`.** The plugin.ts adapter casts `RouteRequest` / `RouteResponse` to Node types; routes.ts depends on real Node HTTP objects.
- **Context gating.** The action fires only when structured routing selects `finance`, `crypto`, `prediction-market`, or `payments` (canonical `__contextRouting` plus legacy `selectedContexts`). It does not keyword-scan raw user text. Outside those contexts the action is skipped.
- **API base URLs** are constants in `src/polymarket-contracts.ts` (`POLYMARKET_GAMMA_API_BASE`, `POLYMARKET_DATA_API_BASE`, `POLYMARKET_CLOB_API_BASE`). Change there to target a different environment.

See the root [AGENTS.md](../../AGENTS.md) for repo-wide architecture rules, logger conventions, and git workflow.

<!-- BEGIN: evidence-and-e2e-mandate (managed; canonical standard = repo-root PR_EVIDENCE.md) -->
## ⛔ NON-NEGOTIABLE — evidence, trajectories & real end-to-end tests

> The binding, repo-wide standard is **[PR_EVIDENCE.md](../../PR_EVIDENCE.md)**. Read it.
> Nothing in this package is *done* until it is *proven* done — a reviewer must confirm it
> works **without reading the code**, from the artifacts you attach. This applies to **every**
> feature, fix, refactor, and chore here. "Tests pass" is not proof; "CI is green" is not proof.

- **Record AND read model trajectories.** Capture the *actual* inputs and outputs of the model
  from a **live** LLM — not the deterministic proxy, not a mock: the prompt, the
  providers/context, the raw model output, every tool/action call, and the result. Then **open
  the trajectory and review it by hand.** A captured-but-unread trajectory is not evidence
  (`packages/scenario-runner/bin/eliza-scenarios run <scenario> --report <out>`).
- **Real, full-featured E2E — no larp.** Every feature ships detailed end-to-end tests that
  drive the *real* path end to end. Not the happy "front door" only: cover error paths,
  edge/empty/invalid input, concurrency, roles/permissions, and adversarial input. A test that
  asserts against a mock/stub/fixture standing in for the thing under test **does not count**.
  If the real model/device/chain/connector/account is hard to reach, **make it reachable — that
  is the work**, not an excuse to mock. If the existing tests here are shallow or mocked, fixing
  them is part of your change.
- **Screenshots + logs at every phase**, plus a **complete walkthrough video/run-through** of
  the entire feature or view, start to finish (`bun run test:e2e:record`).
- **Manually review every artifact the change touches** — never just the green check: client
  logs (console + network), server logs (`[ClassName] …`), the model trajectories in and out,
  before/after full-page screenshots, **and the domain artifacts listed below for this package.**
- **No residuals. No shortcuts.** The goal is not "done" — it is *everything* done. Clear every
  blocker by the **hard path**: build the real architecture, stand up the real
  model/device/service, actually test it. Never leave a TODO, a stub, a stepping-stone, or a
  "follow-up." When unsure, research thoroughly, weigh the options, and ship the best,
  highest-effort, production-ready version. Keep going until every possibility is exhausted.

Artifacts → attached inline in the PR (MP4 video, JPG screenshots, logs in `<details>`); attach each evidence type **or**
explicitly mark it N/A with a reason — never leave it blank. If `develop` moved and changed
behavior, **re-capture** evidence; stale proof is worse than none.

**Capture & manually review for this package — wallet / chain / contracts:**
- On-chain transaction hash(es) + explorer link, wallet balance **before and after**, and the signed-payload/log trail — run against a testnet or fork.
- Revert / insufficient-funds / nonce / gas-estimation-failure paths, and signature-authorization (role/permission) checks.
- The decision trajectory when an agent initiated the on-chain action.
- Never a mocked RPC asserted green — prove the chain state actually changed.
<!-- END: evidence-and-e2e-mandate -->
