<!-- Generated from helius-skills/helius-jupiter/SKILL.md — do not edit -->
<!-- Version: 1.0.1 -->


# Helius x Jupiter — Build DeFi Apps on Solana

You are an expert Solana developer building DeFi applications with Jupiter's APIs and Helius's infrastructure. Jupiter is the leading Solana DEX aggregator and DeFi suite — providing token swaps, lending/borrowing, limit orders, DCA, token data, and more. Helius provides superior transaction submission (Sender), priority fee optimization, asset queries (DAS), real-time on-chain streaming (WebSockets, LaserStream), and wallet intelligence (Wallet API).

## Prerequisites

Before doing anything, verify these:

### 1. Helius MCP Server

**CRITICAL**: Check if Helius MCP tools are available (e.g., `getBalance`, `getAssetsByOwner`, `getPriorityFeeEstimate`). If they are NOT available, **STOP**. Do NOT attempt to call Helius APIs via curl or any other workaround. Tell the user:

```
Configure the Helius MCP server in .clawd/settings.json or your MCP client: npx helius-mcp@latest
Then restart Clawd Code Code so the tools become available.
```

### 2. Jupiter API Key

Jupiter REST endpoints require an API key via the `x-api-key` header. Get one at [developers.jup.ag/portal](https://developers.jup.ag/portal). If the user doesn't have one, read `references/jupiter-portal.md` for setup instructions.

### 3. Helius API Key

If any Helius MCP tool returns an "API key not configured" error, read `references/helius-onboarding.md` for setup paths (existing key, agentic signup, or CLI).

## Routing

Identify what the user is building, then read the relevant reference files before implementing. Always read references BEFORE writing code.

### Quick Disambiguation

These intents map to different Jupiter APIs. Route them correctly:

- **"swap" / "trade" / "exchange tokens"** — Jupiter Swap API Swap + Helius Sender: `references/jupiter-swap.md` + `references/helius-sender.md` + `references/integration-patterns.md`. For priority fee control, also read `references/helius-priority-fees.md`.
- **"limit order" / "buy at price"** — Jupiter Trigger: `references/jupiter-trigger.md` + `references/helius-sender.md`.
- **"DCA" / "dollar cost average" / "recurring buy"** — Jupiter Recurring: `references/jupiter-recurring.md` + `references/helius-sender.md`.
- **"lend" / "earn yield" / "deposit" / "supply"** — Jupiter Lend (earn): `references/jupiter-lend.md` + `references/helius-sender.md`.
- **"borrow" / "leverage" / "vault" / "collateral"** — Jupiter Lend (vaults): `references/jupiter-lend.md` + `references/helius-sender.md`.
- **"token price" / "token info" / "token search"** — Jupiter data APIs: `references/jupiter-tokens-price.md`.
- **"monitor trades" / "track confirmation" / "real-time on-chain"** — Helius WebSockets or LaserStream: `references/helius-websockets.md` OR `references/helius-laserstream.md`.
- **"trading bot" / "HFT" / "liquidation" / "latency-critical"** — LaserStream + Jupiter Swap: `references/helius-laserstream.md` + `references/jupiter-swap.md` + `references/helius-sender.md` + `references/integration-patterns.md`.
- **"portfolio" / "balances" / "token list"** — Asset and wallet queries: `references/helius-das.md` + `references/helius-wallet-api.md`.
- **"send transaction" / "submit"** — Direct transaction submission: `references/helius-sender.md` + `references/helius-priority-fees.md`.
- **"onboarding" / "API key" / "setup"** — Account setup: `references/helius-onboarding.md` + `references/jupiter-portal.md`.
- **"perps" / "leverage trade" / "long" / "short"** — Jupiter Perps (on-chain only): `references/jupiter-perps-predictions.md`. Note: no REST API yet.
- **"prediction market" / "bet" / "event"** — Jupiter Predictions: `references/jupiter-perps-predictions.md`.
- **"swap widget" / "embed swap" / "drop-in swap"** — Jupiter Plugin: `references/jupiter-plugin.md`.
- **"token safety" / "is this token safe"** — Token Shield: `references/jupiter-tokens-price.md`.

### Token Swaps (Swap API V2)
**Reference**: See jupiter-swap.md (inlined below), `references/helius-sender.md`, `references/helius-priority-fees.md`, `references/integration-patterns.md`
**MCP tools**: Helius (`getPriorityFeeEstimate`, `getSenderInfo`, `parseTransactions`)

Use this when the user wants to:
- Swap tokens on Solana (SOL, USDC, any SPL token)
- Build a swap UI or trading terminal
- Execute swaps with optimal routing across the various DEXes integrated with Jupiter
- Get swap quotes with price impact

### Lending & Borrowing (Lend Protocol)
**Reference**: See jupiter-lend.md (inlined below), `references/helius-sender.md`
**MCP tools**: Helius (`getPriorityFeeEstimate`, `parseTransactions`)

Use this when the user wants to:
- Earn yield by depositing tokens (jlTokens)
- Borrow against collateral using vaults
- Query lending rates and pool data
- Build a lending/borrowing UI
- Manage leveraged positions

### Limit Orders (Trigger API V2)
**Reference**: See jupiter-trigger.md (inlined below), `references/helius-sender.md`
**MCP tools**: Helius (`getPriorityFeeEstimate`, `parseTransactions`)

Use this when the user wants to:
- Place limit orders (buy/sell at a USD price target)
- Set up OCO (take-profit + stop-loss) or OTOCO orders
- View, update, or cancel open orders
- Build an order book UI

### Dollar-Cost Averaging (Recurring API)
**Reference**: See jupiter-recurring.md (inlined below), `references/helius-sender.md`
**MCP tools**: Helius (`getPriorityFeeEstimate`, `parseTransactions`)

Use this when the user wants to:
- Set up recurring token purchases (DCA)
- View or cancel DCA orders
- Build a DCA interface

### Perpetuals & Prediction Markets
**Reference**: See jupiter-perps-predictions.md (inlined below), `references/helius-sender.md`
**MCP tools**: Helius (`getPriorityFeeEstimate`, `parseTransactions`, `getAccountInfo`)

Use this when the user wants to:
- Open long/short leveraged positions (perps — on-chain only)
- Trade on prediction markets (events, YES/NO outcomes)
- Query position data or market orderbooks
- Build a perps or prediction market UI

### Swap Widget (Jupiter Plugin)
**Reference**: See jupiter-plugin.md (inlined below)

Use this when the user wants to:
- Embed a swap UI without building from scratch
- Add a floating swap widget to an existing app
- Integrate Jupiter swaps with minimal code

### Token & Price Data
**Reference**: See jupiter-tokens-price.md (inlined below)

Use this when the user wants to:
- Search for tokens by name, symbol, or mint address
- Get token prices with confidence levels
- Verify token legitimacy (organic score, community validation)
- Build token selectors or price feeds

### Real-Time On-Chain Monitoring (Helius)
**Reference**: See helius-websockets.md (inlined below) OR `references/helius-laserstream.md`
**MCP tools**: Helius (`transactionSubscribe`, `accountSubscribe`, `getEnhancedWebSocketInfo`, `laserstreamSubscribe`, `getLaserstreamInfo`, `getLatencyComparison`)

Use this when the user wants to:
- Monitor transaction confirmations after swaps
- Track wallet activity in real time
- Build live dashboards of on-chain activity
- Stream account changes for lending positions

**Choosing between them**:
- Enhanced WebSockets: simpler setup, WebSocket protocol, good for most real-time needs (Business+ plan)
- LaserStream gRPC: lowest latency (shred-level), historical replay, 40x faster than JS Yellowstone clients, best for trading bots and HFT (Professional plan)
- Use `getLatencyComparison` MCP tool to show the user the tradeoffs

### Low-Latency Trading (LaserStream)
**Reference**: See helius-laserstream.md (inlined below), `references/integration-patterns.md`
**MCP tools**: Helius (`laserstreamSubscribe`, `getLaserstreamInfo`)

Use this when the user wants to:
- Build a high-frequency trading system
- Detect arbitrage opportunities at shred-level latency
- Run a liquidation engine for lending positions
- Monitor Jupiter swap fills at the lowest possible latency

### Portfolio & Token Discovery
**Reference**: See helius-das.md (inlined below), `references/helius-wallet-api.md`
**MCP tools**: Helius (`getAssetsByOwner`, `getAsset`, `searchAssets`, `getWalletBalances`, `getWalletHistory`, `getWalletIdentity`)

Use this when the user wants to:
- Build token lists for a swap UI (user's holdings as "From" tokens)
- Get wallet portfolio breakdowns
- Query token metadata, prices, or ownership
- Analyze wallet activity and fund flows

### Transaction Submission
**Reference**: See helius-sender.md (inlined below), `references/helius-priority-fees.md`
**MCP tools**: Helius (`getPriorityFeeEstimate`, `getSenderInfo`)

Use this when the user wants to:
- Submit raw transactions with optimal landing rates
- Understand Sender endpoints and requirements
- Optimize priority fees for any transaction

### Account & Token Data
**MCP tools**: Helius (`getBalance`, `getTokenBalances`, `getAccountInfo`, `getTokenAccounts`, `getProgramAccounts`, `getTokenHolders`, `getBlock`, `getNetworkStatus`)

Use this when the user wants to:
- Check balances (SOL or SPL tokens)
- Inspect account data or program accounts
- Get token holder distributions

These are straightforward data lookups. No reference file needed — just use the MCP tools directly.

### Getting Started / Onboarding
**Reference**: See helius-onboarding.md (inlined below), `references/jupiter-portal.md`
**MCP tools**: Helius (`setHeliusApiKey`, `generateKeypair`, `signup`, `getAccountStatus`)

Use this when the user wants to:
- Create a Helius account or set up API keys
- Get a Jupiter API key (direct them to [developers.jup.ag/portal](https://developers.jup.ag/portal))
- Understand rate limits and authentication requirements

### Documentation & Troubleshooting
**MCP tools**: Helius (`lookupHeliusDocs`, `listHeliusDocTopics`, `troubleshootError`, `getRateLimitInfo`)

Use this when the user needs help with Helius-specific API details, errors, or rate limits.

For Jupiter API details, consult the Jupiter docs at [dev.jup.ag](https://dev.jup.ag/).

## Composing Multiple Domains

Many real tasks span multiple domains. Here's how to compose them:

### "Build a swap/trading app"
1. Read `references/jupiter-swap.md` + `references/helius-sender.md` + `references/helius-priority-fees.md` + `references/integration-patterns.md`
2. Architecture: Jupiter Swap API API for quotes/routing, Helius Sender for submission, DAS for token lists
3. Use Pattern 1 from integration-patterns for the swap execution flow
4. Use Pattern 2 for building the token selector
5. Use `requestId` for idempotent retries

### "Build a DeFi dashboard with swap + lending"
1. Read `references/jupiter-swap.md` + `references/jupiter-lend.md` + `references/helius-wallet-api.md` + `references/helius-das.md` + `references/integration-patterns.md`
2. Architecture: Wallet API for holdings, DAS for token metadata, Jupiter Lend for yield data, Jupiter Swap API for swap execution
3. Use Pattern 5 from integration-patterns

### "Build a trading bot"
1. Read `references/jupiter-swap.md` + `references/helius-laserstream.md` + `references/helius-sender.md` + `references/integration-patterns.md`
2. Architecture: LaserStream for price signals, Jupiter Swap API for execution, Helius Sender for submission
3. Use Pattern 6 from integration-patterns

### "Build a lending/borrowing dApp"
1. Read `references/jupiter-lend.md` + `references/helius-sender.md` + `references/helius-websockets.md` + `references/integration-patterns.md`
2. Architecture: Jupiter Lend SDKs for operations, Helius Sender for tx submission, WebSockets for position monitoring
3. Use Pattern 3 from integration-patterns

### "Build a limit order / DCA app"
1. Read `references/jupiter-trigger.md` + `references/jupiter-recurring.md` + `references/helius-sender.md` + `references/integration-patterns.md`
2. Architecture: Jupiter Trigger/Recurring APIs for order management, Helius for submission and monitoring
3. Use Pattern 4 from integration-patterns

### "Build a perps trading interface"
1. Read `references/jupiter-perps-predictions.md` + `references/helius-sender.md` + `references/helius-websockets.md`
2. Architecture: Jupiter Perps program for position management, Helius Sender for submission, WebSockets for real-time position monitoring and liquidation alerts
3. Use Helius `getAccountInfo` to read position account data on-chain

### "Add a swap widget to an existing app"
1. Read `references/jupiter-plugin.md`
2. Architecture: Drop-in Jupiter Plugin component, no backend needed
3. Optionally combine with Helius DAS for portfolio context

### "Build a high-frequency / latency-critical trading system"
1. Read `references/helius-laserstream.md` + `references/jupiter-swap.md` + `references/helius-sender.md` + `references/helius-priority-fees.md` + `references/integration-patterns.md`
2. Architecture: LaserStream for shred-level on-chain data, Jupiter Swap API for execution, Helius Sender for submission
3. Choose the closest LaserStream regional endpoint for minimal latency

## Rules

Follow these rules in ALL implementations:

### Transaction Sending
- ALWAYS submit Jupiter swap transactions via Helius Sender endpoints — never raw `sendTransaction` to standard RPC
- ALWAYS include `skipPreflight: true` and `maxRetries: 0` when using Sender
- Jupiter Swap API handles priority fees automatically — do not add duplicate compute budget instructions for `/order` swaps
- If building custom transactions (lending, vaults), include a Jito tip (minimum 0.0002 SOL) and priority fee via `ComputeBudgetProgram.setComputeUnitPrice`
- Use `getPriorityFeeEstimate` MCP tool for fee levels — never hardcode fees

### Jupiter APIs
- ALWAYS include the `x-api-key` header for all Jupiter REST endpoints
- ALWAYS use atomic units for token amounts (e.g., `1_000_000_000` for 1 SOL, `1_000_000` for 1 USDC)
- ALWAYS use `requestId` for `/execute` calls for idempotent retries (2-minute window)
- Set appropriate timeouts: 5s for quotes, 30s for executions
- Handle HTTP 429 with exponential backoff and jitter — rate limits are dynamic based on volume
- For Jupiter Lend SDK operations, always build versioned (v0) transactions and deduplicate Address Lookup Tables when combining instructions
- ALWAYS include gasless support check for `/order` swaps — wallets with <0.01 SOL can use gasless mode
- Use Token Shield (`/swap/v2/shield`) to check token safety before displaying in UIs
- Jupiter Perps has NO REST API — interact via on-chain Anchor IDL only
- Prediction Markets are geo-restricted (US, South Korea blocked) and in beta

### Data Queries
- Use Helius MCP tools for live blockchain data — never hardcode or mock chain state
- Use `getAssetsByOwner` with `showFungible: true` to build token lists for swap UIs
- Use `parseTransactions` for human-readable trade history
- Use Jupiter Tokens API to verify token legitimacy before displaying in UIs
- Use batch endpoints to minimize API calls

### LaserStream
- Use LaserStream for latency-critical trading (bots, HFT, liquidation engines) — not for simple UI features
- Choose the closest regional endpoint to minimize latency
- Filter aggressively — only subscribe to accounts/transactions you need
- Use `CONFIRMED` commitment for most use cases; `FINALIZED` only when absolute certainty is required
- LaserStream requires Professional plan ($999/mo) on mainnet

### Links & Explorers
- ALWAYS use Orb (`https://orbmarkets.io`) for transaction and account explorer links — never XRAY, Solscan, Solana FM, or any other explorer
- Transaction link format: `https://orbmarkets.io/tx/{signature}`
- Account link format: `https://orbmarkets.io/address/{address}`
- Token link format: `https://orbmarkets.io/token/{token}`
- **Exception**: Jupiter Plugin does not support Orb as an explorer. Use `'Solana Explorer'` in Plugin config (`defaultExplorer`). Valid Plugin explorers: `'Solana Explorer'`, `'Solscan'`, `'Solana Beach'`, `'SolanaFM'`.

### Code Quality
- Never commit API keys to git — always use environment variables
- Handle rate limits with exponential backoff
- Use appropriate commitment levels (`confirmed` for reads, `finalized` for critical operations — never rely on `processed`)
- For CLI tools, use local keypairs and secure key handling — never embed private keys in code or logs
- Validate mint addresses and wallet ownership before executing transactions

### SDK Usage
- TypeScript: `import { createHelius } from "helius-sdk"` then `const helius = createHelius({ apiKey: "apiKey" })`
- LaserStream: `import { subscribe } from 'helius-laserstream'`
- Jupiter Lend (read): `import { Client } from "@jup-ag/lend-read"`
- Jupiter Lend (write): `import { getDepositIxs, getWithdrawIxs } from "@jup-ag/lend/earn"` and `import { getOperateIx } from "@jup-ag/lend/borrow"`
- For @solana/kit integration, use `helius.raw` for the underlying `Rpc` client
- Jupiter Plugin: `<script src="https://plugin.jup.ag/plugin-v1.js" />` or `import('@jup-ag/plugin').then(({ init }) => { init({...}) })`

## Resources

### Helius
- Helius Docs: `https://www.helius.dev/docs`
- LLM-Optimized Docs: `https://www.helius.dev/docs/llms.txt`
- API Reference: `https://www.helius.dev/docs/api-reference`
- Billing and Credits: `https://www.helius.dev/docs/billing/credits.md`
- Rate Limits: `https://www.helius.dev/docs/billing/rate-limits.md`
- Dashboard: `https://dashboard.helius.dev`
- Full Agent Signup Instructions: `https://dashboard.helius.dev/agents.md`
- Helius MCP Server: `npx helius-mcp@latest` (configure in `.clawd/settings.json` or your MCP client)
- LaserStream SDK: `open-clawd.local/helius-labs/laserstream-sdk`

### Jupiter
- Jupiter Docs: `https://dev.jup.ag`
- LLM-Optimized Docs: `https://dev.jup.ag/docs/llms.txt`
- Jupiter Portal (API keys): `https://developers.jup.ag/portal`
- Jupiter Lend Docs: `https://dev.jup.ag/docs/lend`
- Jupiter Lend SDKs: `@jup-ag/lend-read` (read) and `@jup-ag/lend` (write)
- Jupiter Agent Skills: `open-clawd.local/jup-ag/agent-skills`
- Jupiter Lend Programs: `open-clawd.local/Instadapp/fluid-solana-programs`
- Jupiter Plugin Docs: `https://dev.jup.ag/docs/plugin`
- Jupiter Perps Docs: `https://dev.jup.ag/docs/perps`
- Jupiter Prediction Markets: `https://dev.jup.ag/docs/prediction`


---

# Reference Files

## helius-das.md

# DAS API — Digital Asset Standard

## What DAS Covers

The DAS API is a unified interface for ALL Solana digital assets: NFTs, compressed NFTs (cNFTs), fungible SPL tokens, Token-2022 tokens, and inscriptions. Use it instead of parsing raw on-chain accounts — everything is indexed and queryable.

- 10 credits per request
- 2-3 second indexing latency for new assets
- Batch queries up to 1,000 assets
- Includes off-chain metadata (Arweave, IPFS) and token price data
- Pagination starts at page **1** (not 0)
- Max **1,000** results per request

## Choosing the Right Method

| You want to... | Use this method | MCP tool |
|---|---|---|
| Get one asset by mint/ID | `getAsset` | `getAsset` |
| Get many assets by IDs (up to 1000) | `getAssetBatch` | `getAsset` (with array) |
| Get all assets for a wallet | `getAssetsByOwner` | `getAssetsByOwner` |
| Browse a collection | `getAssetsByGroup` | `getAssetsByGroup` |
| Find assets by creator | `getAssetsByCreator` | (via `searchAssets`) |
| Find assets by update authority | `getAssetsByAuthority` | (via `searchAssets`) |
| Search with multiple filters | `searchAssets` | `searchAssets` |
| Get Merkle proof for cNFT | `getAssetProof` | `getAssetProof` |
| Get proofs for multiple cNFTs | `getAssetProofBatch` | `getAssetProofBatch` |
| Get tx history for a cNFT | `getSignaturesForAsset` | `getSignaturesForAsset` |
| Get editions for a master NFT | `getNftEditions` | `getNftEditions` |
| Get token accounts for a mint | `getTokenAccounts` | `getTokenAccounts` |

**Important**: `getAssetsByCreator` does NOT work for pump.fun tokens. The DAS "creator" field refers to Metaplex creators metadata, not the deployer wallet. Use the `getPumpFunGuide` MCP tool for pump.fun patterns.

## The tokenType Parameter

When using `searchAssets` or `getAssetsByOwner` with `showFungible: true`, the `tokenType` parameter controls what's returned:

| tokenType | Returns | Use case |
|---|---|---|
| `fungible` | SPL tokens and Token-2022 tokens only | Wallet balances, token-gating |
| `nonFungible` | All NFTs (compressed + regular) | Portfolio overview |
| `regularNft` | Legacy and programmable NFTs (uncompressed) | Marketplace listings |
| `compressedNft` | cNFTs only | Mass mints, compressed collections |
| `all` | Everything (tokens + NFTs) | Catch-all discovery |

Every `searchAssets` request MUST include a `tokenType`. If omitted, only NFTs and cNFTs are returned (backwards compatibility).

## Display Options

These flags add extra data to responses. Only request what you need:

| Flag | Effect |
|---|---|
| `showFungible` | Include fungible tokens (SPL + Token-2022) with balances and price data |
| `showNativeBalance` | Include SOL balance of the wallet |
| `showCollectionMetadata` | Add collection-level JSON metadata |
| `showGrandTotal` | Return total match count (slower — only use if you need the total) |
| `showInscription` | Append inscription and SPL-20 data |
| `showZeroBalance` | Include zero-balance token accounts |

## Core Query Patterns

### Get a Single Asset

```typescript
// Via MCP tool
getAsset({ id: "ASSET_MINT_ADDRESS" })

// Via API
{
  jsonrpc: '2.0',
  id: 'my-id',
  method: 'getAsset',
  params: { id: 'ASSET_MINT_ADDRESS' }
}
```

Response includes: `content` (metadata, name, symbol, image), `ownership` (owner), `compression` (compressed status), `royalty`, `creators`, `token_info` (for fungibles: balance, decimals, price_info).

### Get All Assets for a Wallet

Use `getAssetsByOwner` with `showFungible: true` to get NFTs AND tokens in one call:

```typescript
{
  jsonrpc: '2.0',
  id: 'my-id',
  method: 'getAssetsByOwner',
  params: {
    ownerAddress: 'WALLET_ADDRESS',
    page: 1,
    limit: 1000,
    displayOptions: {
      showFungible: true,
      showNativeBalance: true,
      showCollectionMetadata: true,
    }
  }
}
```

This is the best single call for building a portfolio view.

### Browse a Collection

Use `getAssetsByGroup` with `groupKey: "collection"`:

```typescript
{
  jsonrpc: '2.0',
  id: 'my-id',
  method: 'getAssetsByGroup',
  params: {
    groupKey: 'collection',
    groupValue: 'COLLECTION_ADDRESS',
    page: 1,
    limit: 1000,
  }
}
```

### Search with Filters

`searchAssets` supports complex multi-criteria queries:

```typescript
{
  jsonrpc: '2.0',
  id: 'my-id',
  method: 'searchAssets',
  params: {
    ownerAddress: 'WALLET_ADDRESS',         // optional
    grouping: ['collection', 'COLLECTION'], // optional
    creatorAddress: 'CREATOR_ADDRESS',      // optional
    creatorVerified: true,                  // optional
    compressed: true,                       // optional
    burnt: false,                           // optional
    tokenType: 'nonFungible',              // REQUIRED
    page: 1,
    limit: 100,
    sortBy: { sortBy: 'created', sortDirection: 'desc' },
  }
}
```

### Batch Lookups

Use `getAssetBatch` to fetch up to 1,000 assets in one request instead of multiple `getAsset` calls:

```typescript
{
  jsonrpc: '2.0',
  id: 'my-id',
  method: 'getAssetBatch',
  params: { ids: ['ASSET_1', 'ASSET_2', 'ASSET_3'] }
}
```

## Fungible Token Data

When `showFungible: true` is set, fungible tokens include a `token_info` field:

```json
{
  "token_info": {
    "symbol": "JitoSOL",
    "balance": 35688813508,
    "supply": 5949594702758293,
    "decimals": 9,
    "token_program": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
    "associated_token_address": "H7iLu4DPFpzEx1AGN8BCN7Qg966YFndt781p6ukhgki9",
    "price_info": {
      "price_per_token": 56.47,
      "total_price": 2015.68,
      "currency": "USDC"
    }
  }
}
```

Token-2022 tokens additionally include a `mint_extensions` field with parsed extension data (transfer fees, metadata, etc.).

## Compressed NFT Operations

### Getting Merkle Proofs

Compressed NFTs live in Merkle trees. To transfer or burn a cNFT, you need its proof:

```typescript
// Single proof
{
  method: 'getAssetProof',
  params: { id: 'CNFT_ASSET_ID' }
}

// Batch proofs
{
  method: 'getAssetProofBatch',
  params: { ids: ['CNFT_1', 'CNFT_2'] }
}
```

Proof response:

```json
{
  "root": "...",
  "proof": ["...", "..."],
  "node_index": 12345,
  "leaf": "...",
  "tree_id": "MERKLE_TREE_ADDRESS"
}
```

### cNFT Transaction History

Standard `getSignaturesForAddress` does NOT work for compressed NFTs. Use `getSignaturesForAsset` instead:

```typescript
{
  method: 'getSignaturesForAsset',
  params: { id: 'CNFT_ASSET_ID', page: 1, limit: 100 }
}
```

## Pagination

DAS supports two pagination mechanisms:

### Page-Based (recommended for most use cases)

Start at `page: 1`, request up to `limit: 1000`. Loop: collect `result.items`, break when `items.length < limit`, else increment page.

### Cursor-Based (recommended for large datasets 500k+)

Avoids database scanning overhead at high page numbers. Requires `sortBy: { sortBy: 'id', sortDirection: 'asc' }`. On each iteration, pass `cursor` from the previous `result.cursor`. Break when `result.items` is empty.

Cursor pagination only works when sorting by `id`.

### Sorting Options

| sortBy | Description |
|---|---|
| `id` | Sort by asset ID in binary (default, required for cursor pagination) |
| `created` | Sort by creation date |
| `recent_action` | Sort by last update date (not recommended) |
| `none` | No sorting (fastest but inconsistent pagination) |

## SDK Usage

```typescript
// TypeScript — DAS methods are on the root namespace
const assets = await helius.getAssetsByOwner({ ownerAddress: 'ADDR', page: 1, limit: 100, displayOptions: { showFungible: true } });
const asset = await helius.getAsset({ id: 'ASSET_ID' });
const results = await helius.searchAssets({ grouping: ['collection', 'COLLECTION_ADDR'] });
```

```rust
// Rust — DAS methods via helius.rpc()
let assets = helius.rpc().get_assets_by_owner("ADDR").await?;
```

## Building Common Features

### Portfolio View
1. `getAssetsByOwner` with `showFungible: true, showNativeBalance: true` for the full picture
2. Filter `token_info.price_info` for tokens with USD prices
3. Use `getAsset` for detail views on individual assets

### NFT Marketplace / Gallery
1. `getAssetsByGroup` for collection browsing pages
2. `searchAssets` for search/filter functionality
3. `getAsset` for individual NFT detail pages
4. Set up webhooks (see Helius docs at `docs.helius.dev`) to monitor sales and listings

### Token-Gated Application
1. `searchAssets` with `ownerAddress` + `grouping: ['collection', 'REQUIRED_COLLECTION']`
2. If `result.total > 0`, the user holds the required NFT
3. For fungible gating, check `token_info.balance` against a threshold

## Common Mistakes

- Forgetting `tokenType` in `searchAssets` — returns only NFTs by default, missing fungible tokens
- Using `page: 0` — DAS pagination starts at 1, not 0
- Using `getAssetsByCreator` for pump.fun tokens — it won't work; use `getAsset` with the mint directly
- Using `getSignaturesForAddress` for cNFTs — use `getSignaturesForAsset` instead
- Not using batch methods — `getAssetBatch` is far more efficient than multiple `getAsset` calls
- Requesting `showGrandTotal` on every query — it's slower; only use when you need the count
- Using page-based pagination for huge datasets (500k+) — switch to cursor-based


---

## helius-laserstream.md

# LaserStream — High-Performance gRPC Streaming

## What LaserStream Is

LaserStream is a next-generation gRPC streaming service for Solana data. It is a drop-in replacement for Yellowstone gRPC with significant advantages:

- **Ultra-low latency**: taps directly into Solana leaders to receive shreds as they're produced
- **24-hour historical replay**: replay up to 216,000 slots (~24 hours) of data after disconnections via `from_slot`
- **Auto-reconnect**: built-in reconnection with automatic replay of missed data via the SDKs
- **Multi-node failover**: redundant node clusters with automatic load balancing
- **40x faster** than JavaScript Yellowstone clients (Rust core with zero-copy NAPI bindings)
- **9 global regions** for minimal latency
- **Mainnet requires Professional plan** ($999/mo); Devnet available on Developer+ plans
- 3 credits per 0.1 MB of streamed data (uncompressed)

## MCP Tools and SDK Workflow

LaserStream has two MCP tools that work together with the SDK:

1. **`getLaserstreamInfo`** — Returns current capabilities, regional endpoints, pricing, and SDK info. Use this first to check plan requirements and choose the right region.
2. **`laserstreamSubscribe`** — Validates subscription parameters and generates the correct subscription config JSON + ready-to-use SDK code example. Use this to build the subscription.

**Important**: The MCP tools are config generators, not live streams. gRPC streams cannot run over MCP's stdio protocol. The workflow is:

1. Use `getLaserstreamInfo` to get endpoint and capability details
2. Use `laserstreamSubscribe` with the user's requirements to generate the correct subscription config and SDK code
3. The generated code uses the `helius-laserstream` SDK — place it in the user's application code where the actual gRPC stream will run

ALWAYS use the MCP tools first to generate correct configs, then embed the SDK code they produce into the user's project.

## Endpoints

Choose the region closest to your infrastructure:

### Mainnet

| Region | Location | Endpoint |
|---|---|---|
| ewr | Newark, NJ | `https://laserstream-mainnet-ewr.helius-rpc.com` |
| pitt | Pittsburgh | `https://laserstream-mainnet-pitt.helius-rpc.com` |
| slc | Salt Lake City | `https://laserstream-mainnet-slc.helius-rpc.com` |
| lax | Los Angeles | `https://laserstream-mainnet-lax.helius-rpc.com` |
| lon | London | `https://laserstream-mainnet-lon.helius-rpc.com` |
| ams | Amsterdam | `https://laserstream-mainnet-ams.helius-rpc.com` |
| fra | Frankfurt | `https://laserstream-mainnet-fra.helius-rpc.com` |
| tyo | Tokyo | `https://laserstream-mainnet-tyo.helius-rpc.com` |
| sgp | Singapore | `https://laserstream-mainnet-sgp.helius-rpc.com` |

### Devnet

```
https://laserstream-devnet-ewr.helius-rpc.com
```

## Subscription Types

LaserStream supports 7 subscription types that can be combined in a single request:

| Type | What It Streams | Key Filters |
|---|---|---|
| **accounts** | Account data changes | `account` (pubkey list), `owner` (program list), `filters` (memcmp, datasize, lamports) |
| **transactions** | Full transaction data | `account_include`, `account_exclude`, `account_required`, `vote`, `failed` |
| **transactions_status** | Tx status only (lighter) | Same filters as transactions |
| **slots** | Slot progress | `filter_by_commitment`, `interslot_updates` |
| **blocks** | Full block data | `account_include`, `include_transactions`, `include_accounts`, `include_entries` |
| **blocks_meta** | Block metadata only (lighter) | None (all blocks) |
| **entry** | Block entries | None (all entries) |

### Commitment Levels

All subscriptions support:
- `PROCESSED` (0): processed by current node — fastest, least certainty
- `CONFIRMED` (1): confirmed by supermajority — good default
- `FINALIZED` (2): finalized by cluster — most certain, higher latency

### Historical Replay

Set `from_slot` to replay data from a past slot (up to 216,000 slots / ~24 hours back). The SDK handles this automatically on reconnection.

## Implementation Pattern — Using the LaserStream SDK

ALWAYS start by calling the `laserstreamSubscribe` MCP tool with the user's requirements. It will generate validated config and SDK code. The example below shows what the generated code looks like.

The `helius-laserstream` SDK is the recommended way to connect. It handles reconnection, historical replay, and optimized data handling automatically.

```typescript
import { subscribe, CommitmentLevel } from 'helius-laserstream';

const config = {
  apiKey: "your-helius-api-key",
  endpoint: "https://laserstream-mainnet-ewr.helius-rpc.com",
};

// Subscribe to transactions for specific accounts
const request = {
  transactions: {
    client: "my-app",
    accountInclude: ["TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"],
    accountExclude: [],
    accountRequired: [],
    vote: false,
    failed: false,
  },
  commitment: CommitmentLevel.CONFIRMED,
};

await subscribe(
  config,
  request,
  (data) => {
    console.log("Update:", data);
  },
  (error) => {
    console.error("Error:", error);
  }
);
```

SDK repo: `https://open-clawd.local/helius-labs/laserstream-sdk`

## Transaction Filtering

Transaction subscriptions support three address filter types:

- **`account_include`**: transactions must involve ANY of these addresses (OR logic, up to 10M pubkeys)
- **`account_exclude`**: exclude transactions involving these addresses
- **`account_required`**: transactions must involve ALL of these addresses (AND logic)

```json
{
  "transactions": {
    "account_include": ["PROGRAM_ID_1", "PROGRAM_ID_2"],
    "account_exclude": ["VOTE_PROGRAM"],
    "account_required": ["MUST_HAVE_THIS_ACCOUNT"],
    "vote": false,
    "failed": false
  },
  "commitment": 1
}
```

## Account Filtering

Account subscriptions support:

- **`account`**: specific pubkeys to monitor
- **`owner`**: monitor all accounts owned by these programs
- **`filters`**: advanced filtering on account data
  - `memcmp`: match bytes at a specific offset
  - `datasize`: exact account data size in bytes
  - `token_account_state`: filter to only token accounts
  - `lamports`: filter by SOL balance (`eq`, `ne`, `lt`, `gt`)

```json
{
  "accounts": {
    "my-label": {
      "account": ["SPECIFIC_PUBKEY"],
      "owner": ["TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"],
      "filters": {
        "datasize": 165,
        "token_account_state": true
      },
      "nonempty_txn_signature": true
    }
  },
  "commitment": 1
}
```

## Migrating from Yellowstone gRPC

LaserStream is a drop-in replacement. Just change the endpoint and auth token:

```typescript
// Before: Yellowstone gRPC
const connection = new GeyserConnection(
  "your-current-endpoint.com",
  { token: "your-current-token" }
);

// After: LaserStream
const connection = new GeyserConnection(
  "https://laserstream-mainnet-ewr.helius-rpc.com",
  { token: "your-helius-api-key" }
);
```

All existing Yellowstone gRPC code works unchanged.

## Utility Methods

LaserStream also provides standard gRPC utility methods:

| Method | Description |
|---|---|
| `GetBlockHeight` | Current block height |
| `GetLatestBlockhash` | Latest blockhash + last valid block height |
| `GetSlot` | Current slot number |
| `GetVersion` | API and Solana node version info |
| `IsBlockhashValid` | Check if a blockhash is still valid |
| `Ping` | Connection health check |

## LaserStream vs Enhanced WebSockets

| Feature | LaserStream | Enhanced WebSockets |
|---|---|---|
| Protocol | gRPC | WebSocket |
| Latency | Lowest (shred-level) | Low (1.5-2x faster than standard WS) |
| Historical replay | Yes (24 hours) | No |
| Auto-reconnect | Built-in with replay | Manual |
| Plan required | Professional (mainnet) | Business+ |
| Max pubkeys | 10M | 50K |
| Best for | Indexers, bots, high-throughput pipelines | Real-time UIs, dashboards, monitoring |
| SDK | `helius-laserstream` | Raw WebSocket |
| Yellowstone compatible | Yes (drop-in) | No |

**Use LaserStream when**: you're building an indexer, high-frequency trading system, or anything that needs the lowest possible latency, historical replay, or processes high data volumes.

**Use Enhanced WebSockets when**: you're building a real-time UI, dashboard, or monitoring tool that needs simpler WebSocket-based integration and doesn't need historical replay.

Use the `getLatencyComparison` MCP tool to show the user detailed tradeoffs.

## Common Patterns

### Monitor a specific program

```json
{
  "transactions": {
    "account_include": ["YOUR_PROGRAM_ID"],
    "vote": false,
    "failed": false
  },
  "commitment": 1
}
```

### Stream all token transfers

```json
{
  "transactions": {
    "account_include": ["TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"],
    "vote": false,
    "failed": false
  },
  "commitment": 1
}
```

### Track account balance changes

```json
{
  "accounts": {
    "balance-watch": {
      "account": ["WALLET_ADDRESS_1", "WALLET_ADDRESS_2"],
      "nonempty_txn_signature": true
    }
  },
  "commitment": 1
}
```

### Combined subscription with historical replay

```json
{
  "accounts": {
    "my-accounts": {
      "account": ["PUBKEY"],
      "nonempty_txn_signature": true
    }
  },
  "slots": {
    "filter_by_commitment": true
  },
  "commitment": 2,
  "from_slot": 139000000,
  "ping": { "id": 123 }
}
```

## Best Practices

- ALWAYS use the `laserstreamSubscribe` MCP tool to generate subscription configs — it validates parameters and produces correct SDK code
- Choose the closest regional endpoint to minimize latency
- Use the LaserStream SDK (`helius-laserstream`) — it handles reconnection and replay automatically
- Filter aggressively — only subscribe to accounts/transactions you need to minimize data transfer and credit usage
- Use `CONFIRMED` commitment for most use cases; `FINALIZED` only when absolute certainty is required
- For partial account data, use `accounts_data_slice` to reduce bandwidth (specify offset + length)
- Implement ping messages for connection health monitoring in long-running subscriptions
- Use `transactions_status` instead of `transactions` when you only need status (lighter payload)

## Common Mistakes

- Using LaserStream for simple real-time features that Enhanced WebSockets can handle (unnecessary complexity)
- Not setting `from_slot` after reconnection (misses data during the disconnect gap)
- Subscribing to all transactions without filters (massive data volume and credit burn)
- Forgetting that mainnet requires the Professional plan
- Using `PROCESSED` commitment for financial decisions (can be rolled back)
- Not choosing the closest regional endpoint (adds unnecessary latency)


---

## helius-onboarding.md

# Onboarding — Account Setup, API Keys & Plans

## What This Covers

Getting users set up with Helius: creating accounts, obtaining API keys, understanding plans, and managing billing. There are three paths to get an API key, plus SDK-based signup for applications.

## MCP Tools

| MCP Tool | What It Does |
|---|---|
| `setHeliusApiKey` | Configure an existing API key for the session (validates against `getBlockHeight`) |
| `generateKeypair` | Generate or load a Solana keypair for signup (persists to `~/.helius/keypair.json`) |
| `signup` | Create a Helius account via hosted payment link (`mode: "link"`), or pay USDC directly from the local keypair (`mode: "autopay"`), or finalize a previously-created intent (`mode: "resume"`) |
| `getAccountStatus` | Check current plan, credits remaining, rate limits, billing cycle, burn-rate projections |
| `getHeliusPlanInfo` | View plan details — pricing, credits, rate limits, features |
| `compareHeliusPlans` | Compare plans side-by-side by category (rates, features, connections, pricing, support) |
| `previewUpgrade` | Preview upgrade pricing with proration before committing |
| `upgradePlan` | Execute a plan upgrade (returns a hosted payment link or pays USDC directly) |
| `payRenewal` | Pay a renewal payment intent |
| `purchaseCredits` | Buy prepaid credits (link or autopay) |

## Getting an API Key

### Path A: Existing Key (Fastest)

If the user already has a Helius API key from the dashboard:

1. Use the `setHeliusApiKey` MCP tool with their key
2. The tool validates the key against `getBlockHeight`, then persists it to shared config
3. All Helius MCP tools are immediately available

If the environment variable `HELIUS_API_KEY` is already set, no action is needed — tools auto-detect it.

### Path B: MCP Signup (For AI Agents)

Two modes — pick based on whether the user wants to pay in a browser or have the agent pay USDC from a local keypair.

**Link mode (default — pay in browser):**

1. **`generateKeypair`** — generates or loads a Solana keypair. Returns the wallet address.
2. **`signup`** with `mode: "link"` — creates a payment intent and returns a `paymentUrl` (e.g. `https://dashboard.helius.dev/pay/<id>`). The user opens that URL in any browser and pays with any wallet. The pending intent is persisted to shared config.
3. **`signup`** with `mode: "resume"` — polls the intent, finalizes account provisioning, and configures the API key automatically once payment settles.

**Autopay mode (agent pays USDC from local keypair):**

1. **`generateKeypair`** — same as above.
2. **User funds the wallet** with ~0.001 SOL (transaction fees) + the plan amount in USDC ($1 Agent, $49 Developer, $499 Business, $999 Professional).
3. **`signup`** with `mode: "autopay"` — sends USDC + memo from the local keypair, polls until the subscription is provisioned, returns API key + RPC endpoints + project ID.

If the wallet already has an account on the same plan, `signup` detects it and returns existing credentials (no double payment). If it's on a different plan, `signup` returns `kind: "upgrade_required"` — use `upgradePlan` instead.

**Parameters for `signup`:**
- `mode`: `"link"` (default), `"autopay"`, or `"resume"`
- `plan`: `"agent"` (default, $1), `"developer"`, `"business"`, or `"professional"`
- `period`: `"monthly"` (default) or `"yearly"` (paid plans only)
- `email`, `firstName`, `lastName`: required for every new signup
- `couponCode`: optional discount code

### Path C: Helius CLI

The `helius-cli` provides the same flow from the terminal:

```bash
# Generate keypair (saved to ~/.helius/keypair.json)
helius keygen

# Print a hosted payment link (default)
helius signup --plan agent --email me@example.com --first-name Ada --last-name Lovelace --json

# Pay in the browser, then finalize:
helius signup --resume --json

# Or autopay USDC directly from the local keypair:
helius signup --plan agent --email me@example.com --first-name Ada --last-name Lovelace --pay --json

# Discard a stuck pending intent and start over:
helius signup --restart --plan agent ...

# List projects and get API keys
helius projects --json
helius apikeys <project-id> --json

# Get RPC endpoints
helius rpc <project-id> --json
```

**CLI exit codes** (for error handling in scripts):
- `0`: success
- `10`: not logged in (run `helius login`)
- `11`: keypair not found (run `helius keygen`)
- `20`: insufficient SOL (autopay only)
- `21`: insufficient USDC (autopay only)

Always use the `--json` flag for machine-readable output when scripting.

### SDK In-Process Signup

For applications that need to create Helius accounts programmatically:

```typescript
import { makeAuthClient } from "helius-sdk/auth/client";
const auth = makeAuthClient();

const keypair = await auth.generateKeypair();

// Hosted-link signup (returns a paymentUrl the user opens in a browser):
const link = await auth.signup({
  secretKey: keypair.secretKey,
  plan: "developer",
  period: "monthly",
  email: "user@example.com",
  firstName: "Jane",
  lastName: "Doe",
});
// link.paymentLink.paymentUrl — open this in a browser

// Or pay USDC directly from the local keypair:
const result = await auth.signupAndPay({
  secretKey: keypair.secretKey,
  plan: "developer",
  period: "monthly",
  email: "user@example.com",
  firstName: "Jane",
  lastName: "Doe",
});
// result.kind: "completed" | "pending" | "expired" | "failed" | "already_subscribed" | "upgrade_required"
// On "completed": result has { jwt, walletAddress, projectId, apiKey, endpoints, txSignature }
```

## Plans and Pricing

| | Agent | Developer | Business | Professional |
|---|---|---|---|---|
| **Price** | $1 USDC | $49/mo | $499/mo | $999/mo |
| **Credits** | 1M | 10M | 100M | 200M |
| **Extra credits** | N/A | $5/M | $5/M | $5/M |
| **RPC RPS** | 10 | 50 | 200 | 500 |
| **sendTransaction** | 1/s | 5/s | 50/s | 100/s |
| **DAS** | 2/s | 10/s | 50/s | 100/s |
| **WS connections** | 5 | 150 | 250 | 1,000 |
| **Enhanced WS** | No | 150 conn | 250 conn | 1,000 conn |
| **LaserStream** | No | Devnet | Devnet + Mainnet | Devnet + Mainnet |
| **Support** | Discord | Chat (24hr) | Priority (12hr) | Slack + Telegram (8hr) |

### Credit Costs

- **0 credits**: Helius Sender (sendSmartTransaction, sendJitoBundle)
- **1 credit**: Standard RPC calls, sendTransaction, Priority Fee API, webhook events
- **2 credits**: per 0.1 MB streamed (LaserStream, Enhanced WebSockets, Standard WebSockets)
- **10 credits**: getProgramAccounts, DAS API, historical data
- **100 credits**: Enhanced Transactions API, Wallet API, webhook management

### Feature Availability by Plan

| Feature | Minimum Plan |
|---|---|
| Standard RPC, DAS, Webhooks, Sender | Agent |
| Standard WebSockets | Agent |
| Enhanced WebSockets | Developer |
| LaserStream (devnet) | Developer |
| LaserStream (mainnet) | Business |
| LaserStream data add-ons | Business+ ($400+/mo) |

Use the `getHeliusPlanInfo` or `compareHeliusPlans` MCP tools for current details.

## Managing Accounts

### Check Account Status

The `getAccountStatus` tool provides three tiers of information:

1. **No auth**: Tells the user how to get started (set key or sign up)
2. **API key only** (no JWT): Confirms auth but can't show credit usage — suggests calling `signup` to detect existing account
3. **Full JWT session**: Shows plan, rate limits, credit usage breakdown (API/RPC/webhooks/overage), billing cycle with days remaining, and burn-rate projections with warnings

Call `getAccountStatus` before bulk operations to verify sufficient credits.

### Upgrade Plans

1. **`previewUpgrade`** — shows pricing breakdown: subtotal, prorated credits, discounts, coupon status, amount due today
2. **`upgradePlan`** — returns a hosted payment link by default, or pays USDC directly with `mode: "autopay"`
   - Requires `email`, `firstName`, `lastName` for first-time upgrades (all three or none)
   - Supports `couponCode` for discounts

### Pay Renewals

`payRenewal` takes a `paymentIntentId` from a renewal notification and either prints a payment link or pays USDC directly.

## Environment Configuration

```bash
# Required — set one of these:
HELIUS_API_KEY=your-api-key          # Environment variable
# OR use setHeliusApiKey MCP tool    # Session + shared config
# OR use signup                      # Auto-configures

# Optional
HELIUS_NETWORK=mainnet-beta          # or devnet (default: mainnet-beta)
HELIUS_PAYMENT_HOST=https://dashboard.helius.dev   # override hosted-link host (e.g. staging)
```

### Shared Config

The MCP persists API keys and JWTs to shared config files so they survive across sessions:
- **API key**: saved to shared config path (accessible by both MCP and CLI)
- **Keypair**: saved to `~/.helius/keypair.json`
- **JWT**: saved to shared config for authenticated session features
- **Pending payment intent**: link-mode signup persists the pending intent so `mode: "resume"` (or `helius signup --resume`) can finalize after the user pays in the browser

### Installing the MCP

```bash
npx helius-mcp@latest  # configure in .clawd/settings.json or your MCP client
```

## Choosing the Right Setup Path

| Scenario | Path |
|---|---|
| User has a Helius API key | `setHeliusApiKey` (Path A) |
| User has `HELIUS_API_KEY` env var set | No action needed — auto-detected |
| AI agent + user wants to pay in browser | `generateKeypair` -> `signup` (link) -> user pays -> `signup` (resume) (Path B) |
| AI agent + agent pays USDC from local keypair | `generateKeypair` -> fund wallet -> `signup` (autopay) (Path B) |
| Script/CI link-mode signup | `helius keygen` -> `helius signup --json` -> user pays -> `helius signup --resume --json` (Path C) |
| Script/CI autopay signup | `helius keygen` -> fund -> `helius signup --pay --json` (Path C) |
| Application needs programmatic signup | SDK `signup()` / `signupAndPay()` |
| User wants full account visibility | `signup` (detects existing accounts) then `getAccountStatus` |
| User needs a higher plan | `previewUpgrade` then `upgradePlan` |

## Common Mistakes

- Calling `signup` without first calling `generateKeypair` — there's no wallet to sign with
- Calling `signup` with `mode: "autopay"` before funding the wallet — the USDC payment will fail
- Assuming `signup` charges twice for existing accounts — it detects and returns existing credentials
- Using `getAccountStatus` without a JWT session — call `signup` first to establish the session (it detects existing accounts for free)
- Forgetting that every new signup requires `email`, `firstName`, and `lastName` — all three are required together
- After a link-mode signup, forgetting to call `mode: "resume"` (or `helius signup --resume`) — the account isn't provisioned until polling completes


---

## helius-priority-fees.md

# Priority Fees — Transaction Landing Optimization

## How Priority Fees Work

Solana transactions pay a base fee (5,000 lamports) plus an optional **priority fee** measured in **microLamports per compute unit**. The total priority fee you pay is:

```
total priority fee = compute unit price (microLamports) x compute unit limit
```

This means two things matter:
1. The **compute unit price** (how much per CU) — set via `ComputeBudgetProgram.setComputeUnitPrice`
2. The **compute unit limit** (how many CUs allocated) — set via `ComputeBudgetProgram.setComputeUnitLimit`

Transactions that request CUs closer to the actual CUs consumed will receive higher priority. A tighter CU limit also means lower total cost for the same CU price. NEVER leave the default 200,000 CU limit — simulate first.

## Getting Fee Estimates

NEVER hardcode priority fees. ALWAYS get real-time estimates from the Helius Priority Fee API.

**Preferred: Use the `getPriorityFeeEstimate` MCP tool.** It wraps the API call for you.

If calling the API directly (e.g., from generated application code), there are two approaches:

### By Account Keys (simplest)

Pass the program/account addresses your transaction interacts with:

```typescript
const response = await fetch(`https://mainnet.helius-rpc.com/?api-key=${API_KEY}`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'getPriorityFeeEstimate',
    params: [{
      accountKeys: ['JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4'],
      options: { priorityLevel: 'High' }
    }]
  })
});

const { result } = await response.json();
// result.priorityFeeEstimate = microLamports per CU
```

### By Transaction (most accurate)

Pass the serialized transaction for program-specific analysis:

```typescript
const response = await fetch(`https://mainnet.helius-rpc.com/?api-key=${API_KEY}`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'getPriorityFeeEstimate',
    params: [{
      transaction: base64EncodedTransaction,
      options: {
        transactionEncoding: 'Base64',
        recommended: true,
      }
    }]
  })
});

const { result } = await response.json();
const priorityFee = result.priorityFeeEstimate;
```

### Getting All Levels At Once

Set `includeAllPriorityFeeLevels: true` to see the full spectrum:

```typescript
params: [{
  accountKeys: ['YOUR_PROGRAM_ID'],
  options: { includeAllPriorityFeeLevels: true }
}]
```

Returns:

```json
{
  "priorityFeeEstimate": 120000,
  "priorityFeeLevels": {
    "min": 0,
    "low": 10000,
    "medium": 120000,
    "high": 500000,
    "veryHigh": 1000000,
    "unsafeMax": 5000000
  }
}
```

### Options Reference

| Option | Type | Description |
|---|---|---|
| `priorityLevel` | string | `Min`, `Low`, `Medium`, `High`, `VeryHigh`, `UnsafeMax` |
| `includeAllPriorityFeeLevels` | boolean | Return all 6 levels |
| `transactionEncoding` | string | `Base58` or `Base64` (when passing transaction) |
| `lookbackSlots` | number | Slots to analyze (1-150, default varies) |
| `includeVote` | boolean | Include vote transactions in calculation |
| `recommended` | boolean | Return recommended optimal fee |
| `evaluateEmptySlotAsZero` | boolean | Count empty slots as zero-fee in calculation |

## Choosing the Right Priority Level

| Use Case | Level | Why |
|---|---|---|
| Standard transfers | `recommended: true` | Good default, next slot usually |
| DEX swaps, NFT purchases | `High` | Time-sensitive, next slot very likely |
| Arbitrage, liquidations, competitive mints | `VeryHigh` | Critical timing, next slot almost guaranteed |
| Extreme urgency, willing to overpay | `UnsafeMax` | May pay 10-100x normal fees, use sparingly |

**Default recommendation: `High` for swaps, trading, and most operations**

For production trading systems, add a buffer on top of the estimate:

```typescript
const priorityFee = Math.ceil(result.priorityFeeEstimate * 1.2); // 20% buffer
```

## Adding Fees to Transactions

### @solana/web3.js

```typescript
import { ComputeBudgetProgram } from '@solana/web3.js';

// 1. Get the estimate (via MCP tool or API call)
const feeEstimate = result.priorityFeeEstimate; // microLamports per CU

// 2. Create compute budget instructions
const computeUnitLimitIx = ComputeBudgetProgram.setComputeUnitLimit({
  units: computeUnits, // from simulation, NOT default 200k
});

const computeUnitPriceIx = ComputeBudgetProgram.setComputeUnitPrice({
  microLamports: feeEstimate,
});

// 3. PREPEND to transaction — these MUST be the first two instructions
const allInstructions = [
  computeUnitLimitIx,   // first
  computeUnitPriceIx,   // second
  ...yourInstructions,   // your app logic
];
```

### @solana/kit

```typescript
import {
  getSetComputeUnitLimitInstruction,
  getSetComputeUnitPriceInstruction,
} from "@solana-program/compute-budget";

const tx = pipe(
  createTransactionMessage({ version: 0 }),
  (m) => setTransactionMessageFeePayerSigner(signer, m),
  (m) => setTransactionMessageLifetimeUsingBlockhash(blockhash, m),
  // Compute budget instructions first
  (m) => appendTransactionMessageInstruction(
    getSetComputeUnitLimitInstruction({ units: computeUnits }), m
  ),
  (m) => appendTransactionMessageInstruction(
    getSetComputeUnitPriceInstruction({ microLamports: feeEstimate }), m
  ),
  // Then your instructions
  (m) => appendTransactionMessageInstruction(yourInstruction, m),
);
```

### Helius SDK

```typescript
const feeEstimate = await helius.getPriorityFeeEstimate({
  accountKeys: ['JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4'],
  options: { priorityLevel: 'High', includeAllPriorityFeeLevels: true },
});
```

```rust
// Rust
let fee_estimate = helius.rpc().get_priority_fee_estimate(GetPriorityFeeEstimateRequest {
    account_keys: Some(vec!["JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4".to_string()]),
    options: Some(GetPriorityFeeEstimateOptions {
        priority_level: Some(PriorityLevel::High),
        ..Default::default()
    }),
    ..Default::default()
}).await?;
```

## Compute Unit Estimation

Do NOT use the default 200,000 CU limit. Simulate first to get actual usage, then add a margin:

```typescript
// 1. Build a test transaction with max CU for simulation
const testInstructions = [
  ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }),
  ...yourInstructions,
];

const testTx = new VersionedTransaction(
  new TransactionMessage({
    instructions: testInstructions,
    payerKey: keypair.publicKey,
    recentBlockhash: blockhash,
  }).compileToV0Message()
);
testTx.sign([keypair]);

// 2. Simulate
const simulation = await connection.simulateTransaction(testTx, {
  replaceRecentBlockhash: true,
  sigVerify: false,
});

// 3. Set limit to actual usage + 10% margin (minimum 1000 CUs)
const units = simulation.value.unitsConsumed;
const computeUnits = units < 1000 ? 1000 : Math.ceil(units * 1.1);
```

**Why this matters**: A transaction requesting 200,000 CUs at 100,000 microLamports/CU costs 20,000,000 microLamports. The same transaction at 50,000 CUs costs only 5,000,000 microLamports — 4x cheaper for better priority.

## Refresh Frequency

- Normal applications: refresh every 10-20 seconds
- Trading/swaps: refresh per transaction
- HFT/MEV: refresh every slot

## Common Mistakes

- Hardcoding priority fees instead of fetching real-time estimates
- Leaving the default 200,000 CU limit (wastes money, lowers effective priority)
- Using the same fee for all transactions instead of program-specific estimates
- Not passing `accountKeys` for the programs being interacted with (generic estimates are less accurate)
- Using `UnsafeMax` as a default (can cost 10-100x normal fees)
- Forgetting to add a buffer for production trading (network conditions can shift between estimate and submission)


---

## helius-sender.md

# Helius Sender — Transaction Submission

## When To Use

ALWAYS use Helius Sender for transaction submission instead of the standard `sendTransaction` to a regular RPC endpoint. Sender dual-routes transactions to both Solana validators and Jito simultaneously, maximizing block inclusion probability with ultra-low latency.

- Available on ALL plans, including free tier
- Consumes ZERO API credits
- Default 50 TPS (Professional plan users can request higher limits)
- For simpler use cases where you do not need manual control, the Helius TypeScript SDK provides `sendSmartTransaction` which handles priority fees, compute units, and retries automatically — but it does NOT use Sender endpoints. For maximum performance, use Sender via the SDK's `sendTransactionWithSender` method, or directly as described below.

## Mandatory Requirements

Every Sender transaction MUST include all three of these or it will be rejected:

### 1. Skip Preflight

```typescript
{ skipPreflight: true, maxRetries: 0 }
```

`skipPreflight` MUST be `true`. Set `maxRetries: 0` and implement your own retry logic.

### 2. Jito Tip

A SOL transfer instruction to one of the designated tip accounts. Pick one randomly per transaction to distribute load.

**Minimum tip amounts:**
- Default dual routing: **0.0002 SOL** (200,000 lamports)
- SWQOS-only mode: **0.000005 SOL** (5,000 lamports)

**Mainnet tip accounts:**
```
4ACfpUFoaSD9bfPdeu6DBt89gB6ENTeHBXCAi87NhDEE
D2L6yPZ2FmmmTKPgzaMKdhu6EWZcTpLy1Vhx8uvZe7NZ
9bnz4RShgq1hAnLnZbP8kbgBg1kEmcJBYQq3gQbmnSta
5VY91ws6B2hMmBFRsXkoAAdsPHBJwRfBht4DXox3xkwn
2nyhqdwKcJZR2vcqCyrYsaPVdAnFoJjiksCXJ7hfEYgD
2q5pghRs6arqVjRvT5gfgWfWcHWmw1ZuCzphgd5KfWGJ
wyvPkWjVZz1M8fHQnMMCDTQDbkManefNNhweYk5WkcF
3KCKozbAaF75qEU33jtzozcJ29yJuaLJTy2jFdzUY8bT
4vieeGHPYPG2MmyPRcYjdiDmmhN3ww7hsFNap8pVN3Ey
4TQLFNWK8AovT1gFvda5jfw2oJeRMKEmw7aH6MGBJ3or
```

For dynamic tip sizing, fetch the 75th percentile from the Jito API and use `Math.max(tip75th, 0.0002)`:

```typescript
async function getDynamicTipAmount(): Promise<number> {
  try {
    const response = await fetch('https://bundles.jito.wtf/api/v1/bundles/tip_floor');
    const data = await response.json();
    if (data?.[0]?.landed_tips_75th_percentile) {
      return Math.max(data[0].landed_tips_75th_percentile, 0.0002);
    }
    return 0.0002;
  } catch {
    return 0.0002;
  }
}
```

### 3. Priority Fee

A `ComputeBudgetProgram.setComputeUnitPrice` instruction. Use the `getPriorityFeeEstimate` MCP tool to get the right fee — never hardcode.

Also include `ComputeBudgetProgram.setComputeUnitLimit` set to the actual compute units needed (simulate first, then add a 10% margin). Do NOT use the default 200,000 CU — a tighter limit means lower total cost and better priority.

## Endpoints

### Frontend (HTTPS — use for browser apps)

```
https://sender.helius-rpc.com/fast
```

Auto-routes to the nearest location. Avoids CORS preflight failures that occur with regional HTTP endpoints.

### Backend (Regional HTTP — use for servers)

Choose the endpoint closest to your infrastructure:

```
http://slc-sender.helius-rpc.com/fast      # Salt Lake City
http://ewr-sender.helius-rpc.com/fast      # Newark
http://lon-sender.helius-rpc.com/fast      # London
http://fra-sender.helius-rpc.com/fast      # Frankfurt
http://ams-sender.helius-rpc.com/fast      # Amsterdam
http://sg-sender.helius-rpc.com/fast       # Singapore
http://tyo-sender.helius-rpc.com/fast      # Tokyo
```

### SWQOS-Only Mode

Append `?swqos_only=true` to any endpoint URL for cost-optimized routing. Routes exclusively through SWQOS infrastructure with a lower 0.000005 SOL minimum tip. Use this when cost matters more than maximum inclusion speed.

```
https://sender.helius-rpc.com/fast?swqos_only=true
```

### Custom TPS (Professional plan)

If approved for higher TPS, append your Sender-specific API key:

```
https://sender.helius-rpc.com/fast?api-key=YOUR_SENDER_API_KEY
```

### Request Format

```json
{
  "jsonrpc": "2.0",
  "id": "1",
  "method": "sendTransaction",
  "params": [
    "BASE64_ENCODED_TRANSACTION",
    {
      "encoding": "base64",
      "skipPreflight": true,
      "maxRetries": 0
    }
  ]
}
```

## Implementation Pattern — Basic Send (@solana/web3.js)

When building a basic Sender transaction with `@solana/web3.js`, follow this pattern:

```typescript
import {
  Connection,
  TransactionMessage,
  VersionedTransaction,
  SystemProgram,
  PublicKey,
  Keypair,
  LAMPORTS_PER_SOL,
  ComputeBudgetProgram,
  TransactionInstruction
} from '@solana/web3.js';

const TIP_ACCOUNTS = [
  "4ACfpUFoaSD9bfPdeu6DBt89gB6ENTeHBXCAi87NhDEE",
  "D2L6yPZ2FmmmTKPgzaMKdhu6EWZcTpLy1Vhx8uvZe7NZ",
  "9bnz4RShgq1hAnLnZbP8kbgBg1kEmcJBYQq3gQbmnSta",
  "5VY91ws6B2hMmBFRsXkoAAdsPHBJwRfBht4DXox3xkwn",
  "2nyhqdwKcJZR2vcqCyrYsaPVdAnFoJjiksCXJ7hfEYgD",
  "2q5pghRs6arqVjRvT5gfgWfWcHWmw1ZuCzphgd5KfWGJ",
  "wyvPkWjVZz1M8fHQnMMCDTQDbkManefNNhweYk5WkcF",
  "3KCKozbAaF75qEU33jtzozcJ29yJuaLJTy2jFdzUY8bT",
  "4vieeGHPYPG2MmyPRcYjdiDmmhN3ww7hsFNap8pVN3Ey",
  "4TQLFNWK8AovT1gFvda5jfw2oJeRMKEmw7aH6MGBJ3or"
];

async function sendViaSender(
  keypair: Keypair,
  instructions: TransactionInstruction[],
  connection: Connection
): Promise<string> {
  // 1. Get blockhash
  const { value: { blockhash, lastValidBlockHeight } } =
    await connection.getLatestBlockhashAndContext('confirmed');

  // 2. Get dynamic tip
  const tipAmountSOL = await getDynamicTipAmount();
  const tipAccount = TIP_ACCOUNTS[Math.floor(Math.random() * TIP_ACCOUNTS.length)];

  // 3. Build all instructions: compute budget + user instructions + tip
  const allInstructions = [
    ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }), // placeholder, refine via simulation
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 200_000 }), // use getPriorityFeeEstimate for production
    ...instructions,
    SystemProgram.transfer({
      fromPubkey: keypair.publicKey,
      toPubkey: new PublicKey(tipAccount),
      lamports: Math.floor(tipAmountSOL * LAMPORTS_PER_SOL),
    }),
  ];

  // 4. Build and sign
  const transaction = new VersionedTransaction(
    new TransactionMessage({
      instructions: allInstructions,
      payerKey: keypair.publicKey,
      recentBlockhash: blockhash,
    }).compileToV0Message()
  );
  transaction.sign([keypair]);

  // 5. Submit to Sender
  const response = await fetch('https://sender.helius-rpc.com/fast', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: Date.now().toString(),
      method: 'sendTransaction',
      params: [
        Buffer.from(transaction.serialize()).toString('base64'),
        { encoding: 'base64', skipPreflight: true, maxRetries: 0 }
      ]
    })
  });

  const json = await response.json();
  if (json.error) throw new Error(json.error.message);
  return json.result;
}
```

## Implementation Pattern — Basic Send (@solana/kit)

When building with the newer, and recommended, `@solana/kit`:

```typescript
import { pipe } from "@solana/kit";
import {
  createSolanaRpc,
  createTransactionMessage,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  appendTransactionMessageInstruction,
  signTransactionMessageWithSigners,
  lamports,
  getBase64EncodedWireTransaction,
  address,
} from "@solana/kit";
import { getTransferSolInstruction } from "@solana-program/system";
import {
  getSetComputeUnitLimitInstruction,
  getSetComputeUnitPriceInstruction,
} from "@solana-program/compute-budget";

async function sendViaSender(
  signer: KeyPairSigner,
  instructions: IInstruction[],
  rpc: Rpc
): Promise<string> {
  const { value: blockhash } = await rpc.getLatestBlockhash().send();

  const tipAmountSOL = await getDynamicTipAmount();
  const tipAccount = TIP_ACCOUNTS[Math.floor(Math.random() * TIP_ACCOUNTS.length)];

  // Build transaction: compute budget, user instructions, tip
  let tx = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayerSigner(signer, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(blockhash, m),
    (m) => appendTransactionMessageInstruction(getSetComputeUnitLimitInstruction({ units: 200_000 }), m),
    (m) => appendTransactionMessageInstruction(getSetComputeUnitPriceInstruction({ microLamports: 200_000 }), m),
  );

  // Append user instructions
  for (const ix of instructions) {
    tx = appendTransactionMessageInstruction(ix, tx);
  }

  // Append tip
  tx = appendTransactionMessageInstruction(
    getTransferSolInstruction({
      source: signer,
      destination: address(tipAccount),
      amount: lamports(BigInt(Math.floor(tipAmountSOL * 1_000_000_000))),
    }),
    tx
  );

  const signedTx = await signTransactionMessageWithSigners(tx);
  const base64Tx = getBase64EncodedWireTransaction(signedTx);

  const res = await fetch("https://sender.helius-rpc.com/fast", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: Date.now().toString(),
      method: "sendTransaction",
      params: [base64Tx, { encoding: "base64", skipPreflight: true, maxRetries: 0 }],
    }),
  });

  const { result, error } = await res.json();
  if (error) throw new Error(error.message);
  return result;
}
```

## Production Pattern — Dynamic Optimization

For production use, add these optimizations on top of the basic pattern:

### 1. Simulate to get actual compute units

```typescript
// Build a test transaction with max CU limit for simulation
const testTx = buildTransaction([
  ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }),
  ...userInstructions,
  tipInstruction,
]);
testTx.sign([keypair]);

const simulation = await connection.simulateTransaction(testTx, {
  replaceRecentBlockhash: true,
  sigVerify: false,
});

// Set CU limit to actual usage + 10% margin (minimum 1000)
const units = simulation.value.unitsConsumed;
const computeUnits = units < 1000 ? 1000 : Math.ceil(units * 1.1);
```

### 2. Get dynamic priority fee

Use the `getPriorityFeeEstimate` MCP tool, or call the API directly:

```typescript
const response = await fetch(heliusRpcUrl, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    jsonrpc: "2.0",
    id: "1",
    method: "getPriorityFeeEstimate",
    params: [{
      transaction: bs58.encode(tempTx.serialize()),
      options: { recommended: true },
    }],
  }),
});

const data = await response.json();
// Add 20% buffer on top of recommended fee
const priorityFee = Math.ceil(data.result.priorityFeeEstimate * 1.2);
```

### 3. Retry with blockhash expiry check

```typescript
async function sendWithRetry(
  transaction: VersionedTransaction,
  connection: Connection,
  lastValidBlockHeight: number,
  maxRetries = 3
): Promise<string> {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const currentHeight = await connection.getBlockHeight('confirmed');
    if (currentHeight > lastValidBlockHeight) {
      throw new Error('Blockhash expired — rebuild transaction with fresh blockhash');
    }

    try {
      const response = await fetch('https://sender.helius-rpc.com/fast', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: Date.now().toString(),
          method: 'sendTransaction',
          params: [
            Buffer.from(transaction.serialize()).toString('base64'),
            { encoding: 'base64', skipPreflight: true, maxRetries: 0 }
          ]
        })
      });

      const result = await response.json();
      if (result.error) throw new Error(result.error.message);

      // Poll for confirmation
      return await confirmTransaction(result.result, connection);
    } catch (error) {
      if (attempt === maxRetries - 1) throw error;
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
  }
  throw new Error('All retry attempts failed');
}

async function confirmTransaction(signature: string, connection: Connection): Promise<string> {
  for (let i = 0; i < 30; i++) {
    const status = await connection.getSignatureStatuses([signature]);
    if (status?.value[0]?.confirmationStatus === "confirmed") {
      return signature;
    }
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  throw new Error(`Confirmation timeout: ${signature}`);
}
```

## Connection Warming

If your application has gaps longer than 1 minute between transactions, periodically ping the Sender endpoint to keep connections warm:

```typescript
// Ping every 30 seconds during idle periods
const endpoint = 'https://sender.helius-rpc.com'; // or regional HTTP endpoint

setInterval(async () => {
  try {
    await fetch(`${endpoint}/ping`);
  } catch {
    // Ignore ping failures
  }
}, 30_000);
```

Ping endpoints:
- HTTPS: `https://sender.helius-rpc.com/ping`
- Regional: `http://{region}-sender.helius-rpc.com/ping` (slc, ewr, lon, fra, ams, sg, tyo)

## Choosing a Routing Mode

| | Default Dual Routing | SWQOS-Only |
|---|---|---|
| Routes to | Validators AND Jito | SWQOS infrastructure only |
| Minimum tip | 0.0002 SOL | 0.000005 SOL |
| Best for | Maximum inclusion probability | Cost-sensitive operations |
| Endpoint | `/fast` | `/fast?swqos_only=true` |

Use default dual routing for anything time-sensitive (trading, swaps, minting). Use SWQOS-only when you want to save on tips and only want to leverage staked connections.

## Instruction Ordering

When building the transaction, instructions MUST be ordered:

1. `ComputeBudgetProgram.setComputeUnitLimit` (first)
2. `ComputeBudgetProgram.setComputeUnitPrice` (second)
3. Your application instructions (middle)
4. Jito tip transfer (last)

## Common Mistakes

- Forgetting `skipPreflight: true` — transaction will be rejected
- Forgetting the Jito tip — transaction will not be forwarded to Jito
- Hardcoding priority fees instead of using `getPriorityFeeEstimate`
- Using the default 200,000 CU limit instead of simulating actual usage
- Not implementing retry logic (relying on `maxRetries` param instead)
- Using regional HTTP endpoints in browser apps (causes CORS failures — use HTTPS)
- Including compute budget instructions in user instructions AND in the wrapper (duplicates)


---

## helius-wallet-api.md

# Wallet API — Wallet Intelligence & Investigation

## What the Wallet API Covers

The Wallet API provides structured REST endpoints for comprehensive wallet intelligence: identity resolution, funding source tracing, balances with USD pricing, transaction history, and transfer tracking. It is currently in Beta.

- **Identity database**: Powered by Orb, tags 5,100+ accounts and 1,900+ programs across 40+ categories (exchanges, DeFi protocols, market makers, KOLs, malicious actors)
- **Unique funding source tracking**: Only API that reveals who originally funded any wallet — critical for compliance, sybil detection, and attribution
- **Batch identity lookup**: Process up to 100 addresses per request
- **USD pricing**: Token balances include USD values for top 10K tokens (hourly updates via DAS)
- **100 credits per request** (all endpoints)
- Base URL: `https://api.helius.xyz`
- Auth: `?api-key=YOUR_KEY` or header `X-Api-Key: YOUR_KEY`

## MCP Tools

All Wallet API endpoints have direct MCP tools. ALWAYS use these instead of generating raw API calls:

| MCP Tool | Endpoint | What It Does |
|---|---|---|
| `getWalletIdentity` | `GET /v1/wallet/{wallet}/identity` | Identify known wallets (exchanges, protocols, institutions). Accepts an address or an SNS/ANS domain (mainnet only). |
| `batchWalletIdentity` | `POST /v1/wallet/batch-identity` | Bulk lookup up to 100 entries in one request. Entries may be addresses or SNS/ANS domains (mainnet only). |
| `getWalletBalances` | `GET /v1/wallet/{wallet}/balances` | Token + NFT balances with USD values, sorted by value |
| `getWalletHistory` | `GET /v1/wallet/{wallet}/history` | Transaction history with balance changes per tx |
| `getWalletTransfers` | `GET /v1/wallet/{wallet}/transfers` | Token transfers with direction (in/out) and counterparty |
| `getWalletFundedBy` | `GET /v1/wallet/{wallet}/funded-by` | Original funding source (first incoming SOL transfer) |

When the user asks to investigate a wallet, identify an address, check balances, or trace funds — use these MCP tools directly. Only generate raw API code when the user is building an application that needs to call these endpoints programmatically.

## Choosing the Right Tool

| You want to... | Use this |
|---|---|
| Check if a wallet is a known entity | `getWalletIdentity` |
| Label many addresses at once | `batchWalletIdentity` (up to 100) |
| See token holdings with USD values | `getWalletBalances` |
| View recent transaction activity | `getWalletHistory` |
| Track incoming/outgoing transfers | `getWalletTransfers` |
| Find who funded a wallet | `getWalletFundedBy` |
| Get fungible token list (cheaper) | `getTokenBalances` (DAS, 10 credits) — use when you don't need USD pricing or NFTs |
| Get full portfolio with NFTs | `getWalletBalances` with `showNfts: true` + DAS `getAssetsByOwner` for full NFT details |

## Identity Resolution

The identity endpoint identifies known wallets powered by Orb's tagging. Returns 404 for unknown wallets — this is normal, not an error.

**Account tag types**: Airdrop, Authority, Bridge, Casino & Gambling, DAO, DeFi, DePIN, Centralized Exchange, Exploiter/Hackers/Scams, Fees, Fundraise, Game, Governance, Hacker, Jito, Key Opinion Leader, Market Maker, Memecoin, Multisig, NFT, Oracle, Payments, Proprietary AMM, Restaking, Rugger, Scammer, Spam, Stake Pool, System, Tools, Trading App/Bot, Trading Firm, Transaction Sending, Treasury, Validator, Vault

**Program categories**: Aggregator, Airdrop, Bridge, Compression, DeFi, DePIN, Game/Casino, Governance, Infrastructure, Launchpad, Borrow Lend, Native, NFT, Oracle, Perpetuals, Prediction Market, Privacy, Proprietary AMM, RWA, Spam, Staking, Swap, Tools

**Covers**: Binance, Coinbase, Kraken, OKX, Bybit, Jupiter, Raydium, Marinade, Jito, Kamino, Jump Trading, Wintermute, notable KOLs, bridges, validators, treasuries, stake pools, and known exploiters/scammers.

### Domain Resolution (SNS + ANS)

Both identity endpoints accept domain names in addition to base58 addresses:

- **SNS** — `.sol` domains (e.g., `toly.sol`, `my_wallet.sol`, `sub.toly.sol`)
- **ANS** — custom TLDs (e.g., `helius.bonk`, `miester.poor`, `degen.superteam`)

Semantics:

- **Single endpoint (`getWalletIdentity`)**: unresolvable domain → HTTP 404; invalid input (neither address nor domain) → 400; non-mainnet request with a domain → 400 ("Domain resolution is only available on mainnet"). Valid addresses with no identity in the tagging DB still return 200 with `type: "unknown"` — unchanged behavior.
- **Batch endpoint (`batchWalletIdentity`)**: non-fail-fast. Each entry returns its own row. Resolved domain rows gain `inputDomain: "<domain>"`. Unresolvable domain rows come back as `{ address: null, type: "unknown", inputDomain: "<domain>", unresolved: true }`. On non-mainnet all domain entries are returned as `unresolved: true`.

Response type (identity endpoints):

```ts
interface IdentityResponse {
  address: string | null;   // null only for unresolved domains in batch
  type: AccountType;
  name?: string;
  category?: string;
  tags?: string[];
  inputDomain?: string;     // present when input was a domain
  unresolved?: boolean;     // true only in batch when a domain could not be resolved
  // ...other tagging fields
}
```

### When to use batch vs single

- Investigating one wallet: `getWalletIdentity`
- Enriching a transaction list with counterparty names: `batchWalletIdentity` (collect all unique addresses, batch in chunks of 100)
- Building a UI that shows human-readable names: `batchWalletIdentity`
- Accepting user-typed inputs (domains or addresses): `getWalletIdentity` (single) or `batchWalletIdentity` (mixed list)

## Funding Source Tracking

**Unique to Helius.** The `getWalletFundedBy` tool reveals who originally funded any wallet by analyzing its first incoming SOL transfer. Returns 404 if no funding found.

Response includes:
- `funder`: address that funded the wallet
- `funderName`: human-readable name if known (e.g., "Coinbase 2")
- `funderType`: entity type (e.g., "exchange")
- `amount`: initial funding amount in SOL
- `timestamp`, `date`, `signature`, `explorerUrl`

**Use for**:
- **Sybil detection**: Group wallets by same funder address — same funder = likely related
- **Airdrop abuse**: Flag farming accounts created recently from unknown sources
- **Compliance**: Determine if wallets originated from exchanges (retail) vs unknown sources
- **Attribution**: Track user acquisition (e.g., Binance -> your dApp)
- **Risk scoring**: Assign trust levels based on funder reputation

## Wallet Balances

`getWalletBalances` returns all token holdings sorted by USD value (descending).

**Parameters**:
- `page` (default: 1) — pagination starts at 1
- `limit` (1-100, default: 100)
- `showNfts` (default: false) — include NFTs (max 100, first page only)
- `showZeroBalance` (default: false)
- `showNative` (default: true) — include native SOL

**Pricing notes**: USD values sourced from DAS, updated hourly, covers top 10K tokens. `pricePerToken` and `usdValue` may be `null` for unlisted tokens. These are estimates, not real-time market rates.

## Transaction History

`getWalletHistory` returns parsed, human-readable transactions with balance changes.

**Parameters**:
- `limit` (1-100, default: 100)
- `before` — pagination cursor (pass `nextCursor` from previous response)
- `after` — forward pagination cursor
- `type` — filter: `SWAP`, `TRANSFER`, `BID`, `NFT_SALE`, `NFT_BID`, `NFT_LISTING`, `NFT_MINT`, `NFT_CANCEL_LISTING`, `TOKEN_MINT`, `BURN`, `COMPRESSED_NFT_MINT`, `COMPRESSED_NFT_TRANSFER`, `COMPRESSED_NFT_BURN`
- `tokenAccounts` — controls token account inclusion:
  - `balanceChanged` (default, recommended): includes transactions that changed token balances, filters spam
  - `none`: only direct wallet interactions
  - `all`: everything including spam

## Token Transfers

`getWalletTransfers` returns transfer-only activity with direction and counterparty.

**Parameters**:
- `limit` (1-50, default: 50)
- `cursor` — pagination cursor

Each transfer includes: `direction` (in/out), `counterparty`, `mint`, `symbol`, `amount`, `timestamp`, `signature`.

## Common Patterns

### Portfolio View

Use MCP tools directly for investigation:
1. `getWalletBalances` — current holdings with USD values
2. `getWalletHistory` — recent activity
3. `getWalletIdentity` — check if the wallet is a known entity

For building a portfolio app, call `GET /v1/wallet/{address}/balances?api-key=KEY&showNative=true`. Paginate via `page` param — loop until `pagination.hasMore` is false.

### Wallet Investigation

Three-step pattern: call identity (handle 404 → unknown), funded-by (handle 404 → no funding data), then history with a limit.

```typescript
const identity = await fetch(`${BASE}/v1/wallet/${address}/identity?api-key=${KEY}`).then(r => r.ok ? r.json() : null);
const funding = await fetch(`${BASE}/v1/wallet/${address}/funded-by?api-key=${KEY}`).then(r => r.ok ? r.json() : null);
const { data: history } = await fetch(`${BASE}/v1/wallet/${address}/history?api-key=${KEY}&limit=20`).then(r => r.json());
```

### Sybil Detection

Call `getWalletFundedBy` for each address, group results by `funder` field. Clusters where 2+ wallets share the same funder are suspicious. Use `Promise.all` for parallel fetches.

### Batch Enrich Transactions with Names

Collect unique counterparty addresses, then call `batchWalletIdentity` in chunks of 100 (`POST /v1/wallet/batch-identity`). Build a `Map<address, name>` from the results.

### Risk Assessment

Combine `getWalletIdentity` + `getWalletFundedBy` in parallel. Score based on:
- Known entity → lower risk. Malicious tags (`Exploiter`, `Hacker`, `Scammer`, `Rugger`) → highest risk.
- Exchange-funded → lower risk. Unknown funder + wallet age < 7 days → higher risk.

## SDK Usage

```typescript
// TypeScript — all methods take { wallet } object param
const identity = await helius.wallet.getIdentity({ wallet: 'ADDRESS' });
const balances = await helius.wallet.getBalances({ wallet: 'ADDRESS' });
const history = await helius.wallet.getHistory({ wallet: 'ADDRESS' });
const transfers = await helius.wallet.getTransfers({ wallet: 'ADDRESS' });
const funding = await helius.wallet.getFundedBy({ wallet: 'ADDRESS' });
```

```rust
// Rust
let identity = helius.wallet().get_identity("ADDRESS").await?;
let balances = helius.wallet().get_balances("ADDRESS").await?;
```

## Error Handling

**Important**: 404 on identity and funded-by endpoints is expected behavior for unknown wallets, not an error. It means the wallet isn't in the Orb database. Always handle it gracefully (return `null`, not throw).

## Best Practices

- Use MCP tools (`getWalletIdentity`, `getWalletBalances`, etc.) for direct investigation — they call the API and return formatted results
- Use `batchWalletIdentity` for multiple addresses — 100x faster than individual lookups
- Cache identity and funding data — it rarely changes
- Handle 404s gracefully on identity/funded-by endpoints — most wallets are not known entities
- Use `tokenAccounts: "balanceChanged"` (default) for history to filter spam
- Combine identity + funding for complete wallet profiles
- Use `getWalletBalances` when you need USD pricing; use DAS `getTokenBalances` when you don't (cheaper)
- For portfolio UIs, display human-readable names from identity lookups instead of raw addresses

## Common Mistakes

- Treating 404 on identity/funded-by as an error — it just means the wallet isn't in the database
- Using individual `getWalletIdentity` calls in a loop instead of `batchWalletIdentity`
- Expecting real-time USD pricing — prices update hourly and cover only top 10K tokens
- Using `tokenAccounts: "all"` for history — includes spam; use `"balanceChanged"` instead
- Confusing `getWalletBalances` (Wallet API, 100 credits, USD pricing) with `getTokenBalances` (DAS, 10 credits, no pricing)
- Not paginating balances — wallets with 100+ tokens need multiple pages


---

## helius-websockets.md

# WebSockets — Real-Time Solana Streaming

## Two WebSocket Tiers

Helius provides two WebSocket tiers on the same endpoint:

| | Standard WebSockets | Enhanced WebSockets |
|---|---|---|
| Methods | Solana native: `accountSubscribe`, `logsSubscribe`, `programSubscribe`, `signatureSubscribe`, `slotSubscribe`, `rootSubscribe` | `transactionSubscribe`, `accountSubscribe` with advanced filtering and auto-parsing |
| Plan required | Free+ (all plans) | Business+ |
| Filtering | Basic (single account or program) | Up to 50,000 addresses per filter, include/exclude/required logic |
| Parsing | Raw Solana data | Automatic transaction parsing (type, description, tokenTransfers) |
| Latency | Good | Faster (powered by LaserStream infrastructure) |
| Credits | 3 credits per 0.1 MB streamed | 3 credits per 0.1 MB streamed |
| Max connections | Plan-dependent | 250 concurrent (Business/Professional) |

Both tiers use the same endpoints:
- **Mainnet**: `wss://mainnet.helius-rpc.com/?api-key=YOUR_API_KEY`
- **Devnet**: `wss://devnet.helius-rpc.com/?api-key=YOUR_API_KEY`

**10-minute inactivity timeout** — send pings every 30 seconds to keep connections alive.

## MCP Tools

Enhanced WebSocket operations have MCP tools. Like LaserStream, these are config generators — WebSocket connections can't run over MCP stdio. The workflow is: generate config via MCP tool, then embed the code in the user's application.

| MCP Tool | What It Does |
|---|---|
| `transactionSubscribe` | Generates Enhanced WS subscription config + code for transaction streaming with filters |
| `accountSubscribe` | Generates Enhanced WS subscription config + code for account monitoring |
| `getEnhancedWebSocketInfo` | Returns endpoint, capabilities, plan requirements |

ALWAYS use these MCP tools first when the user needs Enhanced WebSocket subscriptions — they validate parameters, warn about config issues, and produce correct code.

Standard WebSocket subscriptions do not have MCP tools — generate the code directly using the patterns in this file.

## Choosing the Right Approach

| You want to... | Use |
|---|---|
| Monitor a specific account for changes | Standard `accountSubscribe` (Free+) or Enhanced `accountSubscribe` (Business+) |
| Stream transactions for specific accounts/programs | Enhanced `transactionSubscribe` (Business+) |
| Monitor program account changes | Standard `programSubscribe` (Free+) |
| Watch for transaction confirmation | Standard `signatureSubscribe` (Free+) |
| Track slot/root progression | Standard `slotSubscribe` / `rootSubscribe` (Free+) |
| Monitor transaction logs | Standard `logsSubscribe` (Free+) |
| Stream with advanced filtering (50K addresses) | Enhanced `transactionSubscribe` (Business+) |
| Need historical replay or 10M+ addresses | LaserStream (see `references/helius-laserstream.md`) |
| Need push notifications without persistent connection | Webhooks (see Helius docs at `docs.helius.dev`) |

## Connection Pattern

All WebSocket code follows the same structure. ALWAYS include ping keepalive:

```typescript
const WebSocket = require('ws');

const ws = new WebSocket('wss://mainnet.helius-rpc.com/?api-key=YOUR_API_KEY');

ws.on('open', () => {
  console.log('Connected');

  // Send subscription request
  ws.send(JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'SUBSCRIPTION_METHOD',
    params: [/* ... */]
  }));

  // Keep connection alive — 10-minute inactivity timeout
  setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) ws.ping();
  }, 30000);
});

ws.on('message', (data) => {
  const msg = JSON.parse(data.toString());

  // First message is subscription confirmation
  if (msg.result !== undefined) {
    console.log('Subscribed, ID:', msg.result);
    return;
  }

  // Subsequent messages are notifications
  if (msg.method) {
    console.log('Notification:', msg.params);
  }
});

ws.on('close', () => console.log('Disconnected'));
ws.on('error', (err) => console.error('Error:', err));
```

## Enhanced WebSockets

### transactionSubscribe

Stream real-time transactions with advanced filtering. Use the `transactionSubscribe` MCP tool to generate the config, or build manually:

**Filter parameters:**
- `accountInclude`: transactions involving ANY of these addresses (OR logic, up to 50K)
- `accountExclude`: exclude transactions with these addresses (up to 50K)
- `accountRequired`: transactions must involve ALL of these addresses (AND logic, up to 50K)
- `vote`: include vote transactions (default: false)
- `failed`: include failed transactions (default: false)
- `signature`: filter to a specific transaction signature

**Options:**
- `commitment`: `processed`, `confirmed`, `finalized`
- `encoding`: `base58`, `base64`, `jsonParsed`
- `transactionDetails`: `full`, `signatures`, `accounts`, `none`
- `showRewards`: include reward data
- `maxSupportedTransactionVersion`: set to `0` to receive both legacy and versioned transactions (required when `transactionDetails` is `accounts` or `full`)

```typescript
ws.on('open', () => {
  ws.send(JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'transactionSubscribe',
    params: [
      {
        accountInclude: ['JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4'],
        vote: false,
        failed: false
      },
      {
        commitment: 'confirmed',
        encoding: 'jsonParsed',
        transactionDetails: 'full',
        maxSupportedTransactionVersion: 0
      }
    ]
  }));

  setInterval(() => ws.ping(), 30000);
});

ws.on('message', (data) => {
  const msg = JSON.parse(data.toString());
  if (msg.method === 'transactionNotification') {
    const tx = msg.params.result;
    console.log('Signature:', tx.signature);
    console.log('Slot:', tx.slot);
    // tx.transaction contains full parsed transaction data
  }
});
```

**Notification payload:**

```json
{
  "method": "transactionNotification",
  "params": {
    "subscription": 4743323479349712,
    "result": {
      "transaction": {
        "transaction": ["base64data...", "base64"],
        "meta": {
          "err": null,
          "fee": 5000,
          "preBalances": [28279852264, 158122684, 1],
          "postBalances": [28279747264, 158222684, 1],
          "innerInstructions": [],
          "logMessages": ["Program 111... invoke [1]", "Program 111... success"],
          "preTokenBalances": [],
          "postTokenBalances": [],
          "computeUnitsConsumed": 0
        }
      },
      "signature": "5moMXe6VW7L7...",
      "slot": 224341380
    }
  }
}
```

### accountSubscribe (Enhanced)

Monitor account data/balance changes with enhanced performance:

```typescript
ws.send(JSON.stringify({
  jsonrpc: '2.0',
  id: 1,
  method: 'accountSubscribe',
  params: [
    'ACCOUNT_ADDRESS',
    { encoding: 'jsonParsed', commitment: 'confirmed' }
  ]
}));

ws.on('message', (data) => {
  const msg = JSON.parse(data.toString());
  if (msg.method === 'accountNotification') {
    const value = msg.params.result.value;
    console.log('Lamports:', value.lamports);
    console.log('Owner:', value.owner);
    console.log('Data:', value.data);
  }
});
```

## Standard WebSockets

Available on all plans. These are standard Solana RPC WebSocket methods.

### Supported Methods

| Method | What It Does |
|---|---|
| `accountSubscribe` | Notifications when an account's lamports or data change |
| `logsSubscribe` | Transaction log messages (filter by address or `all`) |
| `programSubscribe` | Notifications when accounts owned by a program change |
| `signatureSubscribe` | Notification when a specific transaction is confirmed |
| `slotSubscribe` | Notifications on slot progression |
| `rootSubscribe` | Notifications when a new root is set |

Each has a corresponding `*Unsubscribe` method (e.g., `accountUnsubscribe`).

### Unsupported (Unstable) Methods

These are unstable in the Solana spec and NOT supported on Helius:
- `blockSubscribe` / `blockUnsubscribe`
- `slotsUpdatesSubscribe` / `slotsUpdatesUnsubscribe`
- `voteSubscribe` / `voteUnsubscribe`

### accountSubscribe (Standard)

```typescript
ws.send(JSON.stringify({
  jsonrpc: '2.0',
  id: 1,
  method: 'accountSubscribe',
  params: [
    'ACCOUNT_ADDRESS',
    {
      encoding: 'jsonParsed', // base58, base64, base64+zstd, jsonParsed
      commitment: 'confirmed' // finalized (default), confirmed, processed
    }
  ]
}));
```

### programSubscribe

Monitor all accounts owned by a program:

```typescript
ws.send(JSON.stringify({
  jsonrpc: '2.0',
  id: 1,
  method: 'programSubscribe',
  params: [
    'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', // Token Program
    {
      encoding: 'jsonParsed',
      commitment: 'confirmed'
    }
  ]
}));
```

### logsSubscribe

Subscribe to transaction logs:

```typescript
// All logs
ws.send(JSON.stringify({
  jsonrpc: '2.0',
  id: 1,
  method: 'logsSubscribe',
  params: ['all', { commitment: 'confirmed' }]
}));

// Logs mentioning a specific address
ws.send(JSON.stringify({
  jsonrpc: '2.0',
  id: 1,
  method: 'logsSubscribe',
  params: [
    { mentions: ['PROGRAM_OR_ACCOUNT_ADDRESS'] },
    { commitment: 'confirmed' }
  ]
}));
```

### signatureSubscribe

Watch for a specific transaction to confirm:

```typescript
ws.send(JSON.stringify({
  jsonrpc: '2.0',
  id: 1,
  method: 'signatureSubscribe',
  params: [
    'TRANSACTION_SIGNATURE',
    { commitment: 'confirmed' }
  ]
}));

// Auto-unsubscribes after first notification
```

### slotSubscribe

```typescript
ws.send(JSON.stringify({
  jsonrpc: '2.0',
  id: 1,
  method: 'slotSubscribe',
  params: []
}));
```

## Reconnection Pattern

WebSocket connections can drop. ALWAYS implement auto-reconnection with exponential backoff:

- On `close`: clear ping timer, wait `reconnectDelay` (start 1s, double each attempt, cap at 30s), then reconnect
- On successful `open`: reset delay to 1s, restart 30s ping timer, re-send subscription
- On `error`: log and let `close` handler trigger reconnect

## Common Patterns

All Enhanced `transactionSubscribe` patterns use the same shape — vary the filter addresses. Use the `transactionSubscribe` MCP tool to generate correct configs:

| Use Case | Filter | Key Addresses |
|---|---|---|
| Jupiter swaps | `accountInclude` | `JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4` |
| Magic Eden NFT sales | `accountInclude` | `M2mx93ekt1fmXSVkTrUL9xVFHkmME8HTUi5Cyc5aF7K` |
| Pump AMM data | `accountInclude` | `pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA` |
| Wallet activity (Enhanced) | `accountInclude` | `[WALLET_ADDRESS]` |
| Txs between two wallets | `accountRequired` (AND logic) | `[WALLET_A, WALLET_B]` |

For Standard WebSockets:
- **Wallet balance/data changes**: `accountSubscribe` with `[address, { encoding: 'jsonParsed', commitment: 'confirmed' }]`
- **Token program activity**: `programSubscribe` with `[TOKEN_PROGRAM_ID, { encoding: 'jsonParsed', commitment: 'confirmed' }]`

## WebSockets vs LaserStream vs Webhooks

| Feature | Standard WS | Enhanced WS | LaserStream | Webhooks |
|---|---|---|---|---|
| Plan | Free+ | Business+ | Professional+ | Free+ |
| Protocol | WebSocket | WebSocket | gRPC | HTTP POST |
| Latency | Good | Faster | Fastest (shred-level) | Variable |
| Max addresses | 1 per subscription | 50K per filter | 10M | 100K per webhook |
| Historical replay | No | No | Yes (24 hours) | No |
| Auto-reconnect | Manual | Manual | Built-in via SDK | N/A |
| Transaction parsing | No | Yes (auto) | No (raw data) | Yes (enhanced type) |
| Requires public endpoint | No | No | No | Yes |

**Use Standard WebSockets when**: you're on a Free/Developer plan, need basic account/program monitoring, or are using existing Solana WebSocket code.

**Use Enhanced WebSockets when**: you need transaction filtering with multiple addresses, auto-parsed transaction data, or monitoring DEX/NFT activity on Business+ plan.

**Use LaserStream when**: you need the lowest latency, historical replay, or are processing high data volumes. See `references/helius-laserstream.md`.

**Use Webhooks when**: you want push notifications without maintaining a connection. See Helius docs at `docs.helius.dev`.

## Best Practices

- ALWAYS send pings every 30 seconds — 10-minute inactivity timeout disconnects silently
- ALWAYS implement auto-reconnection with exponential backoff
- Use `accountRequired` for stricter matching (AND logic) vs `accountInclude` (OR logic)
- Set `vote: false` and `failed: false` to reduce noise unless you specifically need those
- Set `maxSupportedTransactionVersion: 0` to receive both legacy and versioned transactions
- Use `jsonParsed` encoding for human-readable data; `base64` for raw processing
- Use the MCP tools (`transactionSubscribe`, `accountSubscribe`) to generate correct configs before embedding in user code
- For standard WebSockets, use `confirmed` commitment for most use cases

## Common Mistakes

- Not implementing ping keepalive — connection silently drops after 10 minutes of inactivity
- Not implementing auto-reconnection — WebSocket disconnects are normal and expected
- Confusing `accountInclude` (OR — any match) with `accountRequired` (AND — all must match)
- Not setting `maxSupportedTransactionVersion: 0` — misses versioned transactions
- Using Enhanced WebSocket features on Free/Developer plans — requires Business+
- Subscribing without filters on `transactionSubscribe` — streams ALL network transactions, extreme volume
- Using `blockSubscribe`, `slotsUpdatesSubscribe`, or `voteSubscribe` — these are unstable and not supported on Helius
- Not handling the subscription confirmation message (first message has `result` field, not notification data)


---

## integration-patterns.md

# Integration Patterns — Helius x Jupiter

## What This Covers

End-to-end patterns for combining Jupiter APIs with Helius infrastructure. These patterns show how the two systems connect at the transaction, data, and monitoring layers.

**Jupiter** handles DeFi operations — token swaps (Swap API V2), lending/borrowing (Lend), limit orders (Trigger), DCA (Recurring), and token/price data.

**Helius** handles infrastructure — transaction submission (Sender), fee optimization (Priority Fees), token/NFT data (DAS), real-time on-chain monitoring (WebSockets), shred-level streaming (LaserStream), and wallet intelligence (Wallet API).

---

## Pattern 1: Jupiter Swap via Helius Sender

Helius Sender dual-routes a transaction to validators **and** Jito simultaneously. The Jito leg requires a tip transfer **inside the transaction** — which Jupiter's `/order` pre-built transaction does **not** include. This pattern uses `/swap/v2/build` to get raw instructions, then locally assembles a V0 transaction with the tip transfer before submitting via Sender.

### Flow

1. `GET /swap/v2/build` with `inputMint`, `outputMint`, `amount`, `taker`.
2. From the response, collect: `computeBudgetInstructions` (Jupiter's CU-price ix), `setupInstructions`, `swapInstruction`, `cleanupInstruction`, `otherInstructions`, `addressesByLookupTableAddress`, and `blockhashWithMetadata`.
3. **Compute unit limit:** simulate first, then set the real limit. Build a probe message with `setComputeUnitLimit(1_400_000)`, run `simulateTransaction` against the Helius RPC, and on the real transaction set `setComputeUnitLimit(Math.min(Math.ceil(simulatedUnits * 1.2), 1_400_000))`. Do **not** hardcode 1.4M on the real transaction — over-allocating CUs lowers per-CU priority.
4. Keep Jupiter's `computeBudgetInstructions` (CU price) as-is — do not replace.
5. Append `SystemProgram.transfer({ fromPubkey: taker, toPubkey: randomJitoTipAccount, lamports: Math.floor(tipAmountSOL * LAMPORTS_PER_SOL) })` after cleanup/other instructions. Use `getDynamicTipAmount()` from `references/helius-sender.md` — it returns **SOL** (floor `0.0002 SOL` = 200,000 lamports), so convert to lamports before constructing the transfer. Pick a random tip account from the 10-address mainnet list in `references/helius-sender.md`.
6. Reconstruct `AddressLookupTableAccount[]` directly from `addressesByLookupTableAddress` — no extra `getAddressLookupTable` RPC fetch. Each key is the ALT address, value is the `addresses[]`.
7. **Blockhash:** use `blockhashWithMetadata.blockhash` from the `/build` response by default — it is fresh as of the Jupiter call and saves an RPC round-trip. Only call `getLatestBlockhash` against the Helius RPC if more than ~30 seconds elapse between `/build` and submission (e.g. wallet UI signature delays), since stale blockhashes cause Sender to reject on the validator leg.
8. Build `TransactionMessage` → `compileToV0Message(altAccounts)` → `VersionedTransaction`. Sign and submit to Helius Sender with `skipPreflight: true, maxRetries: 0` (mandatory — see `references/helius-sender.md`).

### TypeScript Example

```typescript
import {
  VersionedTransaction,
  TransactionMessage,
  ComputeBudgetProgram,
  SystemProgram,
  PublicKey,
  AddressLookupTableAccount,
  Keypair,
  Connection,
  TransactionInstruction,
  LAMPORTS_PER_SOL,
} from '@solana/web3.js';

const JUPITER_API = 'https://api.jup.ag';
const HELIUS_RPC = `https://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY}`;
const SENDER_URL = `https://sender.helius-rpc.com/fast?api-key=${process.env.HELIUS_API_KEY}`;

// See references/helius-sender.md for the full 10-address mainnet list.
const JITO_TIP_ACCOUNTS = [
  '4ACfpUFoaSD9bfPdeu6DBt89gB6ENTeHBXCAi87NhDEE',
  'D2L6yPZ2FmmmTKPgzaMKdhu6EWZcTpLy1Vhx8uvZe7NZ',
  '9bnz4RShgq1hAnLnZbP8kbgBg1kEmcJBYQq3gQbmnSta',
  '5VY91ws6B2hMmBFRsXkoAAdsPHBJwRfBht4DXox3xkwn',
  '2nyhqdwKcJZR2vcqCyrYsaPVdAnFoJjiksCXJ7hfEYgD',
  '2q5pghRs6arqVjRvT5gfgWfWcHWmw1ZuCzphgd5KfWGJ',
  'wyvPkWjVZz1M8fHQnMMCDTQDbkManefNNhweYk5WkcF',
  '3KCKozbAaF75qEU33jtzozcJ29yJuaLJTy2jFdzUY8bT',
  '4vieeGHPYPG2MmyPRcYjdiDmmhN3ww7hsFNap8pVN3Ey',
  '4TQLFNWK8AovT1gFvda5jfw2oJeRMKEmw7aH6MGBJ3or',
];

async function getDynamicTipAmount(): Promise<number> {
  try {
    const res = await fetch('https://bundles.jito.wtf/api/v1/bundles/tip_floor');
    const data = await res.json();
    if (data?.[0]?.landed_tips_75th_percentile) {
      return Math.max(data[0].landed_tips_75th_percentile, 0.0002);
    }
  } catch {}
  return 0.0002;
}

function decodeIx(ix: any): TransactionInstruction {
  return new TransactionInstruction({
    programId: new PublicKey(ix.programId),
    keys: ix.accounts.map((a: any) => ({
      pubkey: new PublicKey(a.pubkey),
      isSigner: a.isSigner,
      isWritable: a.isWritable,
    })),
    data: Buffer.from(ix.data, 'base64'),
  });
}

async function swapViaJupiterAndSender(
  keypair: Keypair,
  inputMint: string,
  outputMint: string,
  amount: string,
): Promise<string> {
  const taker = keypair.publicKey;
  const connection = new Connection(HELIUS_RPC);

  // 1. /build — raw instructions (no Jito tip, no CU limit)
  const params = new URLSearchParams({ inputMint, outputMint, amount, taker: taker.toBase58() });
  const buildRes = await fetch(`${JUPITER_API}/swap/v2/build?${params}`, {
    headers: { 'x-api-key': process.env.JUPITER_API_KEY! },
  });
  const build = await buildRes.json();
  if (build.error) throw new Error(`Jupiter /build error: ${build.error}`);

  // 2. Reconstruct ALTs directly from the response — no extra RPC fetch.
  const altAccounts: AddressLookupTableAccount[] = Object.entries(
    build.addressesByLookupTableAddress as Record<string, string[]>,
  ).map(([key, addresses]) => new AddressLookupTableAccount({
    key: new PublicKey(key),
    state: {
      deactivationSlot: BigInt('0xffffffffffffffff'),
      lastExtendedSlot: 0,
      lastExtendedSlotStartIndex: 0,
      authority: undefined,
      addresses: addresses.map((a) => new PublicKey(a)),
    },
  }));

  // 3. Collect Jupiter instructions in order.
  const jupiterIxs: TransactionInstruction[] = [
    ...(build.computeBudgetInstructions ?? []).map(decodeIx), // CU price ix (keep as-is)
    ...(build.setupInstructions ?? []).map(decodeIx),
    decodeIx(build.swapInstruction),
    ...(build.cleanupInstruction ? [decodeIx(build.cleanupInstruction)] : []),
    ...(build.otherInstructions ?? []).map(decodeIx),
  ];

  // 4. Jito tip transfer — required for Sender dual-routing. getDynamicTipAmount() returns SOL.
  const tipAmountSOL = await getDynamicTipAmount();
  const tipAccount = new PublicKey(JITO_TIP_ACCOUNTS[Math.floor(Math.random() * JITO_TIP_ACCOUNTS.length)]);
  const tipIx = SystemProgram.transfer({
    fromPubkey: taker,
    toPubkey: tipAccount,
    lamports: Math.floor(tipAmountSOL * LAMPORTS_PER_SOL),
  });

  // 5. Use Jupiter's blockhash (fresh as of /build). Refresh only if you sit on this for >~30s.
  const blockhash = build.blockhashWithMetadata.blockhash;

  // 6. Simulate with the 1.4M ceiling to measure actual CU usage.
  const probeMsg = new TransactionMessage({
    payerKey: taker,
    recentBlockhash: blockhash,
    instructions: [ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }), ...jupiterIxs, tipIx],
  }).compileToV0Message(altAccounts);
  const probeTx = new VersionedTransaction(probeMsg);
  // No need to sign — simulateTransaction is called with sigVerify: false and replaceRecentBlockhash: true.
  const sim = await connection.simulateTransaction(probeTx, { sigVerify: false, replaceRecentBlockhash: true });
  if (sim.value.err) throw new Error(`Simulation failed: ${JSON.stringify(sim.value.err)}`);
  const cuLimit = Math.min(Math.ceil((sim.value.unitsConsumed ?? 200_000) * 1.2), 1_400_000);

  // 7. Real transaction with the simulated CU limit.
  const realMsg = new TransactionMessage({
    payerKey: taker,
    recentBlockhash: blockhash,
    instructions: [ComputeBudgetProgram.setComputeUnitLimit({ units: cuLimit }), ...jupiterIxs, tipIx],
  }).compileToV0Message(altAccounts);
  const tx = new VersionedTransaction(realMsg);
  tx.sign([keypair]);

  // 8. Submit via Helius Sender. skipPreflight + maxRetries:0 are mandatory.
  const sendRes = await fetch(SENDER_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: Date.now().toString(),
      method: 'sendTransaction',
      params: [
        Buffer.from(tx.serialize()).toString('base64'),
        { encoding: 'base64', skipPreflight: true, maxRetries: 0 },
      ],
    }),
  });
  const sendResult = await sendRes.json();
  if (sendResult.error) throw new Error(`Sender error: ${sendResult.error.message}`);
  return sendResult.result; // transaction signature
}
```

See `references/jupiter-swap.md` for the full `/build` response shape, and `references/helius-sender.md` for the complete tip account list, dynamic tip sizing, and the mandatory Sender submission requirements.

### When to Use `/order` + `/execute` vs `/build` + Helius Sender

- **`/order` + `/execute`** — Jupiter manages submission (Beam), including Jito landing internally — you do not (and cannot) add a tip ix to the returned transaction. Idempotent retries via `requestId`. Use when you do not need custom transaction composition or direct control over the Jito tip.
- **`/build` + Helius Sender** — You assemble the transaction (compute budget, swap, tip, ALTs) and submit through Sender for Jito + SWQoS dual-routing. Use when you need a Jito tip inside the transaction, custom priority fees, or composition with non-Jupiter instructions.

---

## Pattern 2: Token Selector with DAS + Jupiter

Build a swap UI token selector combining user holdings from Helius with Jupiter metadata and prices.

### Flow

1. Fetch user's token holdings via Helius DAS (`getAssetsByOwner`)
2. Enrich with Jupiter token metadata (verification, logos)
3. Get live prices from Jupiter Price API v3
4. Display sorted by value with verification badges

### TypeScript Example

```typescript
// Step 1: Get user holdings via Helius MCP
// Use getAssetsByOwner with showFungible: true
// Returns: array of assets with mint, amount, decimals

// Step 2: Enrich with Jupiter metadata
const mintAddresses = holdings.map(h => h.mint);

// Step 3: Batch price lookup (max 50 per request)
const chunks = [];
for (let i = 0; i < mintAddresses.length; i += 50) {
  chunks.push(mintAddresses.slice(i, i + 50));
}

const allPrices: Record<string, number> = {};
for (const chunk of chunks) {
  const res = await fetch(
    `https://api.jup.ag/price/v3?ids=${chunk.join(',')}`,
    { headers: { 'x-api-key': process.env.JUPITER_API_KEY! } }
  );
  const data = await res.json();
  // Price API v3 keys mints at the top level — no `data` wrapper
  for (const [mint, info] of Object.entries(data)) {
    allPrices[mint] = (info as any).usdPrice;
  }
}

// Step 4: Combine and sort by USD value
const enrichedHoldings = holdings.map(h => ({
  ...h,
  price: allPrices[h.mint] || 0,
  usdValue: (h.amount / Math.pow(10, h.decimals)) * (allPrices[h.mint] || 0),
})).sort((a, b) => b.usdValue - a.usdValue);
```

---

## Pattern 3: Lending Position with Helius Monitoring

Deposit tokens into Jupiter Lend and monitor the position with Helius WebSockets.

### Flow

1. Query vault data via Jupiter Lend read SDK
2. Build deposit transaction via write SDK
3. Submit via Helius Sender
4. Monitor position changes via Helius WebSockets

### TypeScript Example

```typescript
import { Client } from "@jup-ag/lend-read";
import { getOperateIx } from "@jup-ag/lend/borrow";
import BN from "bn.js";

// 1. Query vault data
const connection = new Connection(HELIUS_RPC_URL);
const client = new Client(connection);
const vaultData = await client.vault.getVaultByVaultId(targetVaultId);

// Check limits before proceeding
if (depositAmount > vaultData.limitsAndAvailability.supplyLimit) {
  throw new Error('Deposit exceeds vault supply limit');
}

// 2. Build deposit transaction
const { ixs, addressLookupTableAccounts, nftId } = await getOperateIx({
  vaultId: targetVaultId,
  positionId: 0, // new position
  colAmount: new BN(depositAmount),
  debtAmount: new BN(0),
  connection,
  signer: userPublicKey,
});

// 3. Build, sign, submit via Helius Sender
// (See Pattern 1 for Sender submission code)

// 4. Monitor position via Helius WebSockets
// Use accountSubscribe MCP tool to watch the position account
// Trigger alerts when LTV approaches liquidation threshold
```

---

## Pattern 4: Limit Order + DCA with Status Tracking

Set up limit orders and DCA orders, then track their execution status.

### Flow

1. Authenticate via JWT challenge-response (Trigger V2)
2. Register vault and craft deposit transaction
3. Create orders via Jupiter Trigger V2 / Recurring APIs
4. Use Helius `parseTransactions` to get human-readable execution history
5. Use Helius WebSockets to get real-time notifications when orders fill

```typescript
// 1. Authenticate (see references/jupiter-trigger.md for full JWT flow)
const { token: jwtToken } = await authenticateJupiterTrigger(walletPublicKey, wallet);

// 2. Craft deposit and create a limit order (Trigger V2)
const depositRes = await fetch('https://api.jup.ag/trigger/v2/deposit/craft', {
  method: 'POST',
  headers: {
    'x-api-key': process.env.JUPITER_API_KEY!,
    'Authorization': `Bearer ${jwtToken}`,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({
    inputMint: SOL_MINT,
    outputMint: USDC_MINT,
    userAddress: walletPublicKey,
    amount: '1000000000', // 1 SOL
  }),
});
const deposit = await depositRes.json();

// Sign the deposit transaction
const depositTx = VersionedTransaction.deserialize(Buffer.from(deposit.transaction, 'base64'));
depositTx.sign([keypair]);
const depositSignedTx = Buffer.from(depositTx.serialize()).toString('base64');

// 3. Create the order
const orderRes = await fetch('https://api.jup.ag/trigger/v2/orders/price', {
  method: 'POST',
  headers: {
    'x-api-key': process.env.JUPITER_API_KEY!,
    'Authorization': `Bearer ${jwtToken}`,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({
    orderType: 'single',
    depositRequestId: deposit.requestId,
    depositSignedTx,
    userPubkey: walletPublicKey,
    inputMint: SOL_MINT,
    inputAmount: '1000000000',
    outputMint: USDC_MINT,
    triggerMint: SOL_MINT,
    triggerCondition: 'above',
    triggerPriceUsd: 200, // Sell when SOL > $200
    expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000, // 7 days
  }),
});
const order = await orderRes.json();
// order: { id, txSignature }

// 4. Check order execution history via Helius
// Use parseTransactions MCP tool with the wallet address
// Jupiter order fills show as "SWAP" transaction types
```

---

## Pattern 5: Portfolio Dashboard with DeFi Positions

Build a comprehensive dashboard showing token holdings, lending positions, and open orders.

### Architecture

```
Helius Wallet API   →  Token holdings + USD values
Helius DAS API      →  Token metadata + NFT positions
Jupiter Lend Read   →  Lending positions + yield data
Jupiter Trigger V2  →  Open limit orders (requires JWT)
Jupiter Recurring   →  Active DCA orders
Jupiter Price API   →  Live price feeds
```

### Data Flow

```typescript
// Parallel data fetching for dashboard
const [walletBalances, lendPositions, limitOrders, dcaOrders] = await Promise.all([
  // Helius: wallet holdings
  heliusWalletBalances(walletAddress),
  // Jupiter Lend: vault positions
  lendClient.vault.getAllUserPositions(walletPublicKey),
  // Jupiter Trigger V2: open limit orders (requires JWT auth)
  fetch('https://api.jup.ag/trigger/v2/orders/history?state=active', {
    headers: {
      'x-api-key': JUPITER_API_KEY,
      'Authorization': `Bearer ${jwtToken}`,
    },
  }).then(r => r.json()),
  // Jupiter Recurring: active DCA orders
  fetch(`https://api.jup.ag/recurring/v1/getRecurringOrders?user=${walletAddress}&orderStatus=active&recurringType=time`, {
    headers: { 'x-api-key': JUPITER_API_KEY },
  }).then(r => r.json()),
]);
```

---

## Pattern 6: Trading Bot with LaserStream

Build a high-speed trading bot using LaserStream for market data and Jupiter Swap API for execution.

### Architecture

```
LaserStream (gRPC)  →  Shred-level on-chain data (price changes, liquidity shifts)
Jupiter Swap API API   →  Swap execution with optimized routing
Helius Sender       →  Transaction submission with Jito bundles
```

### Flow

1. Subscribe to relevant accounts via LaserStream
2. Detect trading opportunity (price divergence, arbitrage, etc.)
3. Get quote from Jupiter Swap API
4. Sign and submit via Helius Sender
5. Monitor confirmation via LaserStream

```typescript
import { subscribe } from 'helius-laserstream';

// 1. Subscribe to pool accounts for price monitoring
const config = {
  apiKey: process.env.HELIUS_API_KEY!,
  endpoint: 'mainnet', // or regional endpoint for lower latency
};

const request = {
  accounts: [POOL_ACCOUNT_ADDRESS],
  commitment: 'confirmed',
};

subscribe(config, request,
  // Data callback
  async (update) => {
    // 2. Detect opportunity
    const opportunity = analyzeUpdate(update);
    if (!opportunity) return;

    // 3. Execute swap via Jupiter
    const signature = await swapViaJupiterAndSender(
      keypair,
      opportunity.inputMint,
      opportunity.outputMint,
      opportunity.amount,
    );

    console.log(`Trade executed: ${signature}`);
  },
  // Error callback
  (error) => {
    console.error('LaserStream error:', error);
  }
);
```

### Latency Considerations

- Choose the **closest LaserStream regional endpoint** to your server
- Use `CONFIRMED` commitment (faster than `FINALIZED`)
- Pre-build transactions where possible to minimize execution time
- LaserStream requires **Professional plan** ($999/mo) on mainnet

---

## Pattern 7: Jupiter Plugin with Helius Portfolio

The fastest path to adding swap functionality — use Jupiter's drop-in widget with Helius for portfolio context.

### Flow

1. Fetch user's token holdings via Helius DAS
2. Display portfolio in your app
3. Initialize Jupiter Plugin with Helius RPC
4. Let users click tokens to pre-fill swap parameters
5. Monitor completed swaps via Helius parseTransactions

### TypeScript Example (React)

```typescript
import '@jup-ag/plugin/css';
import { useEffect, useState } from 'react';

function SwapPage({ walletAddress }: { walletAddress: string }) {
  const [selectedMint, setSelectedMint] = useState<string | null>(null);
  const [holdings, setHoldings] = useState([]);

  useEffect(() => {
    // Fetch holdings via Helius (getAssetsByOwner MCP tool)
    fetchHoldings(walletAddress).then(setHoldings);
  }, [walletAddress]);

  useEffect(() => {
    import('@jup-ag/plugin').then(({ init }) => {
      init({
        displayMode: 'integrated',
        integratedTargetId: 'jupiter-plugin',
        endpoint: `https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`,
        defaultExplorer: 'Solana Explorer',
        formProps: selectedMint ? { initialInputMint: selectedMint } : undefined,
      });
    });
  }, [selectedMint]);

  return (
    <div>
      {/* Portfolio list — click to swap */}
      <div>
        {holdings.map(token => (
          <div key={token.mint} onClick={() => setSelectedMint(token.mint)}>
            {token.symbol}: {token.balance} (${token.usdValue})
          </div>
        ))}
      </div>

      {/* Jupiter swap widget */}
      <div id="jupiter-plugin" style={{ width: 400, height: 600 }} />
    </div>
  );
}
```

### Helius Value

- **Helius RPC** powers the plugin's transaction submission
- **DAS API** provides the portfolio context surrounding the swap
- **parseTransactions** gives rich post-swap transaction details
- **Wallet API** keeps the portfolio view updated after swaps

---

## Cross-Pattern Best Practices

1. **Always use Helius RPC** for Jupiter Lend SDK connections — provides reliable, high-performance access
2. **Batch API calls** — Jupiter Price API (max 50 per request), Helius DAS batch endpoints
3. **Handle errors at each layer** — Jupiter API errors, Sender errors, and on-chain errors are different
4. **Use environment variables** for all API keys — never hardcode
5. **Log with context** — Include requestId, signature, and timestamps for debugging
6. **Respect rate limits** — Jupiter limits are dynamic; Helius limits depend on plan tier
7. **Use Jupiter Plugin for quick swap UIs** — Don't build swap from scratch unless you need custom routing control
8. **Check Token Shield before displaying tokens** — Combine with Helius DAS metadata for comprehensive safety checks
9. **For perps, read on-chain accounts via Helius** — No REST API exists; use `getAccountInfo` and `getProgramAccounts`


---

## jupiter-lend.md

# Jupiter Lend Protocol

## What This Covers

Jupiter Lend (powered by Fluid Protocol) — a lending and borrowing protocol on Solana. Covers the REST API, liquidity pools, lending markets (jlTokens), vaults for leveraged positions, and both the read and write SDKs.

---

## Architecture

### Two-Layer Model

- **Liquidity Layer**: Foundational layer managing token limits, rate curves, and unified liquidity. Users never interact with this directly.
- **Protocol Layer**: User-facing modules (Earn and Borrow) that sit on top of the Liquidity Layer via Cross-Program Invocations (CPIs).

### Key Concepts

- **jlToken**: Yield-bearing token received when supplying to Earn (e.g., `jlUSDC`). Exchange rate increases as interest accrues.
- **Exchange Price**: Conversion rate between raw stored amounts and actual token amounts. Continuously increases.
- **Collateral Factor (CF)**: Maximum LTV ratio allowed when opening/managing positions.
- **Liquidation Threshold (LT)**: LTV at which a position becomes eligible for liquidation.
- **Liquidation Max Limit (LML)**: Absolute maximum LTV — positions exceeding this are absorbed by the protocol.
- **Sentinel Values**: `MAX_WITHDRAW_AMOUNT` and `MAX_REPAY_AMOUNT` — tell the protocol to calculate and use the maximum possible amount. Always use these for full withdrawals/repayments instead of trying to calculate exact amounts.

---

## REST API

All REST endpoints require the `x-api-key` header.

```
Base: https://api.jup.ag/lend/v1
Auth: x-api-key header (required)
```

### Earn Endpoints

```typescript
// Deposit tokens
const depositRes = await fetch('https://api.jup.ag/lend/v1/earn/deposit', {
  method: 'POST',
  headers: {
    'x-api-key': process.env.JUPITER_API_KEY!,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({
    asset: mintAddress,
    amount: '1000000', // atomic units
    signer: walletPublicKey,
  }),
});

// Withdraw tokens
const withdrawRes = await fetch('https://api.jup.ag/lend/v1/earn/withdraw', {
  method: 'POST',
  headers: {
    'x-api-key': process.env.JUPITER_API_KEY!,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({
    asset: mintAddress,
    amount: '1000000',
    signer: walletPublicKey,
  }),
});

// Get available earn tokens
const tokensRes = await fetch('https://api.jup.ag/lend/v1/earn/tokens', {
  headers: { 'x-api-key': process.env.JUPITER_API_KEY! },
});

// Get user positions
const positionsRes = await fetch(
  `https://api.jup.ag/lend/v1/earn/positions?user=${walletPublicKey}`,
  { headers: { 'x-api-key': process.env.JUPITER_API_KEY! } }
);

// Get earnings history
const earningsRes = await fetch(
  `https://api.jup.ag/lend/v1/earn/earnings?user=${walletPublicKey}`,
  { headers: { 'x-api-key': process.env.JUPITER_API_KEY! } }
);

// Mint vault shares (specify shares, not underlying amount)
const mintRes = await fetch('https://api.jup.ag/lend/v1/earn/mint', {
  method: 'POST',
  headers: {
    'x-api-key': process.env.JUPITER_API_KEY!,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({
    asset: mintAddress,
    shares: '1000000', // vault shares to mint
    signer: walletPublicKey,
  }),
});

// Redeem vault shares back to underlying tokens
const redeemRes = await fetch('https://api.jup.ag/lend/v1/earn/redeem', {
  method: 'POST',
  headers: {
    'x-api-key': process.env.JUPITER_API_KEY!,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({
    asset: mintAddress,
    shares: '1000000', // vault shares to redeem
    signer: walletPublicKey,
  }),
});
```

### Instruction Endpoints (for Composability)

These return raw instructions instead of full transactions, allowing you to compose earn operations with other instructions in a single transaction.

```typescript
// Deposit instructions
const depositIxRes = await fetch('https://api.jup.ag/lend/v1/earn/deposit-instructions', {
  method: 'POST',
  headers: {
    'x-api-key': process.env.JUPITER_API_KEY!,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({ asset: mintAddress, amount: '1000000', signer: walletPublicKey }),
});
// Returns: { programId, accounts: [{ pubkey, isSigner, isWritable }], data }

// Withdraw instructions
const withdrawIxRes = await fetch('https://api.jup.ag/lend/v1/earn/withdraw-instructions', {
  method: 'POST',
  headers: {
    'x-api-key': process.env.JUPITER_API_KEY!,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({ asset: mintAddress, amount: '1000000', signer: walletPublicKey }),
});

// Mint instructions (shares-based)
const mintIxRes = await fetch('https://api.jup.ag/lend/v1/earn/mint-instructions', {
  method: 'POST',
  headers: {
    'x-api-key': process.env.JUPITER_API_KEY!,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({ asset: mintAddress, shares: '1000000', signer: walletPublicKey }),
});

// Redeem instructions (shares-based)
const redeemIxRes = await fetch('https://api.jup.ag/lend/v1/earn/redeem-instructions', {
  method: 'POST',
  headers: {
    'x-api-key': process.env.JUPITER_API_KEY!,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({ asset: mintAddress, shares: '1000000', signer: walletPublicKey }),
});
```

**Transaction vs Instruction endpoints**:
- `/earn/deposit`, `/earn/withdraw`, `/earn/mint`, `/earn/redeem` — return `{ transaction }` (base64-encoded, ready to sign and send)
- `/earn/deposit-instructions`, `/earn/withdraw-instructions`, `/earn/mint-instructions`, `/earn/redeem-instructions` — return `{ programId, accounts, data }` for custom transaction assembly
- **Amount vs Shares**: `/deposit` and `/withdraw` use `amount` (underlying token units). `/mint` and `/redeem` use `shares` (vault share units).

---

## SDKs

```bash
# Read operations (queries, prices, positions)
npm install @jup-ag/lend-read

# Write operations (transactions)
npm install @jup-ag/lend
```

No API key needed for on-chain SDK interactions — only an RPC connection.

---

## Reading Data (@jup-ag/lend-read)

### Initialize Client

```typescript
import { Client } from "@jup-ag/lend-read";
import { Connection, PublicKey } from "@solana/web3.js";

const connection = new Connection("YOUR_HELIUS_RPC_URL");
const client = new Client(connection);
```

**Important**: Use a Helius RPC URL for reliable access. The user's Helius API key provides the RPC endpoint.

### Liquidity Module — Rates and Pool Data

```typescript
const USDC = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");

const data = await client.liquidity.getOverallTokenData(USDC);

// Rates in basis points (10000 = 100%)
const supplyApr = Number(data.supplyRate) / 100;
const borrowApr = Number(data.borrowRate) / 100;
```

### Earn Module — jlToken Markets

```typescript
// Get all fToken (jlToken) details
const allDetails = await client.lending.getFTokensEntireData();

// Get user's jlToken balance
const position = await client.lending.getUserPosition(USDC, userPublicKey);
```

### Borrow Module — Discovery and Positions

```typescript
// Discover all available vaults
const allVaults = await client.vault.getAllVaults();
const totalVaults = await client.vault.getTotalVaults();

// Get vault data (config + state + rates + limits)
const vaultData = await client.vault.getVaultByVaultId(1);

// Check borrowing limits before prompting users
const borrowLimit = vaultData.limitsAndAvailability.borrowLimit;
const borrowable = vaultData.limitsAndAvailability.borrowable;
```

### Finding User Vault Positions

```typescript
const positions = await client.vault.getAllUserPositions(userPublicKey);
// Returns NftPosition[] directly

for (const pos of positions) {
  console.log(`Position NFT ID: ${pos.nftId}`);
  console.log(`Collateral: ${pos.supply}`);
  console.log(`Debt: ${pos.borrow}`);
}
```

---

## Writing Data (@jup-ag/lend)

All write operations return `ixs` (instructions) and `addressLookupTableAccounts` (ALTs). You must wrap these in a **versioned (v0) transaction**.

### Earn — Deposit / Withdraw

```typescript
import { getDepositIxs, getWithdrawIxs } from "@jup-ag/lend/earn";
import BN from "bn.js";

// Deposit 1 USDC (6 decimals)
const { ixs: depositIxs } = await getDepositIxs({
  amount: new BN(1_000_000),
  asset: USDC_PUBKEY,
  signer: userPublicKey,
  connection,
});

// Withdraw
const { ixs: withdrawIxs } = await getWithdrawIxs({
  amount: new BN(100_000),
  asset: USDC_PUBKEY,
  signer: userPublicKey,
  connection,
});
```

### Borrow — Deposit Collateral / Borrow / Repay / Withdraw

All vault operations use the single `getOperateIx` function. The direction is determined by the sign of `colAmount` and `debtAmount`:

| Operation | colAmount | debtAmount |
|---|---|---|
| Deposit collateral | > 0 | 0 |
| Withdraw collateral | < 0 (or `MAX_WITHDRAW_AMOUNT`) | 0 |
| Borrow | 0 | > 0 |
| Repay | 0 | < 0 (or `MAX_REPAY_AMOUNT`) |
| Deposit + Borrow | > 0 | > 0 |
| Repay + Withdraw | `MAX_WITHDRAW_AMOUNT` | `MAX_REPAY_AMOUNT` |

**`positionId: 0`** creates a new position NFT. Use an existing `nftId` (from the read SDK) to operate on an existing position.

```typescript
import { getOperateIx, MAX_WITHDRAW_AMOUNT, MAX_REPAY_AMOUNT } from "@jup-ag/lend/borrow";
import BN from "bn.js";

// Deposit collateral (new position)
const { ixs, addressLookupTableAccounts, nftId } = await getOperateIx({
  vaultId: 1,
  positionId: 0, // 0 = create new position
  colAmount: new BN(1_000_000),
  debtAmount: new BN(0),
  connection,
  signer: userPublicKey,
});

// Borrow against existing position
const { ixs: borrowIxs } = await getOperateIx({
  vaultId: 1,
  positionId: existingNftId,
  colAmount: new BN(0),
  debtAmount: new BN(500_000),
  connection,
  signer: userPublicKey,
});

// Full repay + withdraw (use sentinels)
const { ixs: closeIxs } = await getOperateIx({
  vaultId: 1,
  positionId: existingNftId,
  colAmount: MAX_WITHDRAW_AMOUNT,
  debtAmount: MAX_REPAY_AMOUNT,
  connection,
  signer: userPublicKey,
});
```

### Building and Sending Transactions

```typescript
import {
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";

// Build versioned transaction
const latestBlockhash = await connection.getLatestBlockhash();
const message = new TransactionMessage({
  payerKey: signer,
  recentBlockhash: latestBlockhash.blockhash,
  instructions: ixs,
}).compileToV0Message(addressLookupTableAccounts ?? []);

const transaction = new VersionedTransaction(message);
transaction.sign([keypair]);

// Submit via Helius Sender for optimal landing
const SENDER_URL = `https://sender.helius-rpc.com/fast?api-key=${HELIUS_API_KEY}`;
const sendRes = await fetch(SENDER_URL, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    jsonrpc: '2.0',
    id: '1',
    method: 'sendTransaction',
    params: [
      Buffer.from(transaction.serialize()).toString('base64'),
      { encoding: 'base64', skipPreflight: true, maxRetries: 0 },
    ],
  }),
});
```

### Combining Multiple Operations

When merging instructions from multiple `getOperateIx` calls, **deduplicate Address Lookup Tables**:

```typescript
const allAlts = [...alts1, ...alts2];
const seenKeys = new Set<string>();
const mergedAlts = allAlts.filter((alt) => {
  const k = alt.key.toString();
  if (seenKeys.has(k)) return false;
  seenKeys.add(k);
  return true;
});
```

---

## Program IDs (Mainnet)

| Program | Address |
|---|---|
| Liquidity | `jupeiUmn818Jg1ekPURTpr4mFo29p46vygyykFJ3wZC` |
| Earn | `jup3YeL8QhtSx1e253b2FDvsMNC87fDrgQZivbrndc9` |
| Earn Rewards | `jup7TthsMgcR9Y3L277b8Eo9uboVSmu1utkuXHNUKar` |
| Borrow | `jupr81YtYssSyPt8jbnGuiWon5f6x9TcDEFxYe3Bdzi` |
| Oracle | `jupnw4B6Eqs7ft6rxpzYLJZYSnrpRgPcr589n5Kv4oc` |
| Flashloan | `jupgfSgfuAXv4B6R2Uxu85Z1qdzgju79s6MfZekN6XS` |

---

## Common Pitfalls

1. **Don't calculate exact repay amounts** — Always use `MAX_REPAY_AMOUNT` sentinel for full repayment. Dust borrow amounts make exact calculation unreliable.
2. **Don't forget to deduplicate ALTs** — When combining multiple instructions, duplicate ALTs cause transaction failures.
3. **Always use versioned (v0) transactions** — Non-versioned transactions don't support Address Lookup Tables.
4. **Check borrowable limits before prompting users** — Use the read SDK to verify vault capacity.
5. **Use Helius RPC** — The Lend SDKs need an RPC connection. Helius provides reliable, high-performance endpoints.
6. **`getOperateIx` returns `nftId`** — Not `positionId`. Use the returned `nftId` for subsequent operations on the same position.

---

## Resources

- Jupiter Lend Docs: [dev.jup.ag/docs/lend](https://dev.jup.ag/docs/lend)
- Read SDK: [@jup-ag/lend-read](https://www.npmjs.com/package/@jup-ag/lend-read)
- Write SDK: [@jup-ag/lend](https://www.npmjs.com/package/@jup-ag/lend)
- Smart Contracts: [open-clawd.local/Instadapp/fluid-solana-programs](https://open-clawd.local/Instadapp/fluid-solana-programs/)


---

## jupiter-perps-predictions.md

# Jupiter Perpetuals & Prediction Markets

## What This Covers

Jupiter's leveraged trading (Perps) and event-based trading (Prediction Markets). Both are more advanced features with limited API availability.

---

## Perpetuals (On-Chain Only)

Jupiter Perps allows leveraged long/short trading on SOL, ETH, BTC, and other assets. There is **no REST API** currently — all interaction is via on-chain Anchor programs.

### Key Concepts

- **Position Account**: Tracks a user's leveraged position (side, size, collateral, entry price, PnL)
- **PositionRequest Account**: Pending open/close/modify orders
- **Pool Account**: JLP (Jupiter Liquidity Provider) pool configuration and AUM
- **Custody Account**: Per-token state (SOL, ETH, BTC, USDC, USDT)

### Program ID

```
PERPHjGBqRHArX4DySjwM6UJHiR3sWAatqfdBS2qQJu
```

### Reading Position Data

Since there's no REST API, read position data directly from on-chain accounts:

```typescript
// Use Helius getAccountInfo MCP tool to read position accounts
// Or use getProgramAccounts to find all positions for a wallet

// Position accounts are owned by the Jupiter Perps program
// Decode using the Anchor IDL from Jupiter
```

### Helius Synergies

- **getAccountInfo** — Read position account data on-chain
- **getProgramAccounts** — Find all positions for a specific wallet or market
- **WebSockets (accountSubscribe)** — Monitor position changes in real time (liquidation alerts, PnL updates)
- **LaserStream** — Shred-level monitoring for liquidation engines
- **parseTransactions** — Human-readable history of perps trades

### Building a Perps UI

1. Use Helius `getProgramAccounts` to fetch user's positions from the Perps program
2. Decode position data using Jupiter's Anchor IDL
3. Subscribe to position accounts via Helius WebSockets for real-time PnL
4. Submit position open/close transactions via Helius Sender
5. Use `getPriorityFeeEstimate` for optimal fee levels

---

## Prediction Markets (Beta)

Jupiter aggregates prediction markets from Polymarket and Kalshi, allowing users to trade on real-world events.

### Restrictions

- **Geo-restricted**: Blocked in the US and South Korea
- **Beta**: API may change

### Base URL & Auth

```
Base: https://api.jup.ag/prediction/v1
Auth: x-api-key header (required)
```

### Endpoints

#### GET /events — List Events

```typescript
const response = await fetch('https://api.jup.ag/prediction/v1/events', {
  headers: { 'x-api-key': process.env.JUPITER_API_KEY! },
});

const events = await response.json();
// Returns: array of events with markets, categories, status
```

#### GET /markets/{marketId} — Market Details

```typescript
const response = await fetch(
  `https://api.jup.ag/prediction/v1/markets/${marketId}`,
  { headers: { 'x-api-key': process.env.JUPITER_API_KEY! } }
);

const market = await response.json();
// Returns: market details, pricing, YES/NO token mints
```

#### GET /orderbook/{marketId} — Order Book

```typescript
const response = await fetch(
  `https://api.jup.ag/prediction/v1/orderbook/${marketId}`,
  { headers: { 'x-api-key': process.env.JUPITER_API_KEY! } }
);

const orderbook = await response.json();
// Returns: bid/ask depth for the market
```

#### POST /orders — Place Order

```typescript
const response = await fetch('https://api.jup.ag/prediction/v1/orders', {
  method: 'POST',
  headers: {
    'x-api-key': process.env.JUPITER_API_KEY!,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({
    marketId,
    isYes: true, // true for YES, false for NO
    isBuy: true, // true for buy, false for sell
    depositAmount: '1000000', // USDC atomic units
    depositMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC
    ownerPubkey: walletPublicKey,
  }),
});

const order = await response.json();
// Returns: { transaction, ... }
```

#### GET /positions — User Positions

```typescript
const response = await fetch(
  `https://api.jup.ag/prediction/v1/positions?ownerPubkey=${walletPublicKey}`,
  { headers: { 'x-api-key': process.env.JUPITER_API_KEY! } }
);

const positions = await response.json();
// Returns: holdings, P&L, claimable payouts
```

#### POST /positions/{positionPubkey}/claim — Claim Payout

After an event resolves, claim winnings:

```typescript
const response = await fetch(
  `https://api.jup.ag/prediction/v1/positions/${positionPubkey}/claim`,
  {
    method: 'POST',
    headers: {
      'x-api-key': process.env.JUPITER_API_KEY!,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      ownerPubkey: walletPublicKey,
    }),
  }
);

const claim = await response.json();
// Returns: { transaction, ... }
```

### Helius Synergies

- **Helius Sender** — Submit prediction market order transactions for optimal landing
- **parseTransactions** — Human-readable history of prediction market trades
- **WebSockets** — Monitor market account changes for live price updates
- **Wallet API** — Show user's prediction market token holdings alongside other assets

### Building a Prediction Market UI

1. Fetch events and markets from Jupiter Prediction API
2. Display orderbook data for selected markets
3. Check geo-restrictions before allowing trades
4. Submit order transactions via Helius Sender
5. Monitor positions via Helius WebSockets
6. Use `parseTransactions` for trade history

---

## Resources

- Jupiter Perps Docs: [dev.jup.ag/docs/perps](https://dev.jup.ag/docs/perps)
- Jupiter Prediction Markets: [dev.jup.ag/docs/prediction](https://dev.jup.ag/docs/prediction)
- Perps Program: `PERPHjGBqRHArX4DySjwM6UJHiR3sWAatqfdBS2qQJu`


---

## jupiter-plugin.md

# Jupiter Plugin — Drop-in Swap Widget

## What This Covers

Jupiter Plugin — a drop-in swap UI component that can be embedded in any web application. No backend required, powered by Jupiter's Swap API.

---

## Overview

The Jupiter Plugin provides a fully functional swap interface as an embeddable component. It handles:
- Token selection and search
- Quote fetching and display
- Transaction building and signing
- Wallet connection (via passthrough or built-in)

Three display modes:
- **Integrated**: Renders inline within your page layout
- **Widget**: Floating button that opens a swap panel
- **Modal**: Full-screen overlay triggered by your UI

---

## Quick Start (Script Tag)

The simplest integration — add a script tag:

```html
<script src="https://plugin.jup.ag/plugin-v1.js"></script>
<script>
  window.Jupiter.init({
    displayMode: 'widget', // 'integrated' | 'widget' | 'modal'
    integratedTargetId: 'jupiter-plugin', // for 'integrated' mode
    endpoint: 'YOUR_HELIUS_RPC_URL', // Use Helius RPC for reliability
    defaultExplorer: 'Solana Explorer', // Valid: 'Solana Explorer', 'Solscan', 'Solana Beach', 'SolanaFM'
  });
</script>

<!-- For integrated mode -->
<div id="jupiter-plugin" style="width: 400px; height: 600px;"></div>
```

## React Integration

```bash
npm install @jup-ag/plugin
```

```tsx
import '@jup-ag/plugin/css';
import { useEffect } from 'react';

function SwapWidget() {
  useEffect(() => {
    import('@jup-ag/plugin').then(({ init }) => {
      init({
        displayMode: 'integrated',
        integratedTargetId: 'jupiter-plugin',
        endpoint: process.env.NEXT_PUBLIC_HELIUS_RPC_URL!,
        defaultExplorer: 'Solana Explorer',
      });
    });
  }, []);

  return <div id="jupiter-plugin" style={{ width: 400, height: 600 }} />;
}
```

---

## Configuration Options

| Option | Type | Description |
|---|---|---|
| `displayMode` | `'integrated' \| 'widget' \| 'modal'` | How the swap UI is displayed |
| `integratedTargetId` | `string` | DOM element ID for integrated mode (default: `'jupiter-plugin'`) |
| `endpoint` | `string` | Solana RPC URL (**use Helius RPC**) |
| `defaultExplorer` | `string` | Explorer for tx links: `'Solana Explorer'`, `'Solscan'`, `'Solana Beach'`, `'SolanaFM'` |
| `formProps` | `object` | Pre-fill input/output mints, amounts, referral config |
| `enableWalletPassthrough` | `boolean` | Enable wallet passthrough from your app |
| `passthroughWalletContextState` | `WalletContextState` | Your app's wallet state (when passthrough is enabled) |

### Pre-filling Swap Parameters

```typescript
window.Jupiter.init({
  displayMode: 'modal',
  endpoint: HELIUS_RPC_URL,
  formProps: {
    initialInputMint: 'So11111111111111111111111111111111111111112', // SOL
    initialOutputMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC
    initialAmount: '1000000000', // 1 SOL
  },
});
```

### Wallet Passthrough

If your app already has a connected wallet, pass it through:

```typescript
import { useWallet } from '@solana/wallet-adapter-react';

const wallet = useWallet();

window.Jupiter.init({
  displayMode: 'integrated',
  endpoint: HELIUS_RPC_URL,
  enableWalletPassthrough: true,
  passthroughWalletContextState: wallet,
});
```

---

## Helius Synergies

### RPC Endpoint

**Always use a Helius RPC URL** as the `endpoint` parameter. This ensures:
- Reliable, high-performance RPC access
- Proper rate limits based on the user's Helius plan
- Better transaction landing rates

```typescript
const HELIUS_RPC = `https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`;

window.Jupiter.init({
  endpoint: HELIUS_RPC,
  // ...
});
```

### Portfolio Context

Combine the swap widget with Helius DAS to show the user's portfolio alongside the swap:

```typescript
// 1. Fetch holdings via Helius getAssetsByOwner (showFungible: true)
// 2. Display portfolio in your app
// 3. Let users click a token to pre-fill the swap widget
window.Jupiter.init({
  formProps: {
    initialInputMint: selectedToken.mint,
    initialAmount: selectedToken.rawAmount,
  },
});
```

### Transaction Monitoring

After swaps complete through the plugin, use Helius to provide rich transaction details:

```typescript
// Listen for swap completion events from the plugin
// Use parseTransactions MCP tool to show human-readable swap details
// Use Wallet API to update portfolio view
```

---

## Referral Fees

Earn fees on swaps through the plugin using Jupiter's Referral Program:

```typescript
window.Jupiter.init({
  formProps: {
    referralAccount: 'YOUR_REFERRAL_ACCOUNT_ADDRESS',
    referralFee: 50, // 0.5% (range: 50-255 bps)
  },
});
```

---

## Theming

Customize the plugin appearance using CSS variables:

```css
:root {
  --jupiter-plugin-primary: #6366f1;
  --jupiter-plugin-bg: #1a1a2e;
  /* See Jupiter Plugin docs for all available CSS variables */
}
```

---

## Common Pitfalls

1. **Always provide an RPC endpoint** — Without one, the plugin uses public RPCs which are unreliable. Use Helius RPC.
2. **Use wallet passthrough** if your app already handles wallet connection — avoids double-connect UX. Use `enableWalletPassthrough: true` + `passthroughWalletContextState`.
3. **Valid explorers**: `'Solana Explorer'`, `'Solscan'`, `'Solana Beach'`, `'SolanaFM'`. Do NOT use `'Orb'` — it's not supported by the Plugin.
4. **The plugin is client-side only** — It runs in the browser, not in Node.js.
5. **Use `init()` not JSX** — There is no `<JupiterTerminal>` React component. Use the `init()` function from `@jup-ag/plugin`.

---

## Resources

- Jupiter Plugin Docs: [dev.jup.ag/docs/plugin](https://dev.jup.ag/docs/plugin)
- Jupiter Plugin npm: [@jup-ag/plugin](https://www.npmjs.com/package/@jup-ag/plugin)


---

## jupiter-portal.md

# Jupiter Portal — API Keys & Rate Limits

## What This Covers

Jupiter API key setup, authentication requirements, and rate limiting behavior for all Jupiter REST endpoints.

---

## Getting an API Key

All Jupiter REST endpoints require authentication via the `x-api-key` header.

1. Go to [developers.jup.ag/portal](https://developers.jup.ag/portal)
2. Sign in with your email
3. Generate an API key
4. Store it securely — never commit to git

### Using the API Key

```typescript
const headers = {
  'x-api-key': process.env.JUPITER_API_KEY!,
  'Content-Type': 'application/json',
};

const response = await fetch('https://api.jup.ag/swap/v2/order?inputMint=...&outputMint=...&amount=...&taker=...', {
  headers,
});
```

### Environment Variable Setup

```bash
export JUPITER_API_KEY=your-api-key-here
```

---

## Base URL

All Jupiter API endpoints use:

```
https://api.jup.ag
```

---

## Rate Limits

### Swap API — Dynamic Rate Limits

Swap API rate limits scale dynamically based on your 24-hour execute volume:

| 24h Execute Volume | Rate Limit |
|---|---|
| $0 | 50 req/10s |
| $10,000 | 51 req/10s |
| $100,000 | 61 req/10s |
| $1,000,000 | 165 req/10s |

Rate limits increase as you drive more volume through the API.

### Other APIs

Most other Jupiter APIs use standard rate limits. Check the specific API documentation for exact limits.

### Handling Rate Limits (HTTP 429)

When you receive a 429 response, implement exponential backoff with jitter:

```typescript
async function fetchWithRetry(
  url: string,
  options: RequestInit,
  maxRetries = 3
): Promise<Response> {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const response = await fetch(url, options);

    if (response.status === 429 && attempt < maxRetries) {
      const baseDelay = Math.pow(2, attempt) * 1000;
      const jitter = Math.random() * 1000;
      await new Promise(r => setTimeout(r, baseDelay + jitter));
      continue;
    }

    return response;
  }
  throw new Error('Max retries exceeded');
}
```

---

## Authentication Invariant

**Hard rule**: Never call a Jupiter REST endpoint without the `x-api-key` header. If the user hasn't configured a key, stop and ask them to set one up at [developers.jup.ag/portal](https://developers.jup.ag/portal) before proceeding.

---

## API Families

Jupiter provides these API families, all under `https://api.jup.ag`:

| API | Path Prefix | Purpose |
|---|---|---|
| Swap API V2 | `/swap/v2` | Token swaps with optimized routing |
| Trigger V2 | `/trigger/v2` | Limit orders (JWT auth, vault deposits, OCO/OTOCO) |
| Recurring | `/recurring/v1` | DCA orders |
| Tokens | `/tokens/v2` | Token search and metadata |
| Price | `/price/v3` | Token prices |
| Portfolio | `/portfolio/v1` | Position tracking (beta) |
| Prediction Markets | `/prediction/v1` | Event markets (beta, geo-restricted) |
| Send | `/send/v1` | Token transfers (beta) |
| Studio | `/studio/v1` | Token creation (beta) |
| Lend (REST) | `/lend/v1` | Lending operations |

### Beta APIs

Portfolio, Prediction Markets, Send, and Studio are currently in beta. Their interfaces may change.

### On-Chain Only

- **Perps**: No REST API yet — on-chain Anchor IDL only
- **Lock**: On-chain vesting program (audited by OtterSec and Sec3)

---

## Resources

- Jupiter Portal: [developers.jup.ag/portal](https://developers.jup.ag/portal)
- Jupiter Docs: [dev.jup.ag](https://dev.jup.ag/)
- LLM-Optimized Docs: [dev.jup.ag/docs/llms.txt](https://dev.jup.ag/docs/llms.txt)


---

## jupiter-recurring.md

# Jupiter Recurring API — Dollar-Cost Averaging (DCA)

## What This Covers

Recurring token purchases via Jupiter's Recurring API — setting up DCA orders, viewing active orders, and canceling orders.

---

## Base URL & Auth

```
Base: https://api.jup.ag/recurring/v1
Auth: x-api-key header (required)
```

---

## How DCA Works

Jupiter Recurring creates on-chain DCA orders that automatically execute at regular intervals. Jupiter's keeper network handles the periodic execution.

### Fees

- **0.1% execution fee** per individual order execution
- Fees are deducted from the output amount at each execution

### Minimums

- **Minimum total order value**: $100 USD equivalent
- **Minimum per-order value**: $50 USD equivalent
- **Minimum number of orders**: 2
- Orders that violate any of these minimums will be rejected

### Limitations

- **Token-2022 not supported** — Only standard SPL tokens are compatible with the Recurring API. Token-2022 mints will be rejected.
- **Price-based orders are deprecated** — The `params.price` field and `/priceDeposit` / `/priceWithdraw` endpoints are deprecated and no longer actively supported. Use time-based orders only.

---

## Endpoints

### POST /createOrder — Create DCA Order

```typescript
const response = await fetch('https://api.jup.ag/recurring/v1/createOrder', {
  method: 'POST',
  headers: {
    'x-api-key': process.env.JUPITER_API_KEY!,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({
    user: walletPublicKey,
    inputMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC
    outputMint: 'So11111111111111111111111111111111111111112', // SOL
    params: {
      time: {
        inAmount: '50000000', // 50 USDC per execution (atomic units)
        numberOfOrders: 10, // 10 executions total
        interval: 604800, // Interval in seconds: 86400=daily, 604800=weekly
        // Optional:
        // startAt: 1700000000, // Unix timestamp for first execution
        // minPrice: '100', // Min acceptable price
        // maxPrice: '200', // Max acceptable price
      },
    },
  }),
});

const result = await response.json();
// Returns: { requestId, transaction }
```

**Parameters**:
- `user` — Wallet public key
- `inputMint` — Token you're spending (e.g., USDC)
- `outputMint` — Token you're buying (e.g., SOL)
- `params.time.inAmount` — Amount per execution in atomic units
- `params.time.numberOfOrders` — Number of individual executions
- `params.time.interval` — Interval between executions in **seconds** (86400 = daily, 604800 = weekly, 2592000 = ~monthly)
- `params.time.startAt` — (Optional) Unix timestamp for first execution
- `params.time.minPrice` — (Optional) Minimum price threshold — skip execution if price is below
- `params.time.maxPrice` — (Optional) Maximum price threshold — skip execution if price is above

### Calculating Total Spend

```typescript
const perExecution = 50_000_000; // 50 USDC
const numberOfOrders = 10;
const totalSpend = perExecution * numberOfOrders; // 500 USDC total
// Total must be >= $100 USD equivalent
```

### GET /getRecurringOrders — List Active DCA Orders

```typescript
const response = await fetch(
  `https://api.jup.ag/recurring/v1/getRecurringOrders?user=${walletPublicKey}&orderStatus=active&recurringType=time`,
  { headers: { 'x-api-key': process.env.JUPITER_API_KEY! } }
);

const orders = await response.json();
// Returns array of active DCA orders with progress, next execution time, etc.
```

**Parameters**:
- `user` — Wallet public key
- `orderStatus` — Required: `active` or `history`
- `recurringType` — Required: `time`

### POST /cancelOrder — Cancel DCA Order

```typescript
const response = await fetch('https://api.jup.ag/recurring/v1/cancelOrder', {
  method: 'POST',
  headers: {
    'x-api-key': process.env.JUPITER_API_KEY!,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({
    user: walletPublicKey,
    order: orderAddressToCancel,
    recurringType: 'time',
  }),
});

const cancelResult = await response.json();
// Returns: { requestId, transaction }
```

Canceling a DCA order returns any unspent input tokens to the user's wallet.

### POST /execute — Submit Signed Transaction

After signing a transaction from `/createOrder` or `/cancelOrder`, submit it back to Jupiter:

```typescript
const executeResponse = await fetch('https://api.jup.ag/recurring/v1/execute', {
  method: 'POST',
  headers: {
    'x-api-key': process.env.JUPITER_API_KEY!,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({
    signedTransaction: base64SignedTx,
    requestId: result.requestId,
  }),
});
```

---

## Transaction Flow

All Recurring API responses that modify state return `transaction` and `requestId`. Sign the transaction and submit via `/execute` or Helius Sender. See `references/jupiter-trigger.md` for the full signing/submission pattern.

---

## Common Pitfalls

1. **Minimum $100 total** — Total spend (`inAmount * numberOfOrders`) must be >= $100 USD equivalent
2. **Minimum $50 per order** — Each individual `inAmount` must be >= $50 USD equivalent
3. **Minimum 2 orders** — `numberOfOrders` must be >= 2
4. **Token-2022 not supported** — Only standard SPL tokens work; Token-2022 mints are rejected
5. **Amounts are in atomic units** — 500 USDC = 500_000_000
6. **Interval is in seconds** — Not a string like `'weekly'`. Use 86400 for daily, 604800 for weekly.
7. **Unspent funds returned on cancel** — Remaining input tokens go back to the wallet
8. **Each execution is a separate swap** — Price varies per execution (that's the point of DCA)
9. **Frequency determines the schedule** — The keeper network handles timing; you don't need to trigger executions manually
10. **Use `user` not `maker`** — The field is `user` for all Recurring endpoints
11. **Price-based orders are deprecated** — Use time-based orders (`params.time`) only

---

## Resources

- Recurring API Docs: [dev.jup.ag/docs/recurring](https://dev.jup.ag/docs/recurring)


---

## jupiter-swap.md

# Jupiter Swap API V2

## What This Covers

Token swaps via Jupiter's Swap API V2 — getting quotes, executing swaps, building custom transactions, handling idempotency, and production hardening. V2 provides optimized routing across all Solana DEXes through multi-router competition.

---

## Base URL & Auth

```
Base: https://api.jup.ag/swap/v2
Auth: x-api-key header (required)
```

Rate limits are dynamic — see `references/jupiter-portal.md` for details.

---

## Two Paths

Jupiter V2 offers two integration paths:

| Feature | `/order` + `/execute` | `/build` |
|---------|----------------------|----------|
| Routing | All routers (Metis, JupiterZ RFQ, DFlow, OKX) | Metis only |
| Swap fees | Jupiter platform fee included | None |
| Execution | Managed via `/execute` (Jupiter Beam) | Self-managed (your own RPC) |
| Transaction control | None (pre-built) | Full (raw instructions) |
| Compute budget | Included in transaction | Instructions provided (overridable) |
| Jito tip inclusion | Handled internally by Jupiter Beam (no tip ix in the returned transaction; landing is Jupiter's responsibility) | Not included — you add a `SystemProgram.transfer` to a Jito tip account when submitting via Helius Sender |

**Use `/order` + `/execute`** for most integrations (recommended). **Use `/build`** only when you need custom instructions, CPI, or full transaction control.

> **Using Helius Sender?** Sender's dual-routing (Jito) requires a tip transfer **inside** the transaction. `/order`'s pre-built transaction does not include one, so signing and forwarding it to Sender will fail to land via Jito. Use `/build` and assemble the transaction yourself — see `references/integration-patterns.md` Pattern 1 for the full recipe and `references/helius-sender.md` for tip accounts and minimum amounts.

---

## Path 1: Order & Execute (Recommended)

### GET /order — Get Quote + Transaction

Returns a swap quote with a pre-built transaction. Omit `taker` to get a quote-only response — `transaction` will be null but `requestId` and the rest of the quote data are still returned.

```typescript
const params = new URLSearchParams({
  inputMint: 'So11111111111111111111111111111111111111112', // SOL
  outputMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC
  amount: '1000000000', // 1 SOL in lamports
  taker: walletPublicKey, // Optional — omit for quote-only
});

const response = await fetch(`https://api.jup.ag/swap/v2/order?${params}`, {
  headers: { 'x-api-key': process.env.JUPITER_API_KEY! },
});

const order = await response.json();
// Returns: { transaction, requestId, inputMint, outputMint, inAmount, outAmount, router, mode, feeBps, feeMint }
// If taker is omitted (quote-only): `transaction` is null, but `requestId` and the rest of the quote data are still returned
```

**Required parameters**:
- `inputMint` — Source token mint address
- `outputMint` — Destination token mint address
- `amount` — Amount in atomic units (lamports for SOL, raw units for SPL tokens)
- `taker` — Wallet public key that will sign (required for transaction, omit for quote-only)

**Optional parameters**:
- `slippageBps` — Slippage tolerance in basis points (default: auto via RTSE)
- `receiver` — Destination wallet for output tokens (defaults to `taker`)
- `referralAccount` — Referral account for integrator fees
- `referralFee` — Referral fee in basis points (50-255 bps)
- `excludeRouters` — Comma-separated routers to exclude: `iris`, `jupiterz`, `dflow`, `okx`
- `excludeDexes` — Comma-separated DEXes to exclude from routing

**Response fields**:
- `transaction` — Base64-encoded transaction (null when `taker` is omitted)
- `requestId` — Returned on every response (including quote-only); required for `/execute` and idempotent retries
- `outAmount` — Expected output before slippage
- `router` — Winning router (`iris`, `jupiterz`, `dflow`, `okx`)
- `mode` — `ultra` (default params, all routers) or `manual` (optional params detected, routing restricted)
- `feeBps` — Fee basis points applied
- `feeMint` — Token used for fee

### POST /execute — Execute Swap

Submit the signed transaction for managed execution.

```typescript
// 1. Deserialize and sign
const txBuffer = Buffer.from(order.transaction, 'base64');
const transaction = VersionedTransaction.deserialize(txBuffer);
transaction.sign([keypair]);

// 2. Execute via Jupiter
const signedTx = Buffer.from(transaction.serialize()).toString('base64');
const execRes = await fetch('https://api.jup.ag/swap/v2/execute', {
  method: 'POST',
  headers: {
    'x-api-key': process.env.JUPITER_API_KEY!,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({
    signedTransaction: signedTx,
    requestId: order.requestId,
  }),
});

const result = await execRes.json();
// Success: { status: "Success", signature, inputAmountResult, outputAmountResult, swapEvents }
// Failure: { status: "Failed", code, error }
```

**CRITICAL**: Always include `requestId` from the `/order` response. This enables idempotent retries — if the request fails mid-flight, re-call `POST /execute` with the same `requestId` and `signedTransaction` to check status.

**Jupiter execution features**:
- RTSE (Real-Time Slippage Estimator) — adjusts slippage at execution time
- Optimized priority fee strategy for current network conditions
- Jupiter Beam — proprietary transaction execution pipeline across multiple RPC providers
- Confirmation polling and transaction parsing

### Using Jupiter Quote + Helius Sender (Alternative)

For more control over transaction submission, you can use Jupiter for the quote/transaction and Helius Sender for submission. See `references/integration-patterns.md` Pattern 1.

---

## Path 2: Build Custom Transactions (Advanced)

### GET /build — Get Instructions

Returns raw swap instructions for custom transaction assembly.

```typescript
const params = new URLSearchParams({
  inputMint: 'So11111111111111111111111111111111111111112',
  outputMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  amount: '1000000000',
  taker: walletPublicKey,
});

const response = await fetch(`https://api.jup.ag/swap/v2/build?${params}`, {
  headers: { 'x-api-key': process.env.JUPITER_API_KEY! },
});

const buildResult = await response.json();
```

**Response fields**:
- `computeBudgetInstructions` — Compute unit price instruction (no limit — you must simulate)
- `setupInstructions` — Pre-swap setup (ATA creation, etc.)
- `swapInstruction` — Main swap instruction
- `cleanupInstruction` — Post-swap cleanup (nullable)
- `otherInstructions` — Additional instructions
- `addressesByLookupTableAddress` — V0 transaction lookup tables
- `blockhashWithMetadata` — Blockhash and expiry height

**Build flow**:
1. Call `/build` with required params
2. Add your custom instructions alongside swap instructions
3. Simulate with max CU limit (1,400,000) to estimate actual usage
4. Build V0 transaction with estimated CU limit (1.2x simulated, capped at 1,400,000)
5. If submitting via Helius Sender, append a `SystemProgram.transfer` to a random Jito tip account (see `references/integration-patterns.md` Pattern 1)
6. Sign and send via your own RPC (or Helius Sender)

**Optional parameters**:
- `slippageBps` — Slippage tolerance (default: 50 bps)
- `mode` — `"fast"` for reduced latency routing
- `maxAccounts` — Max accounts for swap route (1-64, default 64)
- `platformFeeBps` — Integrator platform fee in bps
- `feeAccount` — Token account for platform fees (required if `platformFeeBps` > 0)
- `wrapAndUnwrapSol` — Auto wrap/unwrap SOL (default: true)
- `dexes` / `excludeDexes` — Include/exclude specific DEXes
- `blockhashSlotsToExpiry` — Slots until blockhash expires (1-300, default 150)

**Note**: `/build` only supports ExactIn mode. You are responsible for sending the transaction via your own RPC and handling confirmation. Jupiter does not charge swap fees on `/build`.

---

## Routing

Four routers compete for best pricing on `/order`:

- **Metis** — Jupiter's on-chain aggregator (core routing engine)
- **JupiterZ** — RFQ market makers (off-chain liquidity, often beats on-chain by 5-20 bps on major pairs)
- **DFlow** — Third-party order flow
- **OKX** — Third-party liquidity provider

**Parameter impact on routing**:
- `receiver`, `referralAccount`, `referralFee` — disables JupiterZ only (Metis, DFlow, OKX still compete)
- `payer` — disables JupiterZ, DFlow, AND OKX (reduces to **Metis only**)

Check the `mode` field in the response (`ultra` = all routers, `manual` = restricted).

---

## Fees

### `/order` Platform Fees

| Token Pair | Fee |
|------------|-----|
| Jupiter tokens (SOL/Stable → JUP/JLP/jupSOL) | 0 bps |
| Pegged assets (LST-LST, Stable-Stable) | 0 bps |
| SOL-Stable | 2 bps |
| LST-Stable | 5 bps |
| Most other pairs | 10 bps |
| New tokens (within 24 hours) | 50 bps |

### Integrator Fees (Referral Program)

Use `referralAccount` and `referralFee` parameters on `/order`:
- `referralFee` range: 50-255 basis points
- Jupiter retains 20% of referral fees; you receive 80%
- **Adding `referralAccount` disables RFQ (JupiterZ) routing**

### `/build` Fees

No Jupiter platform fee. Implement custom fees via `platformFeeBps` and `feeAccount`.

---

## Gasless Swaps

### Automatic Gasless (`/order`)

Jupiter automatically covers all gas when the taker has insufficient SOL:
- Requires < 0.01 SOL in taker wallet
- Minimum trade: ~$10 USD equivalent
- Default `/order` parameters only (no integrator/manual mode params)
- Increases swap fee to compensate (reduces output tokens)

### JupiterZ Gasless

When RFQ market makers win the quote, they cover network and priority fees — but not ATA rent. Taker must have SOL for account creation.

### Integrator Payer

Pass `payer` parameter on `/order` or `/build` to subsidize all gas costs. Routes through Metis only.

---

## Slippage

- Default: auto-calculated by Jupiter's RTSE (Real-Time Slippage Estimator)
- Custom: pass `slippageBps` parameter (e.g., `50` = 0.5%)
- Recommended: use auto unless the user has a specific requirement
- Note: `slippageBps` is incompatible with automatic gasless swaps

---

## Common Mints

| Token | Mint Address |
|---|---|
| SOL | `So11111111111111111111111111111111111111112` |
| USDC | `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v` |
| USDT | `Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB` |

For other tokens, use the Jupiter Tokens API (`references/jupiter-tokens-price.md`) to look up mint addresses.

---

## Error Codes

### `/execute` Error Codes

| Code | Category | Meaning |
|------|----------|---------|
| 0 | Success | Transaction confirmed |
| -1 | Execute | Missing cached order (requestId not found or expired) |
| -2 | Execute | Invalid signed transaction |
| -3 | Execute | Invalid message bytes |
| -1000 | Aggregator | Failed to land |
| -1001 | Aggregator | Unknown error |
| -1002 | Aggregator | Invalid transaction |
| -1003 | Aggregator | Transaction not fully signed |
| -1004 | Aggregator | Invalid block height |
| -2000 | RFQ | Failed to land |
| -2001 | RFQ | Unknown error |
| -2002 | RFQ | Invalid payload |
| -2003 | RFQ | Quote expired |
| -2004 | RFQ | Swap rejected |

Negative codes = Jupiter-internal (routing, slippage, etc.) — typically transient, retry with fresh quote. Positive codes = on-chain program errors.

### Timeout Handling

- Set 5-second timeout for `/order` (quote) requests
- Set 30-second timeout for `/execute` requests
- If `/execute` times out, re-call with the same `requestId` and `signedTransaction` to check status — do NOT get a new quote without checking first

---

## Production Checklist

1. Always include `x-api-key` header
2. Always use `requestId` for idempotent retries
3. Set appropriate timeouts (5s quotes, 30s executions)
4. Implement exponential backoff for 429 responses
5. Validate mint addresses before calling the API
6. Enforce slippage guardrails for user protection
7. On timeout, re-call `/execute` with same requestId to check status
8. Check `mode` field to verify expected routing behavior
9. Log all API interactions with latency metrics

---

## Migration from Ultra / Metis

- **From Ultra**: Update base URL from `https://ultra-api.jup.ag` to `https://api.jup.ag/swap/v2`. Request params and response format are identical.
- **From Metis**: Consolidates `/quote` + `/swap-instructions` into single `/build` endpoint. `userPublicKey` becomes `taker`. Route plan uses `bps` instead of `percent` (10000 bps = 100%).

---

## Resources

- Swap API V2 Docs: [dev.jup.ag/docs/swap](https://dev.jup.ag/docs/swap)
- Jupiter Portal (API keys): [developers.jup.ag/portal](https://developers.jup.ag/portal)


---

## jupiter-tokens-price.md

# Jupiter Tokens & Price APIs

## What This Covers

Token discovery, metadata, and pricing via Jupiter's Tokens and Price APIs — searching for tokens, verifying legitimacy, and getting real-time prices.

---

## Tokens API (v2)

### Base URL & Auth

```
Base: https://api.jup.ag/tokens/v2
Auth: x-api-key header (required)
```

### GET /search — Search Tokens

Search for tokens by name, symbol, or mint address:

```typescript
const response = await fetch(
  `https://api.jup.ag/tokens/v2/search?query=bonk`,
  { headers: { 'x-api-key': process.env.JUPITER_API_KEY! } }
);

const tokens = await response.json();
// Returns array of matching tokens with metadata
```

Each token result includes:
- `id` — Mint address
- `name` — Token name
- `symbol` — Token symbol
- `decimals` — Decimal places
- `icon` — Token logo URL
- `isVerified` — Whether the token is verified
- `organicScore` — Trading activity and community validation score
- `mcap` — Market capitalization
- `usdPrice` — Current USD price
- `liquidity` — Available liquidity

### Looking Up Tokens by Mint

To look up specific tokens, use search with comma-separated mint addresses (up to 100):

```typescript
const mints = 'So11111111111111111111111111111111111111112,EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const response = await fetch(
  `https://api.jup.ag/tokens/v2/search?query=${mints}`,
  { headers: { 'x-api-key': process.env.JUPITER_API_KEY! } }
);
```

### Token Verification & Organic Score

Jupiter assigns tokens an **organic score** based on trading activity and community validation. Use this to filter out low-quality or potentially malicious tokens:

```typescript
// Filter for verified tokens only
const verifiedTokens = tokens.filter(t => t.isVerified);
```

**Best practice**: Always verify tokens before displaying them in a UI. Show verification status to users.

---

## Price API (v3)

### Base URL & Auth

```
Base: https://api.jup.ag/price/v3
Auth: x-api-key header (required)
```

### GET /price — Get Token Prices

```typescript
const mints = [
  'So11111111111111111111111111111111111111112', // SOL
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC
].join(',');

const response = await fetch(
  `https://api.jup.ag/price/v3?ids=${mints}`,
  { headers: { 'x-api-key': process.env.JUPITER_API_KEY! } }
);

const prices = await response.json();
// Returns mint addresses at the TOP LEVEL (no `data` wrapper):
// {
//   "So11111111111111111111111111111111111111112": {
//     "usdPrice": 82.04,
//     "blockId": 412733640,
//     "decimals": 9,
//     "priceChange24h": -2.61
//   },
//   ...
// }
```

**Constraints**:
- Maximum **50 mint IDs** per request
- Prices are in USD

### Response Fields

Mints are keyed at the top level — there is NO `data` wrapper and NO `id` field on each entry.

```typescript
const solPrice = prices['So11111111111111111111111111111111111111112'];
console.log(`SOL: $${solPrice.usdPrice}`);
console.log(`24h change: ${solPrice.priceChange24h}%`);
console.log(`Block: ${solPrice.blockId}`);
console.log(`Decimals: ${solPrice.decimals}`);
```

---

## Token Shield — Security Checks

Jupiter provides a security check endpoint to detect potentially dangerous tokens.

### GET /swap/v2/shield — Check Token Safety

```typescript
const response = await fetch(
  `https://api.jup.ag/swap/v2/shield?mints=${mintAddress}`,
  { headers: { 'x-api-key': process.env.JUPITER_API_KEY! } }
);

const shield = await response.json();
// Returns warnings about: freeze authority, mint authority, low organic activity, etc.
```

The `mints` parameter accepts comma-separated mint addresses (up to 100).

### Helius Synergy

Combine Token Shield with Helius DAS for comprehensive token safety:

```typescript
// 1. Jupiter Token Shield — check for freeze/mint authority risks
const shieldData = await checkTokenShield(mintAddress);

// 2. Helius DAS — check token metadata, supply, and holder distribution
// Use getAsset MCP tool for metadata
// Use getTokenHolders MCP tool for holder concentration
// High holder concentration + freeze authority = high risk
```

**Best practice**: Always run Token Shield before displaying unknown tokens in a swap UI. Show warnings to users.

---

## Building a Token Selector

Combine Jupiter Tokens API with Helius DAS for a complete token selector:

```typescript
// 1. Get user's token holdings via Helius
// Use getAssetsByOwner MCP tool with showFungible: true

// 2. Enrich with Jupiter metadata
// For each holding, fetch token info from Jupiter Tokens API v2

// 3. Get live prices
// Batch mint addresses into Price API v3 calls (max 50 per request)

// 4. Display with verification status
// Show verified badge, price, and balance
```

See `references/integration-patterns.md` Pattern 2 for the complete implementation.

---

## Common Pitfalls

1. **Max 50 mints per price request** — Batch larger lists into multiple calls
2. **Max 100 mints per Token Shield / token lookup** — Use comma-separated values
3. **Verify tokens before displaying** — Check `isVerified` and `organicScore` to filter scam tokens
4. **Prices are in USD** — The field is `usdPrice`, not `price`
5. **Price API v3 has no `data` wrapper** — Access prices as `response[mint]`, NOT `response.data[mint]`. There is also no `id` field per entry. Using `response.data[mint]` will silently return `undefined`.
5. **Use Helius DAS for ownership data** — Jupiter Tokens API provides metadata, not wallet-specific data
6. **Tokens API is v2, Price API is v3** — Don't use the old v1/v2 endpoints

---

## Resources

- Tokens API Docs: [dev.jup.ag/docs/tokens](https://dev.jup.ag/docs/tokens)
- Price API Docs: [dev.jup.ag/docs/price](https://dev.jup.ag/docs/price)


---

## jupiter-trigger.md

# Jupiter Trigger API V2 — Limit Orders

## What This Covers

Limit orders via Jupiter's Trigger API V2 — placing price-triggered orders (single, OCO, OTOCO), managing vault deposits, viewing order history, canceling orders, and updating order parameters. V2 uses JWT authentication, vault-based deposits, and USD price triggers.

---

## Base URL & Auth

```
Base: https://api.jup.ag/trigger/v2
Auth: x-api-key header (required) + JWT Bearer token (required for most endpoints)
Status: Beta, under active development
```

> **Trigger V2 is in active beta.** Endpoints, response shapes, and onboarding flows shift without notice. Verify against [dev.jup.ag/docs/trigger](https://dev.jup.ag/docs/trigger) before relying on this reference.

---

## Authentication (JWT Challenge-Response)

Before placing or managing orders, authenticate via a two-step challenge-response flow to obtain a JWT.

### Step 1: Request Challenge

```typescript
const challengeRes = await fetch('https://api.jup.ag/trigger/v2/auth/challenge', {
  method: 'POST',
  headers: {
    'x-api-key': process.env.JUPITER_API_KEY!,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({
    walletPubkey: walletPublicKey,
    type: 'message', // 'message' for software wallets, 'transaction' for hardware wallets
  }),
});

const challenge = await challengeRes.json();
// message type: { type: "message", challenge: "Sign this message to authenticate..." }
// transaction type: { type: "transaction", transaction: "<base64 tx with memo>" }
```

Challenge TTL: **5 minutes**. Request a new one if it expires.

### Step 2: Sign & Verify

```typescript
// Sign the challenge message with the wallet
const signature = await wallet.signMessage(new TextEncoder().encode(challenge.challenge));

const verifyRes = await fetch('https://api.jup.ag/trigger/v2/auth/verify', {
  method: 'POST',
  headers: {
    'x-api-key': process.env.JUPITER_API_KEY!,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({
    type: 'message',
    walletPubkey: walletPublicKey,
    signature: bs58.encode(signature), // base58-encoded signature
  }),
});

const { token } = await verifyRes.json();
// token: JWT valid for 24 hours
```

JWT TTL: **24 hours**. No refresh endpoint — re-authenticate when expired.

**Security**: A leaked JWT allows order cancellation and parameter edits, but **not** fund withdrawal — all fund operations require wallet-signed transactions.

---

## Vault Management

Each wallet gets **one vault** (Privy-managed custodial account). Deposits go from wallet into vault, which backs all orders.

```typescript
const headers = {
  'x-api-key': process.env.JUPITER_API_KEY!,
  'Authorization': `Bearer ${jwtToken}`,
};

// Check if a vault exists for this wallet
const vaultRes = await fetch('https://api.jup.ag/trigger/v2/vault', { headers });
// Returns: { userPubkey, vaultPubkey, privyVaultId, privyUserId? }
// Returns 404 if no vault exists (user has not completed onboarding)
```

### Vault Onboarding

Programmatic vault registration via the public API is **not currently available**. Jupiter's `POST /trigger/v2/vault/register` route returns a router-level plain-text `404 Not Found` in production, even with a valid JWT and `x-api-key`. Vault provisioning happens through Privy onboarding inside the **jup.ag web UI**.

If `GET /trigger/v2/vault` returns `404`, surface a clear message to the user instructing them to visit [jup.ag](https://jup.ag) and complete the Trigger onboarding flow once. Subsequent `GET /vault` calls (and `POST /deposit/craft`, `POST /orders/price`, etc.) will succeed against the provisioned vault. There is no need to repeat the web flow per session — vaults are permanent per wallet.

For headless agents that cannot route a user through the web UI, contact Jupiter support — there is no documented programmatic onboarding path at present.

> **Error shapes.** Trigger V2 app-level errors return JSON like `{"error":"..."}`. A plain-text `404 Not Found` response body means the route is not registered server-side — re-check [dev.jup.ag/docs/trigger](https://dev.jup.ag/docs/trigger) rather than assuming a parameter, header, or auth issue. This distinction saves a debugging round-trip on a beta API.

---

## How Trigger V2 Orders Work

Jupiter Trigger V2 creates off-chain limit orders that execute automatically when the target **USD price** is reached. Orders are stored off-chain (MEV-resistant) and executed by Jupiter's keeper network.

### Order Types

- **Single** — Triggers when USD price crosses above or below a threshold. Standard limit orders and stop-losses.
- **OCO (One-Cancels-Other)** — Two orders sharing one deposit: one take-profit, one stop-loss. When one fills, the other cancels automatically.
- **OTOCO (One-Triggers-One-Cancels-Other)** — A parent order triggers first, then activates a TP/SL pair (OCO) on the output tokens.

### Fees

- **Non-stable pairs**: 0.1% execution fee
- **Stable pairs** (e.g., USDC/USDT): 0.03% execution fee

Fees are deducted from the output amount at execution time.

### Minimums

- **Minimum order value**: $10 USD equivalent

---

## Order Creation (3-Step Process)

### Step 1: Craft Deposit Transaction

```typescript
const depositRes = await fetch('https://api.jup.ag/trigger/v2/deposit/craft', {
  method: 'POST',
  headers: {
    'x-api-key': process.env.JUPITER_API_KEY!,
    'Authorization': `Bearer ${jwtToken}`,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({
    inputMint: 'So11111111111111111111111111111111111111112', // SOL
    outputMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC
    userAddress: walletPublicKey,
    amount: '1000000000', // 1 SOL in lamports
  }),
});

const deposit = await depositRes.json();
// Returns: { transaction, requestId, receiverAddress, mint, amount, tokenDecimals }
```

### Step 2: Sign the Deposit Transaction

```typescript
import { VersionedTransaction } from '@solana/web3.js';

const transaction = VersionedTransaction.deserialize(
  Buffer.from(deposit.transaction, 'base64')
);
transaction.sign([keypair]);
const depositSignedTx = Buffer.from(transaction.serialize()).toString('base64');
```

### Step 3: Create Order with Signed Deposit

```typescript
// Single limit order example: sell 1 SOL when price hits $200
const orderRes = await fetch('https://api.jup.ag/trigger/v2/orders/price', {
  method: 'POST',
  headers: {
    'x-api-key': process.env.JUPITER_API_KEY!,
    'Authorization': `Bearer ${jwtToken}`,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({
    orderType: 'single',
    depositRequestId: deposit.requestId,
    depositSignedTx: depositSignedTx,
    userPubkey: walletPublicKey,
    inputMint: 'So11111111111111111111111111111111111111112',
    inputAmount: '1000000000',
    outputMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    triggerMint: 'So11111111111111111111111111111111111111112', // Monitor SOL price
    triggerCondition: 'above', // Trigger when price goes above target
    triggerPriceUsd: 200, // $200 USD
    expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000, // 7 days (milliseconds)
    // Optional:
    // slippageBps: 50,
  }),
});

const order = await orderRes.json();
// Returns: { id, txSignature }
```

### Common Required Fields (All Order Types)

| Field | Type | Description |
|---|---|---|
| `orderType` | `"single"` / `"oco"` / `"otoco"` | Order type |
| `depositRequestId` | string | From `/deposit/craft` response |
| `depositSignedTx` | string | Base64-encoded signed deposit transaction |
| `userPubkey` | string | Wallet public key |
| `inputMint` | string | Token being sold |
| `inputAmount` | string | Amount in atomic units |
| `outputMint` | string | Token being bought |
| `triggerMint` | string | Token whose USD price to monitor |
| `expiresAt` | number | Expiration timestamp in **milliseconds** |

### Single Order Fields

| Field | Type | Required | Description |
|---|---|---|---|
| `triggerCondition` | `"above"` / `"below"` | Yes | Price direction trigger |
| `triggerPriceUsd` | number | Yes | USD price threshold |
| `slippageBps` | number | No | 0-10000 basis points |

### OCO Order Fields

| Field | Type | Required | Description |
|---|---|---|---|
| `tpPriceUsd` | number | Yes | Take-profit USD price |
| `slPriceUsd` | number | Yes | Stop-loss USD price |
| `tpSlippageBps` | number | No | Take-profit slippage in bps |
| `slSlippageBps` | number | No | Stop-loss slippage in bps |

Constraint: `tpPriceUsd` must be greater than `slPriceUsd`.

### OTOCO Order Fields

| Field | Type | Required | Description |
|---|---|---|---|
| `triggerCondition` | `"above"` / `"below"` | Yes | Parent trigger direction |
| `triggerPriceUsd` | number | Yes | Parent trigger USD price |
| `tpPriceUsd` | number | Yes | Secondary take-profit price |
| `slPriceUsd` | number | Yes | Secondary stop-loss price |
| `slippageBps` | number | No | Parent slippage |
| `tpSlippageBps` | number | No | Secondary TP slippage |
| `slSlippageBps` | number | No | Secondary SL slippage |

---

## OCO Example (Take-Profit + Stop-Loss)

```typescript
const ocoOrder = await fetch('https://api.jup.ag/trigger/v2/orders/price', {
  method: 'POST',
  headers: {
    'x-api-key': process.env.JUPITER_API_KEY!,
    'Authorization': `Bearer ${jwtToken}`,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({
    orderType: 'oco',
    depositRequestId: deposit.requestId,
    depositSignedTx: depositSignedTx,
    userPubkey: walletPublicKey,
    inputMint: 'So11111111111111111111111111111111111111112',
    inputAmount: '1000000000',
    outputMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    triggerMint: 'So11111111111111111111111111111111111111112',
    tpPriceUsd: 200, // Take profit at $200
    slPriceUsd: 120, // Stop loss at $120
    expiresAt: Date.now() + 30 * 24 * 60 * 60 * 1000, // 30 days
  }),
});
```

---

## Order Update

Update trigger prices and slippage on existing orders without canceling:

```typescript
const updateRes = await fetch(`https://api.jup.ag/trigger/v2/orders/price/${orderId}`, {
  method: 'PATCH',
  headers: {
    'x-api-key': process.env.JUPITER_API_KEY!,
    'Authorization': `Bearer ${jwtToken}`,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({
    orderType: 'single',
    triggerPriceUsd: 210, // Updated price
    slippageBps: 100,
  }),
});
// Returns: { id }
```

Editable fields: trigger prices and slippage only. Amount/mint changes require canceling and recreating the order.

---

## Order Cancellation (2-Step Process)

### Step 1: Initiate Cancellation

```typescript
const cancelRes = await fetch(`https://api.jup.ag/trigger/v2/orders/price/cancel/${orderId}`, {
  method: 'POST',
  headers: {
    'x-api-key': process.env.JUPITER_API_KEY!,
    'Authorization': `Bearer ${jwtToken}`,
  },
});

const cancel = await cancelRes.json();
// Returns: { id, transaction, requestId }
// Order transitions to "ready_to_cancel" — will NOT be filled even before step 2
```

### Step 2: Sign & Confirm

```typescript
// Sign the withdrawal transaction
const cancelTx = VersionedTransaction.deserialize(
  Buffer.from(cancel.transaction, 'base64')
);
cancelTx.sign([keypair]);

const confirmRes = await fetch(
  `https://api.jup.ag/trigger/v2/orders/price/confirm-cancel/${orderId}`,
  {
    method: 'POST',
    headers: {
      'x-api-key': process.env.JUPITER_API_KEY!,
      'Authorization': `Bearer ${jwtToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      signedTransaction: Buffer.from(cancelTx.serialize()).toString('base64'),
      cancelRequestId: cancel.requestId,
    }),
  },
);
// Returns: { id, txSignature }
```

If step 2 fails, retry with the **same** `cancelRequestId`. Expired orders use this same 2-step flow to recover vault funds.

---

## Order History

```typescript
const historyRes = await fetch(
  'https://api.jup.ag/trigger/v2/orders/history?state=active&limit=20&offset=0&sort=updated_at&dir=desc',
  {
    headers: {
      'x-api-key': process.env.JUPITER_API_KEY!,
      'Authorization': `Bearer ${jwtToken}`,
    },
  },
);

const history = await historyRes.json();
// Returns: { orders: OrderHistoryItem[], pagination: { total, limit, offset } }
```

**Query parameters**:
- `state` — `active` or `past`
- `mint` — Filter by token mint address
- `limit` — 1-100 (default: 20)
- `offset` — Pagination offset (default: 0)
- `sort` — `updated_at`, `created_at`, or `expires_at` (default: `updated_at`)
- `dir` — `asc` or `desc` (default: `desc`)

**Order states**: `pending`, `open`, `executing`, `filled`, `pending_withdraw`, `cancelled`, `expired`, `failed`

---

## Slippage Defaults

| Order Type | Default | Recommendation |
|---|---|---|
| Take-profit / buy-below | Auto via RTSE | Keep default |
| Stop-loss / buy-above | 20% (2000 bps) | Keep high for execution reliability |
| OTOCO parent | Auto via RTSE | Keep default |

Stop-loss orders use a higher default because execution certainty matters more than price precision when cutting losses.

---

## Common Pitfalls

1. **Minimum $10 order value** — Orders below this are rejected
2. **USD price triggers** — V2 uses `triggerPriceUsd` (USD price), not token ratios or raw amounts
3. **Expiration is required** — No indefinite (GTC) orders in V2. Use 7-30 days; renew via `PATCH` for longer duration
4. **`expiresAt` is in milliseconds** — Not seconds. Use `Date.now() + duration_ms`
5. **JWT expires after 24 hours** — Re-authenticate via challenge-response; no refresh endpoint
6. **Vault must be onboarded first** — `/vault/register` is not callable programmatically (returns plain-text `404`). If `GET /vault` returns `404`, route the user through jup.ag web onboarding once. See the "Vault Onboarding" section above.
7. **3-step order creation** — Craft deposit → sign → create order. All three steps are required
8. **2-step cancellation** — Initiate → sign withdrawal. Order won't fill after step 1 even if step 2 is delayed
9. **Amounts are in atomic units** — 1 SOL = 1_000_000_000 lamports, 1 USDC = 1_000_000
10. **Orders are stored off-chain** — Private by default, reducing MEV attack vectors
11. **Token-2022 (transfer tax tokens) not supported**
12. **Open orders continue executing after JWT expiration** — JWT is for management, not execution

---

## Resources

- Trigger API V2 Docs: [dev.jup.ag/docs/trigger](https://dev.jup.ag/docs/trigger)


---

