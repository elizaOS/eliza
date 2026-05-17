---
title: "MCP Plugin"
sidebarTitle: "MCP"
description: "ElizaOS plugin allowing agents to connect to MCP servers"
---

Connect Eliza agents to Model Context Protocol (MCP) servers for extended tool and resource access.

**Package:** `@elizaos/plugin-mcp`

## Overview

The MCP plugin enables elizaOS agents to connect to external MCP servers, giving them access to tools and resources exposed by those servers. This allows agents to interact with a wide ecosystem of MCP-compatible services and data sources without custom integration code. Connections are configured via a JSON specification that defines which servers to connect to and how.

## Installation

```bash
eliza plugins install mcp
```

## Auto-Enable

The plugin auto-enables when `MCP_SERVERS` is set.

## Configuration

| Variable | Type | Required | Description |
|---|---|---|---|
| `MCP_SERVERS` | string | No | JSON configuration for MCP server connections |

The `MCP_SERVERS` value should be a JSON string defining the MCP servers your agent should connect to, including transport details and any authentication required by each server.

## Related

- [Coding Tools Plugin](/plugin-registry/coding-tools) - Filesystem, shell, and search tooling (READ, WRITE, BASH, GREP, …)
