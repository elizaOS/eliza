---
title: "Obsidian Plugin"
sidebarTitle: "Obsidian"
description: "Obsidian vault integration for Eliza — read, search, and manage notes in your Obsidian vault."
---

<Warning>
This plugin is not yet available in the Eliza plugin registry.
</Warning>

The Obsidian plugin connects Eliza agents to your local [Obsidian](https://obsidian.md) vault, enabling agents to read, search, and interact with your notes and knowledge base.

> **On-demand plugin.** This plugin is resolved from the remote elizaOS plugin registry and auto-installs when configured. It is not included in Eliza's bundled `plugins.json` index.

**Package:** `@elizaos/plugin-obsidian`

## Installation

```bash
eliza plugins install @elizaos/plugin-obsidian
```

## Auto-Enable

The plugin auto-enables when `OBSIDIAN_VAULT_PATH` is set:

```bash
export OBSIDIAN_VAULT_PATH=/path/to/your/vault
```

## Configuration

| Environment Variable | Required | Description |
|---------------------|----------|-------------|
| `OBSIDIAN_VAULT_PATH` | Yes | Path to your Obsidian vault directory |

### eliza.json Example

```json
{
  "features": {
    "obsidian": true
  }
}
```

## Features

- Read and search notes in your Obsidian vault
- Access your personal knowledge graph
- Note management via CLI integration

## Related

- [Knowledge Plugin](/plugin-registry/documents) — RAG-based knowledge retrieval
- [Browser Plugin](/plugin-registry/browser) — Web content access
