# @toddli/plugin-trustgo

This elizaOS plugin provides actions and providers for interacting with trustgo - https://trustgo.trustalabs.ai/.

## Description

The TrustGo plugin enables fetching EVM account information from the TrustGo website and facilitates the minting of MEDIA score attestations.

## Features

- Login to TrustGo Website: Securely authenticate with TrustGo.
- Fetch Multi-Chain MEDIA Score: Retrieve MEDIA scores across multiple chains.
- Fetch User Attestations: Access user attestations.
- Mint L2 MEDIA Attestation: Mint MEDIA attestations on Layer 2.

## Installation

```bash
pnpm install @toddli/plugin-trustgo
```

## Configuration

### Dependencies

```
@elizaos/core
@elizaos/plugin-evm
```

### Required Environment Variables

```env
# Required
EVM_PRIVATE_KEY=your-private-key

```

## Provider

The TrustGo Provider integrates the EVM Wallet Provider. It performs the following functions:

- Login to TrustGo Website: Authenticate and log in to the TrustGo platform.
- Fetch Multi-Chain MEDIA Score: Retrieve MEDIA scores from multiple blockchain networks.
- List User Attestations: Display user attestations.
- Mint MEDIA Attestation: Mint MEDIA attestations on the blockchain.


## Actions

### 1. account

Fetch account information from the TrustGo website.

```typescript
go trustgo
```

### 2. reputation

Display the user's MEDIA score.

```typescript
Show my onchain Reputation
```

### 3. attestation

List the user's attestations.

```typescript
show my attestations
```

### 4. mint attestation

Mint an on-chain reputation attestation.


```typescript
mint my linea media score
```