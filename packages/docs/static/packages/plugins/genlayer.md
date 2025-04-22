# @elizaos/plugin-genlayer

## Purpose

A plugin for interacting with the GenLayer protocol, enabling contract deployment, interactions, and transaction management.

## Installation

```bash
bun add @elizaos/plugin-genlayer
```

## Configuration

### Required Environment Variables

```env
GENLAYER_PRIVATE_KEY=your_private_key     # Required: Must start with 0x
GENLAYER_RPC_URL=your_rpc_url            # Optional: Defaults to https://studio.genlayer.com:8443/api
```

## Integration

Add the plugin to your character configuration:

```typescript
import { genLayerPlugin } from '@elizaos/plugin-genlayer';

const character = {
  plugins: [genLayerPlugin],
};
```

## Key Features

- Read contract state
- Write to contracts
- Deploy new contracts
- Get contract schemas
- Transaction management (details, status, nonces, receipts)

## Example Usage

- READ_CONTRACT: "Read the GenLayer contract at 0xE2632... by calling get_have_coin"
- WRITE_CONTRACT: "Write to the contract at 0xE2632... by calling set_value with argument 42"
- DEPLOY_CONTRACT: "Deploy a new contract from /path/to/contract.py with argument 'true'"
- GET_TRANSACTION: "Get transaction details for hash 0x1234..."
- GET_CURRENT_NONCE: "Get current nonce for address 0xE2632..."
- WAIT_FOR_TRANSACTION_RECEIPT: "Wait for receipt of transaction 0x1234..."
- GET_CONTRACT_SCHEMA: "Get contract schema for address 0xE2632..."
