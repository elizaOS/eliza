---
title: "Webhooks Plugin"
sidebarTitle: "Webhooks"
description: "Webhooks plugin for Eliza — receive and process incoming webhook events from external services."
---

The Webhooks plugin enables Eliza agents to receive and process incoming webhook events from external services, allowing integrations with any platform that supports webhook callbacks.

**Package:** `@elizaos/plugin-webhooks`

## Installation

```bash
eliza plugins install @elizaos/plugin-webhooks
```

## Configuration

### Enable via Features

```json
{
  "features": {
    "webhooks": true
  }
}
```

The plugin registers HTTP endpoints on the agent's API server to receive incoming webhook payloads. External services can send events to these endpoints, which are then routed to the agent for processing.

## Usage

Once enabled, the plugin exposes webhook endpoints that external services can POST to. Configure your external service to send webhook events to:

```
POST http://<your-agent-host>:<port>/api/webhooks/<hook-name>
```

The agent processes incoming payloads and can trigger actions, send responses, or update state based on the webhook content.

## Features

- Receive inbound webhook events from any HTTP-capable service
- Process and route webhook payloads to agent actions
- Configurable webhook endpoint paths
- Integrates with external services via HTTP callbacks

## Related

- [Triggers Guide](/guides/triggers) — Event-driven agent behaviors
- [Cron Plugin](/plugin-registry/cron) — Scheduled task execution
- [REST API Reference](/rest/system) — API endpoint documentation
