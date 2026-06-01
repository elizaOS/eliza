# @elizaos/plugin-steward-app

Steward wallet management plugin — exposes EVM/Solana wallet routes, Steward vault integration, browser wallet bridge, trade/transfer execution, and a React dashboard view to an elizaOS agent.

## Purpose / role

Adds full wallet capability to an Eliza agent: native balance/address providers for the planner, a `walletRouterAction` for executing swaps/transfers across chain backends, and ~30 HTTP routes covering wallet management (addresses, balances, import/generate, config, keys, NFTs), Steward cloud-signing (status, policies, pending approvals, approve/deny, sign), browser wallet bridge (EVM + Solana), and trade execution. The plugin also includes the `StewardView` React component registered as a built-in agent view for the dashboard. Loaded by explicitly including `stewardPlugin` in the agent's plugin list — not auto-enabled.

## Plugin surface

### Actions
| Name | Source | Description |
|------|--------|-------------|
| `walletRouterAction` | `@elizaos/plugin-wallet` (re-exported via plugin) | Routes preview/swap/transfer/wallet sub-actions across registered chain backends |

### Providers
| Name | Source | Description |
|------|--------|-------------|
| `stewardBalanceProvider` | `src/providers/steward-balance.ts` | Read-only EVM + Solana balance snapshot per turn; context-gated to `finance`/`wallet`/`crypto` |
| `stewardReceiveAddressProvider` | `src/providers/steward-receive-address.ts` | Read-only EVM + Solana deposit address snapshot; same context gate |

### Routes (all `rawPath: true`, no plugin-name prefix)
**Wallet core** (`src/routes/wallet-core-routes.ts`):
- `GET /api/wallet/addresses` — all chain addresses
- `GET /api/wallet/balances` — balances across EVM chains + Solana
- `POST /api/wallet/import` — import a private key
- `POST /api/wallet/generate` — generate a new wallet
- `GET|PUT /api/wallet/config` — read/write wallet config
- `POST /api/wallet/export` — export private key

**BSC trade core** (`src/routes/wallet-bsc-core-routes.ts`):
- `POST /api/wallet/trade/preflight` — safety + quote preview
- `POST /api/wallet/trade/quote` — DEX quote
- `GET /api/wallet/trade/tx-status` — transaction status
- `GET /api/wallet/trading/profile` — trading profile
- `POST /api/wallet/production-defaults` — apply production config defaults

**Wallet compat** (`src/routes/wallet-compat-routes.ts`):
- `GET|POST /api/wallet/os-store` — OS keychain store read/write
- `GET /api/wallet/keys` — list stored keys
- `GET /api/wallet/nfts` — NFT holdings

**Browser wallet bridge** (`src/routes/wallet-browser-compat-routes.ts`):
- `POST /api/wallet/browser-transaction` — relay EVM tx from browser wallet
- `POST /api/wallet/browser-sign-message` — sign EIP-191 message
- `POST /api/wallet/browser-solana-sign-message` — sign Solana message
- `POST /api/wallet/browser-solana-transaction` — relay Solana tx

**Steward compat** (`src/routes/steward-compat-routes.ts`):
- `GET /api/wallet/steward-status` — vault connection status
- `GET|PUT /api/wallet/steward-policies` — policy rules
- `GET /api/wallet/steward-tx-records` — transaction history
- `GET /api/wallet/steward-pending-approvals` — approvals queue
- `POST /api/wallet/steward-approve-tx` — approve a pending tx
- `POST /api/wallet/steward-deny-tx` — deny a pending tx
- `POST /api/wallet/steward-webhook` (public, no auth) — inbound Steward webhook
- `GET /api/wallet/steward-webhook-events` — recent webhook events
- `POST /api/wallet/steward-sign` — request Steward signing
- `GET /api/wallet/steward-addresses` — Steward wallet addresses
- `GET /api/wallet/steward-balances` — Steward wallet native balances
- `GET /api/wallet/steward-tokens` — Steward token balances

**Trade execution** (`src/routes/wallet-trade-compat-routes.ts`):
- `POST /api/wallet/trade/execute` — execute a DEX trade with optional Steward signing
- `POST /api/wallet/transfer/execute` — execute a token/native transfer

### Views
- `StewardView` (web + XR) — transaction history + approval queue dashboard panel, path `/steward`
- `StewardTuiView` (tui) — terminal-compatible version, path `/steward/tui`

## Layout

```
src/
  plugin.ts                        # Plugin export (stewardPlugin): routes, actions, providers, views
  index.ts                         # Barrel re-exports for the whole package

  actions/
    wallet-action-shared.ts        # Shared helpers: getWalletActionApiPort(), buildAuthHeaders()

  providers/
    steward-balance.ts             # stewardBalanceProvider — balance snapshot
    steward-receive-address.ts     # stewardReceiveAddressProvider — address snapshot

  routes/
    steward-bridge.ts              # Steward SDK client wrappers: createStewardClient, getStewardBridgeStatus,
                                   #   signViaSteward, approveStewardTransaction, etc.
    wallet-core-routes.ts          # handleWalletCoreRoutes
    wallet-bsc-core-routes.ts      # handleWalletBscCoreRoutes (BSC/trade preflight, quote, status, profile)
    wallet-compat-routes.ts        # handleWalletCompatRoutes (os-store, keys, NFTs)
    wallet-browser-compat-routes.ts# handleWalletBrowserCompatRoutes (browser wallet relay)
    steward-compat-routes.ts       # handleStewardCompatRoutes (Steward vault management)
    wallet-trade-compat-routes.ts  # handleWalletTradeCompatRoutes (trade/transfer execution)

  services/
    steward-credentials.ts         # Re-export from @elizaos/app-core (loadStewardCredentials, saveStewardCredentials)
    steward-evm-account.ts         # viem CustomAccount that signs via Steward API (cloud-provisioned mode)
    steward-evm-bridge.ts          # Pre/post boot hooks: stewardEvmPreBoot, stewardEvmPostBoot
    steward-sidecar.ts             # Re-export from @elizaos/app-core
    steward-wallet.ts              # Steward wallet helpers (resolve credentials path, load, save, status)

  security/
    hydrate-wallet-keys-from-platform-store.ts  # Fill process.env from OS keychain at boot
    wallet-os-store-actions.ts                  # OS keychain read/write actions

  api/
    wallet.ts                      # Core wallet primitives (getWalletAddresses, fetchSolanaNativeBalance)
    wallet-evm-balance.ts          # fetchEvmNativeBalanceViaRpc
    wallet-rpc.ts                  # resolveWalletRpcReadiness
    wallet-routes.ts               # Route handler shared helpers
    wallet-bsc-routes.ts           # BSC-specific trade route logic
    wallet-trade-routes.ts         # Trade execution pipeline
    wallet-capability.ts           # Chain capability detection
    wallet-dex-prices.ts           # DEX price fetching
    wallet-trading-profile.ts      # Trading profile persistence
    tx-service.ts                  # Transaction status tracker
    bsc-trade.ts                   # BSC trade types and helpers
    trade-safety.ts                # Pre-execution safety checks
    binance-skill-helpers.ts       # Binance data helpers

  types/
    steward.ts                     # Steward-specific response types (re-exports from @elizaos/core + local)
    bsc-trade.ts                   # BSC trade request/response types
    index.ts                       # Barrel

  ApprovalQueue.tsx                # React component: pending approval list + approve/deny buttons
  TransactionHistory.tsx           # React component: Steward transaction history list
  StewardView.tsx                  # React panel: tabs history + approvals (web + XR)
  StewardVaultOverview.tsx         # Vault status overview card
  StewardLogo.tsx                  # SVG logo component
  StewardTuiView.test.tsx          # Vitest test for TUI view
  steward-ui-state.ts              # Shared UI state types
  chain-utils.ts                   # Chain ID/name helpers
  register-routes.ts               # Route registration helper
  ui.ts                            # UI re-exports
  steward-logo.svg                 # SVG asset
```

## Commands

```bash
bun run --cwd plugins/plugin-steward-app build         # tsup + vite views + tsc types
bun run --cwd plugins/plugin-steward-app build:js      # tsup only (server/lib code)
bun run --cwd plugins/plugin-steward-app build:views   # vite views bundle (StewardView, StewardTuiView)
bun run --cwd plugins/plugin-steward-app build:types   # tsc declarations only
bun run --cwd plugins/plugin-steward-app clean         # rm -rf dist
bun run --cwd plugins/plugin-steward-app test          # vitest run
bun run --cwd plugins/plugin-steward-app test:e2e:manual  # live E2E tests (needs real APIs)
```

## Config / env vars

| Variable | Required | Description |
|----------|----------|-------------|
| `STEWARD_API_URL` | Conditional | Steward vault base URL. Required for Steward signing. Falls back to persisted credentials. |
| `STEWARD_API_KEY` | Conditional | Steward API key. Either this or `STEWARD_AGENT_TOKEN` is needed. |
| `STEWARD_AGENT_TOKEN` | Conditional | JWT bearer token for agent authentication with Steward. |
| `STEWARD_AGENT_ID` | No | Steward agent ID. Falls back to EVM address if unset. Also `ELIZA_STEWARD_AGENT_ID`. |
| `STEWARD_TENANT_ID` | No | Steward tenant ID for multi-tenant deployments. |
| `EVM_PRIVATE_KEY` | No | EVM wallet private key. Hydrated from OS keychain if unset. |
| `SOLANA_PRIVATE_KEY` | No | Solana wallet private key. Hydrated from OS keychain if unset. |
| `ELIZA_CLOUD_PROVISIONED` | No | Set to `1` in cloud containers to activate Steward EVM account bridge (no local keys). |
| `ELIZA_API_PORT` | No | Loopback API port. Resolved via `resolveDesktopApiPort(process.env)`; do not hardcode. |
| `ELIZA_API_TOKEN` | No | Bearer token for loopback API calls between providers and route handlers. |

Credentials also persist to `$ELIZA_STATE_DIR/steward-credentials.json` (written by `saveStewardCredentials`).

## How to extend

**Add a new route:**
1. Add a handler function to the appropriate file in `src/routes/` or create a new file.
2. Register the route in `src/plugin.ts` inside `stewardRoutes` with `rawPath: true`.
3. Use `coreRouteHandler()` (for handlers taking `(req, res, state: unknown)`) or `stewardRouteHandler()` (for handlers needing `CompatRuntimeState`).

**Add a provider:**
1. Create `src/providers/<name>.ts` exporting a `Provider` object.
2. Import and add it to the `providers` array in `src/plugin.ts`.
3. Set `dynamic: true` and a `contextGate` to avoid running on every turn.

**Add an action:**
1. Create `src/actions/<name>.ts` exporting an `Action` object.
2. Import and add it to the `actions` array in `src/plugin.ts`.
3. Wallet action helpers (`getWalletActionApiPort`, `buildAuthHeaders`) are in `src/actions/wallet-action-shared.ts`.

## Conventions / gotchas

- All routes use `rawPath: true` — they must be registered with the full `/api/wallet/*` or `/api/steward/*` path. Do not remove this flag or the elizaOS runtime will prefix with the plugin name.
- The Steward webhook route (`/api/wallet/steward-webhook`) has `public: true` — it accepts unauthenticated POSTs from the Steward cloud. All other routes require a valid Bearer token.
- `stewardBalanceProvider` and `stewardReceiveAddressProvider` call the loopback API, not Steward directly. They require the agent's own API server to be running.
- In cloud-provisioned mode (`ELIZA_CLOUD_PROVISIONED=1` + `STEWARD_AGENT_TOKEN`), `stewardEvmPreBoot` must be called before plugins load to prevent plugin-wallet from generating a random local key. `stewardEvmPostBoot` must be called after plugins load to inject the Steward viem account.
- The views bundle (`dist/views/bundle.js`) is built separately by `build:views` using Vite. The JS build (`build:js`) does not produce the views bundle.
- `src/services/steward-credentials.ts` and `src/services/steward-sidecar.ts` are thin re-exports of `@elizaos/app-core`. The real implementations live upstream.
- Wallet keys (`EVM_PRIVATE_KEY`, `SOLANA_PRIVATE_KEY`) and Steward credentials can be hydrated from the OS keychain at startup via `hydrateWalletKeysFromNodePlatformSecureStore()` in `src/security/`.
- See `../../AGENTS.md` for global architecture rules (dependency direction, logger-only, ESM, naming).
