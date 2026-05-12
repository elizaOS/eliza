# @elizaos/plugin-tee

Trusted Execution Environment (TEE) integration plugin for elizaOS, providing secure key management and remote attestation capabilities.

## Features

- 🔐 **Remote Attestation** - Generate verifiable proofs that your agent is running in a secure TEE
- 🔑 **Key Derivation** - Securely derive Ed25519 (Solana) and ECDSA (EVM) keypairs within the TEE
- 🛡️ **Vendor Support** - Extensible vendor system (currently supports Phala Network)
- ⚡ **Type Safe** - Strong typing with TypeScript

## Quick Start

### TypeScript

```typescript
import { teePlugin, TEEService } from "@elizaos/plugin-tee";
import { AgentRuntime } from "@elizaos/core";

// Register the plugin
const runtime = new AgentRuntime({
  plugins: [teePlugin],
});

// Or use the service directly
const service = await TEEService.start(runtime);
const solanaKeys = await service.deriveEd25519Keypair(
  "salt",
  "solana",
  agentId,
);
const evmKeys = await service.deriveEcdsaKeypair("salt", "evm", agentId);
```
## Configuration

### Environment Variables

| Variable             | Description                                     | Required | Default |
| -------------------- | ----------------------------------------------- | -------- | ------- |
| `TEE_MODE`           | Operation mode: `LOCAL`, `DOCKER`, `PRODUCTION` | Yes      | -       |
| `WALLET_SECRET_SALT` | Secret salt for deterministic key derivation    | Yes      | -       |
| `TEE_VENDOR`         | TEE vendor to use                               | No       | `phala` |

### TEE Modes

- **LOCAL**: Development mode using simulator at `localhost:8090`
- **DOCKER**: Docker development mode using simulator at `host.docker.internal:8090`
- **PRODUCTION**: Production mode connecting to real TEE infrastructure

## Components

### Actions

| Action               | Description                                                           |
| -------------------- | --------------------------------------------------------------------- |
| `REMOTE_ATTESTATION` | Generate and upload a remote attestation quote to prove TEE execution |

### Providers

| Provider                   | Description                                     |
| -------------------------- | ----------------------------------------------- |
| `phala-derive-key`         | Derive Solana and EVM keypairs with attestation |
| `phala-remote-attestation` | Generate remote attestation quotes              |

### Services

| Service      | Description                                    |
| ------------ | ---------------------------------------------- |
| `TEEService` | Main service for key derivation and management |

## API Reference

### TEEService

```typescript
class TEEService {
  // Derive Ed25519 keypair for Solana
  async deriveEd25519Keypair(
    path: string,
    subject: string,
    agentId: UUID,
  ): Promise<{ keypair: Keypair; attestation: RemoteAttestationQuote }>;

  // Derive ECDSA keypair for EVM
  async deriveEcdsaKeypair(
    path: string,
    subject: string,
    agentId: UUID,
  ): Promise<{
    keypair: PrivateKeyAccount;
    attestation: RemoteAttestationQuote;
  }>;

  // Derive raw key for custom use cases
  async rawDeriveKey(path: string, subject: string): Promise<DeriveKeyResponse>;
}
```

### Remote Attestation

```typescript
class PhalaRemoteAttestationProvider {
  // Generate attestation quote
  async generateAttestation(
    reportData: string,
    hashAlgorithm?: TdxQuoteHashAlgorithm,
  ): Promise<RemoteAttestationQuote>;
}
```

## Directory Structure

```
plugins/plugin-tee/
├── typescript/           # TypeScript implementation
│   ├── src/
│   │   ├── actions/      # Remote attestation action
│   │   ├── providers/    # Key derivation & attestation providers
│   │   ├── services/     # TEE service
│   │   ├── types/        # Type definitions
│   │   ├── vendors/      # Vendor implementations
│   │   └── index.ts      # Main entry point
│   └── __tests__/        # Unit tests
├── package.json          # NPM manifest
└── README.md             # This file
```

## Development

### Building

```bash
bun run build
bun run test
```

### Linting

```bash
# TypeScript
bun run format:check