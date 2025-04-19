# Plugin CoinGecko

## Purpose

A plugin for fetching cryptocurrency price data from the CoinGecko API.

## Installation

```bash
bun add @elizaos/plugin-coingecko
```

## Configuration

Set up your environment with the required CoinGecko API key:

| Variable Name           | Description                |
| ----------------------- | -------------------------- |
| `COINGECKO_API_KEY`     | Your CoinGecko Pro API key |
| `COINGECKO_PRO_API_KEY` | Your CoinGecko Pro API key |

## Integration

The plugin integrates with CoinGecko's API to fetch current prices, market data, trending coins, and top gainers/losers for various cryptocurrencies in different fiat currencies.

## Example Usage

```typescript
import { coingeckoPlugin } from '@elizaos/plugin-coingecko';

// Initialize the plugin
const plugin = coingeckoPlugin;
```

## Links

[CoinGecko Pro API](https://docs.coingecko.com/reference/introduction)
