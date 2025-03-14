# @elizaos/plugin-lit

A plugin that integrates Lit Protocol functionality into the elizaOS runtime environment, enabling secure and decentralized access control and cryptographic operations.

## Features

- Deploy and manage Lit Actions for programmable cryptography
- Interact with Lit Agent Wallet for secure transaction signing
- Built-in tools for common blockchain operations:
  - ECDSA signing
  - ERC20 token transfers
  - Uniswap interactions

## Installation

```bash
npm install @elizaos/plugin-lit
```

## Setup

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

## Quick Start

1. After registration, initialize Lit Protocol:

```javascript
await elizaOS.lit.initialize({
  // Your configuration options
});
```

## Core Components

### Lit Actions

Located in `src/actions/helloLit`, this module provides the foundation for deploying and managing Lit Actions. Lit Actions are JavaScript functions that run in a decentralized manner across the Lit Network.

Example usage:

```javascript
const litAction = await elizaOS.lit.deployAction({
  code: `
    (async () => {
      // Your Lit Action code here
    })();
  `
});
```

### Tools

The `src/actions/helloLit/tools` directory contains pre-built tools for common blockchain operations:

#### ECDSA Signing
```javascript
const signature = await elizaOS.lit.tools.ecdsaSign({
  message: "Message to sign",
  // Additional parameters
});
```

#### ERC20 Token Transfer
```javascript
const transfer = await elizaOS.lit.tools.erc20Transfer({
  tokenAddress: "0x...",
  recipient: "0x...",
  amount: "1000000000000000000" // 1 token with 18 decimals
});
```

#### Uniswap Integration
```javascript
const swap = await elizaOS.lit.tools.uniswapSwap({
  tokenIn: "0x...",
  tokenOut: "0x...",
  amountIn: "1000000000000000000"
});
```

## Agent Wallet Integration

This plugin integrates with the [Lit Protocol Agent Wallet](https://github.com/LIT-Protocol/agent-wallet) for secure key management and transaction signing. The Agent Wallet provides:

- Secure key generation and storage
- Transaction signing capabilities
- Integration with Lit Actions for programmable authorization

## Documentation

For more detailed information about Lit Protocol and its capabilities, visit:
- [Lit Protocol Documentation](https://developer.litprotocol.com/)
- [Agent Wallet Documentation](https://github.com/LIT-Protocol/agent-wallet)

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

## License

MIT License

Copyright (c) 2024 elizaOS

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
