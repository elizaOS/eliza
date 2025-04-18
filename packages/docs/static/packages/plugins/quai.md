# @elizaos/plugin-quai

## Purpose

Quai Network integration plugin for Eliza OS that enables native token transfers and interactions with the Quai blockchain.

## Key Features

- Native QUAI token transfers
- Multiple network support
- Secure transaction signing
- Comprehensive error handling
- Built-in address validation
- Automatic gas estimation
- Real-time transaction status

## Installation

```bash
bun install @elizaos/plugin-quai
```

## Configuration

The plugin requires the following environment variables:

```env
QUAI_PRIVATE_KEY=your-private-key
QUAI_RPC_URL=https://rpc.quai.network  # or your preferred RPC endpoint
```

## Integration

The plugin provides core functionality for interacting with the Quai Network through a simple interface, enabling token transfers and blockchain interactions in ElizaOS.

## Example Usage

```typescript
import { quaiPlugin } from '@elizaos/plugin-quai';

// Send QUAI
const result = await eliza.execute({
  action: 'SEND_TOKEN',
  content: {
    recipient: '0x049d36570d4e46f48e99674bd3fcc84644ddd6b96f7c741b1562b82f9e004dc7',
    amount: '10',
  },
});
```

## Links

- [Quai Network](https://qu.ai/)
- [Quai Documentation](https://docs.qu.ai/)
- [Quai Network GitHub](https://github.com/dominant-strategies)
