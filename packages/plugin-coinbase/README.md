# @elizaos/plugin-coinbase

A comprehensive Coinbase integration plugin for ElizaOS that provides access to Coinbase's various APIs and services.

## Features

- **Commerce Integration**: Create and manage payment charges using Coinbase Commerce
- **Trading**: Execute trades and swaps between different assets
- **Token Contract Management**: Deploy and interact with ERC20, ERC721, and ERC1155 smart contracts
- **Mass Payments**: Process bulk transfers and payments to multiple addresses
- **Advanced Trading**: Access to Coinbase Advanced Trading API features
- **Webhook Management**: Create and manage webhooks for various blockchain events

## Installation

```bash
npm install @elizaos/plugin-coinbase
```

## Configuration

The plugin requires several environment variables to be set:

```env
COINBASE_API_KEY=your_api_key
COINBASE_PRIVATE_KEY=your_private_key
COINBASE_COMMERCE_KEY=your_commerce_key
COINBASE_NOTIFICATION_URI=your_webhook_notification_uri
```

## Usage

```typescript
import { plugins } from '@elizaos/plugin-coinbase';

// Register all plugins
const {
  coinbaseMassPaymentsPlugin,
  coinbaseCommercePlugin,
  tradePlugin,
  tokenContractPlugin,
  webhookPlugin,
  advancedTradePlugin
} = plugins;

// Register individual plugins as needed
runtime.registerPlugin(coinbaseCommercePlugin);
runtime.registerPlugin(tradePlugin);
// etc...
```

## Available Plugins

### Commerce Plugin
- Create charges with fixed or dynamic pricing
- Support for multiple currencies (USD, EUR, USDC)
- Charge status tracking and management

### Trade Plugin
- Execute basic trades between assets
- Support for market and limit orders
- Transaction logging and tracking

### Token Contract Plugin
- Deploy ERC20, ERC721, and ERC1155 contracts
- Interact with deployed contracts
- Read contract data and balances

### Mass Payments Plugin
- Process bulk transfers to multiple addresses
- Support for various assets and networks
- Transaction logging and CSV export

### Advanced Trade Plugin
- Access to advanced trading features
- Support for complex order types
- Detailed trade history and tracking

### Webhook Plugin
- Create and manage blockchain event webhooks
- Support for various event types and filters
- Webhook status tracking and logging

## Supported Networks

- Base (Mainnet & Sepolia)
- Ethereum (Mainnet & Holesky)
- Polygon Mainnet
- Solana (Mainnet & Devnet)
- Arbitrum Mainnet
- And more...

## CSV Logging

The plugin automatically logs various operations to CSV files:
- `trades.csv`: Trading operations
- `transactions.csv`: Mass payment transactions
- `webhooks.csv`: Webhook configurations
- `advanced_trades.csv`: Advanced trading operations

## Dependencies

- `@elizaos/core`: Core ElizaOS functionality
- `coinbase-api`: Coinbase API integration
- `coinbase-advanced-sdk`: Coinbase Advanced Trading SDK
- Additional type definitions and utilities

## Future Enhancements

1. **Advanced Trading Features**
   - Real-time market data streaming
   - Advanced order types (OCO, trailing stop)
   - Portfolio rebalancing automation
   - Custom trading strategies implementation
   - Multi-exchange arbitrage support

2. **Enhanced Commerce Integration**
   - Subscription payment handling
   - Multi-currency checkout optimization
   - Advanced refund management
   - Custom payment flow templates
   - Automated invoice generation

3. **Improved Token Management**
   - Batch token operations
   - Gas optimization for token contracts
   - Token metadata management system
   - Automated token listing process
   - Smart contract deployment templates

4. **Security Enhancements**
   - Advanced API key management
   - Multi-signature support
   - Transaction monitoring system
   - Risk assessment tools
   - Rate limiting improvements

5. **Analytics and Reporting**
   - Custom report generation
   - Trading performance analytics
   - Payment flow analytics
   - Real-time monitoring dashboard
   - Historical data analysis tools

6. **Webhook Management**
   - Enhanced event filtering
   - Retry mechanism improvements
   - Webhook monitoring dashboard
   - Custom webhook templates
   - Event batching support

7. **Developer Tools**
   - SDK expansion
   - Testing environment improvements
   - Documentation generator
   - CLI tools for common operations
   - Integration templates

8. **Cross-Platform Integration**
   - Mobile SDK support
   - Browser extension support
   - Desktop application integration
   - IoT device support
   - Cross-chain bridging capabilities

We welcome community feedback and contributions to help prioritize these enhancements.

## Contributing

Contributions are welcome! Please see the [CONTRIBUTING.md](CONTRIBUTING.md) file for more information.

## Credits

This plugin integrates with and builds upon several key technologies:

- [Coinbase](https://www.coinbase.com/): Digital currency exchange platform
- [Coinbase Commerce](https://commerce.coinbase.com/): Cryptocurrency payment solution
- [Coinbase Cloud](https://www.coinbase.com/cloud): Blockchain infrastructure
- [Coinbase Advanced Trade API](https://docs.cloud.coinbase.com/advanced-trade-api/): Trading interface
- [Coinbase Prime](https://prime.coinbase.com/): Institutional trading platform

Special thanks to:
- The Coinbase development team
- The Coinbase Commerce team
- The Coinbase Cloud infrastructure team
- The Advanced Trade API maintainers
- The Eliza community for their contributions and feedback

For more information about Coinbase capabilities:
- [Coinbase API Documentation](https://docs.cloud.coinbase.com/)
- [Commerce API Reference](https://docs.cloud.coinbase.com/commerce/reference/)
- [Advanced Trade Documentation](https://docs.cloud.coinbase.com/advanced-trade-api/)
- [Coinbase Prime Documentation](https://docs.prime.coinbase.com/)

## License

This plugin is part of the Eliza project. See the main project repository for license information.

