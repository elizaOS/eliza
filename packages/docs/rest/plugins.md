---
title: "Plugins & Registry API"
sidebarTitle: "Plugins"
description: "REST API endpoints for plugin management, the elizaOS plugin registry, and core plugin operations."
---

The plugins API manages the agent's plugin system. It covers three areas: **plugin management** (listing, configuring, enabling/disabling installed plugins), **plugin installation** (install, uninstall, eject, sync from npm), and the **plugin registry** (browsing the elizaOS community catalog).

When `ELIZA_API_TOKEN` is set, include it as a `Bearer` token in the `Authorization` header.

## Endpoints

### Plugin Management

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/plugins` | List all plugins with status and config |
| PUT | `/api/plugins/:id` | Update a plugin (enable/disable, configure) |
| POST | `/api/plugins/:id/test` | Test a plugin's connectivity |
| GET | `/api/plugins/installed` | List installed plugin packages |
| GET | `/api/plugins/ejected` | List ejected (local copy) plugins |

### Plugin Installation

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/plugins/install` | Install a plugin from npm |
| POST | `/api/plugins/update` | Update an installed plugin to a newer version |
| POST | `/api/plugins/uninstall` | Uninstall a plugin |
| POST | `/api/plugins/:id/eject` | Eject a plugin to a local copy |
| POST | `/api/plugins/:id/sync` | Sync an ejected plugin back to npm |
| POST | `/api/plugins/:id/reinject` | Restore an ejected plugin to its registry version |

### Core Plugin Management

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/core/status` | Core manager status |
| GET | `/api/plugins/core` | List core plugins with status |
| POST | `/api/plugins/core/toggle` | Toggle a core plugin |

### Plugin Registry

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/registry/plugins` | List all registry plugins |
| GET | `/api/registry/plugins/:name` | Get details for a registry plugin |
| GET | `/api/registry/search` | Search the registry |
| POST | `/api/registry/refresh` | Refresh the registry cache |
| GET | `/api/registry/status` | Registry connection status |
| POST | `/api/registry/register` | Register the agent with the registry |
| POST | `/api/registry/update-uri` | Update the agent's registry URI |
| POST | `/api/registry/sync` | Sync agent state with the registry |
| GET | `/api/registry/config` | Get registry configuration |

---

## Plugin Management

### GET /api/plugins

List all known plugins — bundled, installed, and discovered from config. Each entry includes enabled/active state, configuration parameters with current values (sensitive values masked), and validation results.

**Response**

```json
{
  "plugins": [
    {
      "id": "twitter",
      "name": "Twitter",
      "description": "Twitter/X integration",
      "category": "social",
      "enabled": true,
      "isActive": true,
      "configured": true,
      "loadError": null,
      "parameters": [
        {
          "key": "TWITTER_API_KEY",
          "required": true,
          "sensitive": true,
          "isSet": true,
          "currentValue": "sk-****...xxxx"
        }
      ],
      "validationErrors": [],
      "validationWarnings": []
    }
  ]
}
```

| Field | Type | Description |
|-------|------|-------------|
| `id` | string | Plugin identifier |
| `enabled` | boolean | Whether user wants it active (config-driven) |
| `isActive` | boolean | Whether it is actually loaded in the runtime |
| `configured` | boolean | Whether all required parameters are set |
| `loadError` | string\|null | Error message if installed but failed to load |

---

### PUT /api/plugins/:id

Update a plugin's enabled state and/or configuration. Enabling/disabling a plugin schedules a runtime restart.

**Request Body**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `enabled` | boolean | No | Enable or disable the plugin |
| `config` | object | No | Map of parameter keys to new values |

```json
{
  "enabled": true,
  "config": {
    "TWITTER_API_KEY": "sk-new-key"
  }
}
```

**Response**

```json
{
  "ok": true,
  "plugin": { "id": "twitter", "enabled": true, "..." : "..." }
}
```

**Errors**

| Status | Condition |
|--------|-----------|
| 404 | Plugin not found |
| 422 | Config validation failed |

---

### POST /api/plugins/:id/test

Test a plugin's connectivity or configuration. If the plugin exposes a health probe, it is invoked. Otherwise, a basic "plugin is loaded" status is returned.

**Response**

```json
{
  "success": true,
  "pluginId": "openai",
  "message": "Connection successful",
  "durationMs": 142
}
```

| Field | Type | Description |
|-------|------|-------------|
| `success` | boolean | Whether the test passed |
| `pluginId` | string | Plugin identifier |
| `message` | string | Human-readable result description |
| `durationMs` | number | Time taken for the test in milliseconds |

**Errors**

| Status | Condition |
|--------|-----------|
| 404 | Plugin not found or not loaded |

---

### GET /api/plugins/installed

List all installed plugin packages with version information.

**Response**

```json
{
  "count": 3,
  "plugins": [
    {
      "name": "@elizaos/plugin-x",
      "version": "1.2.0",
      "installedAt": "2025-06-01T12:00:00.000Z"
    }
  ]
}
```

| Field | Type | Description |
|-------|------|-------------|
| `count` | number | Total number of installed plugins |
| `plugins` | array | List of installed plugin packages |

---

### GET /api/plugins/ejected

List all ejected plugins (plugins that have been copied to a local directory for development).

**Response**

```json
{
  "plugins": [
    {
      "name": "@elizaos/plugin-x",
      "localPath": "/path/to/local/plugin-twitter"
    }
  ]
}
```

---

## Plugin Installation

### POST /api/plugins/install

Install a plugin package from npm. Plugin installation may take significant time depending on the package size and dependency tree. The client SDK uses a 120-second timeout for this endpoint (compared to the default timeout used for other API calls).

**Request Body**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | Yes | npm package name |
| `version` | string | No | Specific version to install (defaults to latest) |
| `autoRestart` | boolean | No | Whether to restart the agent after install (defaults to `true`) |
| `stream` | boolean | No | Stream install progress events via SSE |

**Response**

```json
{
  "ok": true,
  "requiresRestart": true
}
```

---

### POST /api/plugins/update

Update an installed plugin to a newer version. Uses the same install mechanism but targets an existing plugin for upgrade.

**Request Body**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | Yes | npm package name |
| `version` | string | No | Specific version to update to |
| `stream` | string | No | Release stream (`latest` or `alpha`) |
| `autoRestart` | boolean | No | Whether to restart the agent after update (defaults to `true`) |

**Response**

```json
{
  "ok": true,
  "requiresRestart": true
}
```

---

### POST /api/plugins/uninstall

Uninstall a plugin package.

**Request Body**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | Yes | npm package name |

**Response**

```json
{
  "ok": true,
  "requiresRestart": true
}
```

---

### POST /api/plugins/:id/eject

Eject a plugin to a local directory for development. Creates a local copy of the plugin source that can be modified independently. If the result indicates a restart is required, the runtime schedules an automatic restart.

**Response**

```json
{
  "ok": true,
  "pluginName": "@elizaos/plugin-x",
  "requiresRestart": true,
  "message": "@elizaos/plugin-x ejected to local source."
}
```

| Field | Type | Description |
|-------|------|-------------|
| `pluginName` | string | Name of the ejected plugin |
| `requiresRestart` | boolean | Whether the runtime will restart to load the local copy |
| `message` | string | Human-readable status message |

**Errors**

| Status | Condition |
|--------|-----------|
| 422 | Eject failed (plugin not found or already ejected) |

---

### POST /api/plugins/:id/sync

Sync an ejected plugin back — re-build from the local copy.

**Response**

```json
{
  "ok": true,
  "pluginName": "@elizaos/plugin-x",
  "requiresRestart": true,
  "message": "@elizaos/plugin-x synced with upstream."
}
```

| Field | Type | Description |
|-------|------|-------------|
| `pluginName` | string | Name of the synced plugin |
| `requiresRestart` | boolean | Whether the runtime will restart to apply changes |
| `message` | string | Human-readable status message |

**Errors**

| Status | Condition |
|--------|-----------|
| 422 | Sync failed (plugin not ejected or sync error) |

---

### POST /api/plugins/:id/reinject

Restore a previously ejected plugin back to its registry version, removing the local copy.

**Response**

```json
{
  "ok": true,
  "pluginName": "@elizaos/plugin-x",
  "requiresRestart": true,
  "message": "@elizaos/plugin-x restored to registry version."
}
```

| Field | Type | Description |
|-------|------|-------------|
| `pluginName` | string | Name of the reinjected plugin |
| `requiresRestart` | boolean | Whether the runtime will restart to load the registry version |
| `message` | string | Human-readable status message |

**Errors**

| Status | Condition |
|--------|-----------|
| 422 | Reinject failed (plugin not ejected or reinject error) |

---

## Core Plugin Management

### GET /api/core/status

Get the core manager status and available core plugins.

**Response**

```json
{
  "available": true,
  "corePlugins": ["knowledge", "sql"],
  "optionalCorePlugins": ["plugin-manager"]
}
```

- **knowledge** -- RAG knowledge retrieval
- **sql** -- Database layer

---

### GET /api/plugins/core

List core and optional-core plugins with their enabled/loaded status.

**Response**

```json
{
  "core": [
    { "npmName": "@elizaos/plugin-sql", "id": "sql", "name": "Sql", "isCore": true, "loaded": true }
  ],
  "optional": [
    { "npmName": "@elizaos/plugin-browser", "id": "browser", "name": "Browser", "isCore": false, "loaded": true, "enabled": true }
  ]
}
```

---

### POST /api/plugins/core/toggle

Toggle an optional core plugin on or off. Only plugins in the `OPTIONAL_CORE_PLUGINS` list can be toggled; core plugins cannot be disabled.

**Request Body**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `npmName` | string | Yes | Full npm package name (e.g. `@elizaos/plugin-browser`) |
| `enabled` | boolean | Yes | Desired state |

**Response**

```json
{
  "ok": true,
  "requiresRestart": true
}
```

---

## Plugin Registry

### GET /api/registry/plugins

List all plugins from the elizaOS registry with installation and load status.

**Response**

```json
{
  "count": 87,
  "plugins": [
    {
      "name": "@elizaos/plugin-x",
      "displayName": "Twitter",
      "description": "Twitter/X integration for posting and monitoring",
      "npm": {
        "package": "@elizaos/plugin-x",
        "version": "1.2.0"
      },
      "installed": false,
      "installedVersion": null,
      "loaded": false,
      "bundled": false
    }
  ]
}
```

| Field | Type | Description |
|-------|------|-------------|
| `name` | string | Full npm package name |
| `installed` | boolean | Whether this plugin is currently installed |
| `installedVersion` | string\|null | Installed version, or `null` if not installed |
| `loaded` | boolean | Whether this plugin is loaded in the running agent runtime |
| `bundled` | boolean | Whether this plugin is bundled into the Eliza binary |

---

### GET /api/registry/plugins/:name

Get details for a specific registry plugin. The `name` parameter should be URL-encoded if it contains slashes (e.g., `%40elizaos%2Fplugin-twitter`).

**Path Parameters**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `name` | string | Yes | Full npm package name (URL-encoded) |

**Response**

```json
{
  "plugin": {
    "name": "@elizaos/plugin-x",
    "displayName": "Twitter",
    "description": "Twitter/X integration for posting and monitoring",
    "npm": {
      "package": "@elizaos/plugin-x",
      "version": "1.2.0"
    },
    "author": "elizaOS Team",
    "repository": "https://github.com/elizaos/eliza",
    "tags": ["social", "twitter"],
    "installed": false,
    "loaded": false,
    "bundled": false
  }
}
```

---

### GET /api/registry/search

Search the plugin registry by keyword.

**Query Parameters**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `q` | string | Yes | Search query |
| `limit` | integer | No | Maximum results to return (default: 15, max: 50) |

**Response**

```json
{
  "query": "twitter",
  "count": 2,
  "results": [
    {
      "name": "@elizaos/plugin-x",
      "displayName": "Twitter",
      "description": "Twitter/X integration",
      "npmPackage": "@elizaos/plugin-x",
      "version": "1.2.0"
    }
  ]
}
```

---

### POST /api/registry/refresh

Force refresh the local registry cache from the upstream elizaOS registry.

**Response**

```json
{
  "ok": true,
  "count": 87
}
```

---

### GET /api/registry/status

Get the agent's registry connection status.

**Response**

When the registry service is configured:

```json
{
  "registered": true,
  "configured": true,
  "tokenId": 1,
  "agentName": "Eliza",
  "agentEndpoint": "https://...",
  "capabilitiesHash": "...",
  "isActive": true,
  "tokenURI": "https://...",
  "walletAddress": "0x...",
  "totalAgents": 42
}
```

When the registry service is not configured:

```json
{
  "registered": false,
  "configured": false,
  "tokenId": 0,
  "agentName": "",
  "agentEndpoint": "",
  "capabilitiesHash": "",
  "isActive": false,
  "tokenURI": "",
  "walletAddress": "",
  "totalAgents": 0
}
```

---

### POST /api/registry/register

Register the agent with the elizaOS registry.

**Request Body**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | No | Agent name override |
| `endpoint` | string | No | Public endpoint URL |
| `tokenURI` | string | No | Token URI for the registration |

**Response**

Returns the registration result from the registry service (schema depends on registry implementation).

---

### POST /api/registry/update-uri

Update the agent's token URI in the registry.

**Request Body**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `tokenURI` | string | Yes | New token URI |

**Response**

```json
{
  "ok": true
}
```

---

### POST /api/registry/sync

Sync the agent's state with the registry (heartbeat, status update).

**Request Body**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | No | Agent name override |
| `endpoint` | string | No | Public endpoint URL |
| `tokenURI` | string | No | Token URI |

**Response**

```json
{
  "ok": true,
  "txHash": "0x..."
}
```

---

### GET /api/registry/config

Get the current registry configuration. Returns the contents of `config.registry` along with chain metadata.

**Response**

```json
{
  "chainId": 1,
  "explorerUrl": "https://etherscan.io",
  "...": "additional fields from config.registry"
}
```

The exact response shape depends on what is configured in `eliza.json` under the `registry` key.
