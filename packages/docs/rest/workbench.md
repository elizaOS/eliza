---
title: "Workbench API"
sidebarTitle: "Workbench"
description: "REST API endpoints for the workbench — tasks, todos, life-ops, and the overview dashboard."
---

The workbench API manages the agent's task board and todo list. Tasks represent higher-level objectives tracked by the runtime, while todos are lightweight checklist items. Todos are persisted to the database when the todo data service plugin is available, falling back to the runtime task system otherwise. The overview endpoint aggregates both alongside trigger, autonomy, and life-ops state for the dashboard.

## Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/workbench/overview` | Dashboard overview |
| GET | `/api/workbench/tasks` | List all tasks |
| POST | `/api/workbench/tasks` | Create a workbench task |
| GET | `/api/workbench/tasks/:id` | Get a single task |
| PUT | `/api/workbench/tasks/:id` | Update a task |
| DELETE | `/api/workbench/tasks/:id` | Delete a task |
| GET | `/api/workbench/todos` | List all todos |
| POST | `/api/workbench/todos` | Create or update a workbench to-do item |
| POST | `/api/workbench/vfs/projects` | Create or open a VFS project |
| GET | `/api/workbench/vfs/projects/:id/quota` | Read VFS quota |
| GET | `/api/workbench/vfs/projects/:id/files` | List VFS files |
| GET | `/api/workbench/vfs/projects/:id/file` | Read a VFS file |
| PUT | `/api/workbench/vfs/projects/:id/file` | Write a VFS file |
| DELETE | `/api/workbench/vfs/projects/:id/file` | Delete a VFS file |
| GET | `/api/workbench/vfs/projects/:id/snapshots` | List snapshots |
| POST | `/api/workbench/vfs/projects/:id/snapshots` | Create snapshot |
| GET | `/api/workbench/vfs/projects/:id/diff` | Diff current files against a snapshot |
| POST | `/api/workbench/vfs/projects/:id/rollback` | Roll back to snapshot |
| POST | `/api/workbench/vfs/projects/:id/compile-plugin` | Compile TypeScript/JS from VFS |
| POST | `/api/workbench/vfs/projects/:id/load-plugin` | Load a VFS plugin into the runtime |
| GET | `/api/workbench/vfs/plugins` | List loaded VFS plugins |
| DELETE | `/api/workbench/vfs/projects/:id/plugins/:pluginName` | Unload a VFS plugin |

---

### GET /api/workbench/overview

Returns a combined view of tasks, triggers, todos, autonomy state, life-ops data, and summary counts. This is the primary endpoint for the workbench dashboard. When the LifeOps service is available, the response includes a `lifeops` object with the full [LifeOps overview](/rest/lifeops#get-apilifeopsoverview).

**Response**

```json
{
  "tasks": [
    {
      "id": "uuid",
      "name": "Process incoming data",
      "description": "Analyze and store data feeds",
      "tags": ["workbench-task"],
      "isCompleted": false
    }
  ],
  "triggers": [
    {
      "id": "uuid",
      "displayName": "Hourly Check",
      "enabled": true,
      "schedule": "0 * * * *"
    }
  ],
  "todos": [
    {
      "id": "uuid",
      "name": "Review latest logs",
      "description": "Check for anomalies",
      "isCompleted": false,
      "priority": 1,
      "isUrgent": false,
      "type": "task"
    }
  ],
  "summary": {
    "totalTasks": 3,
    "completedTasks": 1,
    "totalTriggers": 2,
    "activeTriggers": 2,
    "totalTodos": 5,
    "completedTodos": 2
  },
  "autonomy": {
    "enabled": true,
    "thinking": false,
    "lastEventAt": 1718000000000
  },
  "lifeops": {
    "occurrences": [],
    "goals": [],
    "reminders": [],
    "summary": {
      "activeOccurrenceCount": 0,
      "overdueOccurrenceCount": 0,
      "snoozedOccurrenceCount": 0,
      "activeReminderCount": 0,
      "activeGoalCount": 0
    }
  },
  "tasksAvailable": true,
  "triggersAvailable": true,
  "todosAvailable": true,
  "lifeopsAvailable": true
}
```

---

## Tasks

### GET /api/workbench/tasks

List all workbench tasks, sorted alphabetically by name.

**Response**

```json
{
  "tasks": [
    {
      "id": "uuid",
      "name": "Process data",
      "description": "...",
      "tags": ["workbench-task"],
      "isCompleted": false
    }
  ]
}
```

---

### POST /api/workbench/tasks

Create a new workbench task.

**Request Body**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | Yes | Task name |
| `description` | string | No | Task description |
| `tags` | string[] | No | Additional tags (auto-includes `workbench-task`) |
| `isCompleted` | boolean | No | Initial completion state (default `false`) |

**Response** (201)

```json
{
  "task": {
    "id": "uuid",
    "name": "New task",
    "description": "",
    "tags": ["workbench-task"],
    "isCompleted": false
  }
}
```

---

### GET /api/workbench/tasks/:id

Get a single task by ID.

**Response**

```json
{
  "task": { "id": "uuid", "name": "...", "isCompleted": false }
}
```

| Status | Condition |
|--------|-----------|
| 404 | Task not found |

---

### PUT /api/workbench/tasks/:id

Update an existing task.

**Request Body**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | No | Updated name (cannot be empty) |
| `description` | string | No | Updated description |
| `tags` | string[] | No | Updated tags |
| `isCompleted` | boolean | No | Completion state |

**Response**

```json
{
  "task": { "id": "uuid", "name": "Updated name", "isCompleted": true }
}
```

---

### DELETE /api/workbench/tasks/:id

Delete a task.

**Response**

```json
{
  "ok": true
}
```

---

## Todos

### GET /api/workbench/todos

List all workbench todos, sorted alphabetically. Todos are aggregated from both the database-backed todo data service and the runtime task system, de-duplicated by name.

**Response**

```json
{
  "todos": [
    {
      "id": "uuid",
      "name": "Review logs",
      "description": "Check for errors",
      "isCompleted": false,
      "priority": 1,
      "isUrgent": false,
      "type": "task"
    }
  ]
}
```

---

### POST /api/workbench/todos

Create or update a to-do item. When the todo data service plugin is available, the todo is persisted to the database first, falling back to the runtime task system on failure.

**Request Body**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | Yes | Todo name |
| `description` | string | No | Todo description |
| `priority` | number | No | Priority level |
| `isUrgent` | boolean | No | Urgency flag |
| `type` | string | No | Todo type (default `task`) |
| `isCompleted` | boolean | No | Initial completion state |
| `tags` | string[] | No | Additional tags |

**Response** (201)

```json
{
  "todo": {
    "id": "uuid",
    "name": "New todo",
    "isCompleted": false,
    "priority": null,
    "isUrgent": false,
    "type": "task"
  }
}
```

## VFS Projects

Workbench VFS projects are isolated virtual filesystems for generated apps,
applets, and plugins. The VFS enforces traversal rejection, symlink rejection,
project quota, max-file quota, snapshots, diff, and rollback. It is the local
storage layer used by mobile-safe applets and by generated TypeScript plugins.

### POST /api/workbench/vfs/projects

Create or open a VFS project.

```json
{ "projectId": "demo-app" }
```

Responses expose virtual project metadata only. Host filesystem roots, snapshot
roots, and compiled plugin disk paths are intentionally redacted from the public
Workbench API.

### GET/PUT/DELETE /api/workbench/vfs/projects/:id/file

`GET` and `DELETE` take a `path` query parameter. `GET` accepts
`encoding=utf-8|base64`. `PUT` takes:

```json
{
  "path": "src/plugin.ts",
  "content": "export default { name: 'demo' };",
  "encoding": "utf-8"
}
```

### Snapshots, Diffs, Rollback

Create snapshots before risky generated-code edits:

```json
{ "note": "before agent edit" }
```

Diff current files against a snapshot:

```text
GET /api/workbench/vfs/projects/demo-app/diff?snapshotId=<snapshot-id>
```

Rollback:

```json
{ "snapshotId": "<snapshot-id>" }
```

### Compile And Load Plugins

Generated TypeScript plugins can be compiled and loaded from the VFS:

```json
{
  "entry": "src/plugin.ts",
  "outFile": "dist/plugin.js",
  "format": "esm",
  "target": "node20"
}
```

```json
{
  "entry": "src/plugin.ts",
  "compileFirst": true
}
```

### Promote To Cloud

Use this route when a local Workbench VFS project needs full Claude, Codex, or
OpenCode execution in an Eliza Cloud coding container.

```text
POST /api/workbench/vfs/projects/demo-app/promote-to-cloud
```

```json
{
  "snapshotId": "snapshot-id",
  "name": "Demo app",
  "description": "Generated app workspace",
  "preferredAgent": "codex",
  "workspacePath": "/workspace/demo-app",
  "branchName": "agent/demo-app"
}
```

The agent backend exports the requested snapshot, packages files with
`encoding=utf-8|base64`, and forwards the bundle to
`@elizaos/plugin-elizacloud` through the `CLOUD_CONTAINER` service.

**Response** (202)

```json
{
  "success": true,
  "data": {
    "promotionId": "promotion-id",
    "status": "accepted",
    "source": {
      "sourceKind": "project",
      "projectId": "demo-app",
      "snapshotId": "snapshot-id"
    },
    "workspacePath": "/workspace/demo-app",
    "createdAt": "2026-05-11T16:00:00.000Z"
  }
}
```

The route fails closed. If Cloud auth is missing, the `CLOUD_CONTAINER` service
is unavailable, or the Cloud control-plane endpoint is not deployed, the server
returns an error such as `503` instead of returning a fake successful stub.

## Common Error Codes

| Status | Code | Description |
|--------|------|-------------|
| 400 | `INVALID_REQUEST` | Request body is malformed or missing required fields |
| 401 | `UNAUTHORIZED` | Missing or invalid authentication token |
| 404 | `NOT_FOUND` | Requested resource does not exist |
| 404 | `TASK_NOT_FOUND` | Task with specified ID does not exist |
| 400 | `EMPTY_NAME` | Task or todo name cannot be empty |
| 500 | `INTERNAL_ERROR` | Unexpected server error |
