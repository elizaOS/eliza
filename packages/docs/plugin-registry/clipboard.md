---
title: "Clipboard Plugin"
sidebarTitle: "Clipboard"
description: "File-based persistent notes and clipboard for Eliza agents — save, recall, and manage text snippets."
---

The Clipboard plugin provides file-based memory storage for Eliza agents.

**Package:** `@elizaos/plugin-clipboard`

## Overview

This plugin gives agents a persistent clipboard and note-taking system backed by file storage. Agents can save text snippets, recall them later, and organize notes across sessions. It serves as a simple, durable scratch space for information agents want to keep outside of conversation memory.

Key capabilities:

- **Save snippets** — agents can store named text entries for later retrieval.
- **Recall by name** — retrieve a specific note or snippet on demand.
- **List entries** — browse all saved clipboard items.
- **File-backed persistence** — notes survive restarts and are stored as plain files.

## Installation

```bash
eliza plugins install clipboard
```

## Configuration

No environment variables or configuration parameters are required. Notes are persisted to the agent's file storage.

## Usage Examples

> "Save this snippet as 'deploy-command': kubectl rollout restart deployment/api"

> "What did I save as 'deploy-command'?"

> "List all my clipboard entries."

## Related

- [Memory Plugin](/plugin-registry/memory) — Conversation-level persistent memory
- [Knowledge Plugin](/plugin-registry/documents) — Structured knowledge ingestion and retrieval
- [Todo Plugin](/plugin-registry/todo) — Task list management
