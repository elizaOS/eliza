# @elizaos/plugin-router-nitro

A plugin for interacting with the Router Nitro bridge within the ElizaOS ecosystem.

## Description

The Router Nitro plugin enables seamless cross-chain token transfers and wallet management across blockchains. It supports efficient bridging of tokens and monitoring wallet balances, facilitating real-time transaction processing and price tracking.

## Installation

```bash
pnpm install @elizaos/plugin-router-nitro
```

## Configuration

The plugin requires the following environment variables to be set:

```typescript
ROUTER_NITRO_EVM_PRIVATE_KEY=<Your EVM-compatible private key>
ROUTER_NITRO_EVM_ADDRESS=<Router Nitro EVM bridge address>
```

## Usage

### Basic Integration

```typescript
import {
    nitroPlugin
} from "@elizaos/plugin-router-nitro";
```

### Transfer Examples

```typescript
// The plugin responds to natural language commands like:

"Bridge 50 USDC from Ethereum to Polygon on address 0xCCa8009f5e09F8C5dB63cb0031052F9CB635Af62";
"Send 1 ETH from Arb to Base"
```
