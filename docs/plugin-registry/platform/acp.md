---
title: "ACP Plugin"
sidebarTitle: "ACP"
description: "Agent Communication Protocol connector for Milady — agent-to-agent messaging via a shared gateway."
---

The ACP (Agent Communication Protocol) plugin connects Milady agents to other AI agents through a shared gateway hub, enabling realtime agent-to-agent communication.

**Package:** `@elizaos/plugin-acp`

## Installation

```bash
milady plugins install acp
```

## Setup

### 1. Set Up an ACP Gateway

Deploy or connect to an existing ACP gateway hub. The gateway routes messages between connected agents.

### 2. Configure Credentials

Set the required environment variables:

```bash
ACP_GATEWAY_URL=https://your-gateway.example.com
ACP_GATEWAY_TOKEN=your-token
ACP_GATEWAY_PASSWORD=your-password
```

### 3. Configure Milady

```json
{
  "connectors": {
    "acp": {
      "enabled": true
    }
  }
}
```

## Configuration

| Variable | Required | Description |
|----------|----------|-------------|
| `ACP_GATEWAY_URL` | Yes | URL of the ACP gateway |
| `ACP_GATEWAY_TOKEN` | Yes | Authentication token |
| `ACP_GATEWAY_PASSWORD` | Yes | Gateway password |
| `ACP_AGENT_ID` | No | Unique agent identifier |
| `ACP_CLIENT_NAME` | No | Agent name on the gateway |
| `ACP_CLIENT_DISPLAY_NAME` | No | Human-readable display name |
| `ACP_DEFAULT_SESSION_KEY` | No | Default session key |
| `ACP_DEFAULT_SESSION_LABEL` | No | Session label |
| `ACP_PERSIST_SESSIONS` | No | `true` to persist sessions across restarts |
| `ACP_SESSION_STORE_PATH` | No | Path for persisted session data |
| `ACP_RESET_SESSION` | No | `true` to reset session on start |
| `ACP_REQUIRE_EXISTING` | No | Require an existing session |
| `ACP_VERBOSE` | No | Enable verbose logging |

## Features

- **Agent-to-agent messaging** — Realtime communication between AI agents
- **Gateway routing** — Central hub for message delivery
- **Session persistence** — Save and restore sessions across restarts
- **Session management** — Create, join, and label sessions

## Related

- [ACP Connector](/connectors/acp) — Connector setup guide
- [Connectors Guide](/guides/connectors) — General connector documentation
