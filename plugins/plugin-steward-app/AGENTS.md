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
- `StewardSpatialView` (`src/components/StewardSpatialView.tsx`) — unified component authored once and rendered across web, XR, and terminal modalities; registered in the terminal via `src/register-terminal-view.tsx`

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
    steward-sidecar/               # Per-submodule thin re-exports from @elizaos/app-core (health-check, helpers, process-management, types, wallet-setup)
    steward-wallet.ts              # Steward wallet helpers (resolve credentials path, load, save, status)

  security/
    hydrate-wallet-keys-from-platform-store.ts  # Fill process.env from OS keychain at boot
    wallet-os-store-actions.ts                  # OS keychain read/write actions

  api/
    wallet.ts                      # Core wallet primitives (getWalletAddresses, fetchSolanaNativeBalanceViaRpc)
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

  components/
    StewardSpatialView.tsx         # Unified approvals+history panel rendered across web, XR, and terminal
    StewardSpatialView.test.tsx    # Vitest tests for StewardSpatialView

  ApprovalQueue.tsx                # React component: pending approval list + approve/deny buttons
  ApprovalQueue.test.tsx           # Vitest tests for ApprovalQueue
  TransactionHistory.tsx           # React component: Steward transaction history list
  TransactionHistory.test.tsx      # Vitest tests for TransactionHistory
  StewardView.tsx                  # React panel: tabs history + approvals (web + XR)
  StewardView.test.tsx             # Vitest tests for StewardView
  StewardView.helpers.ts           # StewardView helper utilities
  StewardView.interact.ts          # StewardView interaction handlers
  StewardVaultOverview.tsx         # Vault status overview card
  StewardVaultOverview.test.tsx    # Vitest tests for StewardVaultOverview
  StewardLogo.tsx                  # SVG logo component
  StewardTuiView.test.tsx          # Vitest test for TUI view
  StewardVisualCopy.test.ts        # Vitest visual copy tests
  steward-ui-state.ts              # Shared UI state types
  steward-view-bundle.ts           # View bundle entry point (re-exports StewardView, StewardTuiView, interact)
  steward-logo.svg                 # SVG asset
  register-terminal-view.tsx       # Registers StewardSpatialView as a terminal view at startup (auto-imported via index.ts)
  chain-utils.ts                   # Chain ID/name helpers
  chain-utils.test.ts              # Vitest tests for chain-utils
  register-routes.ts               # Route registration helper
  ui.ts                            # UI re-exports
  steward-bridge.contract.test.ts  # Contract tests for steward-bridge

  __fixtures__/
    steward-sdk-fixtures.ts        # Test fixtures for Steward SDK responses
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
| `STEWARD_EVM_ADDRESS` | No | EVM address reported by Steward (set in cloud-provisioned mode). |
| `STEWARD_SOLANA_ADDRESS` | No | Solana address reported by Steward (set in cloud-provisioned mode). |
| `EVM_PRIVATE_KEY` | No | EVM wallet private key. Hydrated from OS keychain if unset. |
| `SOLANA_PRIVATE_KEY` | No | Solana wallet private key. Hydrated from OS keychain if unset. |
| `SOLANA_PUBLIC_KEY` | No | Solana public key override. |
| `WALLET_PUBLIC_KEY` | No | Generic wallet public key override. |
| `ELIZA_CLOUD_PROVISIONED` | No | Set to `1` in cloud containers to activate Steward EVM account bridge (no local keys). |
| `ELIZA_MANAGED_EVM_ADDRESS` | No | EVM address injected in cloud-managed mode. |
| `ELIZA_API_PORT` | No | Loopback API port. Resolved via `resolveDesktopApiPort(process.env)`; do not hardcode. |
| `ELIZA_WALLET_NETWORK` | No | Network selection (e.g. `mainnet`, `testnet`). |
| `ELIZAOS_CLOUD_API_KEY` | No | elizaOS cloud API key for cloud backend calls. |
| `ELIZAOS_CLOUD_BASE_URL` | No | elizaOS cloud base URL override. |
| `SOLANA_RPC_URL` | No | Custom Solana RPC endpoint. |
| `SOLANA_TESTNET_RPC_URL` | No | Custom Solana testnet RPC endpoint. |
| `ETHEREUM_RPC_URL` | No | Custom Ethereum mainnet RPC endpoint. |
| `BASE_RPC_URL` | No | Custom Base chain RPC endpoint. |
| `AVALANCHE_RPC_URL` | No | Custom Avalanche RPC endpoint. |
| `BSC_RPC_URL` | No | Custom BSC mainnet RPC endpoint. |
| `BSC_TESTNET_RPC_URL` | No | Custom BSC testnet RPC endpoint. |
| `BSC_SWAP_ROUTER_ADDRESS` | No | DEX router address on BSC mainnet. |
| `BSC_TESTNET_SWAP_ROUTER_ADDRESS` | No | DEX router address on BSC testnet. |
| `BSC_WRAPPED_NATIVE_ADDRESS` | No | WBNB address on BSC mainnet. |
| `BSC_TESTNET_WRAPPED_NATIVE_ADDRESS` | No | WBNB address on BSC testnet. |
| `BSC_TESTNET_CHAIN_ID` | No | Chain ID override for BSC testnet. |
| `BSC_TESTNET_EXPLORER_BASE_URL` | No | Block explorer base URL for BSC testnet. |
| `NODEREAL_BSC_RPC_URL` | No | NodeReal BSC RPC endpoint. |
| `QUICKNODE_BSC_RPC_URL` | No | QuickNode BSC RPC endpoint. |
| `ALCHEMY_API_KEY` | No | Alchemy API key for EVM RPC. |
| `ANKR_API_KEY` | No | Ankr API key for EVM RPC. |
| `INFURA_API_KEY` | No | Infura API key for EVM RPC. |
| `HELIUS_API_KEY` | No | Helius API key for Solana RPC. |
| `BIRDEYE_API_KEY` | No | Birdeye API key for token prices. |
| `ZEROX_API_KEY` | No | 0x API key for DEX quotes. |
| `ZEROX_BSC_API_BASE_URL` | No | 0x BSC API base URL override. |

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
- `StewardSpatialView` (`src/components/StewardSpatialView.tsx`) is the single source-of-truth panel for approvals and history. It is used by `StewardView.tsx` (web/XR) and registered as a terminal view by `src/register-terminal-view.tsx` (auto-imported in `index.ts`).
- See `../../AGENTS.md` for global architecture rules (dependency direction, logger-only, ESM, naming).
