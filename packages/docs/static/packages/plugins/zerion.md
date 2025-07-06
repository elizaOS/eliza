# @elizaos/plugin-zerion

## Purpose

A plugin for Eliza that enables fetching wallet portfolio and position data using the Zerion API.

## Key Features

- Real-time wallet portfolio data
- Detailed token positions and balances
- Chain distribution analysis
- Portfolio value changes tracking
- Support for all EVM-compatible chains
- Natural language processing for wallet queries

## Installation

```bash
bun install @elizaos/plugin-zerion
```

## Configuration

1. Get your API key from Zerion
2. Set environment variables: ZERION_API_KEY
3. Register the plugin in your Eliza configuration:

```typescript
import { zerionPlugin } from '@elizaos/plugin-zerion';

// In your Eliza configuration
plugins: [
  zerionPlugin,
  // ... other plugins
];
```

## Integration

The plugin responds to natural language queries about wallet data through actions like getWallet_portfolio and getWallet_positions.

## Example Usage

```plaintext
"Show me the portfolio for 0x123...abc"
"What are the token positions in 0x456...def?"
"Get wallet holdings for 0x789...ghi"
```

## Links

- [Zerion API Documentation](https://developers.zerion.io/reference/intro)
- [GitHub Repository](https://github.com/elizaos/eliza/tree/main/packages/plugin-zerion)
