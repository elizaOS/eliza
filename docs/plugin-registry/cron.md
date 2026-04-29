---
title: "Cron Plugin"
sidebarTitle: "Cron"
description: "Cron scheduling plugin for Milady — recurring tasks, time-based automation, and scheduled agent actions."
---

The Cron plugin enables Milady agents to schedule and execute recurring tasks — posting content on a schedule, polling external APIs, running maintenance jobs, and triggering autonomous agent behaviors at defined intervals.

**Package:** `@elizaos/plugin-cron` (core plugin — always loaded)

## Overview

The Cron plugin is part of the core plugin set and is always loaded. It provides a reliable cron-style scheduler that integrates with the agent runtime, allowing tasks to be registered programmatically or configured declaratively.

## Configuration

Schedule recurring tasks in `milady.json`:

```json
{
  "cron": {
    "jobs": [
      {
        "name": "daily-summary",
        "schedule": "0 9 * * *",
        "action": "POST_SUMMARY",
        "description": "Post a daily summary every day at 9am"
      },
      {
        "name": "hourly-check",
        "schedule": "0 * * * *",
        "action": "CHECK_FEEDS",
        "description": "Check RSS feeds every hour"
      }
    ]
  }
}
```

## Cron Expression Format

The plugin uses standard 5-field cron expressions:

```
┌─────────── minute (0–59)
│ ┌───────── hour (0–23)
│ │ ┌─────── day of month (1–31)
│ │ │ ┌───── month (1–12)
│ │ │ │ ┌─── day of week (0–7, 0 and 7 = Sunday)
│ │ │ │ │
* * * * *
```

### Common Schedules

| Expression | Meaning |
|-----------|---------|
| `* * * * *` | Every minute |
| `0 * * * *` | Every hour (on the hour) |
| `0 9 * * *` | Every day at 9:00 AM |
| `0 9 * * 1` | Every Monday at 9:00 AM |
| `0 9 * * 1-5` | Weekdays at 9:00 AM |
| `0 0 1 * *` | First day of every month at midnight |
| `*/15 * * * *` | Every 15 minutes |
| `0 9,17 * * *` | At 9 AM and 5 PM every day |

## Actions

| Action | Description |
|--------|-------------|
| `SCHEDULE_JOB` | Create a new recurring job at runtime |
| `CANCEL_JOB` | Cancel a scheduled job |
| `LIST_JOBS` | List all active scheduled jobs |
| `RUN_JOB_NOW` | Immediately execute a scheduled job |

## Programmatic Registration

Other plugins can register cron jobs through the cron service:

```typescript
import type { Plugin, IAgentRuntime } from "@elizaos/core";

const myPlugin: Plugin = {
  name: "my-scheduled-plugin",
  description: "Plugin with scheduled tasks",

  init: async (_config, runtime) => {
    // Get the cron service (loaded as a core plugin)
    const cron = runtime.getService("cron");

    if (cron && typeof (cron as any).schedule === "function") {
      (cron as any).schedule({
        name: "my-hourly-task",
        expression: "0 * * * *",
        handler: async () => {
          runtime.logger?.info("[my-plugin] Running hourly task...");
          await doHourlyWork(runtime);
        },
      });
    }
  },
};

async function doHourlyWork(_runtime: IAgentRuntime) {
  // Your scheduled work here
}
```

## Autonomous Posting Schedule

The most common cron use case is scheduling autonomous agent posts. Combine with platform connectors:

```json
{
  "cron": {
    "jobs": [
      {
        "name": "morning-post",
        "schedule": "0 9 * * *",
        "action": "TWEET",
        "description": "Post a morning thought to Twitter"
      },
      {
        "name": "weekly-recap",
        "schedule": "0 18 * * 5",
        "action": "POST_DISCORD",
        "description": "Post a weekly recap to Discord every Friday at 6pm"
      }
    ]
  }
}
```

## Timezone Support

By default, schedules use the server's local timezone. Override per-job:

```json
{
  "cron": {
    "timezone": "America/New_York",
    "jobs": [
      {
        "name": "ny-market-open",
        "schedule": "30 9 * * 1-5",
        "timezone": "America/New_York",
        "action": "MARKET_OPEN_POST"
      }
    ]
  }
}
```

## Retry Behavior

Failed jobs are retried with exponential backoff:

| Attempt | Delay |
|---------|-------|
| 1 | Immediate |
| 2 | 30 seconds |
| 3 | 2 minutes |
| 4 | 10 minutes |

After 4 failed attempts, the job is marked as errored and skipped until the next scheduled time.

## Monitoring

Cron job status is visible in:

- The admin panel under **Agent → Jobs**
- The REST API at `GET /api/agent/{id}/jobs`
- Agent logs (search for `[cron]`)

## Related

- [Twitter Plugin](/plugin-registry/platform/twitter) — Autonomous Twitter posting
- [Discord Plugin](/plugin-registry/platform/discord) — Scheduled Discord posts
