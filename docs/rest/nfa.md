---
title: NFA API
sidebarTitle: NFA
description: REST API endpoints for Non-Fungible Agent (NFA) token status and learning provenance.
---

<Info>
NFA endpoints depend on the optional `@elizaos/plugin-bnb-identity` plugin. When the plugin is not installed, these endpoints return graceful fallback responses instead of errors.
</Info>

## NFA status

```
GET /api/nfa/status
```

Returns the current NFA token status and on-chain identity registration. Reads from local state files to determine whether the agent has been minted as an NFA and/or registered on-chain.

**Response:**
```json
{
  "nfa": {
    "tokenId": "42",
    "contractAddress": "0x1234...abcd",
    "network": "bsc-testnet",
    "ownerAddress": "0xOwner...1234",
    "merkleRoot": "0xabc123...",
    "mintTxHash": "0xTxHash...",
    "mintedAt": "2026-03-15T10:30:00Z",
    "lastUpdatedAt": "2026-03-18T14:00:00Z",
    "bscscanUrl": "https://testnet.bscscan.com/tx/0xTxHash..."
  },
  "identity": {
    "agentId": "agent-uuid-1234",
    "network": "bsc-testnet",
    "ownerAddress": "0xOwner...1234",
    "agentURI": "https://example.com/agent/1234",
    "registeredAt": "2026-03-15T10:35:00Z",
    "scanUrl": "https://testnet.8004scan.io/agent/agent-uuid-1234"
  },
  "configured": true
}
```

| Field | Type | Description |
|-------|------|-------------|
| `nfa` | object \| null | NFA token details, or `null` if no NFA has been minted |
| `nfa.tokenId` | string | On-chain token ID |
| `nfa.contractAddress` | string | NFA contract address |
| `nfa.network` | string | Network name (`bsc` or `bsc-testnet`) |
| `nfa.ownerAddress` | string | Wallet address of the NFA owner |
| `nfa.merkleRoot` | string | Current Merkle root of the agent's learnings |
| `nfa.mintTxHash` | string | Transaction hash of the mint operation |
| `nfa.mintedAt` | string | ISO 8601 timestamp of when the NFA was minted |
| `nfa.lastUpdatedAt` | string | ISO 8601 timestamp of the last NFA update |
| `nfa.bscscanUrl` | string | Direct link to the mint transaction on BscScan |
| `identity` | object \| null | On-chain identity registration, or `null` if not registered |
| `identity.agentId` | string | Agent identifier |
| `identity.network` | string | Network name |
| `identity.ownerAddress` | string | Wallet address of the identity owner |
| `identity.agentURI` | string | URI pointing to the agent's profile |
| `identity.registeredAt` | string | ISO 8601 timestamp of registration |
| `identity.scanUrl` | string | Direct link to the agent on the registry explorer |
| `configured` | boolean | `true` when either an NFA record or identity record exists |

When neither an NFA nor an identity has been configured, the response returns `nfa: null`, `identity: null`, and `configured: false`.

---

## NFA learnings

```
GET /api/nfa/learnings
```

Returns parsed learning entries from the agent's `LEARNINGS.md` file along with a Merkle root computed over all entry hashes. The Merkle root can be compared against the on-chain value to verify learning provenance.

**Response:**
```json
{
  "entries": [
    { "hash": "0xabc123..." }
  ],
  "merkleRoot": "0xdef456...",
  "totalEntries": 1,
  "source": "/home/user/.eliza/LEARNINGS.md"
}
```

| Field | Type | Description |
|-------|------|-------------|
| `entries` | array | Parsed learning entries, each containing at least a `hash` field |
| `merkleRoot` | string | Merkle root computed from all entry hashes |
| `totalEntries` | number | Total number of parsed entries |
| `source` | string \| null | File path the learnings were read from, or `null` if no file was found |

The endpoint searches for `LEARNINGS.md` in two locations (in order): the Eliza state directory (`~/.eliza/LEARNINGS.md`) and the current working directory.

**Fallback behavior:** When the learnings file is not found or the `@elizaos/plugin-bnb-identity` plugin is not installed, the response returns an empty `entries` array, `totalEntries: 0`, `source: null`, and a default `merkleRoot`.
