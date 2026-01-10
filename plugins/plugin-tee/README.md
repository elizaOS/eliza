# TEE Core Plugin for Eliza

The TEE Core Plugin for Eliza provides foundational capabilities for agents operating within a Trusted Execution Environment (TEE). It enables agents to perform remote attestation to prove their execution within a secure enclave and manage cryptographic keys securely.

## Background

For Eliza agents running in a TEE, it's crucial to demonstrate this secure execution environment to external parties. Remote attestation allows an agent to generate a verifiable report, proving it's running genuine code within a specific TEE (like Intel TDX). This plugin provides the mechanisms for agents to leverage these TEE features, enhancing trust and security. Secure key derivation within the TEE is also essential for managing sensitive cryptographic operations.

## Requirements

- A TEE-enabled environment is required (e.g., Intel TDX) use [Phala Cloud](https://cloud.phala.network) for easy deployment.
- Configuration within Eliza to enable and utilize this plugin's features.

The plugin requires the following environment variables:

```env
# For the environment you are running the TEE plugin. For local and container development, use `LOCAL` or `DOCKER`. For production deployments, use `PRODUCTION`.
TEE_MODE=LOCAL|DOCKER|PRODUCTION
# Secret salt for your default agent to generate a key from through the derive key provider
WALLET_SECRET_SALT=your_secret_salt
# TEE_VENDOR only supports Phala at this time, but adding a vendor is easy and can be done to support more TEE Vendors in the TEE Plugin
TEE_VENDOR=phala

## Features

This plugin offers the following core TEE functionalities:

1.  **Remote Attestation**:

    - Provides actions and providers (`remoteAttestationAction`, `remoteAttestationProvider`) allowing agents to request and receive remote attestation reports.
    - These reports can be presented to third parties to verify the agent's TEE residency.
    - Includes support for specific TEE vendors/attestation services (e.g., Phala Network).

2.  **Key Derivation**:
    - Offers a `deriveKeyProvider` for securely deriving cryptographic keys within the TEE.
    - Ensures that key material is generated and managed within the protected enclave memory.

## Components

Based on the source code (`src/`):

- **Actions**:
  - `remoteAttestationAction.ts`: Likely handles agent requests to initiate the remote attestation process.
- **Providers**:
  - `remoteAttestationProvider.ts`: Implements the logic for interacting with the underlying TEE platform or attestation service (like Phala) to generate the attestation report.
  - `deriveKeyProvider.ts`: Implements the logic for TEE-specific key derivation.
- **Services**
  - `service.ts`: TEE Service to allow agents to generate keys from `deriveKeyProvider` for EVM, Solana, and raw `DeriveKeyResponse` that will return the `key`, `certificate_chain` and the `Uint8Array` with `asUint8Array(max_length?: number)`.
- **Vendors**:
  - `vendors/phala.ts`: Contains specific implementation details for interacting with the Phala Network's attestation services.
  - `vendors/index.ts`, `vendors/types.ts`: Support vendor integration.
- **Utilities & Types**:
  - `utils.ts`, `types.ts`: Contain helper functions and type definitions for the plugin.
- **Tests**:
  - `__tests__/`: Includes unit tests for key derivation, remote attestation, etc.

## Usage

_(This section may need further refinement based on how the plugin is integrated into the core Eliza system)_

To utilize the features of this plugin:

1.  **Ensure the plugin is enabled** in your Eliza agent's configuration.
2.  **Configure the TEE vendor** (e.g., specify 'phala' if using Phala Network attestation) if required by the environment setup.
3.  **Call the relevant actions or services** provided by this plugin from other agent logic or plugins when remote attestation or secure key derivation is needed.

Example (Conceptual):

```typescript
import import { PhalaDeriveKeyProvider, PhalaRemoteAttestationProvider } from '@elizaos/tee-plugin';
// Assuming access to the runtime and its services/actions

// Requesting remote attestation
async function getAttestation(
  runtime: IAgentRuntime,
  userData: string
): Promise<AttestationReport | null> {
  try {
    const provider = new PhalaRemoteAttestationProvider(teeMode);

    const attestation = await provider.generateAttestation(userData);
    const attestationData = hexToUint8Array(attestation.quote);
    const raQuote = await uploadUint8Array(attestationData);
    return attestation;
  } catch (error) {
    console.error('Failed to get remote attestation:', error);
    return null;
  }
}

// Deriving a key
async function deriveAgentKeys(
  runtime: IAgentRuntime, salt: string
  ): Promise<ProviderResult | null> {
  try {
    // Potentially using a service/provider interface
    const provider = new PhalaDeriveKeyProvider(teeMode)
    const secretSalt = runtime.getSetting('WALLET_SECRET_SALT') || 'secret_salt';
    const solanaKeypair = await provider.deriveEd25519Keypair(secretSalt, 'solana', agentId);
    const evmKeypair = await provider.deriveEcdsaKeypair(secretSalt, 'evm', agentId);

    // Original data structure
    const walletData = {
      solana: solanaKeypair.keypair.publicKey,
      evm: evmKeypair.keypair.address,
    };

    // Values for template injection
    const values = {
      solana_public_key: solanaKeypair.keypair.publicKey.toString(),
      evm_address: evmKeypair.keypair.address,
    };

    // Text representation
    const text = `Solana Public Key: ${values.solana_public_key}\nEVM Address: ${values.evm_address}`;

    return {
      data: walletData,
      values: values,
      text: text,
    };
    return key;
  } catch (error) {
    console.error('Failed to derive key:', error);
    return null;
  }
}
```
