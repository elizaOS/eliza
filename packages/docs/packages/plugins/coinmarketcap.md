# @elizaos/plugin-coinmarketcap

A plugin for Eliza that enables cryptocurrency price checking using the CoinMarketCap API.

## Features

- Real-time cryptocurrency price checking
- Support for multiple cryptocurrencies (BTC, ETH, SOL, etc.)
- Currency conversion (USD, EUR, etc.)
- Detailed price and market data
- Natural language processing for price queries

## Installation

```bash
npm install @elizaos/plugin-coinmarketcap
```

## Configuration

1. Get your API key from [CoinMarketCap](https://pro.coinmarketcap.com)

2. Set up your environment variables:

```bash
COINMARKETCAP_API_KEY=your_api_key
```

3. Register the plugin in your Eliza configuration:

```typescript
import { CoinMarketCapPlugin } from "@elizaos/plugin-coinmarketcap";

// In your Eliza configuration
plugins: [
    new CoinMarketCapPlugin(),
    // ... other plugins
];
```

## Usage

The plugin responds to natural language queries about cryptocurrency prices. Here are some examples:

```plaintext
"What's the current price of Bitcoin?"
"Show me ETH price in USD"
"Get the price of SOL"
```

### Supported Cryptocurrencies

The plugin supports major cryptocurrencies including:

- Bitcoin (BTC)
- Ethereum (ETH)
- Solana (SOL)
- USD Coin (USDC)
- And many more...

### Available Actions

#### GET_PRICE

Fetches the current price of a cryptocurrency.

```typescript
// Example response format
{
  symbol: "BTC",
  price: 50000.00,
  currency: "USD",
  marketCap: 1000000000000,
  volume24h: 50000000000,
  percentChange24h: 2.5
}
```

## API Reference

### Environment Variables

| Variable              | Description                | Required |
| --------------------- | -------------------------- | -------- |
| COINMARKETCAP_API_KEY | Your CoinMarketCap API key | Yes      |

### Types

```typescript
interface PriceData {
    price: number;
    marketCap: number;
    volume24h: number;
    percentChange24h: number;
}

interface GetPriceContent {
    symbol: string;
    currency: string;
}
```

## Error Handling

The plugin includes comprehensive error handling for:

- Invalid API keys
- Rate limiting
- Network timeouts
- Invalid cryptocurrency symbols
- Unsupported currencies

## Rate Limits

CoinMarketCap API has different rate limits based on your subscription plan. Please refer to [CoinMarketCap's pricing page](https://coinmarketcap.com/api/pricing/) for detailed information.

## Support

For support, please open an issue in the repository or reach out to the maintainers:

- Discord: 0xspit

## Links

- [CoinMarketCap API Documentation](https://coinmarketcap.com/api/documentation/v1/)

- [GitHub Repository](https://github.com/elizaos/eliza/tree/main/packages/plugin-coinmarketcap)
