---
title: Triggers & Scheduled Tasks
sidebarTitle: Triggers
description: Schedule tasks that wake the agent on intervals, at specific times, or via cron expressions.
---

Triggers are scheduled tasks that wake the Eliza agent at defined times or intervals. They allow the agent to perform recurring work, one-time future tasks, or cron-scheduled operations without manual intervention.

## Architecture Overview

Triggers are built on top of the elizaOS task system. Each trigger is stored as a task with the name `TRIGGER_DISPATCH` and the tags `["queue", "repeat", "trigger"]`. The trigger configuration lives in `task.metadata.trigger` and the execution history lives in `task.metadata.triggerRuns`.

The trigger system consists of four source modules:

| Module | Path | Purpose |
|--------|------|---------|
| Types | `src/triggers/types.ts` | TypeScript interfaces and type definitions |
| Scheduling | `src/triggers/scheduling.ts` | Interval clamping, cron parsing, timing resolution, deduplication |
| Runtime | `src/triggers/runtime.ts` | Task execution, worker registration, health metrics |
| Action | `src/triggers/action.ts` | Chat-based trigger creation via LLM extraction |

The API routes are defined in `src/api/trigger-routes.ts` and handle all REST endpoints.

## Trigger Types

There are three trigger types, set via the `triggerType` field. The `TriggerType` union type is `"interval" | "once" | "cron"`.

### `interval`

Executes repeatedly at a fixed interval. Requires `intervalMs` (milliseconds between runs).

- Minimum interval: 60,000 ms (1 minute) -- defined as `MIN_TRIGGER_INTERVAL_MS`
- Maximum interval: 2,678,400,000 ms (31 days) -- defined as `MAX_TRIGGER_INTERVAL_MS`
- Values outside this range are clamped automatically by `normalizeTriggerIntervalMs()`
- Non-finite values default to the minimum interval
- The value is floored to an integer before clamping

**Example: Run every 5 minutes**

```json
{
  "triggerType": "interval",
  "intervalMs": 300000,
  "instructions": "Check system health and report anomalies"
}
```

**Example: Run every hour**

```json
{
  "triggerType": "interval",
  "intervalMs": 3600000,
  "instructions": "Summarize the latest activity in all channels"
}
```

### `once`

Executes a single time at a specific timestamp. Requires `scheduledAtIso` (ISO 8601 timestamp). The task is automatically deleted after execution.

- If the scheduled time is in the past, the trigger fires immediately (the next run time is set to `Math.max(nowMs, scheduledAt)`)
- The `scheduledAtIso` value must be parseable by `Date.parse()`

**Example: Run once at a future time**

```json
{
  "triggerType": "once",
  "scheduledAtIso": "2026-03-15T09:00:00.000Z",
  "instructions": "Send the quarterly report summary to the team channel"
}
```

### `cron`

Executes on a standard 5-field cron schedule. Requires `cronExpression`. Supports an optional `timezone` field for timezone-aware scheduling (IANA timezone names like `America/New_York`). Without a timezone, cron expressions are evaluated in UTC.

Cron fields: `minute hour dayOfMonth month dayOfWeek`

The cron parser supports:

- Wildcards: `*`
- Ranges: `1-5`
- Steps: `*/15`, `1-30/5`
- Lists: `1,15,30`
- Combinations: `1-5,10-15`

Valid ranges per field:

| Field | Min | Max |
|-------|-----|-----|
| minute | 0 | 59 |
| hour | 0 | 23 |
| dayOfMonth | 1 | 31 |
| month | 1 | 12 |
| dayOfWeek | 0 | 6 (0 = Sunday) |

The next cron run is computed by scanning forward in 1-minute increments from the current time, up to a window of 366 days (`CRON_SCAN_WINDOW_MS`). If no matching minute is found within that window, the trigger cannot be scheduled and returns `null`.

**Example: Every 15 minutes**

```json
{
  "triggerType": "cron",
  "cronExpression": "*/15 * * * *",
  "instructions": "Check price feeds"
}
```

**Example: Daily at 9 AM Eastern**

```json
{
  "triggerType": "cron",
  "cronExpression": "0 9 * * *",
  "timezone": "America/New_York",
  "instructions": "Generate the daily market briefing"
}
```

**Example: Weekdays at noon UTC**

```json
{
  "triggerType": "cron",
  "cronExpression": "0 12 * * 1-5",
  "instructions": "Post the midday status update"
}
```

## Wake Modes

Each trigger has a `wakeMode` that controls how it activates the agent. The `TriggerWakeMode` type is `"inject_now" | "next_autonomy_cycle"`.

| Mode | Description |
|------|-------------|
| `inject_now` | Immediately injects the trigger's instructions into the agent via the autonomy service, waking it if idle. The agent processes the instructions right away. |
| `next_autonomy_cycle` | Queues the instructions to be picked up on the next autonomous reasoning cycle. Does not interrupt the agent's current work. |

The dispatch mechanism calls `autonomyService.injectAutonomousInstruction()` with a payload including the trigger's instructions, the wake mode, trigger ID, task ID, and the autonomous room ID.

If the autonomy service is unavailable (not registered or missing `injectAutonomousInstruction`), the execution fails with error status `"Autonomy service unavailable for trigger dispatch"`.

## Environment Variables

Two environment variables control the trigger system:

### `ELIZA_TRIGGERS_ENABLED`

Enables or disables the entire trigger system. Default: `true` (enabled).

- Set to `"false"` or `"0"` to disable all triggers
- Can also be set as a runtime setting via `runtime.getSetting("ELIZA_TRIGGERS_ENABLED")`
- The runtime setting takes precedence over the environment variable
- When disabled, all trigger API endpoints (except `/api/triggers/health`) return `503`

### `ELIZA_TRIGGERS_MAX_ACTIVE`

Maximum number of active triggers per creator. Default: `100`.

- Must be a positive integer
- Can also be set as a runtime setting via `runtime.getSetting("ELIZA_TRIGGERS_MAX_ACTIVE")`
- The runtime setting takes precedence over the environment variable
- Minimum enforced value is `1` (values less than 1 are clamped)

## TriggerConfig Schema

The full trigger configuration (stored in `task.metadata.trigger`). Schema version is always `1` (`TRIGGER_SCHEMA_VERSION`).

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `version` | `1` | Yes | Schema version (always 1) |
| `triggerId` | `UUID` | Yes | Unique identifier for the trigger |
| `displayName` | `string` | Yes | Human-readable name |
| `instructions` | `string` | Yes | Text instructions the agent receives when the trigger fires |
| `triggerType` | `"interval" \| "once" \| "cron"` | Yes | Schedule type |
| `enabled` | `boolean` | Yes | Whether the trigger is active |
| `wakeMode` | `"inject_now" \| "next_autonomy_cycle"` | Yes | How the agent is activated |
| `createdBy` | `string` | Yes | Creator identifier (entity ID or `"api"`) |
| `runCount` | `number` | Yes | How many times the trigger has fired (starts at 0) |
| `timezone` | `string?` | No | IANA timezone for cron expressions (e.g. `"America/New_York"`) |
| `intervalMs` | `number?` | Conditional | Interval in milliseconds (required for `interval` type) |
| `scheduledAtIso` | `string?` | Conditional | ISO 8601 timestamp (required for `once` type) |
| `cronExpression` | `string?` | Conditional | 5-field cron expression (required for `cron` type) |
| `maxRuns` | `number?` | No | Maximum number of executions before auto-deletion |
| `dedupeKey` | `string?` | No | Hash key to prevent duplicate triggers |
| `nextRunAtMs` | `number?` | No | Computed timestamp of the next scheduled run |
| `lastRunAtIso` | `string?` | No | ISO timestamp of last execution |
| `lastStatus` | `"success" \| "error" \| "skipped"` | No | Result of last execution |
| `lastError` | `string?` | No | Error message from last failed execution |

### Task Metadata Structure

The trigger task's metadata (`TriggerTaskMetadata`) contains:

| Field | Type | Description |
|-------|------|-------------|
| `updatedAt` | `number?` | Timestamp when metadata was last updated |
| `updateInterval` | `number?` | Milliseconds until next execution (used by the task scheduler) |
| `blocking` | `boolean?` | Always `true` for trigger tasks |
| `trigger` | `TriggerConfig?` | The full trigger configuration |
| `triggerRuns` | `TriggerRunRecord[]?` | Execution history (max 100 records) |

## API Endpoints

All trigger endpoints are under `/api/triggers`. Triggers must be enabled via the `ELIZA_TRIGGERS_ENABLED` setting (defaults to `true`). When triggers are disabled, all endpoints except `/api/triggers/health` return a `503` error.

Trigger lookup by `:id` accepts either a `triggerId` or a `taskId` -- the system searches both fields when resolving a trigger.

### List Triggers

**GET `/api/triggers`**

Returns all triggers sorted alphabetically by display name.

```json
{
  "triggers": [
    {
      "id": "uuid",
      "taskId": "uuid",
      "displayName": "Check prices",
      "instructions": "Check the latest crypto prices and report",
      "triggerType": "interval",
      "enabled": true,
      "wakeMode": "inject_now",
      "createdBy": "api",
      "intervalMs": 300000,
      "runCount": 42,
      "nextRunAtMs": 1706000000000,
      "lastRunAtIso": "2026-01-23T12:00:00.000Z",
      "lastStatus": "success"
    }
  ]
}
```

### Create Trigger

**POST `/api/triggers`**

Create a new trigger. The `CreateTriggerRequest` body fields:

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `displayName` | `string?` | `"New Trigger"` | Human-readable name |
| `instructions` | `string?` | -- | Agent instructions (required, validated after normalization) |
| `triggerType` | `string?` | `"interval"` | One of `interval`, `once`, `cron` |
| `wakeMode` | `string?` | `"inject_now"` | One of `inject_now`, `next_autonomy_cycle` |
| `enabled` | `boolean?` | `true` | Whether the trigger starts active |
| `createdBy` | `string?` | `"api"` | Creator identifier |
| `timezone` | `string?` | -- | IANA timezone for cron expressions |
| `intervalMs` | `number?` | -- | Required for `interval` type |
| `scheduledAtIso` | `string?` | -- | Required for `once` type |
| `cronExpression` | `string?` | -- | Required for `cron` type |
| `maxRuns` | `number?` | -- | Max executions before auto-delete |

```json
{
  "displayName": "Market Check",
  "instructions": "Check current market conditions and summarize",
  "triggerType": "interval",
  "wakeMode": "inject_now",
  "enabled": true,
  "intervalMs": 300000,
  "maxRuns": 100,
  "createdBy": "api"
}
```

**Response codes:**

| Code | Reason |
|------|--------|
| `201` | Trigger created successfully; returns `{ trigger: TriggerSummary }` |
| `400` | Validation failed (missing fields, invalid cron, invalid wakeMode, etc.) |
| `409` | Equivalent trigger already exists (matching dedupe key) |
| `429` | Active trigger limit reached for this creator |
| `503` | Triggers are disabled by configuration |

### Get Trigger

**GET `/api/triggers/:id`**

Returns a single trigger by its trigger ID or task ID.

```json
{
  "trigger": { ... }
}
```

Returns `404` if no trigger matches the ID, or `500` if the trigger metadata is invalid.

### Update Trigger

**PUT `/api/triggers/:id`**

Update a trigger's configuration. The `UpdateTriggerRequest` accepts any of:

| Field | Type | Description |
|-------|------|-------------|
| `displayName` | `string?` | New display name |
| `instructions` | `string?` | New instructions |
| `triggerType` | `string?` | Change schedule type |
| `wakeMode` | `string?` | Change wake mode |
| `enabled` | `boolean?` | Enable or disable |
| `timezone` | `string?` | Change timezone |
| `intervalMs` | `number?` | Change interval |
| `scheduledAtIso` | `string?` | Change scheduled time |
| `cronExpression` | `string?` | Change cron expression |
| `maxRuns` | `number?` | Change max runs |

Omitted fields retain their current values. The `createdBy` field cannot be changed via update.

When a trigger is disabled (`enabled: false`), its `updateInterval` is set to `DISABLED_TRIGGER_INTERVAL_MS` (365 days), effectively parking it. When re-enabled, the next run time is recomputed from the current time.

```json
{
  "displayName": "Updated Name",
  "enabled": false,
  "intervalMs": 600000
}
```

### Delete Trigger

**DELETE `/api/triggers/:id`**

Permanently removes a trigger and its associated task. Returns `{ ok: true }` on success, or `404` if not found.

### Execute Trigger

**POST `/api/triggers/:id/execute`**

Manually execute a trigger immediately, regardless of its schedule. Forces execution even if the trigger is disabled (`force: true`). The execution source is recorded as `"manual"`.

Returns the execution result and the refreshed trigger summary:

```json
{
  "ok": true,
  "result": {
    "status": "success",
    "taskDeleted": false,
    "runRecord": { ... }
  },
  "trigger": { ... }
}
```

### Get Run History

**GET `/api/triggers/:id/runs`**

Returns the execution history for a trigger (up to the last 100 runs).

```json
{
  "runs": [
    {
      "triggerRunId": "uuid",
      "triggerId": "uuid",
      "taskId": "uuid",
      "startedAt": 1706000000000,
      "finishedAt": 1706000001500,
      "status": "success",
      "latencyMs": 1500,
      "source": "scheduler"
    }
  ]
}
```

### Health Snapshot

**GET `/api/triggers/health`**

Returns aggregate health metrics for the trigger system. This endpoint works even when triggers are disabled.

```json
{
  "triggersEnabled": true,
  "activeTriggers": 5,
  "disabledTriggers": 2,
  "totalExecutions": 150,
  "totalFailures": 3,
  "totalSkipped": 10,
  "lastExecutionAt": 1706000000000
}
```

The `TriggerHealthSnapshot` merges two data sources:

- **In-memory metrics** -- counters tracked per agent in a `Map<UUID, TriggerMetricsState>`. These reset on process restart.
- **Durable counts** -- reconstructed from the persisted `triggerRuns` arrays in each trigger task's metadata. These survive restarts.

The response uses `Math.max(inMemory, durable)` for execution and failure counts to provide the most accurate picture.

## Creating Triggers from Chat

The `WORKFLOW` action with `op="create_trigger"` (similes include `CREATE_TRIGGER`, `SCHEDULE_TRIGGER`, `CREATE_TRIGGER_TASK`) allows users to create triggers through natural language in the chat. The action validates against these keyword phrases:

- `"create trigger"` / `"create a trigger"`
- `"create task"` / `"schedule task"`
- `"schedule trigger"`
- `"run every"` / `"run at"`
- `"every hour"` / `"every day"`

### Prerequisites

The action requires both conditions to be true:

1. Autonomy mode must be enabled (`runtime.enableAutonomy`)
2. Triggers must be enabled in configuration (`triggersFeatureEnabled()`)

### Extraction Flow

When the action fires:

1. The user's message is sent to a small language model (`ModelType.TEXT_SMALL`) with a structured prompt asking it to extract trigger parameters as XML tags.
2. The model returns XML with tags: `<triggerType>`, `<displayName>`, `<instructions>`, `<wakeMode>`, `<intervalMs>`, `<scheduledAtIso>`, `<cronExpression>`, `<maxRuns>`.
3. Each tag is parsed via regex. Missing or empty tags fall back to defaults derived from the user's raw text.
4. The trigger type is inferred from the extracted data: if a `cronExpression` is present, the type is `cron`; if `scheduledAtIso` is present, the type is `once`; otherwise it defaults to `interval`.
5. If the LLM extraction fails entirely, the trigger is created from the raw text with default settings, and the user is notified.

### Validation and Creation

After extraction:

1. The draft is normalized via `normalizeTriggerDraft()`, which validates all fields.
2. The creator's active trigger count is checked against the limit.
3. A dedupe key is computed from the trigger's instructions, type, interval, and wake mode.
4. Existing triggers are checked for duplicates. If a duplicate exists, the user is informed.
5. Trigger metadata is built with the computed next run time.
6. The trigger task is created in the runtime with the `TRIGGER_DISPATCH` name and `["queue", "repeat", "trigger"]` tags.

## Execution Lifecycle

When a trigger fires (either via the scheduler or manual API execution):

1. **Validation** -- The trigger config is read from task metadata. If missing, the execution is skipped.
2. **Enabled check** -- Disabled triggers are skipped unless `force: true` is passed (manual execution).
3. **Max runs check** -- If `runCount >= maxRuns`, the task is deleted and execution is skipped.
4. **Dispatch** -- Instructions are sent to the autonomy service via `injectAutonomousInstruction()`.
5. **Error handling** -- If dispatch fails, the error is logged and the run is recorded with `status: "error"`.
6. **Run count update** -- `runCount` is incremented, `lastRunAtIso`, `lastStatus`, and `lastError` are updated.
7. **Auto-deletion** -- If the trigger type is `once`, or if `runCount` now equals `maxRuns`, the task is deleted.
8. **Schedule update** -- For surviving triggers, the next run time is computed and the task metadata is persisted.
9. **Metrics** -- In-memory execution metrics are updated for the health endpoint.

### Error Handling

When trigger execution encounters an error:

- The error message is captured and stored in `lastError` on the trigger config.
- The `lastStatus` is set to `"error"`.
- A `TriggerRunRecord` is created with the error details.
- The trigger is **not** disabled -- it will attempt to fire again on the next scheduled run.
- If the autonomy service is unavailable, the error is `"Autonomy service unavailable for trigger dispatch"`.
- If the next schedule cannot be computed (e.g. invalid cron after update), the trigger is auto-disabled with `updateInterval` set to `DISABLED_TRIGGER_INTERVAL_MS` (365 days) and `lastError` set to `"Failed to compute next trigger schedule"`.

### Skipped Executions

A trigger execution is recorded as `"skipped"` when:

- The trigger config is missing or invalid in the task metadata
- The trigger is disabled and the execution was not forced
- The `maxRuns` limit has been reached (the task is also deleted)

## Run History and Monitoring

Each trigger maintains a run history of up to 100 records (`MAX_TRIGGER_RUN_HISTORY`). When the history exceeds 100 records, the oldest entries are trimmed. Each `TriggerRunRecord` tracks:

| Field | Type | Description |
|-------|------|-------------|
| `triggerRunId` | `UUID` | Unique ID for the run |
| `triggerId` | `UUID` | The trigger that was executed |
| `taskId` | `UUID` | The underlying task ID |
| `startedAt` | `number` | Execution start timestamp (ms) |
| `finishedAt` | `number` | Execution end timestamp (ms) |
| `status` | `"success" \| "error" \| "skipped"` | Execution result |
| `error` | `string?` | Error message (if status is `"error"`) |
| `latencyMs` | `number` | Execution duration in milliseconds |
| `source` | `"scheduler" \| "manual"` | How the execution was initiated |

## Duplicate Detection

Triggers are deduplicated using a hash-based `dedupeKey` computed from:

- `triggerType`
- `instructions` (normalized: trimmed, whitespace-collapsed, lowercased)
- `intervalMs` (or empty string if not set)
- `scheduledAtIso` (or empty string)
- `cronExpression` (or empty string)
- `wakeMode`

These values are joined with `|` and hashed using a DJB2 hash. The resulting key is prefixed with `trigger-` (e.g. `trigger-7a3f2b1e`).

When creating a trigger, existing enabled triggers are checked for matching dedupe keys. The API returns `409` if a match is found, and the chat action informs the user of the existing duplicate.

## Trigger Limits and Quotas

- **Active trigger limit** -- configurable via `ELIZA_TRIGGERS_MAX_ACTIVE` (setting or environment variable). Default: 100 active triggers per creator. The limit is checked per `createdBy` value.
- **Feature toggle** -- triggers can be disabled entirely via `ELIZA_TRIGGERS_ENABLED=false` (setting or environment variable). Defaults to enabled.
- **Duplicate detection** -- triggers with identical instructions, type, interval, and wake mode are detected via the dedupe key hash and rejected.
- **Max runs** -- set `maxRuns` to a positive integer to automatically delete a trigger after that many executions. A `maxRuns` of 0 or less is rejected during validation.
- **Once triggers** -- automatically deleted after their single execution, regardless of `maxRuns`.
- **Run history cap** -- each trigger retains at most 100 run records (`MAX_TRIGGER_RUN_HISTORY`). Older records are discarded when the cap is exceeded.

## Security Considerations

- Trigger instructions are passed directly to the agent's autonomy service. Ensure that the instructions do not contain sensitive data that could leak into logs.
- The `createdBy` field identifies who created the trigger. For API-created triggers, this defaults to `"api"`. For chat-created triggers, it is the entity ID of the user who issued the command.
- The trigger limit is enforced **per creator**, not globally. This means different creators can each have up to the configured maximum.
- The `/api/triggers/:id/execute` endpoint bypasses the `enabled` check when forcing execution. Use this with care in production.
- There is no authentication layer on the trigger API endpoints themselves -- access control depends on the gateway configuration and any middleware applied to the `/api/` routes.
