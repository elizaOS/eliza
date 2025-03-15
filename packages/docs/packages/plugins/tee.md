# @elizaos/plugin-tee

A plugin for handling Trusted Execution Environment (TEE) operations, providing secure key derivation and remote attestation capabilities.

## Overview

This plugin provides functionality to:

- Generate secure keys within a TEE environment
- Derive Ed25519 keypairs for Solana
- Derive ECDSA keypairs for Ethereum
- Generate remote attestation quotes
- Manage wallet interactions with TEE-derived keys

## Installation

```bash
npm install @elizaos/plugin-tee
```

## Configuration

The plugin requires the following environment variables:

```env
TEE_MODE=LOCAL|DOCKER|PRODUCTION
WALLET_SECRET_SALT=your_secret_salt  # Required for single agent deployments
DSTACK_SIMULATOR_ENDPOINT=your-endpoint-url  # Optional, for simulator purposes
```

## Usage

Import and register the plugin in your Eliza configuration:

```typescript
import { teePlugin } from "@elizaos/plugin-tee";

export default {
    plugins: [teePlugin],
    // ... other configuration
};
```

## Features

### DeriveKeyProvider

The `DeriveKeyProvider` allows for secure key derivation within a TEE environment:

```typescript
import { DeriveKeyProvider } from "@elizaos/plugin-tee";

// Initialize the provider
const provider = new DeriveKeyProvider();

// Derive a raw key
const rawKey = await provider.rawDeriveKey(
    "/path/to/derive",
    "subject-identifier"
);
// rawKey is a DeriveKeyResponse that can be used for further processing
const rawKeyArray = rawKey.asUint8Array();

// Derive a Solana keypair (Ed25519)
const solanaKeypair = await provider.deriveEd25519Keypair(
    "/path/to/derive",
    "subject-identifier"
);

// Derive an Ethereum keypair (ECDSA)
const evmKeypair = await provider.deriveEcdsaKeypair(
    "/path/to/derive",
    "subject-identifier"
);
```

### RemoteAttestationProvider

The `RemoteAttestationProvider` generates remote attestations within a TEE environment:

```typescript
import { RemoteAttestationProvider } from "@elizaos/plugin-tee";

const provider = new RemoteAttestationProvider();
const attestation = await provider.generateAttestation("your-report-data");
```

## Development

### Building

```bash
npm run build
```

### Testing

```bash
npm run test
```

## Local Development

To get a TEE simulator for local testing, use the following commands:

```bash
docker pull phalanetwork/tappd-simulator:latest
# by default the simulator is available in localhost:8090
docker run --rm -p 8090:8090 phalanetwork/tappd-simulator:latest
```

## Dependencies

- `@phala/dstack-sdk`: Core TEE functionality
- `@solana/web3.js`: Solana blockchain interaction
- `viem`: Ethereum interaction library
- Other standard dependencies listed in package.json

## API Reference

### Providers

- `deriveKeyProvider`: Manages secure key derivation within TEE
- `remoteAttestationProvider`: Handles generation of remote attestation quotes
- `walletProvider`: Manages wallet interactions with TEE-derived keys

### Types

```typescript
enum TEEMode {
    OFF = "OFF",
    LOCAL = "LOCAL", // For local development with simulator
    DOCKER = "DOCKER", // For docker development with simulator
    PRODUCTION = "PRODUCTION", // For production without simulator
}

interface RemoteAttestationQuote {
    quote: string;
    timestamp: number;
}
```

## Future Enhancements

1. **Key Management**

    - Advanced key derivation schemes
    - Multi-party computation support
    - Key rotation automation
    - Backup and recovery systems
    - Hardware security module integration
    - Custom derivation paths

2. **Remote Attestation**

    - Enhanced quote verification
    - Multiple TEE provider support
    - Automated attestation renewal
    - Policy management system
    - Compliance reporting
    - Audit trail generation

3. **Security Features**

    - Memory encryption improvements
    - Side-channel protection
    - Secure state management
    - Access control systems
    - Threat detection
    - Security monitoring

4. **Chain Integration**

    - Multi-chain support expansion
    - Cross-chain attestation
    - Chain-specific optimizations
    - Custom signing schemes
    - Transaction privacy
    - Bridge security

5. **Developer Tools**

    - Enhanced debugging capabilities
    - Testing framework
    - Simulation environment
    - Documentation generator
    - Performance profiling
    - Integration templates

6. **Performance Optimization**
    - Parallel processing
    - Caching mechanisms
    - Resource management
    - Latency reduction
    - Throughput improvements
    - Load balancing

We welcome community feedback and contributions to help prioritize these enhancements.

## Contributing

Contributions are welcome! Please see the CONTRIBUTING.md file for more information.

## Credits

This plugin integrates with and builds upon several key technologies:

- [Phala Network](https://phala.network/): Confidential smart contract platform
- [@phala/dstack-sdk](https://www.npmjs.com/package/@phala/dstack-sdk): Core TEE functionality
- [@solana/web3.js](https://www.npmjs.com/package/@solana/web3.js): Solana blockchain interaction
- [viem](https://www.npmjs.com/package/viem): Ethereum interaction library
- [Intel SGX](https://www.intel.com/content/www/us/en/developer/tools/software-guard-extensions/overview.html): Trusted Execution Environment technology

Special thanks to:

- The Phala Network team for their TEE infrastructure
- The Intel SGX team for TEE technology
- The dStack SDK maintainers
- The Eliza community for their contributions and feedback

For more information about TEE capabilities:

- [Phala Documentation](https://docs.phala.network/)
- [Intel SGX Documentation](https://www.intel.com/content/www/us/en/developer/tools/software-guard-extensions/documentation.html)
- [TEE Security Best Practices](https://docs.phala.network/developers/phat-contract/security-notes)
- [dStack SDK Reference](https://docs.phala.network/developers/dstack-sdk)

## License

This plugin is part of the Eliza project. See the main project repository for license information.
