# @elizaos/plugin-abstract

A plugin for interacting with the Abstract blockchain network within the ElizaOS ecosystem.

## Description
The Abstract plugin enables seamless token transfers on the Abstract testnet. It provides functionality to transfer both native ETH and ERC20 tokens using secure wallet operations.

## Installation

```bash
pnpm install @elizaos/plugin-lensNetwork
```

## Configuration

The plugin requires the following environment variables to be set:
```typescript
LENS_ADDRESS=<Your Lens wallet address>
LENS_PRIVATE_KEY=<Your Lens private key>
```

## Usage

### Basic Integration

```typescript
import { lensPlugin } from '@elizaos/plugin-lensNetwork';
```

### Transfer Examples

```typescript
// The plugin responds to natural language commands like:

"Send 1 Grass to 0xCCa8009f5e09F8C5dB63cb0031052F9CB635Af62"

```

## API Reference

### Actions

#### SEND_TOKEN

Transfers tokens from the agent's wallet to another address.

**Aliases:**
- TRANSFER_TOKEN_ON_LENS
- TRANSFER_TOKENS_ON_LENS
- SEND_TOKENS_ON_LENS
- SEND_ETH_ON_LENS
- PAY_ON_LENS
- MOVE_TOKENS_ON_LENS
- MOVE_ETH_ON_LENS

## Common Issues & Troubleshooting

1. **Transaction Failures**
   - Verify wallet has sufficient balance
   - Check recipient address format
   - Ensure private key is correctly set
   - Verify network connectivity

2. **Configuration Issues**
   - Verify all required environment variables are set
   - Ensure private key format is correct
   - Check wallet address format

## Security Best Practices

1. **Private Key Management**
   - Store private key securely using environment variables
   - Never commit private keys to version control
   - Use separate wallets for development and production
   - Monitor wallet activity regularly

## Development Guide

### Setting Up Development Environment

1. Clone the repository
2. Install dependencies:

```bash
pnpm install
```

3. Build the plugin:

```bash
pnpm run build
```

4. Run the plugin:

```bash
pnpm run dev
```

