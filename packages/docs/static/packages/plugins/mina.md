# @elizaos/plugin-mina

## Purpose

Core Mina blockchain plugin for Eliza OS that provides essential services and actions for token operations and wallet management.

## Key Features

- Transfer MINA tokens between wallets
- Query wallet balances and portfolio values
- Track token prices and valuations
- Manage wallet interactions with the Mina network
- Cache token prices for performance optimization
- Get faucet tokens for testing purposes
- Get balances for wallets

## Installation

```bash
bun install @elizaos/plugin-mina
```

## Configuration

The plugin requires the following environment variables:

```env
MINA_PRIVATE_KEY=your_private_key
MINA_NETWORK=mainnet|devnet
```

## Integration

Import and register the plugin in your Eliza configuration:

```typescript
import { minaPlugin } from '@elizaos/plugin-mina';

export default {
  plugins: [minaPlugin],
  // ... other configuration
};
```

## Example Usage

Send tokens:

```typescript
User: 'Send 1 MINA to B62qkGSBuLmqYApYoWTmAzUtwFVx6Fe9ZStJVPzCwLjWZ5NQDYTiqEU';
Assistant: "I'll send 1 MINA token now...";
```

Check wallet balance:

```typescript
User: "What's my wallet balance?";
Assistant: 'Your wallet contains 299 MINA ($150 USD)...';
```

## Links

- [Mina Documentation](https://docs.minaprotocol.com/)
- [Mina Network Dashboard](https://minascan.io/)
- [Mina GitHub Repository](https://github.com/MinaProtocol/mina)
