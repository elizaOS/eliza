# @elizaos/plugin-zerion

A plugin for Eliza that enables fetching wallet portfolio and position data using the Zerion API.

## Features

- Real-time wallet portfolio data
- Detailed token positions and balances
- Chain distribution analysis
- Portfolio value changes tracking
- Support for all EVM-compatible chains
- Natural language processing for wallet queries

## Installation

```bash
npm install @elizaos/plugin-zerion
```

## Configuration

1. Get your API key from [Zerion](https://developers.zerion.io)

2. Set up your environment variables:

```bash
ZERION_API_KEY=your_api_key
```

3. Register the plugin in your Eliza configuration:

```typescript
import { zerionPlugin } from "@elizaos/plugin-zerion";

// In your Eliza configuration
plugins: [
    zerionPlugin,
    // ... other plugins
];
```

## Usage

The plugin responds to natural language queries about wallet data. Here are some examples:

```plaintext
"Show me the portfolio for 0x123...abc"
"What are the token positions in 0x456...def?"
"Get wallet holdings for 0x789...ghi"
```

### Available Actions

#### getWallet_portfolio

Fetches comprehensive portfolio data for a wallet address, including:
- Total portfolio value
- Chain distribution
- Position type distribution
- 24h value changes

```typescript
// Example response format
{
  totalValue: number;
  chainDistribution: Record<string, number>;
  positionTypes: Record<string, number>;
  changes: {
    absolute_1d: number;
    percent_1d: number;
  };
}
```

#### getWallet_positions

Fetches detailed information about all token positions in a wallet:
- Token name and symbol
- Quantity and current value
- Price and 24h change
- Chain information
- Verification status

```typescript
// Example response format
{
  positions: Array<{
    name: string;
    symbol: string;
    quantity: number;
    value: number;
    price: number;
    chain: string;
    change24h: number | null;
    verified: boolean;
  }>;
  totalValue: number;
}
```

## API Reference

### Environment Variables

| Variable       | Description          | Required |
| ------------- | -------------------- | -------- |
| ZERION_API_KEY | Your Zerion API key  | Yes      |

## Error Handling

## Support

For support, please open an issue in the repository or reach out to the maintainers.
telegram: @singhal_pranav

## Links

- [Zerion API Documentation](https://developers.zerion.io/reference/intro)
- [GitHub Repository](https://github.com/elizaos/eliza/tree/main/packages/plugin-zerion) 