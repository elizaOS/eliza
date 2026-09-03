---
title: Local Deterministic Memory with Vanguard Memory Node
description: Use @lnes/vanguard-memory-node as an offline-first, BM25-based MCP memory backend for Eliza agents — no API keys, no cloud, deterministic retrieval.
---

# Local Deterministic Memory with Vanguard Memory Node

[Vanguard Memory Node (VMN)](https://www.npmjs.com/package/@lnes/vanguard-memory-node) is an
offline-first MCP server that gives Eliza agents persistent, deterministic memory — without
a vector database, without a cloud account, and without an API key.

## Why Deterministic Memory

Eliza's built-in memory uses vector embeddings. Embedding-based retrieval is powerful for
semantic search, but it has one important property: **the same query can return different
results as the underlying model updates**. For agents that need to recall verified facts
consistently — compliance workflows, multi-agent coordination, financial decisions — this
non-determinism is a correctness risk.

VMN uses a sharded BM25 inverted index with stemming, alias expansion, and Unicode
normalization. The retrieval guarantee: **same query → same ranked result, always.**

| | Eliza default memory | VMN |
|---|---|---|
| Retrieval method | Vector / embedding | BM25 lexical |
| Deterministic results | No | Yes |
| Cloud dependency | Varies by provider | None |
| Offline capable | Varies | Yes |
| API key required | Usually | No |
| Per-shard identity | No | SHA-256 |

---

## Install

```bash
# No install required — npx runs VMN on demand
npx @lnes/vanguard-memory-node

# Or install globally
npm install -g @lnes/vanguard-memory-node
```

**Requirements:** Node.js 18+

---

## Add VMN to Your Eliza Agent

Add `@lnes/vanguard-memory-node` to your agent's `mcpServers` configuration:

```json
{
  "mcpServers": {
    "vanguard-memory": {
      "command": "npx",
      "args": ["-y", "@lnes/vanguard-memory-node"]
    }
  }
}
```

That's it. VMN starts as a child process on your local machine, stores shards to
`~/.vmn/` by default, and exposes 11 tools to your Eliza agent.

### Custom vault path

```json
{
  "mcpServers": {
    "vanguard-memory": {
      "command": "npx",
      "args": ["-y", "@lnes/vanguard-memory-node"],
      "env": {
        "VMN_VAULT_PATH": "/path/to/your/vault"
      }
    }
  }
}
```

---

## Available Tools (11)

Your Eliza agent can call these tools directly:

| Tool | What it does |
|---|---|
| `vmn_ingest` | Store text as a SHA-256 shard with BM25 indexing |
| `vmn_search` | Full-vault keyword search with ranked results |
| `vmn_recall` | Retrieve evidence windows from a specific shard |
| `vmn_ingest_file` | Delta-ingest a growing file without re-ingesting old content |
| `vmn_list` | List all memory objects in the vault |
| `vmn_inspect` | Metadata for a specific shard |
| `vmn_delete` | Remove a shard and its index entries |
| `vmn_stats` | Aggregate vault statistics |
| `vmn_index_status` | BM25 index health report |
| `vmn_rebuild_index` | Rebuild the full sharded inverted index |
| `vmn_sync_vault` | Sync shards to ExergyNet LNES-17 for on-chain attestation |

---

## Example: Agent That Remembers Decisions

```typescript
// In your agent character or action handler:

// Store a decision
await runtime.mcpClient.callTool("vanguard-memory", "vmn_ingest", {
  content: "Deployment decision 2026-09-02: contract 0xABCD is canonical production address. Verified on-chain.",
  tags: ["deployment", "contract", "verified"]
});

// Recall it later — deterministically, even after model updates
const results = await runtime.mcpClient.callTool("vanguard-memory", "vmn_search", {
  query: "production contract address deployment",
  top_k: 3
});
```

---

## Persistent Memory Across Sessions

VMN stores shards on disk — memory survives agent restarts and persists across
sessions automatically. To share memory across multiple agent instances:

```json
{
  "mcpServers": {
    "vanguard-memory": {
      "command": "npx",
      "args": ["-y", "@lnes/vanguard-memory-node"],
      "env": {
        "VMN_VAULT_PATH": "/shared/team-vault"
      }
    }
  }
}
```

---

## Optional: On-Chain Memory Attestation

For regulated or multi-party workflows, `vmn_sync_vault` anchors shard hashes to
the ExergyNet LNES-17 ledger — making the agent's memory state independently
verifiable by any third party:

```json
{
  "mcpServers": {
    "vanguard-memory": {
      "command": "npx",
      "args": ["-y", "@lnes/vanguard-memory-node"],
      "env": {
        "LNES17_API_KEY": "<your-key>",
        "LNES17_NETWORK": "mainnet"
      }
    }
  }
}
```

---

## Further Reading

- [npm package](https://www.npmjs.com/package/@lnes/vanguard-memory-node)
- [GitHub repository](https://github.com/ezumba/vanguard-memory-node)
- [ExergyNet documentation](https://exergynet.org)
