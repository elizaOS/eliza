# @elizaos/plugin-dcap

## Purpose

A plugin for verifying DCAP attestation on-chain built based on the automata-dcap-attestation.

## Key Features

- Generate DCAP attestation on TDX using the `remoteAttestationProvider` from plugin-tee
- Generate DCAP attestation on SGX using the `sgxAttestationProvider` from plugin-sgx
- Submit and verify DCAP attestation on-chain

## Installation

```bash
bun install @elizaos/plugin-dcap
```

## Configuration

1. Set up environment variables:

```env
EVM_PRIVATE_KEY=your-private-key-here
DCAP_MODE=PLUGIN-SGX|PLUGIN-TEE|MOCK
```

2. Register the plugin:

```typescript
import { dcapPlugin } from '@elizaos/plugin-dcap';

// In your Eliza configuration
plugins: [
  dcapPlugin,
  // ... other plugins
];
```

## Integration

The plugin provides an action `dcapOnChainVerifyAction` triggered by natural language phrases like "Verify the DCAP attestation on-chain" or the keyword "DCAP_ON_CHAIN".

## Credits

- Automata Network: Provided on-chain DCAP verification
- Phala Network: Provided TDX environment support and plugin-tee
- Gramine: Provided SGX environment support
