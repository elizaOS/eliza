# @elizaos/plugin-todos

Durable, tenant-scoped Todo lists for Eliza agents running in Node or on an
edge host such as Cloudflare Workers.

## What it does

The plugin gives an Eliza agent one `TODO` action for create, write, update,
complete, cancel, delete, list, and clear operations. `CURRENT_TODOS` adds the
user's active list to planner context on every turn.

Every mutating action is exactly-once at the storage boundary. The Todo change
and its immutable mutation receipt commit in the same Postgres transaction.
Retrying the same transport operation returns the original result as a replayed
no-op instead of changing state twice.

## Runtime entries

| Entry | Host | Storage | UI | Default role gates |
|---|---|---|---|---|
| `@elizaos/plugin-todos` | Node `AgentRuntime` | `runtime.db` from `@elizaos/plugin-sql` | Includes `TodosView` | action `ADMIN`, provider `USER` |
| `@elizaos/plugin-todos/plugin` | Node `AgentRuntime` | `runtime.db` from `@elizaos/plugin-sql` | None | action `ADMIN`, provider `USER` |
| `@elizaos/plugin-todos/edge` | Worker/edge `AgentRuntime` | Host-injected `TodoStore` | None | action/provider `GUEST` |

The edge role gate is intended for a server-owned Shared-agent boundary. The
host must authenticate the principal and derive `agentId`, `entityId`, room,
world, and transport idempotency from trusted request state; the model does not
choose storage scope.

## Enable the Node plugin

Load SQL before Todos in the character's plugin list:

```json
{
  "plugins": ["@elizaos/plugin-sql", "@elizaos/plugin-todos"]
}
```

The runtime registers the package's Drizzle schema and `TodosService` wraps the
canonical SQL store.

## Enable the edge plugin

Create the host's Drizzle connection through its normal storage binding, apply
the canonical tables through the host migration pipeline, and inject the store:

```ts
import {
  createTodosEdgePlugin,
  createTodosSqlStore,
} from "@elizaos/plugin-todos/edge";

const store = createTodosSqlStore(db);
const plugin = createTodosEdgePlugin({ store });
```

Eliza Cloud supplies `db` through Hyperdrive. The edge entry imports no React,
dashboard bundle, Node filesystem API, or plugin-sql lifecycle service.

## Action operations

| Operation | Behavior |
|---|---|
| `create` | Add one Todo; `content` is required and status defaults to `pending` |
| `write` | Reconcile the complete scoped list in one transaction |
| `update` | Patch content, status, active form, parent, or metadata |
| `complete` | Transition one Todo to `completed` |
| `cancel` | Transition one Todo to `cancelled` |
| `delete` | Remove one Todo while preserving the original replay outcome |
| `list` | Read current Todos; no mutation receipt is written |
| `clear` | Remove Todos in the current trusted scope/room and preserve the original count for replay |

Todos support `parentTodoId` for hierarchy and `activeForm` for a
present-continuous display label such as "Adding tests." Todo requests are not
reminders: future delivery belongs to the canonical scheduling plugin and
runner.

## Storage and replay

The package owns one Drizzle schema with two tables:

- `todos.todos` stores the current tenant-scoped Todo graph.
- `todos.todo_mutations` stores the request digest and exact committed outcome,
  uniquely keyed by `(agentId, entityId, idempotencyKey)`.

`createTodosSqlStore` applies the same scope locks, hierarchy checks, replay
rules, and typed failures in every host. A reused key with different semantics
fails with `TODO_IDEMPOTENCY_CONFLICT`; storage failures never appear as a
healthy empty list.

## Cutover and identity continuity

The public store contract can atomically read Todo rows plus mutation records,
import both into another runtime, and converge two personal-agent scopes inside
an existing transaction. Shared-to-Dedicated cutover therefore preserves Todo
IDs, parent IDs, mutation IDs, receipt IDs, and replay authority before routing
changes. Provisional phone-to-Telegram identity convergence uses the same store
primitive before deleting the source identity. Target conflicts roll back the
entire operation.

## Public API

The default entry exports the Node plugin, UI, schema, `TodosService`, and the
canonical SQL-store helpers. The Worker-safe entry exports:

```ts
import {
  TODOS_EDGE_COMPATIBILITY,
  createTodosEdgePlugin,
  createTodosSqlStore,
  convergeTodoScopesInTransaction,
  importTodoMutationRecordsInTransaction,
  serializeTodoMutationRecord,
  deserializeTodoMutationRecord,
  type Todo,
  type TodoStore,
  type TodoMutationRecord,
  type TodoCutoverState,
} from "@elizaos/plugin-todos/edge";
```

See `CLAUDE.md` for the full extension and verification contract.

## Environment variables

| Variable | Effect | Required |
|---|---|---|
| `ELIZA_PARENT_TRAJECTORY_STEP_ID` | Adds trajectory provenance to newly created Todos | No |

No provider API key or plugin-specific secret is required.

## Verification

```bash
bun run --cwd plugins/plugin-todos build
bun run --cwd plugins/plugin-todos typecheck
bun run --cwd plugins/plugin-todos lint:check
bun run --cwd plugins/plugin-todos test
```

The package suite includes real-PGlite coverage for tenant isolation,
concurrency, all mutators, exact replay, conflicts, atomic cutover import,
identity-scope convergence, and the packed Worker export.
