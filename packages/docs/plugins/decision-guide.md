---
title: "Choosing the Right Extension Point"
sidebarTitle: "Decision Guide"
description: "When to use Actions, Providers, Services, Skills, Routes, Event Handlers, or Evaluators"
---

elizaOS provides multiple ways to extend agent behavior. This guide helps you pick the right one.

## Quick Decision Tree

**"I want my agent to DO something when asked"** → [Action](#actions)

**"I want to inject context into every response"** → [Provider](#providers)

**"I need a background process running"** → [Service](#services)

**"I want to add knowledge/instructions without code"** → [Skill](#skills)

**"I need an HTTP endpoint"** → [Route](#routes)

**"I want to react to system events"** → [Event Handler](#event-handlers)

**"I want to assess response quality"** → [Evaluator](#evaluators)

---

## Comparison Table

| Feature | Action | Provider | Service | Skill | Route |
|---------|--------|----------|---------|-------|-------|
| Triggered by | User message (LLM selects) | Every inference cycle | Plugin init | User message (LLM selects) | HTTP request |
| Returns | ActionResult | Context string | -- | Agent response | HTTP response |
| Has lifecycle | No | No | Yes (start/stop) | No | No |
| Needs TypeScript | Yes | Yes | Yes | No (markdown) | Yes |
| Hot-reloadable | Rebuild + restart | Rebuild + restart | Rebuild + restart | Edit markdown + restart | Rebuild + restart |
| Runs in background | No | No | Yes | No | No |

---

## Actions

Use when the agent should **perform a task** in response to user input. The LLM selects actions from registered options based on description and examples.

```typescript
import type { Action } from '@elizaos/core';

const sendEmailAction: Action = {
  name: 'SEND_EMAIL',
  description: 'Send an email to a specified recipient',
  similes: ['EMAIL', 'MAIL', 'MESSAGE'],
  validate: async (runtime, message) => {
    return !!runtime.getSetting('SMTP_HOST');
  },
  handler: async (runtime, message, state) => {
    // Parse recipient and body from message, send email
    return { success: true, text: 'Email sent!' };
  },
};
```

**Good for:** API calls, data mutations, tool use, file operations, external service integration

---

## Providers

Use when you need to **inject information** into the agent's context before every response. Providers run automatically on each inference cycle.

```typescript
import type { Provider } from '@elizaos/core';

const timeProvider: Provider = {
  name: 'current-time',
  description: 'Provides current date and time',
  position: -10,
  get: async (runtime, message) => ({
    text: `Current time: ${new Date().toISOString()}`,
  }),
};
```

**Good for:** Real-time data, user preferences, system status, database lookups, environment context

---

## Services

Use when you need a **long-running background process** with startup and shutdown lifecycle.

```typescript
import { defineService } from '@elizaos/core';

const webhookService = defineService({
  serviceType: 'webhook-listener',
  description: 'Listens for incoming webhooks',
  start: async (runtime) => {
    // Start HTTP listener, WebSocket connection, etc.
  },
  stop: async () => {
    // Clean up connections and resources
  },
});
```

**Good for:** WebSocket connections, polling, cron jobs, queue consumers, cache management

---

## Skills

Use when you want to **extend agent behavior with instructions** rather than executable code. Skills are markdown-based and don't require TypeScript.

```markdown
---
name: git-helper
description: Help users with git commands and workflows
---

When asked about git, provide clear explanations and commands.
Always suggest safe operations first (status, log, diff before reset, force-push).
```

**Good for:** Domain knowledge, workflows, instruction sets, prompt engineering, task procedures

---

## Routes

Use when you need to expose **HTTP endpoints** from your plugin.

```typescript
import type { Route } from '@elizaos/core';

const healthRoute: Route = {
  type: 'GET',
  path: '/my-plugin/health',
  public: true,
  handler: async (req, res) => {
    res.json({ status: 'ok', uptime: process.uptime() });
  },
};
```

**Good for:** Webhooks, status pages, plugin APIs, file serving, external integrations

---

## Event Handlers

Use when you need to **react to system events** (messages, connections, actions).

```typescript
import type { Plugin } from '@elizaos/core';

const analyticsPlugin: Plugin = {
  name: 'analytics',
  events: {
    MESSAGE_RECEIVED: [
      async (payload) => {
        const { runtime, message, source } = payload;
        // Log message analytics
      },
    ],
    ACTION_STARTED: [
      async (payload) => {
        // Track action usage
      },
    ],
  },
};
```

Available events: `MESSAGE_RECEIVED`, `VOICE_MESSAGE_RECEIVED`, `WORLD_CONNECTED`, `WORLD_JOINED`, `ACTION_STARTED`, `ACTION_COMPLETED`

**Good for:** Logging, analytics, side effects, notifications, audit trails

---

## Evaluators

Use when you need to **assess response quality** or trigger follow-up actions after the agent responds.

```typescript
import type { Evaluator } from '@elizaos/core';

const sentimentEvaluator: Evaluator = {
  name: 'sentiment-check',
  description: 'Assess sentiment of agent responses',
  alwaysRun: true,
  validate: async (runtime, message) => true,
  handler: async (runtime, message) => {
    // Analyze response sentiment, log metrics, trigger alerts
  },
};
```

**Good for:** Quality monitoring, compliance checks, learning signals, post-response side effects

---

## Combining Extension Points

Many plugins use multiple extension points together:

| Plugin Type | Typical Combination |
|-------------|-------------------|
| API Integration | Action (API calls) + Provider (status context) + Service (token refresh) |
| Platform Connector | Service (connection lifecycle) + Event Handler (messages) + Route (webhooks) |
| Monitoring | Evaluator (quality checks) + Provider (metrics context) + Route (dashboard) |
| Knowledge | Provider (context injection) + Skill (instructions) |

---

## Related

- [Create a Plugin](/plugins/create-a-plugin) -- Build a plugin from scratch
- [Plugin Development](/plugins/development) -- Full API reference for all extension points
- [Skills Documentation](/plugins/skills) -- Deep dive into skills
- [Plugin Patterns](/plugins/patterns) -- Common implementation patterns
