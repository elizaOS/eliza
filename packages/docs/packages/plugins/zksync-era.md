# @elizaos/plugin-zksync-era

A plugin for integrating ZKSync Era blockchain operations with your application, providing token transfer capabilities and transaction management.

## Overview

This plugin provides functionality to:

- Execute token transfers on ZKSync Era
- Handle smart account operations
- Manage transaction signing and submission
- Support multiple token standards
- Process transaction receipts and confirmations

## Installation

```bash
npm install @elizaos/plugin-zksync-era
```

## Configuration

The plugin requires the following environment variables:

```env
ZKSYNC_ADDRESS=your_address           # Required: Your ZKSync wallet address
ZKSYNC_PRIVATE_KEY=your_private_key  # Required: Your wallet's private key
```

## Usage

### Basic Setup

```typescript
import { zksyncEraPlugin } from "@elizaos/plugin-zksync-era";

const plugin = zksyncEraPlugin;
```

### Token Transfers

```typescript
// Transfer tokens
await transfer.handler(
    runtime,
    {
        content: {
            tokenAddress: "0x1d17CBcF0D6D143135aE902365D2E5e2A16538D4", // USDC
            recipient: "0xCCa8009f5e09F8C5dB63cb0031052F9CB635Af62",
            amount: "100",
        },
    },
    state
);
```

## Features

### Supported Tokens

The plugin includes pre-configured addresses for common tokens:

```typescript
const TOKENS = {
    ZK: "0x5A7d6b2F92C77FAD6CCaBd7EE0624E64907Eaf3E",
    ETH: "0x000000000000000000000000000000000000800A",
    USDC: "0x1d17CBcF0D6D143135aE902365D2E5e2A16538D4",
};
```

### Smart Account Integration

```typescript
const web3 = new Web3();
web3.registerPlugin(
    new ZKsyncPlugin(
        Web3ZKsyncL2.initWithDefaultProvider(types.Network.Mainnet)
    )
);

const smartAccount = new web3.ZKsync.SmartAccount({
    address: PUBLIC_KEY,
    secret: PRIVATE_KEY,
});
```

## Error Handling

The plugin includes comprehensive error handling:

```typescript
try {
    const transferTx = await smartAccount.transfer({
        to: recipient,
        token: tokenAddress,
        amount: amount,
    });
    const receipt = await transferTx.wait();
} catch (error) {
    console.error("Transfer failed:", error.message);
}
```

Common error cases:

- Invalid configuration
- Insufficient balance
- Network issues
- Invalid addresses
- Failed transactions

## Best Practices

1. Always validate addresses before transactions
2. Keep private keys secure
3. Monitor transaction status
4. Implement proper error handling
5. Use appropriate gas settings
6. Keep track of transaction receipts

## API Reference

### Core Interfaces

```typescript
interface TransferContent {
    tokenAddress: string;
    recipient: string;
    amount: string | number;
}

interface ZKsyncConfig {
    ZKSYNC_ADDRESS: string;
    ZKSYNC_PRIVATE_KEY: string;
}
```

### Plugin Methods

- `transfer`: Execute token transfers
- `validateZKsyncConfig`: Validate configuration
- Transaction status monitoring
- Receipt handling

## Development

### Building

```bash
npm run build
```

### Testing

```bash
npm run test
```

## Security Best Practices

- Store private keys securely using environment variables
- Validate all addresses before transactions
- Implement proper error handling
- Keep dependencies updated
- Monitor transaction status
- Use secure RPC endpoints
- Implement proper gas management

## Example Usage

```typescript
// Initialize plugin
const zksync = zksyncEraPlugin;

// Execute transfer
try {
    await transfer.handler(
        runtime,
        {
            content: {
                tokenAddress: TOKENS.USDC,
                recipient: "0xCCa8009f5e09F8C5dB63cb0031052F9CB635Af62",
                amount: "100",
            },
        },
        state
    );
} catch (error) {
    console.error("Transfer failed:", error.message);
}
```

## Validation

The plugin includes validation for:

- Wallet addresses
- Token addresses
- Transaction amounts
- Configuration parameters
- Network status

## Dependencies

- `@elizaos/core`: Core Eliza functionality
- `web3`: Web3 library for blockchain interaction
- `web3-plugin-zksync`: ZKSync Era integration
- Other standard dependencies listed in package.json

## Contributing

Contributions are welcome! Please see the CONTRIBUTING.md file for more information.

## Credits

This plugin integrates with and builds upon several key technologies:

- [ZKSync Era](https://zksync.io/): Layer 2 scaling solution for Ethereum
- [Web3.js](https://web3js.org/): Ethereum JavaScript API
- [web3-plugin-zksync](https://www.npmjs.com/package/web3-plugin-zksync): Official ZKSync plugin for Web3.js

Special thanks to:

- The Eliza community for their contributions and feedback

For more information about ZKSync Era and its capabilities, visit:

- [ZKSync Documentation](https://docs.zksync.io/)
- [Matter Labs Blog](https://blog.matter-labs.io/)
- [ZKSync GitHub](https://github.com/matter-labs/zksync-era)

## License

This plugin is part of the Eliza project. See the main project repository for license information.
