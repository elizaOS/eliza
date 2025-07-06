# @elizaos/plugin-zapper

## Purpose

A plugin for Eliza that allows users to fetch portfolio data using the Zapper API.

## Key Features

- Get portfolio data from wallet addresses on networks supported by the Zapper API
- Get portfolio data from addresses attached to Farcaster profiles

## Installation

```bash
bun install @elizaos/plugin-zapper
```

## Configuration

1. Get your API key from Zapper
2. Set up environment variables: `ZAPPER_API_KEY=your_api_key`
3. Register the plugin in your Eliza configuration:

```typescript
import { zapperPlugin } from '@elizaos/plugin-zapper';

// In your Eliza configuration
plugins: [
  zapperPlugin,
  // ... other plugins
];
```

## Integration

The plugin responds to natural language queries about wallet data with two main actions: "portfolio" to fetch current portfolio of provided addresses, and "farcasterPortfoio" to fetch portfolios of addresses attached to Farcaster profiles.

## Example Usage

```plaintext
"Show me the holdings of @vitalik.eth"
"Show me the portfolio of these wallets 0xd8d...045, 0xadd...077"
"Get wallet holdings for HN7cA...WrH"
```

## Links

- [Zapper API Documentation](https://protocol.zapper.xyz/docs/api/)
