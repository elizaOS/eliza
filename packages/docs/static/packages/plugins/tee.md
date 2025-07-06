# @elizaos/plugin-tee

## Purpose

A plugin for handling Trusted Execution Environment (TEE) operations, providing secure key derivation and remote attestation capabilities.

## Key Features

- Generate secure keys within a TEE environment
- Derive Ed25519 keypairs for Solana
- Derive ECDSA keypairs for Ethereum
- Generate remote attestation quotes
- Manage wallet interactions with TEE-derived keys

## Installation

```bash
bun install @elizaos/plugin-tee
```

## Configuration

Environment variables:

```env
TEE_MODE=LOCAL|DOCKER|PRODUCTION
WALLET_SECRET_SALT=your_secret_salt  # Required for single agent deployments
DSTACK_SIMULATOR_ENDPOINT=your-endpoint-url  # Optional, for simulator purposes
```

## Integration

Import and register in Eliza configuration:

```typescript
import { teePlugin } from '@elizaos/plugin-tee';

export default {
  plugins: [teePlugin],
  // ... other configuration
};
```

## Example Usage

```typescript
import { DeriveKeyProvider, RemoteAttestationProvider } from '@elizaos/plugin-tee';

// Key derivation
const provider = new DeriveKeyProvider();
const solanaKeypair = await provider.deriveEd25519Keypair('/path/to/derive', 'subject-identifier');
const evmKeypair = await provider.deriveEcdsaKeypair('/path/to/derive', 'subject-identifier');

// Remote attestation
const raProvider = new RemoteAttestationProvider();
const attestation = await raProvider.generateAttestation('your-report-data');
```
