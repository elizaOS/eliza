---
title: "Todo Plugin"
sidebarTitle: "Todo"
description: "A todo list for Eliza — task management for humans and agents."
---

The Todo plugin adds task list management to Eliza agents.

**Package:** `@elizaos/plugin-todo`

## Overview

This plugin provides a straightforward todo list that both humans and agents can use. Agents can create tasks, mark them complete, list pending items, and remove finished work. It serves as a lightweight alternative to external project management tools for simple task tracking.

Key capabilities:

- **Create tasks** — add items with descriptions via natural language.
- **Complete tasks** — mark items as done when finished.
- **List tasks** — view all pending, completed, or all items.
- **Remove tasks** — delete items that are no longer relevant.
- **Shared usage** — both the human user and the agent can manage the same list.

## Installation

```bash
eliza plugins install todo
```

## Configuration

No environment variables or configuration parameters are required. Tasks are stored using the agent's default storage backend.

## Usage Examples

> "Add a todo: review the pull request for auth changes."

> "What's on my todo list?"

> "Mark 'review the pull request' as done."

## Related

- [Goals Plugin](/plugin-registry/goals) — Higher-level objective tracking
- [Linear Plugin](/plugin-registry/linear) — External project management with Linear
