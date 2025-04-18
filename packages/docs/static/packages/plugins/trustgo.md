# @toddli/plugin-trustgo

## Purpose

The TrustGo plugin enables fetching EVM account information from the TrustGo website and facilitates the minting of MEDIA score attestations.

## Key Features

- Login to TrustGo Website: Securely authenticate with TrustGo.
- Fetch Multi-Chain MEDIA Score: Retrieve MEDIA scores across multiple chains.
- Fetch User Attestations: Access user attestations.
- Mint L2 MEDIA Attestation: Mint MEDIA attestations on Layer 2.

## Installation

```bash
bun install @toddli/plugin-trustgo
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

## Integration

The TrustGo Provider integrates the EVM Wallet Provider, performing authentication, fetching MEDIA scores from multiple blockchain networks, displaying attestations, and minting attestations.

## Example Usage

```typescript
go trustgo
Show my onchain Reputation
show my attestations
mint my linea media score
```

## Links

https://trustgo.trustalabs.ai/
