
---

## Cross-Chain Registry Strategy

**Requirement:** True interoperability across Base, Ethereum, BSC, and Solana.

### EVM Chains (Base, Ethereum, BSC, Arbitrum, Polygon)

ERC-8004 uses CREATE2 deterministic deployment — the same contract address exists on every EVM chain. An agent registered on Base can be verified on Ethereum or BSC by querying the same contract address on that chain.

**Steward's approach:**
- **Primary registry:** Base (cheap gas, sub-cent per registration)
- **Mirror registries:** Ethereum + BSC + Arbitrum (for platforms on those chains)
- **Cross-chain attestation:** When an agent registers on Base, steward can optionally mirror the registration to other chains via a batch relay
- **Reputation aggregation:** Reputation signals from ALL chains feed into a unified score

| Chain | Registry Address | Gas Cost | Use Case |
|-------|-----------------|----------|----------|
| Base | 0x8004...A432 | ~$0.001 | Primary (default) |
| Ethereum | 0x8004...A432 | ~$2-5 | High-value agents needing L1 trust |
| BSC | 0x8004...A432 | ~$0.05 | BSC-native platforms |
| Arbitrum | 0x8004...A432 | ~$0.01 | Arbitrum ecosystem |

### Solana

Solana is NOT EVM, so ERC-8004 contracts don't deploy there. Two options:

**Option A: Bridge/Attestation (recommended)**
- Agent registers on Base (EVM, ERC-8004 native)
- A Wormhole/LayerZero attestation proves the Base registration on Solana
- Solana programs can verify the attestation
- Reputation: post on EVM, attest to Solana

**Option B: Solana-native registry (future)**
- Deploy a Solana program that mirrors the ERC-8004 interface
- Same agent card JSON schema, different on-chain implementation
- Cross-chain linking via shared agentId + multi-chain identity proof

**Steward already supports Solana wallets** (chain_family: "solana" in the DB). Adding Solana attestation is a natural extension.

### Universal Agent ID

Every steward agent gets a cross-chain identifier:

```
steward:{tenantId}:{agentId}
```

This maps to ERC-8004's format:

```
eip155:{chainId}:{registryAddress}:{tokenId}
```

Steward maintains the mapping between its internal ID and all on-chain registrations:

| Internal ID | Base Registration | Ethereum Registration | Solana Attestation |
|------------|-------------------|----------------------|--------------------|
| `agent-123` | `eip155:8453:0x8004...A432:42` | `eip155:1:0x8004...A432:42` | `wormhole:attestation:...` |

### Per-Tenant Chain Selection

Tenants can configure which chains to register on:

```json
{
  "registryConfig": {
    "primaryChain": 8453,
    "mirrorChains": [1, 56],
    "solanaAttestation": true,
    "customRegistryAddress": null
  }
}
```

Default: Base only. Tenants can opt into multi-chain at their own gas cost.
