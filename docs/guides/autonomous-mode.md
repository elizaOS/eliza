---
title: Autonomous Mode
sidebarTitle: Autonomous Mode
description: Configure and monitor the agent's autonomous reasoning loop, where it acts independently between conversations.
---

Autonomous mode allows the Eliza agent to reason and act independently between user conversations. When enabled, the agent runs a continuous loop -- observing its environment, making decisions, and executing actions without waiting for explicit user input. This is useful for background monitoring, scheduled workflows, and proactive behavior.

<Tip>
For a step-by-step walkthrough with use cases and safety controls, see the [Autonomous Agent Tutorial](/guides/tutorial-autonomous-agent).
</Tip>

## How Autonomous Mode Works

The autonomous system is built on elizaOS's core task system and consists of several interconnected components:

1. **Autonomy Service** (`AUTONOMY`) -- a runtime service that manages the autonomous loop lifecycle, including enabling/disabling autonomy and providing an autonomous room for reasoning.
2. **Autonomous State Provider** (`elizaAutonomousState`) -- a dynamic provider that bridges context between loop iterations by injecting recent activity snapshots.
3. **Agent Event Service** (`AGENT_EVENT`) -- the event bus that broadcasts thoughts, actions, tool calls, and heartbeats to subscribers.
4. **Trigger System** -- scheduled and event-based automations that wake the agent at defined intervals.
5. **Proactive Messaging** -- routes autonomous output to the user's active conversation in the dashboard.

<Info>
Autonomy is always enabled at the runtime level -- it is managed by the core task system. The Autonomy Service provides the API for toggling it on and off and querying its current state.
</Info>

## Enabling and Disabling

Autonomous mode is managed through the Autonomy Service, which exposes two API endpoints and a dashboard toggle.

### API Endpoints

**GET `/api/agent/autonomy`**

Returns the current autonomy state:

```json
{
  "enabled": true,
  "thinking": false
}
```

- `enabled` -- whether autonomous mode is active. This is resolved from the Autonomy Service's `getStatus()` method, falling back to the runtime's `enableAutonomy` flag.
- `thinking` -- whether the autonomous loop is currently executing a reasoning cycle, as reported by `isLoopRunning()`.

**POST `/api/agent/autonomy`**

Toggle autonomy on or off by sending a JSON body:

```json
{
  "enabled": true
}
```

Response:

```json
{
  "ok": true,
  "autonomy": true,
  "thinking": false
}
```

When `enabled` is `true`, the service calls `enableAutonomy()` on the Autonomy Service. When `false`, it calls `disableAutonomy()`.

<Info>
The autonomy routes are implemented in `src/api/autonomy-routes.ts`. The `getAutonomyState()` helper determines the canonical enabled/thinking state by checking the service status first, then falling back to runtime flags.
</Info>

### Dashboard Toggle

The Autonomous Panel in the dashboard UI provides a visual toggle for enabling and disabling autonomy. The panel reads agent status from the `useApp()` context, which tracks `agentStatus` including autonomy state.

### Runtime Flag

At the elizaOS runtime level, autonomy is controlled by the `runtime.enableAutonomy` boolean. This flag is checked by actions like the trigger creation action (`CREATE_TRIGGER`) to validate whether autonomous features should be available.

## Autonomous State Provider

The `elizaAutonomousState` provider bridges context between autonomous loop iterations. It is a dynamic elizaOS provider (position 10) that injects a snapshot of recent autonomous activity into the agent's context on every reasoning cycle.

### Provider Configuration

| Property | Value |
|----------|-------|
| **Name** | `elizaAutonomousState` |
| **Type** | Dynamic provider |
| **Position** | 10 |
| **Source** | `src/providers/autonomous-state.ts` |

### How It Works

1. **Event Subscription** -- `ensureAutonomousStateTracking()` subscribes to the `AGENT_EVENT` service for the current agent. All events (thoughts, actions, tool calls) and heartbeats are cached in memory.

2. **Event Cache** -- Up to 240 events are cached per agent in a circular buffer (`MAX_CACHED_EVENTS = 240`). When the buffer is full, the oldest events are evicted via `splice`. Each agent maintains its own cache, keyed by agent ID.

3. **Context Injection** -- On each provider call, the provider fetches the 24 most recent events from the cache, filters to only `assistant`, `action`, and `tool` streams, takes the 10 most recent of those, and renders them as text lines:

```
Autonomous state snapshot:
- [assistant] I should check the latest market data
- [action] Fetched price feed from API
- [tool] Processed 15 data points
- [heartbeat/idle] to discord -- monitoring channel
```

If no events exist, the provider returns: `Autonomous state snapshot: no recent thought/action events.`

4. **Provider Result** -- The provider returns structured data including:

| Field | Type | Description |
|-------|------|-------------|
| `text` | `string` | Rendered snapshot text injected into agent context |
| `values.hasAutonomousState` | `boolean` | Whether any events exist |
| `values.autonomousEventsCount` | `number` | Total cached events (up to 24 recent) |
| `values.heartbeatStatus` | `string` | Last heartbeat status string |
| `data.events` | `array` | Last 10 event summaries (`runId`, `seq`, `stream`, `ts`) |
| `data.heartbeat` | `object \| null` | Last heartbeat (`status`, `ts`, `to`) |

### Lifecycle Management

When `ensureAutonomousStateTracking()` is called:

1. If a cache already exists for the agent with the same runtime reference, it is reused (no-op).
2. If a cache exists but with a different runtime (e.g., after restart), the old subscriptions are detached, the cache is cleared, and new subscriptions are created.
3. If no cache exists, new event and heartbeat subscriptions are created.

This ensures clean teardown and re-initialization across agent restarts.

## Activity Stream

The autonomous state provider tracks several event streams:

| Stream | Description | Panel Color |
|--------|-------------|-------------|
| `assistant` | Agent reasoning/thought outputs | Accent |
| `action` | Actions the agent has executed | Green (success) |
| `tool` | Tool calls made during execution | Green (success) |
| `error` | Error events from the loop | Red (danger) |
| `provider` | Provider-level events | Green (success) |
| `evaluator` | Self-evaluation events | Accent |

The Autonomous Panel groups these into two categories for visual clarity:

- **Thoughts** -- `assistant` and `evaluator` streams
- **Actions** -- `action`, `tool`, and `provider` streams

### Heartbeats

Heartbeats are separate from the main event stream and represent the agent's periodic status signals. They are tracked via a dedicated `subscribeHeartbeat` subscription on the Agent Event Service. Each heartbeat contains:

| Field | Type | Description |
|-------|------|-------------|
| `status` | `string` | Current state (e.g., `"idle"`, `"busy"`) |
| `to` | `string?` | Optional target (e.g., a Discord channel name) |
| `preview` | `string?` | Short text preview of what the agent is doing |
| `durationMs` | `number?` | How long the current state has lasted (milliseconds) |
| `hasMedia` | `boolean?` | Whether the current action involves media |
| `reason` | `string?` | Reason for the current state |
| `channel` | `string?` | Which channel the agent is operating on |
| `silent` | `boolean?` | Whether the heartbeat should suppress UI notifications |
| `indicatorType` | `string?` | Type of visual indicator to display |

Heartbeats are rendered in the context snapshot as:

```
- [heartbeat/idle] to discord -- monitoring channel
```

## Proactive Messages

When the autonomous loop produces text output that should reach the user, it is routed through the proactive messaging system.

### How It Works

1. The server subscribes to `AGENT_EVENT` events from the runtime.
2. When an event arrives on the `assistant` stream, the `maybeRouteAutonomyEventToConversation()` function evaluates whether it should be forwarded to the user's active conversation.
3. Events from regular user conversation turns are filtered out -- only events with an autonomy-related source are forwarded.
4. The `routeAutonomyTextToUser()` function stores the message as a Memory in the active conversation room and broadcasts a `proactive-message` WebSocket event to all connected dashboard clients.

### WebSocket Delivery

The frontend receives proactive messages via the `proactive-message` WebSocket event type, which includes the `conversationId` and the full message object (`id`, `role`, `text`). The `AppContext` listens for these events and appends the message to the appropriate conversation in the UI.

<Info>
Proactive messages only appear in the user's currently active conversation. If no conversation is active, the message is still stored as a Memory in the conversation room but will not trigger a real-time UI update.
</Info>

## Monitoring

### Dashboard Indicators

The Autonomous Panel in the Chat tab provides real-time monitoring:

- **Agent state banner** -- shows "Live stream connected" when the agent is running, or the current state (e.g., "Agent state: paused") otherwise.
- **Current Thought/Action** -- displays the most recent thought and action events.
- **Event Stream** -- collapsible feed of up to 120 events with timestamps.
- **Workbench** -- tasks, triggers, and todos from the agent's workbench, loaded via the workbench API.

### WebSocket Events

Two WebSocket event types carry autonomous activity to the dashboard:

| Event Type | Content |
|------------|---------|
| `agent_event` | Agent thoughts, actions, tool calls, provider events, evaluator events, and errors. Each event includes `stream`, `runId`, `seq`, `ts`, `agentId`, and `roomId` fields. |
| `heartbeat_event` | Periodic agent status signals with `status`, `to`, `preview`, `durationMs`, and other fields. |

These events are broadcast from the server's event subscription on the `AGENT_EVENT` service and streamed to all connected WebSocket clients.

### Logs

Runtime logs from autonomous operations are tagged with the `autonomy` source and `["agent", "autonomy"]` tags. These appear in the Logs sub-tab under Advanced and can be filtered by source.

## Triggers

Triggers are the primary mechanism for waking the autonomous agent on a schedule. They are managed through the Triggers sub-tab in the Advanced section or created via natural language in chat.

### Trigger Types

| Type | Description |
|------|-------------|
| `interval` | Repeats at a fixed interval (in milliseconds) |
| `once` | Executes a single time at a scheduled ISO timestamp |
| `cron` | Executes on a cron schedule expression |

### Trigger Configuration

Each trigger includes:

| Field | Description |
|-------|-------------|
| `displayName` | Human-readable name |
| `instructions` | What the agent should do when triggered |
| `triggerType` | `interval`, `once`, or `cron` |
| `wakeMode` | `inject_now` (immediate) or `next_autonomy_cycle` (deferred) |
| `intervalMs` | Interval in milliseconds (for `interval` type) |
| `scheduledAtIso` | ISO timestamp (for `once` type) |
| `cronExpression` | Cron expression (for `cron` type) |
| `maxRuns` | Maximum number of executions (optional) |
| `runCount` | Current execution count |
| `enabled` | Whether the trigger is active |

### Creating Triggers via Chat

The `CREATE_TRIGGER` action allows the agent to create triggers from natural language requests. It validates that autonomy is enabled, uses the LLM to extract trigger details, and creates a task in the runtime assigned to the autonomous room via `AUTONOMY.getAutonomousRoomId()`.

### Trigger Execution

When a trigger fires, the `injectAutonomousInstruction()` method on the Autonomy Service injects the trigger's instructions into the autonomous reasoning loop. The trigger runtime handles scheduling next runs, incrementing `runCount`, auto-deleting triggers that have reached `maxRuns` or are one-time, and enforcing per-creator quotas (default: 100 active triggers).

## Safety and Controls

### Resource Limits

| Limit | Value | Purpose |
|-------|-------|---------|
| **Event buffer cap** | 240 events per agent | Bounds memory usage for the autonomous state cache |
| **Max active triggers** | 100 per creator (default) | Prevents runaway trigger creation. Configurable via `ELIZA_TRIGGERS_MAX_ACTIVE` env var or runtime setting. |
| **Trigger maxRuns** | Per-trigger configurable | Limits how many times a trigger can execute before auto-deletion |

### SSRF Protection

Custom actions executed during autonomous mode enforce the same SSRF guards as user-initiated actions, blocking requests to private/internal network addresses. This applies to all tool calls and action executions within the autonomous loop.

### Enabling and Disabling at Runtime

<Tabs>
  <Tab title="Dashboard">
    Use the Autonomous Panel toggle in the Chat tab to enable or disable autonomy. The toggle immediately calls the Autonomy Service's `enableAutonomy()` or `disableAutonomy()` methods.
  </Tab>
  <Tab title="API">
    Send a POST request to `/api/agent/autonomy`:
    ```bash
    # Disable autonomy
    curl -X POST http://localhost:31337/api/agent/autonomy \
      -H "Content-Type: application/json" \
      -d '{"enabled": false}'

    # Enable autonomy
    curl -X POST http://localhost:31337/api/agent/autonomy \
      -H "Content-Type: application/json" \
      -d '{"enabled": true}'
    ```
  </Tab>
  <Tab title="Headless Mode">
    When the runtime is initialized in headless mode (no dashboard), autonomy is enabled automatically:
    ```
    [eliza] Runtime initialised in headless mode (autonomy enabled)
    ```
  </Tab>
</Tabs>

### Per-Connector Controls

Triggers can target specific connectors by setting the `channel` field in their configuration. The `wakeMode` field controls how instructions are delivered:

- **`inject_now`** -- the instruction is injected immediately into the current autonomous cycle.
- **`next_autonomy_cycle`** -- the instruction is queued for the next autonomous reasoning cycle.

### Heartbeat Monitoring

Use the heartbeat status to detect if the agent is stuck or unresponsive:

- **`idle`** -- the agent is waiting for the next trigger or reasoning cycle.
- **`busy`** -- the agent is actively processing a task.
- No heartbeat for an extended period may indicate the agent is stuck or the Autonomy Service has stopped.

<Warning>
The autonomous loop runs continuously when enabled. Monitor CPU and memory usage, especially with frequent reasoning cycles or short trigger intervals. Disable autonomous mode via the API or dashboard when continuous agent activity is not required.
</Warning>

## The Autonomous Panel

The dashboard UI includes an `AutonomousPanel` component that provides real-time visibility into autonomous operations. See the [Dashboard guide](/apps/dashboard#autonomous-panel) for full details on the panel's layout, event color coding, and responsive sizing.
