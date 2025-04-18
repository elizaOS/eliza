# @elizaos/plugin-router-nitro

## Purpose

The Router Nitro plugin enables seamless cross-chain token transfers and wallet management across blockchains within the ElizaOS ecosystem.

## Key Features

- Cross-chain token transfers
- Wallet management across blockchains
- Efficient bridging of tokens
- Monitoring wallet balances
- Real-time transaction processing
- Price tracking

## Installation

```bash
bun install @elizaos/plugin-router-nitro
```

## Configuration

The plugin requires the following environment variables:

```typescript
ROUTER_NITRO_EVM_PRIVATE_KEY=<Your EVM-compatible private key>
ROUTER_NITRO_EVM_ADDRESS=<Router Nitro EVM bridge address>
```

## Integration

Import the plugin into ElizaOS:

```typescript
import { nitroPlugin } from '@elizaos/plugin-router-nitro';
```

## Example Usage

The plugin responds to natural language commands like:

- 'Bridge 50 USDC from Ethereum to Polygon on address 0xCCa8009f5e09F8C5dB63cb0031052F9CB635Af62'
- 'Send 1 ETH from Arb to Base'
