---
title: "Rolodex Plugin"
sidebarTitle: "Rolodex"
description: "Entity and relationship management for Eliza agents — contacts, connections, and relationship tracking."
---

The Rolodex plugin provides entity and relationship management for Eliza agents.

**Package:** `@elizaos/plugin-rolodex`

## Overview

This plugin lets agents track entities (people, organizations, other agents), their attributes, and the relationships between them. It serves as a contact management layer, enabling agents to remember who they have interacted with, how entities relate to each other, and relevant details about each contact.

Key capabilities:

- **Entity tracking** — store people, organizations, and other agents with their attributes.
- **Relationship mapping** — record how entities relate to each other (colleague, manager, collaborator, etc.).
- **Contact lookup** — agents can query their rolodex to recall details about a specific entity.
- **Cross-platform identity** — link the same person across different connectors (Telegram, Discord, etc.).

## Installation

```bash
eliza plugins install rolodex
```

## Configuration

No environment variables or configuration parameters are required. Entity and relationship data is stored using the agent's default storage backend.

## Usage Examples

> "Who is Alice and what team does she work on?"

> "Remember that Bob is the lead engineer on the payments team."

> "List all contacts I have at Acme Corp."

## Related

- [Memory Plugin](/plugin-registry/memory) — Persistent memory across sessions
- [Trust (runtime)](/plugin-registry/trust) — Trust primitives between agents and humans
