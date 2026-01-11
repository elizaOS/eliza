# elizaos-plugin-tee (Python)

Python implementation of the elizaOS TEE Plugin for Trusted Execution Environment integration.

## Features

- 🔐 **Remote Attestation** - Prove agent execution in TEE
- 🔑 **Key Derivation** - Secure Ed25519 and ECDSA key derivation
- 🛡️ **Vendor Support** - Extensible vendor system (Phala Network)
- ⚡ **Async** - Full async/await support
- 🔒 **Type Safe** - Pydantic models with strict validation

## Installation

```bash
pip install elizaos-plugin-tee
```

## Quick Start

```python
from elizaos_plugin_tee import TEEService, TeeMode

# Start the service
service = await TEEService.start(tee_mode="LOCAL")

# Derive Ed25519 keypair (for Solana)
solana_result = await service.derive_ed25519_keypair(
    path="my-secret-salt",
    subject="solana",
    agent_id="agent-123"
)
print(f"Solana Public Key: {solana_result.public_key}")

# Derive ECDSA keypair (for EVM)
evm_result = await service.derive_ecdsa_keypair(
    path="my-secret-salt",
    subject="evm",
    agent_id="agent-123"
)
print(f"EVM Address: {evm_result.address}")

# Stop the service
await service.stop()
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

```python
# Initialize
service = await TEEService.start(tee_mode="LOCAL")

# Derive keys
await service.derive_ed25519_keypair(path, subject, agent_id)
await service.derive_ecdsa_keypair(path, subject, agent_id)
await service.raw_derive_key(path, subject)

# Cleanup
await service.stop()
```

### Remote Attestation

```python
from elizaos_plugin_tee import (
    PhalaRemoteAttestationProvider,
    handle_remote_attestation,
)

# Using provider directly
provider = PhalaRemoteAttestationProvider("LOCAL")
quote = await provider.generate_attestation(report_data)
await provider.close()

# Using action handler
result = await handle_remote_attestation(
    tee_mode="LOCAL",
    agent_id="agent-123",
    entity_id="entity-456",
    room_id="room-789",
    content="Message content"
)
```

### Types

```python
from elizaos_plugin_tee import (
    TeeMode,
    TeeVendor,
    RemoteAttestationQuote,
    Ed25519KeypairResult,
    EcdsaKeypairResult,
)
```

## Development

```bash
# Install dev dependencies
pip install -e ".[dev]"

# Run tests
pytest

# Type checking
mypy elizaos_plugin_tee

# Linting
ruff check .
ruff format .
```

## License

MIT



