# @elizaos/plugin-wallet

Non-custodial wallet plugin for elizaOS agents. Provides EVM and Solana signing, token transfers, swaps, cross-chain bridging, on-chain governance, LP management, and market analytics behind a single unified action+provider surface.

Replaces the former fan-out across `plugin-evm`, `plugin-solana`, `plugin-raydium`, `plugin-orca`, `plugin-meteora`, `plugin-jupiter`, `plugin-lp-manager`, and `plugin-clanker`.

## Capabilities

### On-chain actions (via the `WALLET` action)

| Subaction | What it does |
|-----------|-------------|
| `transfer` | Send tokens to an external address. EVM or Solana. Always requires user confirmation. |
| `swap` | Token swap via Li.Fi (EVM) or Jupiter (Solana). |
| `bridge` | Cross-chain transfer via Li.Fi route finding or CCTP (Circle's native USDC bridge). |
| `gov` | On-chain governance: propose, vote, queue, execute via OpenZeppelin Governor. |

All write operations default to `mode=prepare` (stages the transaction but does not sign or send). The agent asks the user to confirm before submitting. `dryRun=true` returns metadata without signing.

### Analytics subactions (no wallet required)

| Subaction | What it does |
|-----------|-------------|
| `token_info` | Token and market data from DexScreener, Birdeye, or CoinGecko. |
| `search_address` | Birdeye wallet portfolio lookup by address. |

### LP management

Multi-DEX LP management for both EVM and Solana chains:

- **EVM:** Uniswap V3, Aerodrome, PancakeSwap V3
- **Solana:** Raydium CLMM, Orca Whirlpools, Meteora DLMM

Access via the `lpManagerPlugin` export or the `liquidityAction` subaction.

### Market analytics

- **Birdeye:** real-time prices, trending tokens, portfolio valuation.
- **DexScreener:** pair search, token lookups.
- **Token info:** multi-provider dispatcher (DexScreener, Birdeye, CoinGecko).
- **DeFi news:** via `defiNewsPlugin`.

## Wallet backends

The plugin supports two signing backends, selected by `ELIZA_WALLET_BACKEND`:

- **`local`** — raw EOA private keys from environment variables or the OS keychain. Default for desktop.
- **`steward`** — multi-tenant Steward signing service. Required for cloud and mobile deployments.
- **`auto`** (default) — uses Steward when `ELIZA_CLOUD_PROVISIONED=1` or `ELIZA_WALLET_STEWARD_AUTO=1`, otherwise local.

## Required configuration

None of the variables below are strictly required at load time; the plugin degrades gracefully. To get signing:

| Variable | When needed |
|----------|-------------|
| `EVM_PRIVATE_KEY` | EVM operations with local backend |
| `SOLANA_PRIVATE_KEY` | Solana operations with local backend |
| `STEWARD_API_URL` + `STEWARD_AGENT_TOKEN` | Steward backend or cloud deployments |
| `SOLANA_RPC_URL` | Any Solana operation |

Additional optional variables:

| Variable | Purpose |
|----------|---------|
| `ELIZA_WALLET_BACKEND` | `local` \| `steward` \| `auto` |
| `BIRDEYE_API_KEY` | Direct Birdeye access (falls back to Eliza Cloud route) |
| `BIRDEYE_WALLET_ADDR` | Enables portfolio provider for a specific address |
| `BIRDEYE_NO_TRENDING` | Disable trending provider |
| `ELIZA_AGENT_WALLET_AUTO_ENABLE` | Set to `0` to disable auto-enable |
| `X402_SUPPORTED_NETWORKS` | Comma-separated networks for x402 micropayments |
| `X402_GLOBAL_DAILY_LIMIT` | Daily USDC spending cap for x402 |
| `X402_PER_REQUEST_MAX` | Per-request USDC cap for x402 |

EVM RPC per chain: `ETHEREUM_RPC_URL` / `EVM_PROVIDER_MAINNET`, `BASE_RPC_URL` / `EVM_PROVIDER_BASE`, `BSC_RPC_URL` / `EVM_PROVIDER_BSC`, `ARBITRUM_RPC_URL` / `EVM_PROVIDER_ARBITRUM`.

## Enabling the plugin

The plugin auto-enables when any signing path is present (EVM or Solana private key, or Steward credentials). To opt out of auto-enable, set `ELIZA_AGENT_WALLET_AUTO_ENABLE=0`. To explicitly disable, set `enabled: false` for plugin id `wallet` in the agent config.

## Security model

All on-chain writes (`transfer`, `swap`, `bridge`, `gov`) require an explicit user confirmation before execution. The LLM cannot authorize a transaction by itself — a confirmed human reply turn is always required. EVM recipient addresses on transfers are additionally validated via `assertEvmTransferRecipientAuthorized`.

An append-only hash-chained audit log records all action validate/handler lifecycle events and signing requests.

## SDK

`src/sdk/` provides lower-level ERC-6551 token-bound account primitives, x402 micropayment protocol types, CCTP bridge helpers, and spend-policy tooling. These are primarily for plugin internals but are re-exported from the package barrel for external use. SDK source is MIT-licensed (attribution: agent-wallet-sdk); see `SDK-LICENSE`.

## License

MIT
