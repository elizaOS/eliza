# @elizaos/plugin-todos

Durable, tenant-scoped Todos for Node and edge-hosted Eliza agents.

## Purpose / role

The package exposes one Todo domain with two host adapters. The default plugin
uses `@elizaos/plugin-sql` in a Node runtime and includes the dashboard view.
`@elizaos/plugin-todos/edge` is UI-free and accepts a host-owned `TodoStore`, so
Cloudflare Workers can load the genuine action/provider graph without importing
Node or React code. Both adapters use the canonical `createTodosSqlStore`
implementation and the same Postgres schema.

Mutating actions are durably idempotent. The Todo row change and its
`todo_mutations` ledger record commit in one transaction, allowing transport
retries and Shared-to-Dedicated cutover to replay the original result instead
of applying the effect twice.

## Plugin surface

**Action**
- `TODO` (`src/actions/todo.ts`) — umbrella action for `write`, `create`,
  `update`, `complete`, `cancel`, `delete`, `list`, and `clear`. Every mutating
  operation derives a stable key from `content.chatIdempotency.clientMessageId`
  (falling back to the Memory id) plus its Todo-mutation ordinal. Applied
  mutations return a durable effect receipt; exact replays return the same
  domain result with a replayed no-op receipt.

**Provider**
- `CURRENT_TODOS` (`src/providers/current-todos.ts`) — injects active Todos into
  `tasks` / `todos` / `automation` planner contexts. Storage failure throws; it
  is never reported as a healthy empty list.

**Storage contract**
- `TodoStore` (`src/store.ts`) — storage-neutral, fully tenant-qualified port.
  Every read/write carries `(agentId, entityId)` scope. `applyMutation` is the
  planner-facing exactly-once boundary; direct CRUD methods support trusted
  internal import/repair code.
- `createTodosSqlStore` (`src/sql-store.ts`) — canonical Drizzle/Postgres
  implementation shared by Node and Worker hosts. Scope advisory locks protect
  hierarchy, bulk replacement, ledger replay, import, and identity convergence.
- `TodosService` (`src/service.ts`) — Node `AgentRuntime` lifecycle adapter. It
  obtains the Drizzle connection from `runtime.db` and delegates to the
  canonical SQL store.

**Host adapters**
- `todosPlugin` (default export) — Node plugin plus the dashboard view. Requires
  `@elizaos/plugin-sql`; `TODO` defaults to `ADMIN`, `CURRENT_TODOS` to `USER`.
- `todosRuntimePlugin` (`./plugin`) — UI-free Node plugin for runtimes that do
  not load dashboard bundles.
- `createTodosEdgePlugin` (`./edge`) — Worker-safe action/provider plugin with
  an injected `TodoStore`. Its server-owned Shared-agent boundary admits
  `GUEST` principals; the host remains responsible for authenticating and
  deriving storage scope.

**Views**
- `TodosView` (`src/components/todos/TodosView.tsx`) — three-lane dashboard view
  registered only by the default Node entry.

**Schema**
- `todos.todos` — current Todo rows, including hierarchy and room/world
  projections.
- `todos.todo_mutations` — immutable mutation outcomes keyed uniquely by
  `(agentId, entityId, idempotencyKey)` for replay and cutover continuity.

## Layout

```
src/
  index.ts                  Default Node plugin + dashboard view and public exports
  plugin.ts                 UI-free Node plugin
  edge.ts                   Worker-safe factory and edge public exports
  store.ts                  Storage-neutral TodoStore and mutation contracts
  sql-store.ts              Canonical tenant-safe Drizzle/Postgres implementation
  service.ts                Node AgentRuntime adapter over the SQL store
  types.ts                  Todo domain types and constants
  actions/todo.ts           TODO action and durable receipt handling
  providers/current-todos.ts CURRENT_TODOS planner provider
  components/todos/         Dashboard view and bundle entry
  db/schema.ts              todos + todo_mutations Drizzle schema
test/
  todos.real-db.test.ts     Real-PGlite CRUD, ledger, replay, and cutover proof
  todo-scope-convergence.real-db.test.ts
  edge-package-export.test.ts
```

## Commands

```bash
bun run --cwd plugins/plugin-todos build
bun run --cwd plugins/plugin-todos test
bun run --cwd plugins/plugin-todos typecheck
bun run --cwd plugins/plugin-todos lint:check
bun run --cwd plugins/plugin-todos check
bun run --cwd plugins/plugin-todos clean
```

## Config / env vars

| Variable | Where used | Required |
|---|---|---|
| `ELIZA_PARENT_TRAJECTORY_STEP_ID` | Added to newly created Todos for trajectory provenance | No |

The package has no API keys or provider credentials. Edge hosts inject storage;
the Cloud Shared host currently supplies a Hyperdrive-backed Drizzle client.

## How to extend

**Add a mutating operation:**
1. Extend the discriminated contracts in `src/types.ts` and `src/store.ts`.
2. Implement it once inside the canonical transaction in `src/sql-store.ts`.
3. Route the action through `TodoStore.applyMutation`; do not call direct CRUD
   from the planner path.
4. Persist and serialize the exact replay result, then cover fresh, replay,
   conflicting-key, concurrency, tenant-isolation, and cutover behavior in real
   PGlite.

**Add another host:**
1. Create the host's Drizzle connection and apply the canonical schema through
   its normal migration system.
2. Construct `createTodosSqlStore(db)` and inject it into
   `createTodosEdgePlugin({ store })`, or adapt it to the host lifecycle.
3. Derive `agentId`, `entityId`, room, world, and transport idempotency from
   server-authoritative identity; never accept those scopes from model output.

## Conventions / gotchas

- **One implementation, two adapters.** Do not duplicate Todo SQL or action
  behavior in a host package. Node and edge both use `TodoStore` and
  `createTodosSqlStore`.
- **Every operation is tenant-scoped.** `agentId` and `entityId` are required in
  all storage predicates. `write` replaces the entity-scoped list exposed to
  the planner across rooms, while `clear` may narrow deletion to the current
  room. `roomId` and `worldId` otherwise remain projection metadata, not
  ownership boundaries.
- **Planner mutations use the ledger.** Calling direct `create` / `update` /
  `delete` from an action bypasses exactly-once replay and is a correctness bug.
- **`write` is a full replacement.** It reconciles the desired scoped list,
  preserves hierarchy invariants, and rejects duplicate persisted ids.
- **Cutover transfers rows and replay authority together.** Snapshot/import and
  provisional-identity convergence preserve Todo, parent, mutation, and receipt
  ids; conflicts fail closed before routing or identity authority changes.
- **Todos are not reminders.** Time-triggered delivery belongs to the canonical
  scheduling plugin/runner. Do not tag Todo actions as reminders or promise a
  future notification from a Todo write.
- **Migrations stay host-owned.** The default plugin registers its Drizzle
  schema for Dedicated runtimes. Shared Cloud applies additive control-plane
  migrations before constructing the injected store; the plugin must not create
  tables at request time.
- **Errors remain visible.** Missing storage and invalid persisted records
  surface explicit failures; hierarchy and idempotency conflicts use typed
  failures. No failure may be fabricated as an empty or successful result.

## Verification

Follow the repository-wide evidence standard in the root `CLAUDE.md`. At a
minimum run the package build, typecheck, lint, full Vitest suite, real-PGlite
tests, and packed edge-export test. Host integrations must additionally prove a
genuine Worker/AgentRuntime action, exact transport replay, tenant isolation,
and Shared-to-Dedicated or identity-convergence behavior when those boundaries
change.
