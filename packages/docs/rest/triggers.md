---
title: "Triggers API"
sidebarTitle: "Triggers"
description: "REST API endpoints for creating and managing scheduled, one-shot, and cron-based agent triggers."
---

Triggers schedule the agent to perform tasks automatically. They are backed by the elizaOS `TaskService` and support interval-based, cron-based, and one-shot scheduling. The agent must be running and triggers must be enabled in configuration.

<Info>
Triggers are disabled by configuration in some deployments. Check `GET /api/triggers/health` to verify the trigger system is available.
</Info>

## Endpoints

### GET /api/triggers/health

Get the trigger system health snapshot. This endpoint works even when triggers are disabled.

**Response**

```json
{
  "triggersEnabled": true,
  "activeTriggers": 3,
  "disabledTriggers": 1,
  "totalExecutions": 42,
  "totalFailures": 2,
  "totalSkipped": 0
}
```

---

### GET /api/triggers

List all triggers, sorted alphabetically by display name.

**Response**

```json
{
  "triggers": [
    {
      "triggerId": "550e8400-e29b-41d4-a716-446655440000",
      "displayName": "Morning Check-in",
      "triggerType": "interval",
      "enabled": true,
      "intervalMs": 3600000,
      "instructions": "Post a morning update",
      "wakeMode": "inject_now",
      "createdBy": "api",
      "nextRunAtMs": 1718003600000,
      "lastRunAtMs": 1718000000000,
      "runCount": 5
    }
  ]
}
```

---

### POST /api/triggers

Create a new trigger. Returns `429` if the active trigger limit for the creator is reached, and `409` if an equivalent trigger (same dedupe key) already exists.

**Request**

```json
{
  "displayName": "Morning Check-in",
  "instructions": "Post a morning update about what you're working on",
  "triggerType": "interval",
  "intervalMs": 3600000,
  "wakeMode": "inject_now",
  "enabled": true,
  "createdBy": "api"
}
```

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `kind` | string | No | Trigger kind: `"text"` (default) or `"workflow"`. Workflow triggers require `workflowId`. |
| `displayName` | string | No | Human-readable trigger name (default: `"New Trigger"`) |
| `instructions` | string | No | Instructions for the agent when this trigger fires |
| `triggerType` | string | No | `"interval"`, `"cron"`, or `"once"` (default: `"interval"`) |
| `intervalMs` | number | No | Interval in milliseconds (for `triggerType: "interval"`) |
| `cronExpression` | string | No | Cron expression (for `triggerType: "cron"`) |
| `scheduledAtIso` | string | No | ISO 8601 datetime for one-shot triggers (for `triggerType: "once"`) |
| `maxRuns` | number | No | Maximum number of times this trigger can fire |
| `wakeMode` | string | No | `"inject_now"` fires immediately (default), other modes defer |
| `enabled` | boolean | No | Whether the trigger is active (default: `true`) |
| `createdBy` | string | No | Creator identifier for limit tracking (default: `"api"`) |
| `workflowId` | string | No | workflow ID (required when `kind` is `"workflow"`) |
| `workflowName` | string | No | Human-readable workflow name (for `kind: "workflow"`) |

**Response (201 Created)**

```json
{
  "trigger": {
    "triggerId": "550e8400-e29b-41d4-a716-446655440000",
    "displayName": "Morning Check-in",
    "triggerType": "interval",
    "enabled": true,
    "intervalMs": 3600000,
    "nextRunAtMs": 1718003600000
  }
}
```

---

### GET /api/triggers/:id

Get a trigger by its ID (trigger UUID or task UUID).

**Path Parameters**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `id` | string | Yes | Trigger ID or task ID |

**Response**

```json
{
  "trigger": {
    "triggerId": "550e8400-e29b-41d4-a716-446655440000",
    "displayName": "Morning Check-in",
    "triggerType": "interval",
    "enabled": true,
    "intervalMs": 3600000
  }
}
```

---

### PUT /api/triggers/:id

Update a trigger. Fields not provided are preserved from the existing trigger. Changing schedule parameters recomputes `nextRunAtMs`.

**Path Parameters**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `id` | string | Yes | Trigger ID |

**Request**

```json
{
  "displayName": "Updated Morning Check-in",
  "intervalMs": 7200000,
  "enabled": true
}
```

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `displayName` | string | No | New display name |
| `instructions` | string | No | New instructions |
| `intervalMs` | number | No | New interval in milliseconds |
| `cronExpression` | string | No | New cron expression |
| `scheduledAtIso` | string | No | New one-shot datetime |
| `maxRuns` | number | No | New maximum run count |
| `enabled` | boolean | No | Enable or disable the trigger |

**Response**

```json
{
  "trigger": {
    "triggerId": "550e8400-e29b-41d4-a716-446655440000",
    "displayName": "Updated Morning Check-in",
    "enabled": true,
    "intervalMs": 7200000,
    "nextRunAtMs": 1718007200000
  }
}
```

---

### DELETE /api/triggers/:id

Delete a trigger permanently.

**Path Parameters**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `id` | string | Yes | Trigger ID |

**Response**

```json
{
  "ok": true
}
```

---

### POST /api/triggers/:id/execute

Manually execute a trigger immediately, regardless of its schedule.

**Path Parameters**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `id` | string | Yes | Trigger ID |

**Response**

```json
{
  "ok": true,
  "result": { "success": true },
  "trigger": {
    "triggerId": "550e8400-e29b-41d4-a716-446655440000",
    "runCount": 6,
    "lastRunAtMs": 1718001000000
  }
}
```

---

### GET /api/triggers/:id/runs

Get the run history for a trigger.

**Path Parameters**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `id` | string | Yes | Trigger ID |

**Response**

```json
{
  "runs": [
    {
      "runId": "run-001",
      "startedAt": 1718000000000,
      "completedAt": 1718000005000,
      "success": true,
      "source": "scheduled"
    }
  ]
}
```

## Common Error Codes

| Status | Code | Description |
|--------|------|-------------|
| 400 | `INVALID_REQUEST` | Request body is malformed or missing required fields |
| 401 | `UNAUTHORIZED` | Missing or invalid authentication token |
| 404 | `NOT_FOUND` | Requested resource does not exist |
| 409 | `TRIGGER_EXISTS` | A trigger with the same configuration already exists |
| 429 | `TRIGGER_LIMIT_REACHED` | Maximum number of triggers for this creator has been reached |
| 500 | `TRIGGER_DISABLED` | Trigger system is disabled in configuration |
| 500 | `INTERNAL_ERROR` | Unexpected server error |
