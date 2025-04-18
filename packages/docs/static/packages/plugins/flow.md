# @elizaos/plugin-flow

## Purpose

A plugin for interacting with the Flow blockchain within the ElizaOS ecosystem, providing functionality for native FLOW token transfers, fungible token transfers, and EVM token interactions.

## Installation

```bash
bun install @elizaos/plugin-flow
```

## Configuration

The plugin requires environment variables:

```typescript
FLOW_ADDRESS=<Flow wallet address starting with 0x>
FLOW_PRIVATE_KEY=<Private key for the Flow wallet starting with 0x>
FLOW_NETWORK=<Network to connect to: "mainnet", "testnet", or "emulator" (optional, defaults to "mainnet")>
FLOW_ENDPOINT_URL=<Custom RPC endpoint URL (optional)>
```

## Integration

```typescript
import { flowPlugin } from '@elizaos/plugin-flow';
```

## Example Usage

```typescript
'Send 5 FLOW to 0xa51d7fe9e0080662';
'Send 1 FLOW - A.1654653399040a61.FlowToken to 0xa2de93114bae3e73';
'Send 1000 FROTH - 0xb73bf8e6a4477a952e0338e6cc00cc0ce5ad04ba to 0x000000000000000000000002e44fbfbd00395de5';
```

## Links

- [Flow Documentation](https://docs.onflow.org/)
- [Flow Developer Portal](https://developers.flow.com/)
- [Flow Block Explorer](https://flowscan.io/)
- [Cadence Documentation](https://docs.onflow.org/cadence/)
