# Plugin CoinGecko

A plugin for fetching cryptocurrency price data from the CoinGecko API.

## Overview

The Plugin CoinGecko provides a simple interface to get real-time cryptocurrency prices. It integrates with CoinGecko's API to fetch current prices for various cryptocurrencies in different fiat currencies.

## Installation

```bash
pnpm add @elizaos/plugin-coingecko
```

## Configuration

Set up your environment with the required CoinGecko API key:

| Variable Name       | Description            |
| ------------------- | ---------------------- |
| `COINGECKO_API_KEY` | Your CoinGecko API key |

## Usage

```typescript
import { coingeckoPlugin } from "@elizaos/plugin-coingecko";

// Initialize the plugin
const plugin = coingeckoPlugin;

// The plugin provides the GET_PRICE action which can be used to fetch prices
// Supported coins: BTC, ETH, USDC, and more
```

## Actions

### GET_PRICE

Fetches the current price of a cryptocurrency.

Examples:

- "What's the current price of Bitcoin?"
- "Check ETH price in EUR"
- "What's USDC worth?"

## License

MIT
