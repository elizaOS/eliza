---
title: "LifeOps API"
sidebarTitle: "LifeOps"
description: "REST API endpoints for managing life-ops definitions, goals, and occurrences — the behavior-support system for tasks, habits, and routines."
---

The LifeOps API manages the agent's behavior-support system. Definitions describe recurring tasks, habits, or routines. The engine generates occurrences (individual instances) based on each definition's cadence. Goals group related definitions and track progress. All endpoints are under `/api/lifeops`.

<Info>
LifeOps routes require an active agent runtime. If the runtime is unavailable, all endpoints return `503 Service Unavailable`.
</Info>

## Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/lifeops/overview` | Aggregated overview of occurrences, goals, and reminders |
| GET | `/api/lifeops/definitions` | List all definitions |
| POST | `/api/lifeops/definitions` | Create a new definition |
| GET | `/api/lifeops/definitions/:id` | Get a single definition |
| PUT | `/api/lifeops/definitions/:id` | Update a definition |
| GET | `/api/lifeops/goals` | List all goals |
| POST | `/api/lifeops/goals` | Create a new goal |
| GET | `/api/lifeops/goals/:id` | Get a single goal |
| PUT | `/api/lifeops/goals/:id` | Update a goal |
| POST | `/api/lifeops/occurrences/:id/complete` | Mark an occurrence as completed |
| POST | `/api/lifeops/occurrences/:id/skip` | Skip an occurrence |
| POST | `/api/lifeops/occurrences/:id/snooze` | Snooze an occurrence |
| POST | `/api/lifeops/reminders/process` | Advance the reminder engine (fire pending reminders) |
| POST | `/api/lifeops/reminders/acknowledge` | Acknowledge a reminder |
| GET | `/api/lifeops/reminders/inspection` | Inspect reminder state for an occurrence |
| GET | `/api/lifeops/workflows` | List event-triggered workflows |
| POST | `/api/lifeops/workflows` | Create an event-triggered workflow |

---

### GET /api/lifeops/overview

Returns an aggregated view of active occurrences, goals, reminders, and summary counts. This is the primary endpoint for the LifeOps dashboard.

**Response**

```json
{
  "occurrences": [
    {
      "id": "occ-uuid",
      "agentId": "agent-uuid",
      "definitionId": "def-uuid",
      "occurrenceKey": "2026-04-05-morning",
      "scheduledAt": "2026-04-05T08:00:00Z",
      "dueAt": "2026-04-05T09:00:00Z",
      "relevanceStartAt": "2026-04-05T07:30:00Z",
      "relevanceEndAt": "2026-04-05T09:30:00Z",
      "windowName": "morning",
      "state": "visible",
      "snoozedUntil": null,
      "completionPayload": null,
      "derivedTarget": null,
      "metadata": {},
      "createdAt": "2026-04-05T00:00:00Z",
      "updatedAt": "2026-04-05T07:30:00Z",
      "definitionKind": "habit",
      "definitionStatus": "active",
      "title": "Morning meditation",
      "description": "10-minute guided session",
      "priority": 1,
      "timezone": "America/New_York",
      "source": "user",
      "goalId": "goal-uuid"
    }
  ],
  "goals": [
    {
      "id": "goal-uuid",
      "agentId": "agent-uuid",
      "title": "Improve focus",
      "description": "Build a daily mindfulness practice",
      "cadence": null,
      "supportStrategy": {},
      "successCriteria": {},
      "status": "active",
      "reviewState": "on_track",
      "metadata": {},
      "createdAt": "2026-04-01T00:00:00Z",
      "updatedAt": "2026-04-05T00:00:00Z"
    }
  ],
  "reminders": [
    {
      "occurrenceId": "occ-uuid",
      "definitionId": "def-uuid",
      "title": "Morning meditation",
      "channel": "in_app",
      "stepIndex": 0,
      "stepLabel": "First reminder",
      "scheduledFor": "2026-04-05T07:45:00Z",
      "dueAt": "2026-04-05T09:00:00Z",
      "state": "visible"
    }
  ],
  "summary": {
    "activeOccurrenceCount": 3,
    "overdueOccurrenceCount": 0,
    "snoozedOccurrenceCount": 1,
    "activeReminderCount": 2,
    "activeGoalCount": 1
  }
}
```

| Field | Type | Description |
|-------|------|-------------|
| `occurrences` | array | Active occurrences with their parent definition metadata |
| `goals` | array | All goal definitions |
| `reminders` | array | Active reminders with scheduling details |
| `summary` | object | Aggregate counts for dashboard display |

---

## Definitions

Definitions describe a repeating task, habit, or routine. Each definition has a cadence that controls when occurrences are generated.

### GET /api/lifeops/definitions

List all definitions for the current agent.

**Response**

```json
{
  "definitions": [
    {
      "id": "def-uuid",
      "agentId": "agent-uuid",
      "kind": "habit",
      "title": "Morning meditation",
      "description": "10-minute guided session",
      "originalIntent": "I want to meditate every morning",
      "timezone": "America/New_York",
      "status": "active",
      "priority": 1,
      "cadence": {
        "kind": "daily",
        "windows": ["morning"],
        "visibilityLeadMinutes": 30,
        "visibilityLagMinutes": 30
      },
      "windowPolicy": {
        "timezone": "America/New_York",
        "windows": [
          {
            "name": "morning",
            "label": "Morning",
            "startMinute": 420,
            "endMinute": 720
          }
        ]
      },
      "progressionRule": { "kind": "none" },
      "reminderPlanId": null,
      "goalId": "goal-uuid",
      "source": "user",
      "metadata": {},
      "createdAt": "2026-04-01T00:00:00Z",
      "updatedAt": "2026-04-05T00:00:00Z"
    }
  ]
}
```

---

### POST /api/lifeops/definitions

Create a new definition.

**Request body**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `kind` | string | Yes | One of `task`, `habit`, or `routine` |
| `title` | string | Yes | Display title |
| `description` | string | No | Longer description |
| `originalIntent` | string | No | The user's original request text |
| `timezone` | string | No | IANA timezone (e.g. `America/New_York`) |
| `priority` | number | No | Priority level (lower is higher priority) |
| `cadence` | object | Yes | Scheduling cadence (see [cadence types](#cadence-types)) |
| `windowPolicy` | object | No | Time window configuration |
| `progressionRule` | object | No | Progression rule (see [progression rules](#progression-rules)) |
| `reminderPlan` | object \| null | No | Inline reminder plan with steps, mute policy, and quiet hours |
| `goalId` | string \| null | No | Associated goal ID |
| `source` | string | No | Source identifier (e.g. `user`, `agent`) |
| `metadata` | object | No | Arbitrary key-value metadata |

**Response** (201)

Returns the created definition object.

---

### GET /api/lifeops/definitions/:id

Get a single definition by ID.

**Response**

Returns the full definition object.

| Status | Condition |
|--------|-----------|
| 404 | Definition not found |

---

### PUT /api/lifeops/definitions/:id

Update an existing definition. All fields are optional — only provided fields are updated.

**Request body**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `title` | string | No | Updated title |
| `description` | string | No | Updated description |
| `originalIntent` | string | No | Updated intent text |
| `timezone` | string | No | Updated timezone |
| `priority` | number | No | Updated priority |
| `cadence` | object | No | Updated cadence |
| `windowPolicy` | object | No | Updated window policy |
| `progressionRule` | object | No | Updated progression rule |
| `status` | string | No | One of `active`, `paused`, or `archived` |
| `reminderPlan` | object \| null | No | Updated reminder plan |
| `goalId` | string \| null | No | Updated goal association |
| `metadata` | object | No | Updated metadata |

**Response**

Returns the updated definition object.

---

## Goals

Goals group related definitions and track overall progress toward an objective.

### GET /api/lifeops/goals

List all goals for the current agent.

**Response**

```json
{
  "goals": [
    {
      "id": "goal-uuid",
      "agentId": "agent-uuid",
      "title": "Improve focus",
      "description": "Build a daily mindfulness practice",
      "cadence": null,
      "supportStrategy": {},
      "successCriteria": {},
      "status": "active",
      "reviewState": "on_track",
      "metadata": {},
      "createdAt": "2026-04-01T00:00:00Z",
      "updatedAt": "2026-04-05T00:00:00Z"
    }
  ]
}
```

---

### POST /api/lifeops/goals

Create a new goal.

**Request body**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `title` | string | Yes | Goal title |
| `description` | string | No | Goal description |
| `cadence` | object \| null | No | Optional review cadence |
| `supportStrategy` | object | No | Strategy for supporting linked definitions |
| `successCriteria` | object | No | Criteria for marking the goal as satisfied |
| `status` | string | No | One of `active`, `paused`, `archived`, or `satisfied` |
| `reviewState` | string | No | One of `idle`, `needs_attention`, `on_track`, or `at_risk` |
| `metadata` | object | No | Arbitrary key-value metadata |

**Response** (201)

Returns the created goal object.

---

### GET /api/lifeops/goals/:id

Get a single goal by ID.

**Response**

Returns the full goal object.

| Status | Condition |
|--------|-----------|
| 404 | Goal not found |

---

### PUT /api/lifeops/goals/:id

Update an existing goal. All fields are optional.

**Request body**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `title` | string | No | Updated title |
| `description` | string | No | Updated description |
| `cadence` | object \| null | No | Updated review cadence |
| `supportStrategy` | object | No | Updated support strategy |
| `successCriteria` | object | No | Updated success criteria |
| `status` | string | No | Updated status |
| `reviewState` | string | No | Updated review state |
| `metadata` | object | No | Updated metadata |

**Response**

Returns the updated goal object.

---

## Occurrences

Occurrences are individual instances of a definition, generated by the scheduling engine. You do not create occurrences directly — they are produced automatically based on each definition's cadence. The API exposes actions to transition occurrence state.

### POST /api/lifeops/occurrences/:id/complete

Mark an occurrence as completed.

**Request body**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `note` | string | No | Completion note or reflection |
| `metadata` | object | No | Additional completion metadata |

**Response**

```json
{
  "occurrence": {
    "id": "occ-uuid",
    "state": "completed",
    "completionPayload": {
      "note": "Felt focused today",
      "metadata": {}
    }
  }
}
```

| Status | Condition |
|--------|-----------|
| 404 | Occurrence not found |

---

### POST /api/lifeops/occurrences/:id/skip

Skip an occurrence. Send an empty JSON object as the request body.

**Request body**

```json
{}
```

**Response**

```json
{
  "occurrence": {
    "id": "occ-uuid",
    "state": "skipped"
  }
}
```

| Status | Condition |
|--------|-----------|
| 404 | Occurrence not found |

---

### POST /api/lifeops/occurrences/:id/snooze

Snooze an occurrence for a specified duration.

**Request body**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `minutes` | number | No | Custom snooze duration in minutes |
| `preset` | string | No | Named preset: `15m`, `30m`, `1h`, `tonight`, or `tomorrow_morning` |

Provide either `minutes` or `preset`, not both.

**Response**

```json
{
  "occurrence": {
    "id": "occ-uuid",
    "state": "snoozed",
    "snoozedUntil": "2026-04-05T09:30:00Z"
  }
}
```

| Status | Condition |
|--------|-----------|
| 404 | Occurrence not found |

---

## Cadence types

The `cadence` field on a definition controls when occurrences are generated. Four cadence kinds are supported:

| Kind | Description |
|------|-------------|
| `once` | A single occurrence at a specific time |
| `daily` | Repeats every day during specified time windows |
| `times_per_day` | Repeats at specific times each day |
| `weekly` | Repeats on specific weekdays during specified time windows |

### Once

```json
{
  "kind": "once",
  "dueAt": "2026-04-10T14:00:00Z",
  "visibilityLeadMinutes": 30,
  "visibilityLagMinutes": 15
}
```

### Daily

```json
{
  "kind": "daily",
  "windows": ["morning", "evening"],
  "visibilityLeadMinutes": 30,
  "visibilityLagMinutes": 30
}
```

### Times per day

```json
{
  "kind": "times_per_day",
  "slots": [
    { "key": "am-dose", "label": "Morning dose", "minuteOfDay": 480, "durationMinutes": 30 },
    { "key": "pm-dose", "label": "Evening dose", "minuteOfDay": 1200, "durationMinutes": 30 }
  ]
}
```

### Weekly

```json
{
  "kind": "weekly",
  "weekdays": [1, 3, 5],
  "windows": ["morning"],
  "visibilityLeadMinutes": 30,
  "visibilityLagMinutes": 30
}
```

Visibility lead and lag minutes control when an occurrence becomes visible before its scheduled time and how long it remains visible after.

---

## Progression rules

Progression rules allow a definition's target to increase over time.

| Kind | Description |
|------|-------------|
| `none` | No progression — fixed target |
| `linear_increment` | Target increases by a fixed step each period |

### Linear increment example

```json
{
  "kind": "linear_increment",
  "metric": "duration_minutes",
  "start": 5,
  "step": 1,
  "unit": "minutes"
}
```

---

## Time windows

Time windows divide the day into named periods. The built-in window names are `morning`, `afternoon`, `evening`, `night`, and `custom`. Each window specifies a start and end minute of the day (0–1439).

```json
{
  "timezone": "America/New_York",
  "windows": [
    { "name": "morning", "label": "Morning", "startMinute": 420, "endMinute": 720 },
    { "name": "afternoon", "label": "Afternoon", "startMinute": 720, "endMinute": 1020 },
    { "name": "evening", "label": "Evening", "startMinute": 1020, "endMinute": 1260 }
  ]
}
```

## Reminders

The reminder engine fires notifications for upcoming or overdue occurrences based on each definition's reminder plan.

### POST /api/lifeops/reminders/process

Advance the reminder engine — evaluates all active occurrences and fires any pending reminder steps. Typically called on a timer by the runtime.

**Request body**

```json
{}
```

**Response**

Returns the processed reminder results.

---

### POST /api/lifeops/reminders/acknowledge

Acknowledge a fired reminder. Prevents re-delivery of the same reminder step.

**Request body**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `reminderId` | string | Yes | The reminder instance ID |
| `channel` | string | No | The channel on which the reminder was acknowledged |

**Response**

Returns the updated reminder state.

---

### GET /api/lifeops/reminders/inspection

Inspect the current reminder ladder state for an occurrence. Useful for debugging reminder escalation.

**Query parameters**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `ownerType` | string | Yes | `occurrence` |
| `ownerId` | string | Yes | The occurrence ID |

**Response**

Returns the reminder plan steps and their current states (pending, fired, acknowledged, skipped).

---

## Workflows

Event-triggered workflows execute actions in response to external events (e.g., calendar events ending).

### GET /api/lifeops/workflows

List all event-triggered workflows for the current agent.

**Response**

Returns an array of workflow objects.

---

### POST /api/lifeops/workflows

Create a new event-triggered workflow.

**Request body**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `trigger` | object | Yes | Event trigger configuration (event type, filters) |
| `actions` | array | Yes | Actions to execute when the trigger fires |
| `title` | string | No | Display title |
| `enabled` | boolean | No | Whether the workflow is active (default: `true`) |

**Response** (201)

Returns the created workflow object.

---

## Common error codes

| Status | Description |
|--------|-------------|
| 400 | Request body is malformed or missing required fields |
| 401 | Missing or invalid authentication token |
| 404 | Requested resource does not exist |
| 503 | Agent runtime is not available |
