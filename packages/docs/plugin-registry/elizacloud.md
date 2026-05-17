---
title: "Eliza Cloud Plugin"
sidebarTitle: "Eliza Cloud"
description: "Connect Eliza to elizaOS Cloud for managed hosting, app registration, user auth, billing, and deployment."
---

The Eliza Cloud plugin connects Eliza agents to the elizaOS Cloud platform for managed backend services.

**Package:** `@elizaos/plugin-elizacloud`

## Overview

This plugin integrates Eliza with elizaOS Cloud, providing access to cloud-hosted APIs, app registration, user authentication and redirect flows, usage tracking, billing, app domains, creator monetization, and Docker container deployments for server-side workloads. When enabled, Eliza can use Cloud as its default managed backend.

## Installation

```bash
eliza plugins install elizacloud
```

## Auto-Enable

Auto-enables when `ELIZAOS_CLOUD_API_KEY` or `ELIZAOS_CLOUD_ENABLED` is set.

## Configuration

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `ELIZAOS_CLOUD_API_KEY` | string | Yes | Cloud API key (sensitive) |
| `ELIZAOS_CLOUD_ENABLED` | boolean | No | Enable cloud connection |
| `ELIZAOS_CLOUD_URL` | string | No | Custom cloud endpoint URL |

Set via environment variables or in your agent configuration:

```bash
export ELIZAOS_CLOUD_API_KEY="your-api-key"
export ELIZAOS_CLOUD_ENABLED=true
```

## Related

- [Secrets (runtime)](/runtime/services#secrets-secrets-service) — Manage sensitive configuration
- [Webhooks Plugin](/plugin-registry/webhooks) — Receive cloud event callbacks
