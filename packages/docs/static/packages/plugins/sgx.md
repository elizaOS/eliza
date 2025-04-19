# SGX Plugin for Eliza

## Purpose

The SGX Plugin for Eliza enhances the platform by providing Intel SGX attestation capabilities within trusted execution environments (TEEs).

## Key Features

- Intel SGX attestation for confidential computing
- Supports Trusted Execution Environment (TEE) implementation
- Integration with Gramine Library OS for unmodified applications
- SGX remote attestation generation

## Components

- **sgxAttestationProvider**: Responsible for generating SGX remote attestations within Gramine SGX environments

## Integration

The provider `sgxAttestationProvider` is registered into Eliza through plugin-sgx when the environment variable `SGX` is set to `1`.

## Example Usage

```typescript
const sgxAttestationProvider = new SgxAttestationProvider();
const sgxAttestation = await sgxAttestationProvider.generateAttestation(userReport);
```

## Quick Start

```bash
# Start Eliza in SGX with default character
SGX=1 make start
# Start with specific character
SGX=1 make start -- --character "character/trump.character.json"
```

## Links

[Gramine Library OS](https://github.com/gramineproject/gramine)
[Gramine installation options](https://gramine.readthedocs.io/en/latest/installation.html)
