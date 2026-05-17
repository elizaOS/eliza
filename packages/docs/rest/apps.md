---
title: "Apps API"
sidebarTitle: "Apps"
description: "REST API endpoints for browsing, launching, and managing apps, plus Hyperscape embedded agent integration."
---

The apps API manages installable applications (which are backed by elizaOS plugins). Apps can be browsed from the registry, launched (which installs their plugin if needed), and stopped. The Hyperscape integration provides control of embedded AI agents in the Hyperscape virtual environment.

## Apps

### GET /api/apps

List all available and installed apps from the registry.

**Response**

```json
[
  {
    "name": "@hyperscape/plugin-hyperscape",
    "displayName": "Hyperscape",
    "description": "Virtual world environment",
    "category": "game",
    "launchType": "viewer",
    "launchUrl": null,
    "icon": null,
    "heroImage": null,
    "capabilities": [],
    "stars": 100,
    "repository": "https://github.com/HyperscapeAI/hyperscape",
    "latestVersion": "1.0.0",
    "supports": { "v0": false, "v1": false, "v2": true },
    "npm": {
      "package": "@hyperscape/plugin-hyperscape",
      "v0Version": null,
      "v1Version": null,
      "v2Version": "1.0.0"
    },
    "viewer": {
      "url": "https://example.com/app",
      "sandbox": "allow-scripts allow-same-origin",
      "postMessageAuth": false
    }
  }
]
```

---

### GET /api/apps/search

Search for apps in the registry.

**Query Parameters**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `q` | string | Yes | Search query. Returns empty array if blank |
| `limit` | integer | No | Maximum results to return |

**Response**

Array of app objects matching the search query.

---

### GET /api/apps/installed

List all currently installed apps.

**Response**

Array of installed app objects.

---

### POST /api/apps/launch

Launch an app. If the app's plugin is not installed, it is installed first. Returns viewer configuration for the app.

**Request**

```json
{
  "name": "@elizaos/app-browser"
}
```

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `name` | string | Yes | App name from the registry |

**Response**

```json
{
  "name": "@elizaos/app-browser",
  "displayName": "Browser",
  "viewerUrl": "http://localhost:2138/apps/browser",
  "running": true
}
```

---

### POST /api/apps/stop

Stop a running app. Disconnects the app session and uninstalls its plugin if it was installed on-demand.

**Request**

```json
{
  "name": "@elizaos/app-browser"
}
```

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `name` | string | Yes | App name to stop |

**Response**

```json
{
  "ok": true,
  "name": "@elizaos/app-browser"
}
```

---

### GET /api/apps/info/:name

Get details for a specific app.

**Path Parameters**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `name` | string | Yes | URL-encoded app name |

**Response**

```json
{
  "name": "@elizaos/app-browser",
  "displayName": "Browser",
  "description": "Web browsing capability",
  "version": "1.0.0",
  "installed": true,
  "running": false,
  "readme": "..."
}
```

---

### GET /api/apps/plugins

List non-app plugins from the registry (plugins that are not categorized as apps).

**Response**

Array of plugin registry objects.

---

### GET /api/apps/plugins/search

Search non-app plugins in the registry.

**Query Parameters**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `q` | string | Yes | Search query. Returns empty array if blank |
| `limit` | integer | No | Maximum results to return |

**Response**

Array of plugin search results.

---

### POST /api/apps/refresh

Refresh the app registry cache from the upstream registry source.

**Response**

```json
{
  "ok": true,
  "count": 42
}
```

---

## Hyperscape Integration

The Hyperscape endpoints relay requests to the Hyperscape embedded agent API. These endpoints control AI agents embedded in the Hyperscape virtual world environment.

### GET /api/apps/hyperscape/embedded-agents

List all embedded Hyperscape agents.

**Response**

Proxied response from the Hyperscape API — array of embedded agent objects.

---

### POST /api/apps/hyperscape/embedded-agents

Create a new embedded Hyperscape agent.

**Request**

Proxied directly to the Hyperscape API. See Hyperscape documentation for the request body schema.

**Response**

Proxied response from the Hyperscape API.

---

### POST /api/apps/hyperscape/embedded-agents/:id/:action

Control an embedded agent. `:action` must be one of `start`, `stop`, `pause`, `resume`, or `command`.

**Path Parameters**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `id` | string | Yes | Embedded agent character ID |

**Response**

Proxied response from the Hyperscape API.

---

### POST /api/apps/hyperscape/agents/:id/message

Send a chat message to a Hyperscape agent.

**Path Parameters**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `id` | string | Yes | Hyperscape agent ID |

**Request**

```json
{
  "content": "Hello, what are you doing?"
}
```

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `content` | string | Yes | Message text to send to the agent |

**Response**

Proxied response from the Hyperscape API.

---

### GET /api/apps/hyperscape/agents/:id/goal

Get the current goal of a Hyperscape agent.

**Path Parameters**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `id` | string | Yes | Hyperscape agent ID |

**Response**

Proxied response from the Hyperscape API.

---

### GET /api/apps/hyperscape/agents/:id/quick-actions

Get available quick actions for a Hyperscape agent.

**Path Parameters**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `id` | string | Yes | Hyperscape agent ID |

**Response**

Proxied response from the Hyperscape API.

## Common Error Codes

| Status | Code | Description |
|--------|------|-------------|
| 400 | `INVALID_REQUEST` | Request body is malformed or missing required fields |
| 401 | `UNAUTHORIZED` | Missing or invalid authentication token |
| 404 | `NOT_FOUND` | Requested resource does not exist |
| 500 | `REGISTRY_ERROR` | Failed to fetch from app registry |
| 500 | `APP_ALREADY_RUNNING` | App is already running and cannot be launched again |
| 500 | `INTERNAL_ERROR` | Unexpected server error |
