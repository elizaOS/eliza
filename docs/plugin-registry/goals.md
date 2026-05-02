---
title: "Goals Plugin"
sidebarTitle: "Goals"
description: "Goal tracking for Eliza agents — define, pursue, and complete objectives across sessions."
---

The Goals plugin gives Eliza agents the ability to set and track goals.

**Package:** `@elizaos/plugin-goals`

## Overview

This plugin provides goal management for agents, letting them define objectives, track progress, and mark goals as complete. Goals persist across sessions, giving agents a structured way to pursue multi-step tasks and report on their status.

Key capabilities:

- **Define goals** — agents can create named objectives with descriptions.
- **Track progress** — goals carry status so agents know what is in progress, blocked, or done.
- **Multi-step pursuit** — agents can break goals into sub-steps and work through them across multiple turns and sessions.
- **Status reporting** — agents can summarize their current goal state on request.

## Installation

```bash
eliza plugins install goals
```

## Configuration

No environment variables or configuration parameters are required. Goals are stored using the agent's default storage backend.

## Usage Examples

> "Set a goal to finish the API migration by Friday."

> "What goals are still in progress?"

> "Mark the deployment goal as complete."

## Related

- [Todo Plugin](/plugin-registry/todo) — Lightweight task lists for humans and agents
- [Linear Plugin](/plugin-registry/linear) — External project management integration
