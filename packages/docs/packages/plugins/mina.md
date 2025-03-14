# @elizaos/plugin-mina

Core Mina blockchain plugin for Eliza OS that provides essential services and actions for token operations and wallet management.

## Overview

This plugin provides functionality to:

- Transfer MINA tokens between wallets
- Query wallet balances and portfolio values
- Track token prices and valuations
- Manage wallet interactions with the Mina network
- Cache token prices for performance optimization
- Get faucet tokens for testing purposes
- Get balances for wallets

## Installation

```bash
npm install @elizaos/plugin-mina
```

## Configuration

The plugin requires the following environment variables:

```env
MINA_PRIVATE_KEY=your_private_key
MINA_NETWORK=mainnet|devnet
```

## Usage

Import and register the plugin in your Eliza configuration:

```typescript
import { minaPlugin } from "@elizaos/plugin-mina";

export default {
    plugins: [minaPlugin],
    // ... other configuration
};
```

## Features

### Send Token

Transfer MINA tokens to another address:

```typescript
// Example conversation
User: "Send 1 MINA to B62qkGSBuLmqYApYoWTmAzUtwFVx6Fe9ZStJVPzCwLjWZ5NQDYTiqEU";
Assistant: "I'll send 1 MINA token now...";
```

### Check Wallet Balance

Query wallet balance and portfolio value:

```typescript
// Example conversation
User: "What's my wallet balance?";
Assistant: "Your wallet contains 299 MINA ($150 USD)...";
```

## Get Faucet Tokens

Request faucet tokens for testing:

```typescript
// Example conversation
User: "Get faucet to B62qqLnFfhYvMkFD2nUeLX1bCHtDQH3edRVtvENtwAfn2KTCFxYRjtM";
Assistant: "I'll send you some faucet tokens...";
```

## API Reference

### Actions

- `SEND_TOKEN`: Transfer MINA tokens to another address
- `TRANSFER_TOKEN`: Alias for SEND_TOKEN
- `SEND_MINA`: Alias for SEND_TOKEN
- `PAY`: Alias for SEND_TOKEN
- `FAUCET`: Request faucet tokens for testing
- `BALANCE`: Query wallet balance

### Providers

- `walletProvider`: Manages wallet interactions with the Mina network, including balance queries and portfolio tracking

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

- `o1js`: Core Mina blockchain interaction library
- `node-cache`: Caching implementation
- Other standard dependencies listed in package.json

## Contributing

Contributions are welcome! Please see the CONTRIBUTING.md file for more information.

## Credits

This plugin integrates with and builds upon several key technologies:

- [Mina Blockchain](https://minaprotocol.com/): The ZK blockchain for a secure, private and verifiable internet.
- [o1js](https://www.npmjs.com/package/o1js): Official Mina SDK for building zkApps.
- [node-cache](https://www.npmjs.com/package/node-cache): Caching implementation

Special thanks to:

- The Mina team for developing Mina
- The Mina Developer community
- The o1Labs team for Mina SDK maintainers
- The Eliza community for their contributions and feedback

For more information about Mina blockchain capabilities:

- [Mina Documentation](https://docs.minaprotocol.com/)
- [Mina Network Dashboard](https://minascan.io/)
- [Mina GitHub Repository](https://github.com/MinaProtocol/mina)

## License

This plugin is part of the Eliza project. See the main project repository for license information.
