---
title: "Copilot Proxy Plugin"
sidebarTitle: "Copilot Proxy"
description: "Copilot proxy model provider for Eliza — route agent inference through the Copilot API."
---

The Copilot Proxy plugin adds a Copilot-backed model provider to Eliza agents.

**Package:** `@elizaos/plugin-copilot-proxy`

## Overview

This plugin registers a model provider that proxies inference requests through the Copilot API. It allows Eliza agents to use Copilot as a backend for language model calls, routing requests through your Copilot API key.

Once configured, the provider is available alongside any other model providers in the agent's runtime. Model selection and routing follow the standard elizaOS provider priority system.

## Installation

```bash
eliza plugins install copilot-proxy
```

## Auto-Enable

Auto-enables when `COPILOT_API_KEY` is set.

## Configuration

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `COPILOT_API_KEY` | string | Yes | Copilot API key (sensitive) |

Set via environment variables or in your agent configuration:

```bash
export COPILOT_API_KEY="your-copilot-api-key"
```

## Related

- [Eliza Cloud Plugin](/plugin-registry/elizacloud) — Cloud-managed backend services
