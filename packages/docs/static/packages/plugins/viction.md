# @elizaos/plugin-viction

## Purpose

Core Viction blockchain plugin for Eliza OS that provides essential services and actions for token operations, trading, and DeFi integrations.

## Key Features

- **Token Information**: Provide Viction information
- **Token Transfers**: Send and receive tokens securely native and non-native

## Installation

```bash
bun install @elizaos/plugin-viction
```

## Configuration

```typescript
const victionEnvSchema = {
  VICTION_ADDRESS: string,
  VICTION_PRIVATE_KEY: string,
  VICTION_RPC_URL: string,
};
```

## Integration

Serves as a foundational component of Eliza OS, bridging Viction blockchain capabilities with the Eliza ecosystem.

## Example Usage

```typescript
import { victionPlugin } from '@elizaos/plugin-viction';

// Initialize the plugin
const runtime = await initializeRuntime({
  plugins: [victionPlugin],
});

// Get Viction information
const result = await runtime.executeAction('GIVE_VICTION_INFOMATION', {});

// Transfer VIC
const result = await runtime.executeAction('SEND_VIC', {
  recipient: 'RecipientAddressHere',
  amount: '1000',
});

// Transfer tokens
const result = await runtime.executeAction("SEND_TOKEN", {
    recipient: "RecipientAddressHere",
    tokenAddress: "TokenAddressHere"
    amount: "1000",
});
```
