# @elizaos/plugin-zksync-era

## Purpose

A plugin for integrating ZKSync Era blockchain operations with your application, providing token transfer capabilities and transaction management.

## Key Features

- Execute token transfers on ZKSync Era
- Handle smart account operations
- Manage transaction signing and submission
- Support multiple token standards
- Process transaction receipts and confirmations

## Installation

```bash
bun install @elizaos/plugin-zksync-era
```

## Configuration

The plugin requires the following environment variables:

```env
ZKSYNC_ADDRESS=your_address           # Required: Your ZKSync wallet address
ZKSYNC_PRIVATE_KEY=your_private_key  # Required: Your wallet's private key
```

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
        recipient: '0xCCa8009f5e09F8C5dB63cb0031052F9CB635Af62',
        amount: '100',
      },
    },
    state
  );
} catch (error) {
  console.error('Transfer failed:', error.message);
}
```

## Links

- [ZKSync Documentation](https://docs.zksync.io/)
- [Matter Labs Blog](https://blog.matter-labs.io/)
- [ZKSync GitHub](https://github.com/matter-labs/zksync-era)
