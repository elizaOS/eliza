# @elizaos/plugin-near

## Purpose

NEAR Protocol integration plugin for Eliza OS that enables token management, transfers, and swaps using Ref Finance.

## Key Features

- NEAR token transfers
- Token swaps via Ref Finance
- Multiple network support (mainnet, testnet)
- Secure transaction signing
- Automatic storage deposit handling
- Real-time price feeds
- Portfolio tracking and management
- Smart routing for optimal swaps
- Built-in denomination handling
- Comprehensive error handling

## Installation

```bash
bun install @elizaos/plugin-near
```

## Configuration

The plugin requires environment variables or runtime settings:

```env
NEAR_WALLET_SECRET_KEY=your-wallet-private-key
NEAR_WALLET_PUBLIC_KEY=your-wallet-public-key
NEAR_ADDRESS=your-account.near
NEAR_NETWORK=testnet  # mainnet or testnet
NEAR_RPC_URL=https://neart.lava.build
NEAR_SLIPPAGE=0.01  # 1% slippage tolerance
```

## Integration

The plugin integrates with ElizaOS through actions like `SEND_NEAR` and `EXECUTE_SWAP_NEAR` and provides wallet information through the wallet provider.

## Example Usage

```typescript
import { nearPlugin } from '@elizaos/plugin-near';

// Send NEAR
const result = await eliza.execute({
  action: 'SEND_NEAR',
  content: {
    recipient: 'bob.near',
    amount: '1.5',
  },
});
```

## Links

- [NEAR Documentation](https://docs.near.org/)
- [NEAR Developer Portal](https://near.org/developers)
- [NEAR Network Dashboard](https://nearscan.io/)
- [NEAR GitHub Repository](https://github.com/nearprotocol/near-api-js)
