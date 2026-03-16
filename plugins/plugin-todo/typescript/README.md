# @elizaos/plugin-todo - TypeScript

The TypeScript implementation of the elizaOS Todo plugin.

## Installation

```bash
npm install @elizaos/plugin-todo
# or
bun add @elizaos/plugin-todo
```

## Usage

```typescript
import { todoPlugin } from "@elizaos/plugin-todo";

// Register with AgentRuntime
const runtime = new AgentRuntime({
  plugins: [todoPlugin],
});
```

## Structure

```
typescript/
├── index.ts              # Main plugin definition
├── index.node.ts         # Node.js entry point
├── index.browser.ts      # Browser entry point
├── build.ts              # Build script
├── schema.ts             # Database schema
├── apis.ts               # API route definitions
├── tests.ts              # Test exports
├── actions/              # Action handlers
│   ├── createTodo.ts
│   ├── completeTodo.ts
│   ├── confirmTodo.ts
│   ├── updateTodo.ts
│   └── cancelTodo.ts
├── providers/            # Data providers
│   └── todos.ts
├── services/             # Background services
│   ├── reminderService.ts
│   ├── integrationBridge.ts
│   ├── notificationManager.ts
│   ├── cacheManager.ts
│   └── todoDataService.ts
├── types/                # Type definitions
│   └── index.ts
└── __tests__/           # Tests
    ├── e2e/
    └── unit/
```

## Building

```bash
bun run build.ts
```

This produces:

- `dist/node/index.node.js` - ESM for Node.js
- `dist/browser/index.browser.js` - ESM for browsers
- `dist/cjs/index.node.cjs` - CommonJS for Node.js
- `dist/*.d.ts` - TypeScript declarations

## Testing

```bash
npx vitest
```

## Exports

### Plugin

```typescript
import { TodoPlugin } from "@elizaos/plugin-todo";
```

### Services

```typescript
import {
  TodoReminderService,
  TodoIntegrationBridge,
  NotificationManager,
  CacheManager,
  createTodoDataService,
} from "@elizaos/plugin-todo";
```

### Types

```typescript
import type {
  TodoData,
  CacheEntry,
  CacheStats,
  NotificationData,
  NotificationPreferences,
} from "@elizaos/plugin-todo";
```

## Actions

| Action          | Description              | Trigger                          |
| --------------- | ------------------------ | -------------------------------- |
| `CREATE_TODO`   | Create a new task        | "add task...", "remind me to..." |
| `COMPLETE_TODO` | Mark task complete       | "done with...", "finished..."    |
| `UPDATE_TODO`   | Modify a task            | "change...", "update..."         |
| `CANCEL_TODO`   | Delete a task            | "cancel...", "remove..."         |
| `CONFIRM_TODO`  | Confirm pending creation | "yes", "confirm"                 |

## Providers

### todosProvider

Injects current todos into the agent's context:

```typescript
// Provides context like:
// "User has 3 active tasks: ..."
```

## Services

### TodoReminderService

Background service for reminder notifications:

```typescript
const service = runtime.getService("TODO_REMINDER");
await service.checkTasksForReminders();
```

### TodoIntegrationBridge

Bridges to external notification services:

```typescript
const bridge = runtime.getService("TODO_INTEGRATION_BRIDGE");
await bridge.deliverReminder(todo, { type: "upcoming" });
```

## API Routes

| Route                   | Method | Description     |
| ----------------------- | ------ | --------------- |
| `/todos`                | GET    | List todos      |
| `/todos/:id`            | GET    | Get a todo      |
| `/todos`                | POST   | Create todo     |
| `/todos/:id`            | PUT    | Update todo     |
| `/todos/:id`            | DELETE | Delete todo     |
| `/todos/:id/complete`   | POST   | Complete todo   |
| `/todos/:id/uncomplete` | POST   | Uncomplete todo |
| `/todos/:id/tags`       | POST   | Add tags        |
| `/todos/:id/tags`       | DELETE | Remove tags     |

## Configuration

Environment variables:

```bash
DATABASE_URL=postgresql://...
TODO_ENABLE_REMINDERS=true
TODO_REMINDER_INTERVAL_MS=30000
```



