---
title: "Local Embedding Plugin"
sidebarTitle: "Local Embedding"
description: "Local embedding generation plugin for Eliza — generate vector embeddings locally without external API calls."
---

The Local Embedding plugin provides on-device vector embedding generation for Eliza agents, enabling memory and semantic search without external API dependencies.

**Package:** `@elizaos/plugin-local-embedding` (core plugin — always loaded, required for memory)

## Overview

This plugin generates vector embeddings locally using on-device models, avoiding the need for external embedding API calls. It is a required component of the memory subsystem — agents rely on embeddings for semantic retrieval, knowledge recall, and context matching. Because it runs locally, there is no network latency or API cost for embedding operations.

## Installation

This plugin is a core plugin required for the memory system and is always loaded. No manual installation is required.

## Related

- [Knowledge Plugin](/plugin-registry/documents) — Knowledge ingestion and retrieval
