# Plugin CoinGecko

A plugin for fetching cryptocurrency price data from the CoinGecko API.

## Overview

The Plugin CoinGecko provides a simple interface to get real-time cryptocurrency data. It integrates with CoinGecko's API to fetch current prices, market data, trending coins, and top gainers/losers for various cryptocurrencies in different fiat currencies.

This plugin uses the [CoinGecko Pro API](https://docs.coingecko.com/reference/introduction). Please refer to their documentation for detailed information about rate limits, available endpoints, and response formats.

## Installation

```bash
pnpm add @elizaos/plugin-coingecko
```

## Configuration

Set up your environment with the required CoinGecko API key:

| Variable Name       | Description            |
| ------------------- | ---------------------- |
| `COINGECKO_API_KEY` | Your CoinGecko Pro API key |
| `COINGECKO_PRO_API_KEY` | Your CoinGecko Pro API key |

## Usage

```typescript
import { coingeckoPlugin } from "@elizaos/plugin-coingecko";

// Initialize the plugin
const plugin = coingeckoPlugin;
```

## Actions

### GET_PRICE

Fetches the current price and market data for one or more cryptocurrencies.

Features:
- Multiple currency support (e.g., USD, EUR, JPY)
- Optional market cap data
- Optional 24h volume data
- Optional 24h price change data
- Optional last update timestamp

Examples:
- "What's the current price of Bitcoin?"
- "Check ETH price in EUR with market cap"
- "Show me BTC and ETH prices in USD and EUR"
- "What's USDC worth with 24h volume and price change?"

### GET_TRENDING

Fetches the current trending cryptocurrencies on CoinGecko.

Features:
- Includes trending coins with market data
- Optional NFT inclusion
- Optional category inclusion

Examples:
- "What's trending in crypto?"
- "Show me trending coins only"
- "What are the hot cryptocurrencies right now?"

### GET_TOP_GAINERS_LOSERS

Fetches the top gaining and losing cryptocurrencies by price change.

Features:
- Customizable time range (1h, 24h, 7d, 14d, 30d, 60d, 1y)
- Configurable number of top coins to include
- Multiple currency support
- Market cap ranking included

Examples:
- "Show me the biggest gainers and losers today"
- "What are the top movers in EUR for the past week?"
- "Show me monthly performance of top 100 coins"

## Response Format

All actions return structured data including:
- Formatted text for easy reading
- Raw data for programmatic use
- Request parameters used
- Error details when applicable

## Error Handling

The plugin handles various error scenarios:
- Rate limiting
- API key validation
- Invalid parameters
- Network issues
- Pro plan requirements