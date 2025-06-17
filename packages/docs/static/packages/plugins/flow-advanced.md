# @elizaos-plugins/plugin-flow-advanced

## Purpose

This plugin provides advanced functionality for the Flow Blockchain.

## Key Features

- Accounts management based on Account Linking feature
- Token Price Query for any token on Flow Blockchain
- Token Transfer from User's account to others' address
- Token Registration for any token on Flow Blockchain

## Installation

```bash
npx elizaos plugins add @elizaos-plugins/plugin-di
npx elizaos plugins add @elizaos-plugins/plugin-flow
npx elizaos plugins add @elizaos-plugins/plugin-flow-advanced
```

## Configuration

Environment variables:

```typescript
FLOW_ADDRESS=<Flow wallet address starting with 0x>
FLOW_PRIVATE_KEY=<Private key for the Flow wallet starting with 0x>
FLOW_NETWORK=<Network to connect to: "mainnet", "testnet", or "emulator" (optional, defaults to "mainnet")>
FLOW_ENDPOINT_URL=<Custom RPC endpoint URL (optional)>
```

## Integration

```typescript
import { advancedFlowPlugin } from '@elizaos-plugins/plugin-flow-advanced';
```

## Example Usage

```typescript
'Send 5 FLOW to 0xa51d7fe9e0080662';
'Send 1 FLOW - A.1654653399040a61.FlowToken to 0xa2de93114bae3e73';
'Send 1000 FROTH - 0xb73bf8e6a4477a952e0338e6cc00cc0ce5ad04ba to 0x000000000000000000000002e44fbfbd00395de5';
```
