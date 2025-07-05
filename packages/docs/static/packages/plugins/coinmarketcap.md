# @elizaos/plugin-coinmarketcap

## Purpose

A plugin for Eliza that enables cryptocurrency price checking using the CoinMarketCap API.

## Key Features

- Real-time cryptocurrency price checking
- Support for multiple cryptocurrencies (BTC, ETH, SOL, etc.)
- Currency conversion (USD, EUR, etc.)
- Detailed price and market data
- Natural language processing for price queries

## Installation

```bash
bun install @elizaos/plugin-coinmarketcap
```

## Configuration

1. Get your API key from [CoinMarketCap](https://pro.coinmarketcap.com)
2. Set up environment variables: `COINMARKETCAP_API_KEY=your_api_key`
3. Register the plugin in your Eliza configuration

## Integration

The plugin responds to natural language queries about cryptocurrency prices, providing detailed price and market data.

## Example Usage

```plaintext
"What's the current price of Bitcoin?"
"Show me ETH price in USD"
"Get the price of SOL"
```

## Links

- [CoinMarketCap API Documentation](https://coinmarketcap.com/api/documentation/v1/)
- [GitHub Repository](https://github.com/elizaos/eliza/tree/main/packages/plugin-coinmarketcap)
