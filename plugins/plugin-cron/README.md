# @elizaos/plugin-cron

Cron job scheduling plugin for elizaOS agents. Schedule recurring or one-time jobs that execute prompts, actions, or emit events.

## Features

- **Multiple schedule types**: Cron expressions, intervals, one-time timestamps
- **Timezone support**: Full IANA timezone support via `croner`
- **Persistent storage**: Jobs survive agent restarts via Eliza components
- **Natural language**: Create jobs using conversational input
- **Flexible payloads**: Execute prompts, trigger actions, or emit events
- **Lifecycle events**: Track job creation, execution, and errors

## Installation

```bash
bun add @elizaos/plugin-cron
```

## Usage

### Basic Setup

```typescript
import { cronPlugin } from '@elizaos/plugin-cron';

const agent = {
  character: myCharacter,
  plugins: [cronPlugin],
};
```

### Creating Jobs via Actions

Users can create jobs through natural language:

- "Create a cron job to check the news every hour"
- "Schedule a daily reminder at 9am to review my goals"
- "Set up a recurring job every 5 minutes to check server status"

### Programmatic API

```typescript
import { CronService } from '@elizaos/plugin-cron';

const cronService = runtime.getService<CronService>('CRON');

// Interval-based job
await cronService.createJob({
  name: 'Hourly check',
  enabled: true,
  schedule: { kind: 'every', everyMs: 3600000 },
  payload: { kind: 'prompt', text: 'Check system status' },
});

// Cron expression job
await cronService.createJob({
  name: 'Daily report',
  enabled: true,
  schedule: { 
    kind: 'cron', 
    expr: '0 9 * * *',      // 9am daily
    tz: 'America/New_York'  // Optional timezone
  },
  payload: { kind: 'prompt', text: 'Generate daily report' },
});

// One-shot job (runs once then deletes)
await cronService.createJob({
  name: 'Reminder',
  enabled: true,
  deleteAfterRun: true,
  schedule: { kind: 'at', at: '2024-12-31T23:59:00Z' },
  payload: { kind: 'prompt', text: 'Happy New Year!' },
});

// Action-based job
await cronService.createJob({
  name: 'Backup',
  enabled: true,
  schedule: { kind: 'cron', expr: '0 2 * * *' },
  payload: { 
    kind: 'action', 
    actionName: 'BACKUP_DATABASE',
    params: { full: true }
  },
});

// Event-based job
await cronService.createJob({
  name: 'Heartbeat',
  enabled: true,
  schedule: { kind: 'every', everyMs: 60000 },
  payload: { 
    kind: 'event', 
    eventName: 'AGENT_HEARTBEAT',
    payload: { type: 'cron' }
  },
});
```

### Managing Jobs

```typescript
// List all jobs
const jobs = await cronService.listJobs();

// Get a specific job
const job = await cronService.getJob('job-id');

// Update a job
await cronService.updateJob('job-id', {
  enabled: false,  // Disable the job
});

// Delete a job
await cronService.deleteJob('job-id');

// Manually run a job
const result = await cronService.runJob('job-id', 'force');
```

## Schedule Types

### Interval (`every`)

Runs at fixed intervals:

```typescript
schedule: { 
  kind: 'every', 
  everyMs: 300000,  // Every 5 minutes
  anchorMs: Date.now()  // Optional: anchor point for interval calculation
}
```

### Cron Expression (`cron`)

Standard cron expressions with optional timezone:

```typescript
schedule: { 
  kind: 'cron', 
  expr: '0 9 * * 1-5',  // 9am weekdays
  tz: 'America/Los_Angeles'
}
```

Cron expression format: `minute hour day month weekday`
- Supports 6-field format with seconds: `second minute hour day month weekday`

### One-time (`at`)

Runs once at a specific time:

```typescript
schedule: { 
  kind: 'at', 
  at: '2024-12-31T23:59:00Z'  // ISO 8601 timestamp
}
```

## Payload Types

### Prompt

Sends a prompt to the agent for processing:

```typescript
payload: { 
  kind: 'prompt', 
  text: 'Generate a status report',
  model: 'claude-3-sonnet',  // Optional model override
  thinking: 'medium',        // Optional thinking level
  timeoutSeconds: 120        // Optional timeout
}
```

### Action

Invokes a registered action:

```typescript
payload: { 
  kind: 'action', 
  actionName: 'SEND_EMAIL',
  params: { to: 'user@example.com', subject: 'Daily Report' },
  roomId: 'room-uuid'  // Optional room context
}
```

### Event

Emits a custom event:

```typescript
payload: { 
  kind: 'event', 
  eventName: 'CUSTOM_EVENT',
  payload: { key: 'value' }
}
```

## Events

The plugin emits the following events:

- `CRON_CREATED` - When a job is created
- `CRON_UPDATED` - When a job is updated
- `CRON_DELETED` - When a job is deleted
- `CRON_FIRED` - When a job executes successfully
- `CRON_FAILED` - When a job execution fails

Subscribe to events:

```typescript
runtime.registerEvent('CRON_FIRED', async (payload) => {
  console.log(`Job ${payload.jobName} completed:`, payload.result);
});
```

## Configuration

The service can be configured when creating the plugin:

```typescript
const cronService = new CronService(runtime, {
  minIntervalMs: 10000,       // Minimum interval (default: 10s)
  maxJobsPerAgent: 100,       // Max jobs per agent
  defaultTimeoutMs: 300000,   // Default execution timeout (5min)
  catchUpMissedJobs: false,   // Run missed jobs on startup
  catchUpWindowMs: 3600000,   // Catch-up window (1 hour)
  timerCheckIntervalMs: 1000, // Timer check frequency
});
```

## Actions

The plugin provides the following actions:

| Action | Description |
|--------|-------------|
| `CREATE_CRON` | Create a new cron job |
| `UPDATE_CRON` | Update an existing job |
| `DELETE_CRON` | Delete a job |
| `LIST_CRONS` | List all jobs |
| `RUN_CRON` | Manually run a job |

## License

MIT
