---
title: "Automations API"
sidebarTitle: "Automations"
description: "REST API endpoints for listing automation items and browsing the node catalog."
---

The Automations API provides a unified view of all automation sources (triggers, workflows, cron jobs, workbench tasks) and a catalog of available automation nodes. These endpoints power the Automations tab in the dashboard.

## Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/automations` | List all automation items |
| GET | `/api/automations/nodes` | Browse the automation node catalog |

---

### GET /api/automations

Returns a unified list of all automation items across sources (triggers, workflows, cron jobs, workbench tasks).

**Response**

```json
{
  "automations": [
    {
      "id": "trigger-uuid",
      "source": "trigger",
      "type": "coordinator_text",
      "displayName": "Daily summary",
      "enabled": true,
      "triggerId": "trigger-uuid",
      "lastRun": "2026-04-22T14:00:00Z"
    }
  ]
}
```

| Field | Type | Description |
|-------|------|-------------|
| `automations` | array | All automation items across all sources |
| `automations[].source` | string | `"trigger"`, `"workflow"`, `"cron"`, or `"workbench"` |
| `automations[].type` | string | Automation type (e.g., `"coordinator_text"`, `"workflow_service"`) |
| `automations[].enabled` | boolean | Whether the automation is currently active |

---

### GET /api/automations/nodes

Returns the catalog of available automation node types that can be used to compose workflows.

**Response**

```json
{
  "nodes": [
    {
      "id": "trigger-interval",
      "class": "trigger",
      "displayName": "Interval Trigger",
      "description": "Fires on a recurring interval"
    }
  ]
}
```

| Field | Type | Description |
|-------|------|-------------|
| `nodes` | array | Available automation node descriptors |
| `nodes[].class` | string | Node class: `"trigger"`, `"action"`, `"context"`, `"integration"`, or `"agent"` |

---

## Related

- [Triggers API](/rest/triggers) — Create and manage triggers directly
- [Coding Agents API](/rest/coding-agents) — Workbench task management
