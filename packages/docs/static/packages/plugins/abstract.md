# @elizaos/plugin-abstract

## Purpose

A plugin for interacting with the Abstract blockchain network, enabling seamless token transfers on the Abstract testnet.

## Installation

```bash
bun install @elizaos/plugin-abstract
```

## Configuration

The plugin requires these environment variables:

```typescript
ABSTRACT_ADDRESS=<Your Abstract wallet address>
ABSTRACT_PRIVATE_KEY=<Your Abstract private key>
```

## Integration

The plugin responds to natural language commands for token transfers on the Abstract network, including native ETH and ERC20 tokens.

## Example Usage

```typescript
// Import
import { abstractPlugin } from '@elizaos/plugin-abstract';

// Example commands:
('Send 100 USDC to 0xCCa8009f5e09F8C5dB63cb0031052F9CB635Af62');
('Transfer 0.1 ETH to 0xbD8679cf79137042214fA4239b02F4022208EE82');
('Pay 50 USDC on Abstract to [address]');
```

## Links

- [Abstract](https://abs.xyz/): Consumer blockchain
- [viem](https://viem.sh/): Typescript web3 client
