# @elizaos/plugin-trikon

## Purpose

Trikon plugin for Eliza OS that provides token transfer functionality as a Proof of Concept (POC) implementation for Trikon token transfers within the Eliza ecosystem.

## Key Features

- Basic token transfer capabilities
- Wallet management

## Installation

```
bun add @elizaos/plugin-trikon
```

## Configuration

The plugin requires the following environment variables:

- `TRIKON_WALLET_ADDRESS`: Your Trikon wallet address (must be a valid 64-character hex string starting with '0x')
- `TRIKON_INITIAL_BALANCE`: (Optional) The initial balance for the wallet. Defaults to "0" if not provided.

## Integration

```typescript
import { trikonPlugin } from '@elizaos/plugin-trikon';

const eliza = new ElizaOS({
  plugins: [trikonPlugin],
});
```
