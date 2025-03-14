# @elizaos/plugin-dcap

A plugin for verifying DCAP attestation on-chain built based on the [automata-dcap-attestation](https://github.com/automata-network/automata-dcap-attestation).

## Features

This plugin provides the following features:
- Generate DCAP attestation on TDX using the `remoteAttestationProvider` provided by the [plugin-tee](https://github.com/elizaOS/eliza/tree/develop/packages/plugin-tee).
- Generate DCAP attestation on SGX using the `sgxAttestationProvider` provided by the [plugin-sgx](https://github.com/elizaOS/eliza/tree/develop/packages/plugin-sgx).
- Submit and verify DCAP attestation on-chain.

## Future Features (coming soon)
- Support to verify DCAP attestation on more EVM networks.
- Support to verify DCAP attestation on Solana.
- Support to verify DCAP attestation using ZKVM and verify the zk proof on-chain.
- Support to topup the wallet before submitting the DCAP attestation on testnets.

## Installation

```bash
pnpm install @elizaos/plugin-dcap
```

## Configuration
1. Set up your environment variables:
```env
EVM_PRIVATE_KEY=your-private-key-here
DCAP_MODE=PLUGIN-SGX|PLUGIN-TEE|MOCK
```
The EVM_PRIVATE_KEY used to submit the DCAP attestation on evm networks, please make sure it has enough balance to pay for the transaction fee.

The DCAP_MODE is used to specify the mode of generating DCAP attestation, it can be:
- PLUGIN-SGX: Use the `sgxAttestationProvider` in `plugin-sgx` to generate the DCAP attestation.
- PLUGIN-TEE: Use the `remoteAttestationProvider` in `plugin-tee` to generate the DCAP attestation.
- MOCK: Use a predefined attestation, this option is only for testing purposes.

Check the docs of `plugin-sgx` and `plugin-tee` for how to run your agent in TEE before using the SGX or TDX mode.

2. Register the plugin in your Eliza configuration:
```typescript
import { dcapPlugin } from "@elizaos/plugin-dcap";

// In your Eliza configuration
plugins: [
    dcapPlugin,
    // ... other plugins
];
```

## Usage
The plugin provides an action `dcapOnChainVerifyAction` which will be triggered by natural languages like:
```plaintext
"Verify the DCAP attestation on-chain"
"Generate a DCAP attestation and verify it on-chain"
"DCAP_ON_CHAIN" # The keyword will also trigger the action
```

## Development

1. Clone the repository
2. Install dependencies:

```bash
pnpm install
```

3. Build the plugin:

```bash
pnpm run build
```

4. Run tests:

```bash
pnpm test
```

We are welcom to any feedback and contributions!

## Credits
- [Automata Network](https://ata.network): Provided the on-chain DCAP verification, enabling the decentralized verification of TEE attestations.
- [Phala Network](https://phala.network): Provided support for running agents in TDX environment and contributed the `plugin-tee` for generating DCAP attestation on TDX.
- [Gramine](https://gramineproject.io/): Provided support for running agents in SGX environment.

## License

This plugin is part of the Eliza project. See the main project repository for license information.
