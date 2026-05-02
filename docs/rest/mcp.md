---
title: "MCP Server API"
sidebarTitle: "MCP"
description: "REST API endpoints for managing MCP (Model Context Protocol) server configurations, marketplace search, and runtime status."
---

The MCP API manages Model Context Protocol server integrations. You can search the MCP marketplace for servers, add/remove server configurations, replace the full config, and check the runtime status of connected MCP servers.

## Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/mcp/marketplace/search` | Search the MCP marketplace |
| GET | `/api/mcp/marketplace/details/:name` | Get details for a marketplace server |
| GET | `/api/mcp/config` | Get the current MCP server configuration |
| POST | `/api/mcp/config/server` | Add or update a single MCP server |
| DELETE | `/api/mcp/config/server/:name` | Remove an MCP server from config |
| PUT | `/api/mcp/config` | Replace the entire MCP servers config |
| GET | `/api/mcp/status` | Get runtime status of connected MCP servers |

---

### GET /api/mcp/marketplace/search

Search the MCP marketplace for available servers.

**Query Parameters**

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `q` | string | `""` | Search query (empty returns all) |
| `limit` | number | 30 | Max results (1-50) |

**Response**

```json
{
  "ok": true,
  "results": [
    {
      "name": "filesystem",
      "description": "Read and write files on the local filesystem",
      "author": "modelcontextprotocol",
      "downloads": 50000
    }
  ]
}
```

**Errors**

| Status | Condition |
|--------|-----------|
| 502 | Marketplace search failed (upstream error) |

---

### GET /api/mcp/marketplace/details/:name

Get full details for a specific MCP server from the marketplace.

**Path Parameters**

| Parameter | Type | Description |
|-----------|------|-------------|
| `name` | string | Server name (URL-encoded) |

**Response**

```json
{
  "ok": true,
  "server": {
    "name": "filesystem",
    "description": "Read and write files",
    "author": "modelcontextprotocol",
    "homepage": "https://github.com/modelcontextprotocol/servers",
    "config": {
      "command": "bunx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/path"]
    }
  }
}
```

**Errors**

| Status | Condition |
|--------|-----------|
| 400 | Server name is empty |
| 404 | Server not found in marketplace |
| 502 | Failed to fetch details |

---

### GET /api/mcp/config

Returns the current MCP server configuration from the Eliza config file. Secret values (API keys, tokens) are redacted.

**Response**

```json
{
  "ok": true,
  "servers": {
    "filesystem": {
      "command": "bunx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/home"]
    },
    "brave-search": {
      "command": "bunx",
      "args": ["-y", "@modelcontextprotocol/server-brave-search"],
      "env": {
        "BRAVE_API_KEY": "****"
      }
    }
  }
}
```

---

### POST /api/mcp/config/server

Add or update a single MCP server configuration. Changes are persisted to the config file. A restart is typically required for the runtime to pick up the new server.

**Request Body**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | Yes | Server identifier |
| `config` | object | Yes | Server config (command, args, env, etc.) |

```json
{
  "name": "brave-search",
  "config": {
    "command": "bunx",
    "args": ["-y", "@modelcontextprotocol/server-brave-search"],
    "env": {
      "BRAVE_API_KEY": "BSA_xxxx"
    }
  }
}
```

**Response**

```json
{
  "ok": true,
  "name": "brave-search",
  "requiresRestart": true
}
```

**Errors**

| Status | Condition |
|--------|-----------|
| 400 | Server name is empty or reserved (`__proto__`, `constructor`, `prototype`) |
| 400 | Config object is missing or invalid |

---

### DELETE /api/mcp/config/server/:name

Remove an MCP server from the configuration. A restart is required for the change to take effect.

**Path Parameters**

| Parameter | Type | Description |
|-----------|------|-------------|
| `name` | string | Server name (URL-encoded) |

**Response**

```json
{
  "ok": true,
  "requiresRestart": true
}
```

---

### PUT /api/mcp/config

Replace the entire MCP servers configuration object. All existing servers are replaced with the provided set.

**Request Body**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `servers` | object | Yes | Complete servers configuration map |

```json
{
  "servers": {
    "filesystem": {
      "command": "bunx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/home"]
    }
  }
}
```

**Response**

```json
{
  "ok": true
}
```

**Errors**

| Status | Condition |
|--------|-----------|
| 400 | `servers` is not a JSON object |
| 400 | Server config validation failed |

---

### GET /api/mcp/status

Returns the runtime status of all connected MCP servers, including tool and resource counts.

**Response**

```json
{
  "ok": true,
  "servers": [
    {
      "name": "filesystem",
      "status": "connected",
      "toolCount": 5,
      "resourceCount": 0
    },
    {
      "name": "brave-search",
      "status": "disconnected",
      "toolCount": 0,
      "resourceCount": 0
    }
  ]
}
```

| Field | Type | Description |
|-------|------|-------------|
| `servers[].name` | string | Server identifier |
| `servers[].status` | string | Connection status (`connected`, `disconnected`, etc.) |
| `servers[].toolCount` | number | Number of tools provided by this server |
| `servers[].resourceCount` | number | Number of resources provided by this server |

## Common Error Codes

| Status | Code | Description |
|--------|------|-------------|
| 400 | `INVALID_REQUEST` | Request body is malformed or missing required fields |
| 401 | `UNAUTHORIZED` | Missing or invalid authentication token |
| 404 | `NOT_FOUND` | Requested resource does not exist |
| 400 | `INVALID_CONFIG` | MCP server configuration is invalid |
| 404 | `SERVER_NOT_FOUND` | MCP server with specified name does not exist |
| 400 | `RESERVED_NAME` | Attempted to use a reserved server name |
| 502 | `INTERNAL_ERROR` | Marketplace or server connection error |
