# @elizaos/plugin-sei

Sei Network plugin for Eliza OS that enables Eliza agents to perform actions on the Sei blockchain.
## Overview

This plugin provides functionality to:

- Transfer SEI tokens to other `0x` or `sei` addresses
- Query wallet balances

## Installation

```bash
pnpm install @elizaos/plugin-sei
```

## Configuration

The plugin requires the following environment variables:

```env
SEI_PRIVATE_KEY= #your_private_key
SEI_NETWORK= #"mainnet","testnet", or "devnet"
```

## Usage

Import and register the plugin in your Eliza configuration:

```typescript
import { seiPlugin } from "@elizaos/plugin-sei";

export default {
    plugins: [seiPlugin],
    // ... other configuration
};
```

## Features

### Send Token

Transfer SEI tokens to another address:

```typescript
// Example conversation
User: "Send 1 SEI to 0xD5ca6eA5e33606554F746606157a7512FA738A12";
Assistant: "I'll send 1 SEI token now...";
```

```typescript
// Example conversation
User: "Send 1 SEI to sei1vpz36punknkdjfs7ew2vkdwws8ydcquy00hhsd";
Assistant: "I'll send 1 SEI token now...";
```

### Check Wallet Balance

Query wallet balance and portfolio value:

```typescript
// Example conversation
User: "What's my wallet balance?";
Assistant: "Your wallet contains 10.5 SEI ($5.25 USD)...";
```

## API Reference

### Actions

- `SEND_TOKEN`: Transfer SEI to a specified address

### Providers

- `walletProvider`: Manages wallet interactions with the Sei network, including balance queries and portfolio tracking

## Development

### Building

```bash
pnpm build
```

### Testing

```bash
pnpm test
```

## Future Enhancements

Some features planned for future releases include:
- On chain actions such as Staking and Unstaking, Governance, and native token creation
- Complex queries and transaction history tracking
- Smart contract deployment and interaction
- Integration with DeFi protocols on Sei, such as DEXes, Lending Protocols and Money Markets.

## Credits

This plugin integrates with and builds upon several key technologies:

- [Sei Blockchain](https://sei.io/): The fastest EVM blockchain

## License

This plugin is part of the Eliza project. See the main project repository for license information.
