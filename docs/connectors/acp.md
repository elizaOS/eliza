---
title: ACP Connector
sidebarTitle: ACP
description: Connect your agent to other agents using the Agent Communication Protocol (ACP) via @elizaos/plugin-acp.
---

Connect your agent to other AI agents through an ACP gateway for agent-to-agent communication.

## Overview

The ACP (Agent Communication Protocol) connector links agents through a shared gateway, enabling realtime agent-to-agent messaging. Each agent authenticates with a gateway token and can establish persistent sessions with other agents on the same gateway.

## Package Info

| Field | Value |
|-------|-------|
| Package | `@elizaos/plugin-acp` |
| Config key | `connectors.acp` |
| Primary env var | `ACP_GATEWAY_TOKEN` |

## Installation

```bash
eliza plugins install acp
```

## Minimal Configuration

Set the gateway credentials via environment variables:

```bash
ACP_GATEWAY_URL=https://your-gateway.example.com
ACP_GATEWAY_TOKEN=your-token
ACP_GATEWAY_PASSWORD=your-password
```

Or configure in `~/.eliza/eliza.json`:

```json
{
  "connectors": {
    "acp": {
      "enabled": true
    }
  }
}
```

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `ACP_GATEWAY_URL` | Yes | URL of the ACP gateway hub |
| `ACP_GATEWAY_TOKEN` | Yes | Authentication token for the gateway |
| `ACP_GATEWAY_PASSWORD` | Yes | Gateway password |
| `ACP_AGENT_ID` | No | Unique agent identifier |
| `ACP_CLIENT_NAME` | No | Agent name sent to the gateway |
| `ACP_CLIENT_DISPLAY_NAME` | No | Human-readable display name |
| `ACP_CLIENT_MODE` | No | Operating mode |
| `ACP_CLIENT_VERSION` | No | Version identifier |
| `ACP_DEFAULT_SESSION_KEY` | No | Default session key for connections |
| `ACP_DEFAULT_SESSION_LABEL` | No | Human-readable session label |
| `ACP_PERSIST_SESSIONS` | No | Set `true` to save sessions across restarts |
| `ACP_SESSION_STORE_PATH` | No | File path for persisted sessions |
| `ACP_RESET_SESSION` | No | Set `true` to reset session on start |
| `ACP_REQUIRE_EXISTING` | No | Require an existing session (don't create new) |
| `ACP_PREFIX_CWD` | No | Prefix current working directory |
| `ACP_VERBOSE` | No | Enable verbose logging |

## Features

- **Agent-to-agent messaging** — Send and receive messages between AI agents
- **Gateway hub** — Central gateway for routing messages between agents
- **Persistent sessions** — Optionally persist sessions across agent restarts
- **Session management** — Create, join, and manage communication sessions

## Disabling

```json
{
  "connectors": {
    "acp": {
      "enabled": false
    }
  }
}
```

## Related

- [ACP plugin reference](/plugin-registry/platform/acp)
- [Connectors overview](/guides/connectors)
- [Configuration reference](/configuration)
