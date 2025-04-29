# Marlin TEE Plugin

## Purpose

A plugin for making agents on Eliza verifiable through the use of Trusted Execution Environments (TEEs).

## Configuration

Add the following to your `.env` file to enable the plugin:

```
TEE_MARLIN=yes
```

Optional configuration for the attestation server:

```
# Optional, default is http://127.0.0.1:1350
TEE_MARLIN_ATTESTATION_ENDPOINT="http://127.0.0.1:1350"
```

## Integration

The plugin leverages the Marlin Oyster platform and SDKs to provide the REMOTE_ATTESTATION action that fetches attestations from a server, allowing users to verify if an agent is running inside a TEE environment.

## Example Usage

```
You: attest yourself
```

The agent will respond with an attestation string that verifies its TEE environment.

## Links

- [Marlin Oyster](https://docs.marlin.org/user-guides/oyster/)
- [SDKs](https://github.com/marlinprotocol/oyster-monorepo)
- [Mock attestation server](https://github.com/marlinprotocol/oyster-monorepo/tree/master/attestation/server-custom-mock)
