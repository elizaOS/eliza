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
| `WALLET` | `token_info` | Read-only token/market data (DexScreener, Birdeye, CoinGecko). |
| `WALLET` | `search_address` | Birdeye wallet/portfolio lookup by address. |

Similes handled: `SWAP`, `SWAP_SOLANA`, `TRANSFER`, `TRANSFER_TOKEN`, `WALLET_SWAP`, `WALLET_TRANSFER`, `CROSS_CHAIN_TRANSFER`, `PREPARE_TRANSFER`, `WALLET_ACTION`, `WALLET_GOV`, `TOKEN_INFO`, `BIRDEYE_LOOKUP`, `BIRDEYE_SEARCH`, `WALLET_SEARCH_ADDRESS`.

All on-chain subactions (`transfer`, `swap`, `bridge`, `gov`) require a user confirmation turn before execution. `mode=prepare` (default) stages without signing; `mode=execute` or a confirmed follow-up submits. `dryRun=true` returns metadata without signing.

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
    chains/
      wallet-action.ts         walletRouterAction (WALLET action, all subactions)
      registry.ts              registerDefaultWalletChainHandlers (EVM + Solana)
      evm/
        index.ts               evmPlugin (sub-plugin composed into walletPlugin)
        service.ts             EVMService
        chain-handler.ts       EvmWalletChainHandler (transfer/swap/bridge/gov)
        bridge-router.ts       Li.Fi + CCTP bridge routing
        gov-router.ts          On-chain governance routing
        providers/             evmWalletProvider, tokenBalanceProvider
        routes/sign.ts         EVM sign/verify HTTP routes
        dex/                   Uniswap V3, Aerodrome DEX adapters
      solana/
        index.ts               solanaPlugin (sub-plugin composed into walletPlugin)
        service.ts             SolanaService, SolanaWalletService
        keypairUtils.ts        Key loading from settings/env
        providers/wallet.ts    Solana wallet provider
        routes/                Solana REST routes
        dex/                   Raydium, Orca, Meteora DEX adapters
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

```bash
bun run --cwd plugins/plugin-wallet build        # tsdown build → dist/
bun run --cwd plugins/plugin-wallet check        # tsc --noEmit type check
bun run --cwd plugins/plugin-wallet lint         # biome check --write --unsafe
bun run --cwd plugins/plugin-wallet test         # vitest run
bun run --cwd plugins/plugin-wallet test:watch   # vitest watch
bun run --cwd plugins/plugin-wallet clean        # rm -rf dist
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
| `BIRDEYE_API_KEY` | Birdeye features | Direct API key for Birdeye. Falls back to Eliza Cloud route if absent. |
| `BIRDEYE_WALLET_ADDR` | No | Enables `agentPortfolioProvider` for this wallet address. |
| `BIRDEYE_NO_TRENDING` | No | Set to `true` to skip trending provider registration. |
| `ELIZA_AGENT_WALLET_AUTO_ENABLE` | No | Set to `0` to disable auto-enable logic entirely. |
| `X402_SUPPORTED_NETWORKS` | No | Comma-separated network list for x402 SDK. |
| `X402_GLOBAL_DAILY_LIMIT` | No | Daily USDC spend cap for x402. |
| `X402_PER_REQUEST_MAX` | No | Per-request USDC cap for x402. |

EVM RPC (LP manager / chain routing): `ETHEREUM_RPC_URL` / `EVM_PROVIDER_MAINNET`, `BASE_RPC_URL` / `EVM_PROVIDER_BASE`, `BSC_RPC_URL` / `EVM_PROVIDER_BSC`, `ARBITRUM_RPC_URL` / `EVM_PROVIDER_ARBITRUM`.

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

- **Financial confirmation gate.** All on-chain subactions (`transfer`, `swap`, `bridge`, `gov`) go through `requireConfirmation` in `src/security/wallet-financial-confirmation.ts`. The LLM cannot bypass this by passing `mode=execute` or `confirmed=true` alone — a confirmed reply turn is always required. Do not remove or short-circuit this gate.
- **`WalletBackend` is the only signing path.** Providers and actions must never read raw private key env vars directly. Go through `WalletBackendService.getWalletBackend()` → `WalletBackend`.
- **`handleWalletRoutes` is dependency-injected.** It imports nothing from `@elizaos/agent` to avoid a cycle. All agent-internal helpers (runtime lookup, auth, route helpers) are passed via `WalletRouteContext.deps` by `@elizaos/agent`'s server wiring.
- **Sub-plugins.** `evmPlugin` and `solanaPlugin` are composed into `walletPlugin` in `plugin.ts`. They are not intended to be loaded directly; always depend on `@elizaos/plugin-wallet`.
- **`SDK-LICENSE`** covers the `src/sdk/` subtree (originally from agent-wallet-sdk, MIT).
- **Auto-enable.** `auto-enable.ts` must remain a lightweight env-read module with no transitive plugin imports. The auto-enable engine loads it on every agent boot.
