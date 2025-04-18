# @elizaos/plugin-grix

## Purpose

A plugin that enables DeFi options data fetching and price analysis through the Grix Finance API integration.

## Key Features

- Real-time BTC/ETH price feeds
- Options pricing across multiple protocols
- Available liquidity information
- Call and Put options data
- Strike prices and expiry dates
- Protocol-specific pricing
- Position types (long/short)

## Installation

```bash
bun add @elizaos/plugin-grix
```

## Configuration

Requires a Grix API key, available via Discord or Telegram.

Two configuration methods:

1. Environment Variables:

```env
GRIX_API_KEY=your_api_key
```

2. Character Configuration:

```json
{
  "name": "Your Character",
  "plugins": ["@elizaos/plugin-grix"],
  "settings": {
    "secrets": {
      "GRIX_API_KEY": "your_api_key_here"
    }
  }
}
```

## Integration

Available Actions:

- getOptionPrice: Fetches options data across protocols
- getAssetPrice: Retrieves real-time price data for BTC/ETH

## Links

- [Discord Community](https://discord.com/invite/ZgPpr9psqp)
- [Telegram Group](https://t.me/GrixFinance)
- [Documentation](https://app.grix.finance/docs)
