# @elizaos/plugin-moralis

## Purpose

A plugin for interacting with Moralis APIs to fetch various blockchain data across different chains, currently supporting Solana chain endpoints.

## Key Features

- Fetch Solana trading pairs for specific tokens
- Get detailed statistics for Solana trading pairs
- Access aggregated token statistics across all pairs
- Retrieve price history (OHLCV) data
- Get current token prices
- Fetch comprehensive token metadata

## Installation

```bash
bun install @elizaos/plugin-moralis
```

## Configuration

| Variable Name     | Description          |
| ----------------- | -------------------- |
| `MORALIS_API_KEY` | Your Moralis API key |

## Integration

Import and initialize the plugin using:

```typescript
import { moralisPlugin } from '@elizaos/plugin-moralis';
const plugin = moralisPlugin;
```

## Example Usage

- "Get all Solana trading pairs for token So11111111111111111111111111111111111111112"
- "Get stats for Solana pair A8nPhpCJqtqHdqUk35Uj9Hy2YsGXFkCZGuNwvkD3k7VC"
- "Get aggregated stats for Solana token SRMuApVNdxXokk5GT7XD5cUUgXMBCoAz2LHeuAoKWRt"
- "Get hourly candlestick prices for Solana pair A8nPhpCJqtqHdqUk35Uj9Hy2YsGXFkCZGuNwvkD3k7VC"
- "Get current price of Solana token 6Rwcmkz9yiYVM5EzyMcr4JsQPGEAWhcUt"
- "What's the FDV and supply for SRM token?"

## Links

License: MIT
