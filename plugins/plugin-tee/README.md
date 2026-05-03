# @elizaos/plugin-tee

Multi-language Trusted Execution Environment (TEE) integration plugin for elizaOS, providing secure key management and remote attestation capabilities.

## 🌐 Multi-Language Support

This plugin is implemented in three languages for maximum flexibility:

| Language   | Package               | Registry  |
| ---------- | --------------------- | --------- |
| TypeScript | `@elizaos/plugin-tee` | npm       |
| Rust       | `elizaos-plugin-tee`  | crates.io |
| Python     | `elizaos-plugin-tee`  | PyPI      |

All implementations share the same API design and behavior.

## Features

- 🔐 **Remote Attestation** - Generate verifiable proofs that your agent is running in a secure TEE
- 🔑 **Key Derivation** - Securely derive Ed25519 (Solana) and ECDSA (EVM) keypairs within the TEE
- 🛡️ **Vendor Support** - Extensible vendor system (currently supports Phala Network)
- ⚡ **Type Safe** - Strong typing in all languages (TypeScript, Rust, Python/Pydantic)
- 🔒 **No Unsafe Code** - Rust implementation uses `#![deny(unsafe_code)]`

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

### Rust

```rust
use elizaos_plugin_tee::{TEEService, TeeMode};

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let service = TEEService::start(Some("LOCAL"), None)?;

    let solana = service.derive_ed25519_keypair("salt", "solana", "agent-id").await?;
    println!("Solana: {}", solana.public_key);

    let evm = service.derive_ecdsa_keypair("salt", "evm", "agent-id").await?;
    println!("EVM: {}", evm.address);

    Ok(())
}
```

### Python

```python
from elizaos_plugin_tee import TEEService, TeeMode

async def main():
    service = await TEEService.start(tee_mode="LOCAL")

    solana = await service.derive_ed25519_keypair("salt", "solana", "agent-id")
    print(f"Solana: {solana.public_key}")

    evm = await service.derive_ecdsa_keypair("salt", "evm", "agent-id")
    print(f"EVM: {evm.address}")

    await service.stop()
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
├── rust/                 # Rust implementation
│   ├── src/
│   │   ├── actions/      # Remote attestation action
│   │   ├── providers/    # Key derivation & attestation providers
│   │   ├── services/     # TEE service
│   │   ├── types.rs      # Type definitions
│   │   └── lib.rs        # Main entry point
│   ├── tests/            # Integration tests
│   └── Cargo.toml        # Crate manifest
├── python/               # Python implementation
│   ├── elizaos_plugin_tee/
│   │   ├── actions/      # Remote attestation action
│   │   ├── providers/    # Key derivation & attestation providers
│   │   ├── services/     # TEE service
│   │   ├── types.py      # Pydantic models
│   │   └── __init__.py   # Main entry point
│   ├── tests/            # Unit tests
│   └── pyproject.toml    # Package manifest
├── package.json          # NPM manifest
└── README.md             # This file
```

## Development

### Building

```bash
# TypeScript
bun run build

# Rust (native)
cd rust && cargo build --release

# Rust (WASM)
bun run build:rust:wasm

# Python (install in dev mode)
cd python && pip install -e ".[dev]"
```

### Testing

```bash
# TypeScript
bun run test

# Rust
bun run test:rust

# Python
bun run test:python

# All languages
bun run test:all
```

### Linting

```bash
# TypeScript
bun run format:check

# Rust
bun run lint:rust

# Python
bun run lint:python
```

## Requirements

- **TypeScript**: Node.js 18+ or Bun
- **Rust**: Rust 1.70+
- **Python**: Python 3.11+
- **TEE Environment**: Intel TDX-enabled environment or [Phala Cloud](https://cloud.phala.network) for production

## License

MIT

## Related Links

- [elizaOS Documentation](https://elizaos.ai/docs)
- [Phala Network](https://phala.network)
- [Intel TDX](https://www.intel.com/content/www/us/en/developer/tools/trust-domain-extensions/overview.html)
