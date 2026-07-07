# @elizaos/plugin-hyperliquid

Native Hyperliquid perpetual-market integration for elizaOS agents: status, markets, positions, and open orders via read-only routes and a conversational action.

## Purpose / role

Adds Hyperliquid perpetual-market capabilities to an Eliza agent. Registers an action (`PERPETUAL_MARKET`), a service (`PerpetualMarketService`), eleven HTTP routes under `/api/hyperliquid/`, and one GUI view. Shipped view inventory is GUI-only; `xr`/`tui` remain compatibility modality values but are not declared. Loaded opt-in via `registerAppRoutePluginLoader`; see `src/register-routes.ts`. Execution (order placement) is intentionally disabled — only read operations are implemented.

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
| id | modalities | Component |
|---|---|---|
| `hyperliquid` | `gui` | `HyperliquidView` |

## Layout

```
src/
  index.ts                  Public package exports
  plugin.ts                 Plugin object: actions, services, routes, views, dispose
  register.ts               Side-effect: imports hyperliquid-app (registers overlay app)
  register-routes.ts        Side-effect: calls registerAppRoutePluginLoader
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
bun run --cwd plugins/plugin-hyperliquid build        # tsup JS + vite views + tsc types
bun run --cwd plugins/plugin-hyperliquid build:js     # tsup only
bun run --cwd plugins/plugin-hyperliquid build:views  # vite views bundle
bun run --cwd plugins/plugin-hyperliquid build:types  # tsc declarations
bun run --cwd plugins/plugin-hyperliquid test         # vitest run
bun run --cwd plugins/plugin-hyperliquid clean        # rm -rf dist
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
- **Context gating:** `PERPETUAL_MARKET` validates when `state` contains a `finance`, `crypto`, `trading`, or `payments` selected context. Relevance to the user's request is handled by semantic action retrieval (the action description), not a hardcoded keyword list (#10470).
- **`HyperliquidClient`** is created by patching `ElizaClient.prototype` at import time (`src/client.ts`). Import `"./client"` as a side effect before calling the extended methods.
- **Overlay app registration** (`src/hyperliquid-app.ts`) happens as a side effect when `src/register.ts` is imported. The plugin entrypoint exports `src/register.ts` so this is automatic when the plugin loads.
- Upstream API: `https://api.hyperliquid.xyz/info` (POST, public). No API key required for market/position reads.
- See root `AGENTS.md` for repo-wide architecture rules, logger conventions, ESM/naming standards, and git workflow.

<!-- BEGIN: evidence-and-e2e-mandate (managed; canonical standard = repo-root AGENTS.md) -->
## ⛔ NON-NEGOTIABLE — evidence, trajectories & real end-to-end tests

> The binding, repo-wide standard is **[AGENTS.md](../../AGENTS.md)**. Read it.
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
