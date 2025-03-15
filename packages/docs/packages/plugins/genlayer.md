# @elizaos/plugin-genlayer

A plugin for interacting with the GenLayer protocol, enabling contract deployment, interactions, and transaction management.

## Installation

```bash
pnpm add @elizaos/plugin-genlayer
```

## Configuration

### Required Environment Variables

```env
GENLAYER_PRIVATE_KEY=your_private_key     # Required: Must start with 0x
GENLAYER_RPC_URL=your_rpc_url            # Optional: Defaults to https://studio.genlayer.com:8443/api
```

## Usage

Add the plugin to your character configuration:

```typescript
import { genLayerPlugin } from "@elizaos/plugin-genlayer";

const character = {
    plugins: [genLayerPlugin]
};
```

## Features

### Contract Operations
- Read contract state
- Write to contracts
- Deploy new contracts
- Get contract schemas

### Transaction Management
- Get transaction details
- Monitor transaction status
- Track nonces
- Wait for transaction receipts

## Available Actions

### READ_CONTRACT
Read state from a contract:
```plaintext
"Read the GenLayer contract at 0xE2632... by calling get_have_coin"
```

### WRITE_CONTRACT
Write to a contract:
```plaintext
"Write to the contract at 0xE2632... by calling set_value with argument 42"
```

### DEPLOY_CONTRACT
Deploy a new contract:
```plaintext
"Deploy a new contract from /path/to/contract.py with argument 'true'"
```

### GET_TRANSACTION
Get transaction details:
```plaintext
"Get transaction details for hash 0x1234..."
```

### GET_CURRENT_NONCE
Get current nonce for an address:
```plaintext
"Get current nonce for address 0xE2632..."
```

### WAIT_FOR_TRANSACTION_RECEIPT
Wait for a transaction to be confirmed:
```plaintext
"Wait for receipt of transaction 0x1234..."
```

### GET_CONTRACT_SCHEMA
Get the schema for a deployed contract:
```plaintext
"Get contract schema for address 0xE2632..."
```

## Provider

### ClientProvider
Manages connection to GenLayer protocol:
- Creates and manages client instance
- Handles authentication with private key
- Provides client interface for all actions

## Dependencies

- genlayer-js: 0.4.7
- @elizaos/core: workspace:*
