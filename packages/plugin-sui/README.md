# @elizaos/plugin-sui

Core Sui blockchain plugin for Eliza OS that provides essential services and actions for token operations and wallet management.

## Overview

This plugin provides functionality to:
- Transfer SUI tokens between wallets
- Query wallet balances and portfolio values
- Track token prices and valuations
- Manage wallet interactions with the Sui network

## Installation

```bash
npm install @elizaos/plugin-sui
```

## Configuration

The plugin requires the following environment variables:

```env
SUI_PRIVATE_KEY=your_private_key
SUI_NETWORK=mainnet|testnet|devnet|localnet
```

## Usage

Import and register the plugin in your Eliza configuration:

```typescript
import { suiPlugin } from "@elizaos/plugin-sui";

export default {
  plugins: [suiPlugin],
  // ... other configuration
};
```

## Features

### Send Token

Transfer SUI tokens to another address:

```typescript
// Example conversation
User: "Send 1 SUI to 0x4f2e63be8e7fe287836e29cde6f3d5cbc96eefd0c0e3f3747668faa2ae7324b0"
Assistant: "I'll send 1 SUI token now..."
```

### Check Wallet Balance

Query wallet balance and portfolio value:

```typescript
// Example conversation
User: "What's my wallet balance?"
Assistant: "Your wallet contains 10.5 SUI ($42.00 USD)..."
```

## API Reference

### Actions

- `SEND_TOKEN`: Transfer SUI tokens to another address
- `TRANSFER_TOKEN`: Alias for SEND_TOKEN
- `SEND_SUI`: Alias for SEND_TOKEN
- `PAY`: Alias for SEND_TOKEN

### Providers

- `walletProvider`: Manages wallet interactions with the Sui network, including balance queries and portfolio tracking

## Development

### Building

```bash
npm run build
```

### Testing

```bash
npm run test
```

## Dependencies

- `@mysten/sui`: Core Sui blockchain interaction library
- `bignumber.js`: Precise number handling
- `node-cache`: Caching implementation
- Other standard dependencies listed in package.json

## Future Enhancements

The following features and improvements are planned for future releases:

1. **Transaction Management**
   - Batch transaction processing
   - Transaction simulation
   - Gas optimization strategies
   - Custom transaction builders
   - Advanced error handling

2. **Wallet Integration**
   - Multi-wallet support
   - Hardware wallet integration
   - Social recovery options
   - Account abstraction
   - Transaction history tracking

3. **Smart Contract Features**
   - Contract deployment tools
   - Move module templates
   - Testing framework
   - Upgrade management
   - Security analysis

4. **Token Operations**
   - Batch token transfers
   - NFT support enhancement
   - Token metadata handling
   - Custom token standards
   - Collection management

5. **Developer Tools**
   - Enhanced debugging
   - CLI improvements
   - Documentation generator
   - Integration templates
   - Performance monitoring

We welcome community feedback and contributions to help prioritize these enhancements.

## Contributing

Contributions are welcome! Please see the [CONTRIBUTING.md](CONTRIBUTING.md) file for more information.

## Credits

This plugin integrates with and builds upon several key technologies:

- [Sui Blockchain](https://sui.io/): Next-generation smart contract platform
- [@mysten/sui.js](https://www.npmjs.com/package/@mysten/sui.js): Official Sui SDK
- [bignumber.js](https://github.com/MikeMcl/bignumber.js/): Precise number handling
- [node-cache](https://www.npmjs.com/package/node-cache): Caching implementation

Special thanks to:
- The Mysten Labs team for developing Sui
- The Sui Developer community
- The Sui SDK maintainers
- The Eliza community for their contributions and feedback

For more information about Sui blockchain capabilities:
- [Sui Documentation](https://docs.sui.io/)
- [Sui Developer Portal](https://sui.io/developers)
- [Sui Network Dashboard](https://suiscan.xyz/)
- [Sui GitHub Repository](https://github.com/MystenLabs/sui)

## License

This plugin is part of the Eliza project. See the main project repository for license information.
