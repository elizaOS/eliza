---
title: Local Deterministic Memory with Vanguard Memory Node
description: Use @lnes/vanguard-memory-node as an offline-first, BM25-based MCP memory backend for Eliza agents — no API keys, no cloud, deterministic retrieval.
---

# Local Deterministic Memory with Vanguard Memory Node

> **Disclosure:** This guide covers [`@lnes/vanguard-memory-node`](https://www.npmjs.com/package/@lnes/vanguard-memory-node), a package published by the PR author. It is submitted as a community resource, not an official elizaOS endorsement. Maintainer sign-off on third-party inclusion is at the maintainers' discretion.

[Vanguard Memory Node (VMN)](https://www.npmjs.com/package/@lnes/vanguard-memory-node) is an
offline-first MCP server that gives Eliza agents persistent, deterministic memory — without
a vector database, without a cloud account, and without an API key.

## Why Deterministic Memory

Eliza's built-in memory uses vector embeddings. Embedding-based retrieval is powerful for
semantic search, but the same query can return different results as the underlying model
updates. For agents that need to recall verified facts consistently — compliance workflows,
multi-agent coordination, financial decisions — this non-determinism is a correctness risk.

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

## Add VMN to Your Eliza Character

Add `@lnes/vanguard-memory-node` to your character file under `settings.mcp.servers`.
elizaOS reads MCP servers from `settings.mcp.servers` (not a top-level `mcpServers` key),
and the `type` discriminator is required — omitting it causes a fatal `MCP_SETTINGS_INVALID`
error on startup.

```json
{
  "name": "MyAgent",
  "settings": {
    "mcp": {
      "servers": {
        "vanguard-memory": {
          "type": "stdio",
          "command": "npx",
          "args": ["-y", "@lnes/vanguard-memory-node"]
        }
      }
    }
  }
}
```

### Custom vault path

```json
{
  "name": "MyAgent",
  "settings": {
    "mcp": {
      "servers": {
        "vanguard-memory": {
          "type": "stdio",
          "command": "npx",
          "args": ["-y", "@lnes/vanguard-memory-node"],
          "env": {
            "VMN_VAULT_PATH": "/path/to/your/vault"
          }
        }
      }
    }
  }
}
```

> **Note:** If you configure MCP servers by PATCHing `/api/config` instead of editing a character
> file on disk, stdio entries additionally require terminal authorization (`ELIZA_TERMINAL_RUN_TOKEN`);
> see `packages/agent/src/api/server-helpers-mcp.ts`. When using character files (as shown above),
> no additional environment variable is needed.

---

## Available Tools (11)

Once configured, VMN's tools are automatically available to your Eliza agent through the
MCP plugin — no additional code required. The agent can invoke them directly as part of
its tool-use loop:

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
| `vmn_sync_vault` | Sync shards to ExergyNet LNES-17 for on-chain attestation (optional) |

---

## Persistent Memory Across Sessions

VMN stores shards on disk — memory survives agent restarts automatically. To share memory
across multiple agent instances, point them at the same vault:

```json
{
  "settings": {
    "mcp": {
      "servers": {
        "vanguard-memory": {
          "type": "stdio",
          "command": "npx",
          "args": ["-y", "@lnes/vanguard-memory-node"],
          "env": {
            "VMN_VAULT_PATH": "/shared/team-vault"
          }
        }
      }
    }
  }
}
```

---

## Further Reading

- [npm package](https://www.npmjs.com/package/@lnes/vanguard-memory-node)
- [GitHub repository](https://github.com/ezumba/vanguard-memory-node)
