# @elizaos/plugin-aptos

## Purpose

A plugin for interacting with the Aptos blockchain network within the ElizaOS ecosystem, enabling seamless token transfers and wallet management.

## Key Features

- Transfer APT tokens
- Monitor wallet balances
- Real-time price tracking
- Portfolio value calculation
- Cached wallet information (5-minute TTL)

## Installation

```bash
bun install @elizaos/plugin-aptos
```

## Configuration

Environment variables required:

```typescript
APTOS_PRIVATE_KEY=<Your Aptos private key>
APTOS_NETWORK=<"mainnet" | "testnet">
```

## Integration

The plugin responds to natural language commands like:

- 'Send 69 APT tokens to [address]'
- 'Transfer APT to [address]'
- 'Pay [amount] APT to [recipient]'

## Example Usage

```typescript
import { aptosPlugin, WalletProvider, TransferAptosToken } from '@elizaos/plugin-aptos';
```

## Links

- Aptos Documentation: https://aptos.dev/
- Move Language Guide: https://move-language.github.io/move/
- Petra Wallet Docs: https://petra.app/docs
- DexScreener API: https://docs.dexscreener.com/
