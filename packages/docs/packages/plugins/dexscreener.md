# @elizaos/plugin-dexscreener

A plugin for accessing DexScreener's token data and price information through your Eliza agent.

## Installation

```bash
pnpm add @elizaos/plugin-dexscreener
```

## Usage

Add the plugin to your character configuration:

```typescript
import { dexScreenerPlugin } from "@elizaos/plugin-dexscreener";

const character = {
    plugins: [dexScreenerPlugin]
};
```

## Features

### Token Price Checking
Query token prices using addresses or symbols:
```plaintext
"What's the price of ETH?"
"Check price of 0x1234..."
"How much is $BTC worth?"
```

### Token Trends
View latest and trending tokens:
```plaintext
"Show me the latest tokens"
"What are the new boosted tokens?"
"Show me the top boosted tokens"
```

## Available Actions

### GET_TOKEN_PRICE
Fetches current token price and market information.
- Aliases: `FETCH_TOKEN_PRICE`, `CHECK_TOKEN_PRICE`, `TOKEN_PRICE`
- Supports ETH addresses and token symbols (with or without $ prefix)
- Returns price, liquidity, and 24h volume information

### GET_LATEST_TOKENS
Retrieves the most recently listed tokens.
- Aliases: `FETCH_NEW_TOKENS`, `CHECK_RECENT_TOKENS`, `LIST_NEW_TOKENS`

### GET_LATEST_BOOSTED_TOKENS
Fetches the most recently boosted tokens.
- Aliases: `FETCH_NEW_BOOSTED_TOKENS`, `CHECK_RECENT_BOOSTED_TOKENS`

### GET_TOP_BOOSTED_TOKENS
Shows tokens with the most active boosts.
- Aliases: `FETCH_MOST_BOOSTED_TOKENS`, `CHECK_HIGHEST_BOOSTED_TOKENS`

## Providers

### TokenPriceProvider
Provides token price data from DexScreener API:
- Current price in USD
- Liquidity information
- 24h volume data
- Automatic best pair selection by liquidity

## Evaluators

### TokenPriceEvaluator
Evaluates messages for token price requests:
- Detects price-related keywords
- Identifies token addresses and symbols
- Supports multiple token identifier formats:
  - Ethereum addresses
  - Symbols with $ or # prefix
  - Natural language patterns ("price of TOKEN")
