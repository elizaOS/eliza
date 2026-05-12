---
title: "Autonomy API"
sidebarTitle: "Autonomy"
description: "REST API endpoints for reading and controlling the agent's autonomous operation state."
---

The autonomy API controls whether the agent operates autonomously — proactively taking actions, posting, and engaging without user prompts. The autonomy state is managed by the `AUTONOMY` service in the agent runtime.

## Architecture

The autonomy system is managed by the `AUTONOMY` service registered in the agent runtime. The service creates a recurring task that the runtime's `TaskService` picks up and executes on its 1-second polling interval.

### Service Interface

The API layer interacts with the autonomy service through this interface:

| Method | Return Type | Description |
|--------|-------------|-------------|
| `enableAutonomy()` | `Promise<void>` | Start the autonomous operation loop |
| `disableAutonomy()` | `Promise<void>` | Stop the loop gracefully |
| `isLoopRunning()` | `boolean` | Whether the autonomy loop is currently executing a tick |
| `getStatus()` | `{ enabled?: boolean }` | Current enabled state |

### State Resolution

The `enabled` field in the response is resolved from the runtime flag `runtime.enableAutonomy === true`.

### Trigger Integration

When autonomy is enabled, the triggers system checks `runtime.enableAutonomy` as a gate before creating trigger-based actions. The autonomy service also exposes:

- `getAutonomousRoomId()` — returns the room UUID used for autonomous conversations
- `injectAutonomousInstruction(payload)` — injects a one-time instruction into the next autonomy tick

## Endpoints

### GET /api/agent/autonomy

Get the current autonomy state.

**Response**

```json
{
  "enabled": true
}
```

| Field | Type | Description |
|-------|------|-------------|
| `enabled` | boolean | Whether autonomous operation is currently enabled |

---

### POST /api/agent/autonomy

Enable or disable autonomous operation.

When enabling, the autonomy task fires its first tick immediately. When disabling, the loop is stopped gracefully after the current tick (if any) completes.

**Request**

```json
{
  "enabled": true
}
```

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `enabled` | boolean | Yes | `true` to enable autonomy, `false` to disable |

**Response**

```json
{
  "enabled": true
}
```

| Field | Type | Description |
|-------|------|-------------|
| `enabled` | boolean | The current autonomy enabled state after the operation |

**Behavior Notes**

- If the `AUTONOMY` service is not registered in the runtime, the `enabled` property is set directly on the runtime object
- The `enabled` parameter must be a boolean; non-boolean values return a `400` error

## Related

- [Autonomous Mode guide](/guides/autonomous-mode) — configuring autonomous behavior
- [Triggers guide](/guides/triggers) — trigger system that works with autonomy
- [API Reference overview](/api-reference)

## Common Error Codes

| Status | Code | Description |
|--------|------|-------------|
| 400 | `INVALID_REQUEST` | Request body is malformed or missing required fields |
| 401 | `UNAUTHORIZED` | Missing or invalid authentication token |
| 404 | `NOT_FOUND` | Requested resource does not exist |
| 503 | `SERVICE_UNAVAILABLE` | Autonomy service is not available |
| 500 | `AUTONOMY_DISABLED` | Autonomy feature is disabled in configuration |
| 500 | `INTERNAL_ERROR` | Unexpected server error |
