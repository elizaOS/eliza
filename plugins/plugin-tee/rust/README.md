# elizaos-plugin-tee (Rust)

Rust implementation of the elizaOS TEE Plugin for Trusted Execution Environment integration.

## Features

- 🔐 **Remote Attestation** - Prove agent execution in TEE
- 🔑 **Key Derivation** - Secure Ed25519 and ECDSA key derivation
- 🛡️ **Vendor Support** - Extensible vendor system (Phala Network)
- ⚡ **Async** - Full async/await support with Tokio
- 🔒 **Type Safe** - Strong Rust types with no unsafe code
- 🌐 **WASM** - Optional WebAssembly support

## Installation

Add to your `Cargo.toml`:

```toml
[dependencies]
elizaos-plugin-tee = "1.0"
```

## Quick Start

```rust
use elizaos_plugin_tee::{TEEService, TeeMode};

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    // Start the service
    let service = TEEService::start(Some("LOCAL"), None)?;

    // Derive Ed25519 keypair (for Solana)
    let solana_result = service
        .derive_ed25519_keypair("my-secret-salt", "solana", "agent-123")
        .await?;
    println!("Solana Public Key: {}", solana_result.public_key);

    // Derive ECDSA keypair (for EVM)
    let evm_result = service
        .derive_ecdsa_keypair("my-secret-salt", "evm", "agent-123")
        .await?;
    println!("EVM Address: {}", evm_result.address);

    // Stop the service
    service.stop();

    Ok(())
}
```

## Configuration

| Variable             | Description                                     | Required |
| -------------------- | ----------------------------------------------- | -------- |
| `TEE_MODE`           | Operation mode: `LOCAL`, `DOCKER`, `PRODUCTION` | Yes      |
| `WALLET_SECRET_SALT` | Secret for key derivation                       | Yes      |
| `TEE_VENDOR`         | Vendor name (default: `phala`)                  | No       |

## API Reference

### TEEService

Main service for TEE operations.

```rust
// Initialize
let service = TEEService::start(Some("LOCAL"), None)?;

// Derive keys
let ed25519 = service.derive_ed25519_keypair(path, subject, agent_id).await?;
let ecdsa = service.derive_ecdsa_keypair(path, subject, agent_id).await?;
let raw = service.raw_derive_key(path, subject).await?;

// Cleanup
service.stop();
```

### Remote Attestation

```rust
use elizaos_plugin_tee::{PhalaRemoteAttestationProvider, RemoteAttestationProvider};

// Using provider directly
let provider = PhalaRemoteAttestationProvider::new("LOCAL")?;
let quote = provider.generate_attestation(report_data, None).await?;
```

### Types

```rust
use elizaos_plugin_tee::{
    TeeMode,
    TeeVendor,
    RemoteAttestationQuote,
    Ed25519KeypairResult,
    EcdsaKeypairResult,
};
```

## Features

- `native` (default): Full async support with Tokio
- `wasm`: WebAssembly support for browser environments

```toml
# For WASM
elizaos-plugin-tee = { version = "1.0", default-features = false, features = ["wasm"] }
```

## Development

```bash
# Build
cargo build --release

# Test
cargo test

# Build WASM
wasm-pack build --target web

# Lint
cargo clippy --all-targets -- -D warnings
```

## License

MIT



