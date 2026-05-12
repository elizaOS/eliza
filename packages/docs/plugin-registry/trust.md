---
title: "Trust (runtime)"
sidebarTitle: "Trust"
description: "Trust primitives for Eliza — scoring, security signals, and trust-based decisions via the built-in runtime capability."
---

Trust is provided by the elizaOS runtime. Enable it with `enableTrust: true` (and related agent config) rather than installing a separate package.

## Overview

Agents get trust building blocks: scoring, trust-gated behavior, and security-oriented checks. State uses the agent’s normal storage backend.

Key capabilities:

- **Trust scoring** — assign and update trust levels for known entities.
- **Trust-gated actions** — require a minimum trust level before sensitive operations.
- **Inter-agent trust** — model trust between agents as well as humans.
- **Reputation tracking** — trust levels can evolve from interaction history.

## Configuration

Optional settings such as `OWNER_ENTITY_ID` and `WORLD_ID` may apply when integrating with your deployment; see runtime trust types and admin UI.

## Usage Examples

> "What is my current trust level?"

> "Only run shell commands for users with high trust."

> "Show me the trust scores for known contacts."

## Related

- [Rolodex Plugin](/plugin-registry/rolodex) — Entity and relationship management
- [Memory Plugin](/plugin-registry/memory) — Persistent memory across sessions
