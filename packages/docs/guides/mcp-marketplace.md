---
title: "MCP Marketplace"
sidebarTitle: "MCP Servers"
description: "Browse, install, and configure Model Context Protocol servers from the MCP registry."
---

The MCP (Model Context Protocol) marketplace lets your agent discover and connect to external tool servers. MCP servers extend your agent with capabilities like file access, database queries, web browsing, and API integrations — all through a standardized protocol.

## How It Works

Eliza integrates with the official MCP registry at `https://registry.modelcontextprotocol.io`. You can browse available servers, install them into your agent config, and the runtime connects to them automatically.

MCP servers run in three modes:

| Mode | Transport | Example |
|------|-----------|---------|
| **stdio** | Local process (bunx, node, docker) | `bunx -y @modelcontextprotocol/server-filesystem` |
| **streamable-http** | Remote HTTP endpoint | `https://mcp.example.com/sse` |
| **sse** | Server-Sent Events | Legacy remote servers |

## REST API

The MCP marketplace is accessed through the REST API (there is no dedicated CLI command).

### Browse Servers

```bash
# Search for MCP servers
curl "http://localhost:31337/api/mcp/marketplace/search?q=filesystem&limit=10" \
  -H "Authorization: Bearer your-token"
```

### Get Server Details

```bash
# Get full details for a specific server
curl "http://localhost:31337/api/mcp/marketplace/server/filesystem" \
  -H "Authorization: Bearer your-token"
```

### Install a Server

Installation writes the server config into your `eliza.json` under the `mcp.servers` key:

```bash
# Add a server to your config
curl -X POST "http://localhost:31337/api/mcp/config/server" \
  -H "Authorization: Bearer your-token" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "filesystem",
    "config": {
      "type": "stdio",
      "command": "bunx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/path/to/allowed/dir"]
    }
  }'
```

### View Current Config

```bash
# List all configured MCP servers (secrets redacted)
curl "http://localhost:31337/api/mcp/config" \
  -H "Authorization: Bearer your-token"
```

### Remove a Server

```bash
curl -X DELETE "http://localhost:31337/api/mcp/config/server/filesystem" \
  -H "Authorization: Bearer your-token"
```

### Check MCP Status

```bash
# See which MCP servers are currently connected
curl "http://localhost:31337/api/mcp/status" \
  -H "Authorization: Bearer your-token"
```

## Configuration

MCP servers are configured in `eliza.json` under the `mcp` key:

```json
{
  "mcp": {
    "servers": {
      "filesystem": {
        "type": "stdio",
        "command": "bunx",
        "args": ["-y", "@modelcontextprotocol/server-filesystem", "/home/user/documents"],
        "env": {},
        "cwd": "/home/user"
      },
      "postgres": {
        "type": "stdio",
        "command": "bunx",
        "args": ["-y", "@modelcontextprotocol/server-postgres"],
        "env": {
          "POSTGRES_URL": "postgresql://localhost:5432/mydb"
        }
      },
      "remote-tools": {
        "type": "streamable-http",
        "url": "https://tools.example.com/mcp",
        "headers": {
          "Authorization": "Bearer remote-api-key"
        },
        "timeoutInMillis": 30000
      }
    }
  }
}
```

### Server Config Fields

| Field | Type | Description |
|-------|------|-------------|
| `type` | `"stdio"` \| `"http"` \| `"streamable-http"` \| `"sse"` | Transport protocol |
| `command` | string | Executable to run (for stdio servers) |
| `args` | string[] | Command arguments |
| `url` | string | Remote server URL (for HTTP/SSE servers) |
| `env` | object | Environment variables passed to the server process |
| `headers` | object | HTTP headers for remote servers |
| `cwd` | string | Working directory for stdio servers |
| `timeoutInMillis` | number | Connection timeout in milliseconds |

### Security

The API enforces an allowlist for stdio commands:

**Allowed commands:** `npx`, `node`, `bun`, `deno`, `uvx`, `python`, `python3`, `podman`, `docker`

**Blocked environment variables:** `LD_PRELOAD`, `LD_LIBRARY_PATH`, `DYLD_INSERT_LIBRARIES`, `SHELL`, and other injection vectors.

## Related

- [Configuration reference](/configuration)
- [Plugin architecture](/plugins/architecture)
- [API Reference](/api-reference)
