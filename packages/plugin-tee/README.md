# TEE Core Plugin for Eliza

The TEE Core Plugin for Eliza provides foundational capabilities for agents operating within a Trusted Execution Environment (TEE). It enables agents to perform remote attestation to prove their execution within a secure enclave and manage cryptographic keys securely.

## Background

For Eliza agents running in a TEE, it's crucial to demonstrate this secure execution environment to external parties. Remote attestation allows an agent to generate a verifiable report, proving it's running genuine code within a specific TEE (like Intel TDX). This plugin provides the mechanisms for agents to leverage these TEE features, enhancing trust and security. Secure key derivation within the TEE is also essential for managing sensitive cryptographic operations.

## Requirements

- A TEE-enabled environment is required (e.g., Intel TDX).
- Configuration within Eliza to enable and utilize this plugin's features.

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
// Assuming access to the runtime and its services/actions

// Requesting remote attestation
async function getAttestation(
  runtime: IAgentRuntime,
  userData: string
): Promise<AttestationReport | null> {
  try {
    // Potentially using an action defined by this plugin
    const report = await runtime.invokeAction('tee/getRemoteAttestation', { userData });
    console.log('Received attestation report:', report);
    return report;
  } catch (error) {
    console.error('Failed to get remote attestation:', error);
    return null;
  }
}

// Deriving a key
async function deriveAgentKey(runtime: IAgentRuntime, salt: string): Promise<CryptoKey | null> {
  try {
    // Potentially using a service/provider interface
    const keyProvider = runtime.getService<IDeriveKeyProvider>(/* ServiceType or ID */);
    const key = await keyProvider.deriveKey(salt);
    console.log('Derived key successfully.');
    return key;
  } catch (error) {
    console.error('Failed to derive key:', error);
    return null;
  }
}
```

**Note:** The exact method calls (`invokeAction`, `getService`, service types/IDs) are illustrative and depend on the final integration pattern within Eliza.
