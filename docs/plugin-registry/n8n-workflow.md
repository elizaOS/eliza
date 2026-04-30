---
title: "n8n Workflow Plugin"
sidebarTitle: "n8n Workflow"
description: "Manage n8n automation workflows from Milady — create, activate, deactivate, and delete workflows through agent chat."
---

The n8n Workflow plugin lets Milady agents manage n8n automations through natural language.

**Package:** `@elizaos/plugin-n8n-workflow`

## Overview

This plugin connects Milady to an n8n instance, exposing workflow management actions. Agents can create new workflows, activate or deactivate existing ones, and delete workflows they no longer need — all through conversational commands rather than the n8n UI.

## Installation

```bash
milady plugins install n8n-workflow
```

## Auto-Enable

Auto-enables when `N8N_API_KEY` is set.

## Configuration

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `N8N_API_KEY` | string | Yes | n8n API key (sensitive) |
| `N8N_BASE_URL` | string | Yes | n8n instance URL |

Set via environment variables or in your agent configuration:

```bash
export N8N_API_KEY="your-n8n-api-key"
export N8N_BASE_URL="https://your-n8n-instance.example.com"
```

## Related

- [Webhooks Plugin](/plugin-registry/webhooks) — Receive inbound webhook triggers
- [Cron Plugin](/plugin-registry/cron) — Schedule recurring agent tasks
