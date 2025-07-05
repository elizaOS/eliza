# @elizaos/plugin-attps

## Purpose

Foundation plugin that enables advanced agent interactions, data verification, and price queries on the Eliza OS platform.

## Key Features

- **Agent Operations**: Creation, registration, multi-signer framework
- **Data Verification**: Chain validation, transaction execution, auto-hashing, metadata parsing
- **Price Queries**: Live price data, format validation, APIs integration
- **Security Features**: Access control, verification

## Installation

```bash
bun install @elizaos/plugin-attps
```

## Configuration

Configure with environment variables:

- ATTPS_RPC_URL
- ATTPS_PROXY_ADDRESS
- ATTPS_PRIVATE_KEY
- ATTPS_CONVERTER_ADDRESS
- ATTPS_AUTO_HASH_DATA

## Integration

Initializes within the Eliza runtime system using the provided plugin architecture.

## Example Usage

```typescript
import { attpsPlugin } from '@elizaos/plugin-attps';

// Initialize the plugin
const runtime = await initializeRuntime({
  plugins: [attpsPlugin],
});

// Actions: CREATE_AND_REGISTER_AGENT, VERIFY, PRICE_QUERY
```

## Links

- [Apro Documentation](https://docs.apro.com/en)
