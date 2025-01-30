# @elizaos/plugin-moralis

A plugin for interacting with Moralis APIs to fetch various blockchain data across different chains.

## Description

The Plugin Moralis provides interfaces to fetch real-time DeFi data including trading pairs, pair statistics, and price history. Currently supports Solana chain endpoints.

## Installation

```bash
pnpm install @elizaos/plugin-moralis
```

## Configuration

Set up your environment with the required Moralis API key:

| Variable Name     | Description          |
| ----------------- | -------------------- |
| `MORALIS_API_KEY` | Your Moralis API key |

## Usage

```typescript
import { moralisPlugin } from "@elizaos/plugin-moralis";

// Initialize the plugin
const plugin = moralisPlugin;
```

## Actions

### GET_SOLANA_TOKEN_PAIRS

Fetches all trading pairs for a specific token on Solana blockchain.

Examples:

- "Get all Solana trading pairs for token So11111111111111111111111111111111111111112"
- "Show me Solana pairs for USDC token EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"

Response includes:

- Exchange information (name, address)
- Pair details (label, address)
- Price and volume data
- Liquidity information

### GET_SOLANA_PAIR_STATS

Fetches detailed statistics for a specific trading pair on Solana blockchain.

Examples:

- "Get stats for Solana pair A8nPhpCJqtqHdqUk35Uj9Hy2YsGXFkCZGuNwvkD3k7VC"
- "Show me details of Solana trading pair 83v8iPyZihDEjDdY8RdZddyZNyUtXngz69Lgo9Kt5d6d"

Response includes:

- Current price and liquidity
- Price changes over multiple timeframes
- Volume statistics
- Buy/Sell ratios
- Unique traders count

### GET_SOLANA_TOKEN_STATS

Fetches aggregated statistics across all pairs for a specific token on Solana blockchain.

Examples:

- "Get aggregated stats for Solana token SRMuApVNdxXokk5GT7XD5cUUgXMBCoAz2LHeuAoKWRt"
- "Show me overall trading metrics for all pairs of token EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"

Response includes:

- Total liquidity across all pairs
- Number of active pairs and DEXes
- Combined volume statistics
- Total trader activity
- Buy/Sell volume breakdowns

### GET_SOLANA_PAIR_OHLCV

Fetches price history (OHLCV) data for a specific trading pair on Solana blockchain.

Examples:

- "Get hourly candlestick prices for Solana pair A8nPhpCJqtqHdqUk35Uj9Hy2YsGXFkCZGuNwvkD3k7VC"
- "Show me last 15 candles for Solana pair 83v8iPyZihDEjDdY8RdZddyZNyUtXngz69Lgo9Kt5d6d"

Supports:

- Multiple timeframes (1h, 15m, etc.)
- Custom date ranges
- Price data in different currencies

### GET_SOLANA_TOKEN_PRICE

Fetches current token price from the main liquidity source.

Examples:

- "Get current price of Solana token 6Rwcmkz9yiYVM5EzyMcr4JsQPGEAWhcUvLvfBperYnUt"
- "What's the current price for BONK?"

Returns:

- USD price
- Native price (e.g., in SOL)
- Exchange name and address

### GET_SOLANA_TOKEN_METADATA

- Fetches comprehensive token metadata including supply and valuation metrics.

Examples:

- "What's the FDV and supply for SRM token?"
- "Show me metadata for BONK token"

Returns:

- Token name and symbol
- Contract address
- Total supply (raw and formatted)
- Fully Diluted Valuation (FDV)
- Token standard and decimals
- Metaplex-specific details

## Usage Tips

1. Always specify "Solana" in requests to ensure correct chain selection
2. Use complete token/pair addresses for accurate results
3. For OHLCV data, specify timeframe and date range for precise results

## License

MIT
