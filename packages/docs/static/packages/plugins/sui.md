# @elizaos/plugin-sui

## Purpose

Core Sui blockchain plugin for Eliza OS that provides essential services and actions for token operations and wallet management.

## Key Features

- Transfer SUI tokens between wallets
- Query wallet balances and portfolio values
- Track token prices and valuations
- Manage wallet interactions with the Sui network

## Installation

```bash
bun install @elizaos/plugin-sui
```

## Configuration

Requires environment variables:

```env
SUI_PRIVATE_KEY=your_private_key
SUI_NETWORK=mainnet|testnet|devnet|localnet
```

## Integration

Import and register the plugin in Eliza configuration:

```typescript
import { suiPlugin } from '@elizaos/plugin-sui';

export default {
  plugins: [suiPlugin],
  // ... other configuration
};
```

## Example Usage

Send tokens:

```typescript
User: 'Send 1 SUI to 0x4f2e63be8e7fe287836e29cde6f3d5cbc96eefd0c0e3f3747668faa2ae7324b0';
Assistant: "I'll send 1 SUI token now...";
```

Check balance:

```typescript
User: "What's my wallet balance?";
Assistant: 'Your wallet contains 10.5 SUI ($42.00 USD)...';
```

## Links

- [Sui Documentation](https://docs.sui.io/)
- [Sui Developer Portal](https://sui.io/developers)
- [Sui Network Dashboard](https://suiscan.xyz/)
- [Sui GitHub Repository](https://github.com/MystenLabs/sui)
