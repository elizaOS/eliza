# @elizaos/plugin-dexscreener

## Purpose

A plugin for accessing DexScreener's token data and price information through your Eliza agent.

## Installation

```bash
bun add @elizaos/plugin-dexscreener
```

## Configuration

```typescript
import { dexScreenerPlugin } from '@elizaos/plugin-dexscreener';

const character = {
  plugins: [dexScreenerPlugin],
};
```

## Key Features

- Token Price Checking: Query token prices using addresses or symbols
- Token Trends: View latest and trending tokens

## Integration

The plugin provides:

- GET_TOKEN_PRICE (with aliases)
- GET_LATEST_TOKENS (with aliases)
- GET_LATEST_BOOSTED_TOKENS (with aliases)
- GET_TOP_BOOSTED_TOKENS (with aliases)
- TokenPriceProvider: Provides token price data from DexScreener API
- TokenPriceEvaluator: Evaluates messages for token price requests

## Example Usage

```plaintext
"What's the price of ETH?"
"Check price of 0x1234..."
"How much is $BTC worth?"
"Show me the latest tokens"
"What are the new boosted tokens?"
"Show me the top boosted tokens"
```
