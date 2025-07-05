# @elizaos/plugin-lit

## Purpose

A plugin that integrates Lit Protocol functionality into the elizaOS runtime environment, enabling secure and decentralized access control and cryptographic operations.

## Key Features

- Deploy and manage Lit Actions for programmable cryptography
- Interact with Lit Agent Wallet for secure transaction signing
- Built-in tools for common blockchain operations:
  - ECDSA signing
  - ERC20 token transfers
  - Uniswap interactions

## Installation

```bash
bun install @elizaos/plugin-lit
```

## Configuration

There are two ways to register the plugin:

1. Add to your agent's plugins in `agent/src/index.ts`:

```typescript
import { LitPlugin } from '@elizaos/plugin-lit';

export default {
  plugins: [
    // ... other plugins
    litPlugin,
  ],
  // ... rest of your agent configuration
};
```

2. Or add it in your character configuration:

```typescript
{
  name: "YourCharacter",
  plugins: [
    // ... other plugins
    "@elizaos/plugin-lit"
  ]
}
```

## Integration

After registration, initialize Lit Protocol:

```javascript
await elizaOS.lit.initialize({
  // Your configuration options
});
```

## Example Usage

```javascript
// Deploy Lit Action
const litAction = await elizaOS.lit.deployAction({
  code: `
    (async () => {
      // Your Lit Action code here
    })();
  `,
});

// ECDSA Signing
const signature = await elizaOS.lit.tools.ecdsaSign({
  message: 'Message to sign',
  // Additional parameters
});

// ERC20 Token Transfer
const transfer = await elizaOS.lit.tools.erc20Transfer({
  tokenAddress: '0x...',
  recipient: '0x...',
  amount: '1000000000000000000', // 1 token with 18 decimals
});
```

## Links

- [Lit Protocol Documentation](https://developer.litprotocol.com/)
- [Agent Wallet Documentation](https://github.com/LIT-Protocol/agent-wallet)
