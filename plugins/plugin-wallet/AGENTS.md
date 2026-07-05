# @elizaos/plugin-wallet

Non-custodial wallet for elizaOS agents: EVM + Solana signing, x402 micropayments, CCTP bridge, Li.Fi swap/bridge routing, Jupiter routing, multi-DEX LP management, on-chain spend policies, and analytics (Birdeye, DexScreener, token info).

## Purpose / role

Adds a unified wallet action+provider surface to an Eliza agent, replacing the previous fan-out across `plugin-evm`, `plugin-solana`, `plugin-raydium`, `plugin-orca`, `plugin-meteora`, `plugin-jupiter`, `plugin-lp-manager`, and `plugin-clanker`. Loaded as `walletPlugin` (exported default and named from `plugin.ts`). Auto-enabled via `auto-enable.ts` when any signing path is present (EVM key, Solana key, or Steward credentials); opt-in otherwise.

## Plugin surface

**Actions (all promoted from `walletRouterAction` in `src/chains/wallet-action.ts`):**

| Name | Subaction | Description |
|------|-----------|-------------|
| `WALLET` | `transfer` | Move tokens to an external address (EVM or Solana). Always policy-checked. |
| `WALLET` | `swap` | Token swap via Li.Fi (EVM) or Jupiter (Solana). |
| `WALLET` | `bridge` | Cross-chain transfer via Li.Fi or CCTP. |
| `WALLET` | `gov` | On-chain governance: propose, vote, queue, execute. |
| `WALLET` | `pump_fun_buy` | Buy a pump.fun token on Solana via PumpPortal trade-local, local signing, browser coin-page open, and Solana RPC submission. |
| `WALLET` | `token_info` | Read-only token/market data (DexScreener, Birdeye, CoinGecko). |
| `WALLET` | `search_address` | Birdeye wallet/portfolio lookup by address. |

Similes handled: `SWAP`, `SWAP_SOLANA`, `TRANSFER`, `TRANSFER_TOKEN`, `WALLET_SWAP`, `WALLET_TRANSFER`, `CROSS_CHAIN_TRANSFER`, `PREPARE_TRANSFER`, `WALLET_ACTION`, `WALLET_GOV`, `PUMP_FUN_BUY`, `PUMPFUN_BUY`, `TOKEN_INFO`, `BIRDEYE_LOOKUP`, `BIRDEYE_SEARCH`, `WALLET_SEARCH_ADDRESS`.

All on-chain subactions (`transfer`, `swap`, `bridge`, `gov`, `pump_fun_buy`) require a user confirmation turn before execution. `mode=prepare` (default) stages without signing. Setting `mode=execute` does **not** bypass the gate — submission only happens after a confirmed reply turn. `dryRun=true` returns metadata without signing.

**Providers:**

| Name | File | Description |
|------|------|-------------|
| `wallet` | `src/providers/wallet-provider.ts` | Injects EVM + Solana addresses into planner context (finance/crypto/wallet contexts, OWNER+ role gate). |
| `evmWalletProvider` | `src/chains/evm/providers/wallet.ts` | EVM-specific wallet context (viem `Account`). |
| `tokenBalanceProvider` | `src/chains/evm/providers/get-balance.ts` | EVM token balances. |
| `agentPortfolioProvider` | `src/analytics/birdeye/providers/agent-portfolio-provider.ts` | Birdeye portfolio for configured `BIRDEYE_WALLET_ADDR`. Registered when that setting is present. |
| `marketProvider` | `src/analytics/birdeye/providers/market.ts` | Birdeye market context. |
| `trendingProvider` | `src/analytics/birdeye/providers/trending.ts` | Birdeye trending tokens. Skipped if `BIRDEYE_NO_TRENDING=true`. |
| Solana `walletProvider` | `src/chains/solana/providers/wallet.ts` | Solana wallet context (balance, address). Registered at init. |

**Services:**

| Name | Service type key | File | Description |
|------|-----------------|------|-------------|
| `WalletBackendService` | `"wallet-backend"` | `src/services/wallet-backend-service.ts` | Core signing router — resolves `WalletBackend`, registers chain handlers, dispatches `routeWalletAction`. |
| `EVMService` | EVM service type | `src/chains/evm/service.ts` | EVM RPC + wallet management. |
| `SolanaService` | `SOLANA_SERVICE_NAME` | `src/chains/solana/service.ts` | Solana RPC, swap routing (Jupiter), portfolio. |
| `SolanaWalletService` | compat alias | `src/chains/solana/service.ts` | Compatibility alias for consumers expecting the old service name. |
| `BirdeyeService` | `BIRDEYE_SERVICE_NAME` | `src/analytics/birdeye/service.ts` | Birdeye API client (market, portfolio, trending). |
| `DexScreenerService` | dexscreener type | `src/analytics/dexscreener/service.ts` | DexScreener pair/token lookup. |
| `TokenInfoService` | `TOKEN_INFO_SERVICE_TYPE` | `src/analytics/token-info/service.ts` | Multi-provider token info dispatcher. |

**Routes (HTTP):**

`handleWalletRoutes` in `src/api/wallet-routes.ts` is mounted by `@elizaos/agent`'s HTTP server. Endpoints cover wallet generate, import, balances, export, config, and chain/RPC settings. Solana-specific REST routes live in `src/chains/solana/routes/` and are registered directly on the plugin's `routes` array.

EVM sign routes live in `src/chains/evm/routes/sign.ts`.

## Layout

```
plugins/plugin-wallet/
  auto-enable.ts               Auto-enable logic (env-read only, no service imports)
  src/
    index.ts                   Package barrel — re-exports everything
    plugin.ts                  walletPlugin object (services/providers/actions/init/dispose)
    core-augmentation.ts       Augments @elizaos/core interfaces with wallet types
    contracts.ts               On-chain contract type definitions and exports
    register-routes.ts         Route registration helpers
    wallet-action.ts           Top-level wallet action re-export
    actions/
      failure-codes.ts         Failure code constants
      intent-trajectory.ts     Intent trajectory types
    browser-shim/              Browser environment shim (build-shim.ts, shim.template.js)
    chains/
      wallet-action.ts         walletRouterAction (WALLET action, all subactions)
      registry.ts              registerDefaultWalletChainHandlers (EVM + Solana + pump.fun)
      evm/
        index.ts               evmPlugin (sub-plugin composed into walletPlugin)
        service.ts             EVMService
        chain-handler.ts       EvmWalletChainHandler (transfer/swap/bridge/gov)
        bridge-router.ts       Li.Fi + CCTP bridge routing
        gov-router.ts          On-chain governance routing
        providers/             evmWalletProvider, tokenBalanceProvider
        routes/sign.ts         EVM sign/verify HTTP routes
        dex/                   Uniswap V3, Aerodrome, PancakeSwap V3 DEX adapters
      solana/
        index.ts               solanaPlugin (sub-plugin composed into walletPlugin)
        service.ts             SolanaService, SolanaWalletService
        keypairUtils.ts        Key loading from settings/env
        providers/wallet.ts    Solana wallet provider
        routes/                Solana REST routes
        dex/                   Raydium, Orca, Meteora DEX adapters
    lib/
      server-wallet-trade.ts   canUseLocalTradeExecution, resolveTradePermissionMode helpers
      wallet-export-guard.ts   Wallet export audit log and guard
    services/
      wallet-backend-service.ts  WalletBackendService — top-level chain router
    wallet/
      backend.ts               WalletBackend interface + SolanaSigner + WalletAddresses
      local-eoa-backend.ts     LocalEoaBackend (raw private keys from env/keychain)
      steward-backend.ts       StewardBackend (cloud/mobile multi-tenant signing)
      select-backend.ts        resolveWalletBackend (auto/local/steward selection)
      pending.ts               SignScope, SignResult types
      errors.ts                WalletBackendNotConfiguredError, StewardUnavailableError
    providers/
      wallet-provider.ts       walletProvider (addresses into planner context)
      canonical-provider.ts    CanonicalProvider interface definition
    analytics/
      birdeye/                 BirdeyeService, market/trending/portfolio providers
      dexscreener/             DexScreenerService
      token-info/              TokenInfoService (multi-provider dispatcher)
      lpinfo/                  kaminoPlugin, lpinfoPlugin, steerPlugin re-exports
      news/                    defiNewsPlugin, NewsDataService
    lp/
      lp-manager-entry.ts      lpManagerPlugin (Uniswap/Aerodrome/Raydium/Orca/Meteora LP)
    sdk/
      index.ts                 ERC-6551 wallet-core, x402, CCTP, escrow, swap, identity
      abi.ts                   AgentAccountV2Abi, AgentAccountFactoryV2Abi
      wallet-core.ts           createWallet, setSpendPolicy, agentTransferToken, checkBudget
      convenience.ts           x402 convenience helpers (reads X402_* env vars)
      x402/                    x402 micropayment protocol types + helpers
    policy/
      policy.ts                PolicyModule (spend-policy enforcement)
    audit/
      audit-log.ts             AuditLogRow schema (hash-chained, append-only)
    security/
      wallet-context-safety.ts   assertWalletFinancialActionAllowed, assertEvmTransferRecipientAuthorized
      wallet-financial-confirmation.ts  requireConfirmation gate for on-chain writes
    api/
      wallet-routes.ts         handleWalletRoutes — mounted by @elizaos/agent HTTP server
    routes/
      plugin.ts                Additional plugin route exports
    types/
      wallet-router.ts         WalletRouterParams, WalletRouterResult, WalletChainHandler interface
```

## Commands

Scripts are defined in `package.json`; run them from the repo root with `bun run --cwd`:

```bash
bun run --cwd plugins/plugin-wallet clean         # remove build output
bun run --cwd plugins/plugin-wallet build         # build package artifacts
bun run --cwd plugins/plugin-wallet typecheck     # TypeScript typecheck
bun run --cwd plugins/plugin-wallet check         # package check alias
bun run --cwd plugins/plugin-wallet lint          # mutating Biome check
bun run --cwd plugins/plugin-wallet lint:check    # read-only Biome check
bun run --cwd plugins/plugin-wallet format        # write formatting
bun run --cwd plugins/plugin-wallet format:check  # read-only formatting check
bun run --cwd plugins/plugin-wallet test          # run package tests
bun run --cwd plugins/plugin-wallet test:watch    # watch test lane
```

## Config / env vars

All read via `runtime.getSetting()` (or `process.env` fallback where noted).

| Variable | Required | Description |
|----------|----------|-------------|
| `ELIZA_WALLET_BACKEND` | No | `local` \| `steward` \| `auto` (default: `auto`). Auto = Steward when cloud-provisioned, else local. |
| `EVM_PRIVATE_KEY` | Local backend | 32-byte hex, 0x-prefixed. Local EOA signing key for EVM. |
| `SOLANA_PRIVATE_KEY` | Solana local | Base58-encoded Solana private key. |
| `STEWARD_API_URL` | Steward backend | Steward API base URL. |
| `STEWARD_AGENT_ID` | Steward backend | Agent identifier for Steward. |
| `STEWARD_AGENT_TOKEN` | Steward backend | Bearer token for Steward. |
| `STEWARD_TENANT_ID` | Steward backend | Tenant/user identifier. |
| `SOLANA_RPC_URL` | Solana features | RPC endpoint; skips Solana init if absent. |
| `SOLANA_NO_ACTIONS` | No | Set to `true` to skip Solana action registration. |
| `PUMPFUN_TRADE_LOCAL_URL` | No | PumpPortal local transaction API. Defaults to `https://pumpportal.fun/api/trade-local`. |
| `PUMPFUN_PRIORITY_FEE_SOL` | No | Priority fee in SOL for `pump_fun_buy`. Defaults to `0.00005`. |
| `PUMPFUN_POOL` | No | PumpPortal pool selector. Defaults to `auto`. |
| `BIRDEYE_API_KEY` | Birdeye features | Direct API key for Birdeye. Falls back to Eliza Cloud route if absent. |
| `BIRDEYE_WALLET_ADDR` | No | Enables `agentPortfolioProvider` for this wallet address. |
| `BIRDEYE_NO_TRENDING` | No | Set to `true` to skip trending provider registration. |
| `ELIZA_AGENT_WALLET_AUTO_ENABLE` | No | Set to `0` to disable auto-enable logic entirely. |
| `COINGECKO_API_KEY` | No | CoinGecko API key (also accepts `COINGECKO_DEMO_API_KEY` / `COINGECKO_PRO_API_KEY`). |
| `HELIUS_API_KEY` | No | Helius API key for enhanced Solana RPC. |
| `ELIZAOS_CLOUD_API_KEY` | No | Eliza Cloud API key for cloud-routing fallbacks. |
| `ELIZA_WALLET_EXPORT_TOKEN` | No | Auth token required to export wallet keys via HTTP routes. |
| `X402_SUPPORTED_NETWORKS` | No | Comma-separated network list for x402 SDK. |
| `X402_GLOBAL_DAILY_LIMIT` | No | Daily USDC spend cap for x402. |
| `X402_PER_REQUEST_MAX` | No | Per-request USDC cap for x402. |

EVM RPC (LP manager / chain routing): `ETHEREUM_RPC_URL` / `EVM_PROVIDER_MAINNET`, `BASE_RPC_URL` / `EVM_PROVIDER_BASE`, `BSC_RPC_URL` / `EVM_PROVIDER_BSC`, `ARBITRUM_RPC_URL` / `EVM_PROVIDER_ARBITRUM`, `AVALANCHE_RPC_URL`, `EVM_PROVIDER_OPTIMISM`, `EVM_PROVIDER_POLYGON`.

## How to extend

**Add a new chain handler (new EVM chain or alt-chain):**

1. Implement `WalletChainHandler` from `src/types/wallet-router.ts`. Provide `chain`, `name`, `supportedSubactions`, `metadata()`, `prepare()`, and `execute()`.
2. Register it in `src/chains/registry.ts` inside `registerDefaultWalletChainHandlers`, calling `service.registerChainHandler(handler)`.
3. No new action needed — `walletRouterAction` dispatches to all registered handlers via `WalletBackendService.routeWalletAction`.

**Add a new analytics provider:**

1. Implement `CanonicalProvider` from `src/providers/canonical-provider.ts`.
2. Register on the runtime inside `plugin.ts` `init` (use `runtime.registerProvider`).
3. Wire into `TokenInfoService` if it should be a token_info dispatch target.

**Add a new Birdeye route:**

Extend `src/analytics/birdeye/service.ts`. The service proxies all calls through `@elizaos/cloud-routing` (`resolveCloudRoute`), so no direct API key management is needed beyond adding the endpoint constant in `src/analytics/birdeye/constants.ts`.

## Conventions / gotchas

- **Financial confirmation gate.** All on-chain subactions (`transfer`, `swap`, `bridge`, `gov`, `pump_fun_buy`) go through `gateWalletFinancialExecution` in `src/security/wallet-financial-confirmation.ts`, which calls `requireConfirmation` from `@elizaos/core`. The LLM cannot bypass this by passing `mode=execute` alone — a confirmed reply turn is always required. Do not remove or short-circuit this gate.
- **`WalletBackend` is the only signing path.** Providers and actions must never read raw private key env vars directly. Go through `WalletBackendService.getWalletBackend()` → `WalletBackend`.
- **pump.fun buy path.** `pump_fun_buy` is a Solana handler alias (`pumpfun`, `pump.fun`, `pump-fun`, `pump`) that requires `toToken`/`token` as a valid Solana mint and `amount` as SOL. It requests a serialized transaction from PumpPortal trade-local, signs through `WalletBackend.getSolanaSigner()` when available (falling back to the existing local `getWalletKey` Solana path), opens the token page through the optional browser service when available, then submits through `SOLANA_RPC_URL`.
- **`handleWalletRoutes` is dependency-injected.** It imports nothing from `@elizaos/agent` to avoid a cycle. All agent-internal helpers (runtime lookup, auth, route helpers) are passed via `WalletRouteContext.deps` by `@elizaos/agent`'s server wiring.
- **Sub-plugins.** `evmPlugin` and `solanaPlugin` are composed into `walletPlugin` in `plugin.ts`. They are not intended to be loaded directly; always depend on `@elizaos/plugin-wallet`.
- **`SDK-LICENSE`** covers the `src/sdk/` subtree (originally from agent-wallet-sdk, MIT).
- **Auto-enable.** `auto-enable.ts` must remain a lightweight env-read module with no transitive plugin imports. The auto-enable engine loads it on every agent boot.

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
