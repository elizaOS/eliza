# @elizaos/plugin-ton

## Purpose

A plugin for handling TON (Telegram Open Network) blockchain operations, providing wallet management and transfer capabilities.

## Key Features

- Manage TON wallets and key derivation
- Execute secure token transfers
- Query wallet balances and portfolio information
- Format and cache transaction data
- Interface with TON blockchain via RPC endpoints
- Connect TON wallets using TonConnect protocol
- Support multiple wallet applications (like Tonkeeper)
- Support QR Code scanning connection
- Batch transfers of NFTs, Jettons and TON in a single transaction
- On-demand wallet creation with encrypted key storage
- Auction interactions

## Installation

```bash
bun install @elizaos/plugin-ton
```

## Configuration

Environment variables:

```env
TON_PRIVATE_KEY=your_mnemonic_phrase
TON_RPC_URL=your_rpc_endpoint
TON_RPC_API_KEY=
TON_MANIFEST_URL=your_manifest_url
TON_BRIDGE_URL=your_bridge_url
```

## Integration

Import and register in Eliza configuration:

```typescript
import { tonPlugin } from '@elizaos/plugin-ton';

export default {
  plugins: [tonPlugin],
  // ... other configuration
};
```

## Example Usage

```typescript
// WalletProvider
const provider = await initWalletProvider(runtime);
const balance = await provider.getWalletBalance();
const portfolio = await provider.getFormattedPortfolio(runtime);

// Transfer
const action = new TransferAction(walletProvider);
const hash = await action.transfer({
  recipient: 'EQCGScrZe1xbyWqWDvdI6mzP-GAcAWFv6ZXuaJOuSqemxku4',
  amount: '1.5',
});
```
