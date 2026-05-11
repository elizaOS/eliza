---
title: Coding Agents API
sidebarTitle: Coding Agents
description: REST API endpoints for managing autonomous coding agent tasks and sessions.
---

These endpoints manage coding agent tasks exposed by `@elizaos/plugin-agent-orchestrator`. When the plugin does not export its own route handler, Eliza falls back to the plugin's `CODE_TASK` compatibility service for task metadata.

On iOS, Google Play Android, desktop store builds, and any local device without
validated Claude/Codex/OpenCode binaries, full coding-agent work should run in
Eliza Cloud coding containers. The local app can promote a Workbench VFS bundle
to Cloud, start a container with a selected agent, and sync changes back.

For setup, architecture, auth, and debug/benchmark guidance, see:

- [Coding Swarms (Orchestrator)](/guides/coding-swarms)

## Coordinator Status

```
GET /api/coding-agents/coordinator/status
```

Returns the supervision level and list of all active/completed coding agent tasks.

**Response:**
```json
{
  "supervisionLevel": "autonomous",
  "taskCount": 2,
  "pendingConfirmations": 0,
  "tasks": [
    {
      "sessionId": "550e8400-e29b-41d4-a716-446655440000",
      "agentType": "eliza",
      "label": "Refactor auth module",
      "originalTask": "Refactor the auth module to use JWT",
      "workdir": "/home/user/project",
      "status": "active",
      "decisionCount": 5,
      "autoResolvedCount": 3
    }
  ]
}
```

Returns an empty task list (not an error) if the orchestrator service is unavailable.

**Task status mapping:**

| Orchestrator State | API Status |
|-------------------|------------|
| `running`, `pending` | `active` |
| `completed` | `completed` |
| `failed`, `error` | `error` |
| `cancelled` | `stopped` |
| `paused` | `blocked` |

## Stop Task

```
POST /api/coding-agents/:sessionId/stop
```

Cancels a specific coding agent task by its session ID.

**Path params:**

| Param | Type | Description |
|-------|------|-------------|
| `sessionId` | string | The task UUID |

**Response:**
```json
{ "ok": true }
```

**Errors:** `503` if the orchestrator service is unavailable; `500` on cancellation failure.

## Cloud Coding Containers

These routes are exposed by `@elizaos/plugin-elizacloud`. The local plugin
requires a configured Eliza Cloud account and a deployed Cloud coding-container
control plane. It fails closed: when Cloud auth is disconnected, the
`CLOUD_CONTAINER` service is unavailable, or the backend endpoint is not
deployed, these routes return an error such as `503` instead of a fake
successful stub.

Container `status` values are `requested`, `pending`, `building`, `running`,
`failed`, or `stopped`. File encodings are `utf-8` or `base64`.

Workbench VFS callers can use the shortcut route documented in
[Workbench VFS](/rest/workbench#promote-to-cloud):

```text
POST /api/workbench/vfs/projects/:id/promote-to-cloud
```

### Promote VFS Bundle

```
POST /api/cloud/coding-containers/promotions
```

```json
{
  "source": {
    "sourceKind": "project",
    "projectId": "demo-app",
    "snapshotId": "snapshot-id",
    "files": [
      {
        "path": "src/plugin.ts",
        "contents": "export default { name: 'demo' };",
        "encoding": "utf-8"
      }
    ]
  },
  "preferredAgent": "codex"
}
```

**Response** (200)

```json
{
  "success": true,
  "data": {
    "promotionId": "promotion-id",
    "status": "accepted",
    "source": {
      "sourceKind": "project",
      "projectId": "demo-app"
    },
    "workspacePath": "/workspace/demo-app",
    "createdAt": "2026-05-11T16:00:00.000Z"
  }
}
```

### Start Coding Container

```
POST /api/cloud/coding-containers
```

```json
{
  "agent": "codex",
  "promotionId": "promotion-id",
  "prompt": "Implement the app and return patches"
}
```

`agent` must be `claude`, `codex`, or `opencode`.

**Response** (200)

```json
{
  "success": true,
  "data": {
    "containerId": "container-id",
    "status": "requested",
    "agent": "codex",
    "promotionId": "promotion-id",
    "workspacePath": "/workspace/demo-app",
    "url": "https://cloud.elizaos.ai/coding/container-id",
    "createdAt": "2026-05-11T16:00:00.000Z"
  }
}
```

### Sync Changes

```
POST /api/cloud/coding-containers/:containerId/sync
```

```json
{
  "direction": "roundtrip",
  "target": {
    "sourceKind": "project",
    "projectId": "demo-app",
    "baseRevision": "snapshot-id"
  },
  "changedFiles": [],
  "deletedFiles": [],
  "patches": []
}
```

**Response** (200)

```json
{
  "success": true,
  "data": {
    "syncId": "sync-id",
    "containerId": "container-id",
    "status": "accepted",
    "direction": "roundtrip",
    "target": {
      "sourceKind": "project",
      "projectId": "demo-app",
      "baseRevision": "snapshot-id"
    },
    "changedFiles": [],
    "deletedFiles": [],
    "patches": [],
    "createdAt": "2026-05-11T16:00:00.000Z"
  }
}
```
