# @elizaos/plugin-coinbase

## Purpose

A comprehensive Coinbase integration plugin for ElizaOS that provides access to Coinbase's various APIs and services.

## Key Features

- Commerce Integration: Create and manage payment charges using Coinbase Commerce
- Trading: Execute trades and swaps between different assets
- Token Contract Management: Deploy and interact with ERC20, ERC721, and ERC1155 smart contracts
- Mass Payments: Process bulk transfers and payments to multiple addresses
- Advanced Trading: Access to Coinbase Advanced Trading API features
- Webhook Management: Create and manage webhooks for various blockchain events

## Installation

```bash
bun install @elizaos/plugin-coinbase
```

## Configuration

The plugin requires several environment variables:

```env
COINBASE_API_KEY=your_api_key
COINBASE_PRIVATE_KEY=your_private_key
COINBASE_COMMERCE_KEY=your_commerce_key
COINBASE_NOTIFICATION_URI=your_webhook_notification_uri
```

## Integration

The plugin provides multiple sub-plugins that can be registered with ElizaOS runtime:

```typescript
import { plugins } from '@elizaos/plugin-coinbase';

// Register all plugins
const {
  coinbaseMassPaymentsPlugin,
  coinbaseCommercePlugin,
  tradePlugin,
  tokenContractPlugin,
  webhookPlugin,
  advancedTradePlugin,
} = plugins;

// Register individual plugins as needed
runtime.registerPlugin(coinbaseCommercePlugin);
runtime.registerPlugin(tradePlugin);
// etc...
```

## Links

- [Coinbase API Documentation](https://docs.cloud.coinbase.com/)
- [Commerce API Reference](https://docs.cloud.coinbase.com/commerce/reference/)
- [Advanced Trade Documentation](https://docs.cloud.coinbase.com/advanced-trade-api/)
- [Coinbase Prime Documentation](https://docs.prime.coinbase.com/)
