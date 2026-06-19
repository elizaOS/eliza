# @elizaos/plugin-todos

User-scoped persistent todo list for Eliza agents.

## What it does

Gives an Eliza agent a durable, queryable todo list keyed per user (`entityId`). The agent can create, update, complete, cancel, delete, and bulk-replace todos through a single `TODO` action, and the user's active todos are automatically injected into the planner's context on every turn.

Data is stored in a Postgres table (`pgSchema("todos")`) via drizzle-orm; the plugin requires `@elizaos/plugin-sql` to supply the DB connection.

## Capabilities

### Action: `TODO`

A single umbrella action that dispatches on the `action` (or `op`) parameter:

| op | what it does |
|---|---|
| `create` | Add one todo (`content` required; `status` defaults to `pending`) |
| `write` | Bulk-replace the user's entire list with the provided `todos` array |
| `update` | Patch a todo by `id` (content, status, activeForm, parentTodoId) |
| `complete` | Set status → `completed` by `id` |
| `cancel` | Set status → `cancelled` by `id` |
| `delete` | Remove a todo by `id` |
| `list` | Return todos (pending + in-progress by default; pass `includeCompleted: true` for all) |
| `clear` | Delete all todos for the current user/agent/room |

Todos have an optional `activeForm` field (present-continuous string, e.g. "Adding tests") and support a `parentTodoId` for sub-tasks.

### Provider: `CURRENT_TODOS`

Injected at position `-5` on every planner turn (in the `tasks`, `todos`, and `automation` contexts). Shows pending and in-progress todos as a markdown checklist so the agent always knows what is outstanding.

## Requirements

- `@elizaos/plugin-sql` must be loaded before this plugin (provides `runtime.db`).
- The agent entity must have at minimum the `ADMIN` role for the `TODO` action to fire.

## Enabling the plugin

Add `@elizaos/plugin-todos` to the agent's plugin list in your character configuration:

```json
{
  "plugins": ["@elizaos/plugin-sql", "@elizaos/plugin-todos"]
}
```

## Environment variables

| Variable | Effect | Required |
|---|---|---|
| `ELIZA_PARENT_TRAJECTORY_STEP_ID` | Attached to new todos as `parentTrajectoryStepId` for trajectory linking | No |

## Exported API

```ts
import {
  todosPlugin,          // default Plugin export
  todoAction,           // the TODO action
  currentTodosProvider, // the CURRENT_TODOS provider
  TodosService,         // the drizzle-backed service class
  getTodosService,      // helper: runtime → TodosService (throws if missing)
  todosSchema,          // drizzle pgSchema
  todosTable,           // drizzle table
} from "@elizaos/plugin-todos";
```

Key types: `Todo`, `TodoStatus`, `TodoActionName`, `CreateTodoInput`, `UpdateTodoInput`, `TodoFilter`, `TodoRow`, `TodoInsert`.
