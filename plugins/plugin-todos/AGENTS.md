# @elizaos/plugin-todos

User-scoped persistent todos with CRUD for Eliza agents.

## Purpose / role

Adds a structured todo list capability to any Eliza agent: a single `TODO` umbrella action (op-based dispatch), a `CURRENT_TODOS` provider that injects active todos into the planner context each turn, and a `TodosService` backed by a drizzle `pgSchema('todos')` table. The plugin is opt-in — add it to the agent's plugin list. It hard-depends on `@elizaos/plugin-sql` (declared as a peer dep and in `dependencies: ["@elizaos/plugin-sql"]`); the service will throw at runtime if `runtime.db` is absent.

## Plugin surface

**Action**
- `TODO` (`src/actions/todo.ts`) — single umbrella action with op-based dispatch. Accepted ops: `write`, `create`, `update`, `complete`, `cancel`, `delete`, `list`, `clear`. Contexts: `tasks`, `todos`, `automation`. Role gate: `ADMIN`. Validates that `TodosService` is available before handling.

**Provider**
- `CURRENT_TODOS` (`src/providers/current-todos.ts`) — injected at position `-5` on every turn in the `tasks`/`todos`/`automation` contexts. Lists the user's `pending` and `in_progress` todos as a markdown checklist. Returns empty text when there are no active todos.

**Service**
- `TodosService` (`src/service.ts`) — `serviceType = "todos"`. Wraps drizzle queries for `create`, `get`, `list`, `update`, `delete`, `writeList` (bulk-replace), and `clear`. Scoped by `(agentId, entityId)`; `roomId`/`worldId` are optional narrowing keys.

**Schema**
- `todosSchema` / `todosTable` (`src/db/schema.ts`) — `pgSchema("todos")` with table `todos`. Indexes on `(entityId, status)`, `(agentId, entityId)`, `roomId`. Exported from `src/index.ts` as `schema` (the drizzle schema object the runtime registers migrations from).

## Layout

```
src/
  index.ts                  Plugin export; wires action + provider + service + schema
  types.ts                  TODO_STATUSES, TODO_ACTIONS, Todo interface, constants
  service.ts                TodosService class + CreateTodoInput/UpdateTodoInput/TodoFilter
  actions/
    todo.ts                 todoAction — op dispatch, parameter parsing, scope resolution
    todo.test.ts            Unit tests
  providers/
    current-todos.ts        currentTodosProvider — per-turn context injection
  db/
    schema.ts               drizzle pgSchema + todosTable + TodoRow/TodoInsert types
    index.ts                re-exports schema.ts
```

## Commands

```bash
bun run --cwd plugins/plugin-todos build        # bun build → dist/ (ESM) + tsc --emitDeclarationOnly
bun run --cwd plugins/plugin-todos dev          # hot-rebuild via build.ts
bun run --cwd plugins/plugin-todos test         # vitest run
bun run --cwd plugins/plugin-todos typecheck    # tsgo --noEmit
bun run --cwd plugins/plugin-todos check        # typecheck + test
bun run --cwd plugins/plugin-todos clean        # rm -rf dist .turbo
```

## Config / env vars

| Variable | Where used | Required |
|---|---|---|
| `ELIZA_PARENT_TRAJECTORY_STEP_ID` | `src/actions/todo.ts` — attached as `parentTrajectoryStepId` on new todos when set | No |

No plugin-specific settings keys. No API keys or external service credentials needed.

## How to extend

**Add a new op to the TODO action:**
1. Add the op name to `TODO_ACTIONS` in `src/types.ts`.
2. Write an `async function actionMyOp(args: ActionHandlerArgs): Promise<ActionResult>` in `src/actions/todo.ts`.
3. Add the case to the `switch (action)` block in `todoAction.handler`.
4. Extend the `parameters` array in `todoAction` if the op needs new parameters.

**Add a new provider:**
1. Create `src/providers/<name>.ts` implementing the `Provider` interface from `@elizaos/core`.
2. Import and add it to the `providers` array in `src/index.ts`.

**Add a new service method:**
1. Add the method to `TodosService` in `src/service.ts`. Use `this.getDb()` to obtain the drizzle DB handle.
2. Export the new input/output types from `src/service.ts` and re-export from `src/index.ts` if callers need them.

## Conventions / gotchas

- **`@elizaos/plugin-sql` must be loaded first.** `TodosService.getDb()` throws `runtime.db is not available` if the SQL plugin has not initialized the DB. The plugin declares this in `dependencies: ["@elizaos/plugin-sql"]`.
- **Scoping is `(agentId, entityId)`.** Todos are per-user (`entityId`), per-agent (`agentId`). They persist across rooms for the same user. `roomId` and `worldId` are stored but are optional narrowing keys, not primary scope.
- **`write` is a full replacement.** `action=write` calls `service.writeList`, which reconciles the full desired list: rows absent from the payload are deleted. Treat it like `TodoWrite` in Claude Code.
- **`activeForm`** is the present-continuous display string (e.g. "Adding tests"). Defaults to `content` when not provided.
- **Role gate is `ADMIN`.** The `TODO` action will not fire for non-admin entities. Check the runtime's role system if todos are unexpectedly unavailable.
- **No migrations runner in this plugin.** Schema registration (`schema: dbSchema` in the plugin object) tells the elizaOS runtime to handle migrations. Do not add a manual migration runner here.
- **`getTodosService(runtime)`** — convenience helper in `src/service.ts` that throws a clear error if the service is missing; prefer it over raw `runtime.getService` in new code.
