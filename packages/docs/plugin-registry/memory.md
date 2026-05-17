---
title: "Memory Plugin"
sidebarTitle: "Memory"
description: "Agent memory for Eliza — persistent recall of conversations, facts, and context across sessions."
---

The Memory plugin provides persistent memory capabilities for Eliza agents.

**Package:** `@elizaos/plugin-memory`

## Overview

This plugin gives agents the ability to remember information across conversations and sessions. It stores and retrieves facts, conversation context, and learned details so agents can maintain continuity and recall prior interactions.

Key capabilities:

- **Fact storage** — agents remember discrete pieces of information surfaced during conversations.
- **Context recall** — prior conversation context is available to the agent when relevant topics come up again.
- **Cross-session persistence** — memory survives agent restarts and session boundaries.

## Installation

```bash
eliza plugins install memory
```

## Configuration

No environment variables or configuration parameters are required. The plugin uses the agent's default storage backend.

## Usage Examples

> "Remember that my preferred language is Python."

> "What do you know about my last project?"

> "Forget what I told you about the API key."

## Related

- [Knowledge Plugin](/plugin-registry/documents) — Structured knowledge ingestion and retrieval
- [Clipboard Plugin](/plugin-registry/clipboard) — File-based notes and persistent clipboard
- [Rolodex Plugin](/plugin-registry/rolodex) — Entity and relationship management
