---
title: "Linear Plugin"
sidebarTitle: "Linear"
description: "Linear project management integration for Eliza — create, update, and query issues and projects through agent chat."
---

The Linear plugin lets Eliza agents interact with Linear for issue tracking and project management.

**Package:** `@elizaos/plugin-linear`

## Overview

This plugin connects Eliza to the Linear API, enabling agents to create issues, update statuses, query projects and teams, and manage workflows through natural language. Useful for development teams that track work in Linear and want their agent to participate in issue management.

## Installation

```bash
eliza plugins install linear
```

## Auto-Enable

Auto-enables when `LINEAR_API_KEY` is set.

## Configuration

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `LINEAR_API_KEY` | string | Yes | Linear API key (sensitive) |
| `LINEAR_TEAM_ID` | string | No | Default team ID |
| `LINEAR_PROJECT_ID` | string | No | Default project ID |

Set via environment variables or in your agent configuration:

```bash
export LINEAR_API_KEY="lin_api_..."
export LINEAR_TEAM_ID="your-team-id"
```

## Related

- [Goals Plugin](/plugin-registry/goals) — Track agent-level goals alongside Linear issues
- [Todo Plugin](/plugin-registry/todo) — Lightweight task tracking without an external service
