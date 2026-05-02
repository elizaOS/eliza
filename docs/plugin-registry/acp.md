---
title: "ACP Plugin"
sidebarTitle: "ACP"
description: "Agent Communication Protocol connector for Eliza — linking agents through an ACP gateway."
---

The ACP plugin connects Eliza agents to an Agent Communication Protocol gateway, enabling structured communication between agents across different runtimes and environments.

**Package:** `@elizaos/plugin-acp`

## Overview

ACP (Agent Communication Protocol) provides a standardized way for agents to discover, message, and collaborate with other agents through a shared gateway. This plugin implements the ACP client within the elizaOS runtime, allowing Eliza agents to participate in multi-agent workflows.

## Installation

```bash
eliza plugins install acp
```

## Auto-Enable

Auto-enables when `ACP_GATEWAY_TOKEN` is set.

## Configuration

### Required

| Environment Variable | Required | Description |
|---------------------|----------|-------------|
| `ACP_GATEWAY_PASSWORD` | Yes | Password for ACP Gateway (sensitive) |

### Optional

| Environment Variable | Description |
|---------------------|-------------|
| `ACP_GATEWAY_URL` | URL for the ACP Gateway |
| `ACP_GATEWAY_TOKEN` | Authentication token (sensitive) |
| `ACP_CLIENT_NAME` | Client display name |
| `ACP_CLIENT_DISPLAY_NAME` | Human-readable display name |
| `ACP_CLIENT_VERSION` | Client version string |
| `ACP_CLIENT_MODE` | Client operating mode |
| `ACP_AGENT_ID` | Agent identifier |
| `ACP_VERBOSE` | Enable verbose logging |
| `ACP_PREFIX_CWD` | Prefix working directory paths |
| `ACP_RESET_SESSION` | Reset session on connect |
| `ACP_PERSIST_SESSIONS` | Persist sessions to disk |
| `ACP_REQUIRE_EXISTING` | Require an existing session |
| `ACP_SESSION_STORE_PATH` | Path for session persistence |
| `ACP_DEFAULT_SESSION_KEY` | Default session key |
| `ACP_DEFAULT_SESSION_LABEL` | Default session label |
