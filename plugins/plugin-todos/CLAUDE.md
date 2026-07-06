# @elizaos/plugin-todos

User-scoped persistent todos with CRUD for Eliza agents.

## Purpose / role

Adds a structured todo list capability to any Eliza agent: a single `TODO` umbrella action (op-based dispatch), a `CURRENT_TODOS` provider that injects active todos into the planner context each turn, a `TodosService` backed by a drizzle `pgSchema('todos')` table, and a `TodosView` UI component registered as a dashboard view. The plugin is opt-in — add it to the agent's plugin list. It hard-depends on `@elizaos/plugin-sql` (declared as a peer dep and in `dependencies: ["@elizaos/plugin-sql"]`); the service will throw at runtime if `runtime.db` is absent.

## Plugin surface

**Action**
- `TODO` (`src/actions/todo.ts`) — single umbrella action with op-based dispatch. Accepted ops: `write`, `create`, `update`, `complete`, `cancel`, `delete`, `list`, `clear`. Contexts: `tasks`, `todos`, `automation`. Role gate: `ADMIN`. Validates that `TodosService` is available before handling.

**Provider**
- `CURRENT_TODOS` (`src/providers/current-todos.ts`) — injected at position `-5` on every turn in the `tasks`/`todos`/`automation` contexts. Lists the user's `pending` and `in_progress` todos as a markdown checklist. Returns empty text when there are no active todos.

**Service**
- `TodosService` (`src/service.ts`) — `serviceType = "todos"`. Wraps drizzle queries for `create`, `get`, `list`, `update`, `delete`, `writeList` (bulk-replace), and `clear`. Scoped by `(agentId, entityId)`; `roomId`/`worldId` are optional narrowing keys.

**Views**
- `TodosView` (`src/components/todos/TodosView.tsx`) — three-lane todo board (Today / Upcoming / Someday). Registered as a dashboard view with id `"todos"`, path `/todos`, bundled to `dist/views/bundle.js`. Enabled in desktop tab and visible in manager.

**Schema**
- `todosSchema` / `todosTable` (`src/db/schema.ts`) — `pgSchema("todos")` with table `todos`. Indexes on `(entityId, status)`, `(agentId, entityId)`, `roomId`. Exported from `src/index.ts` as `schema` (the drizzle schema object the runtime registers migrations from).

## Layout

```
src/
  index.ts                  Plugin export; wires action + provider + service + schema + view
  types.ts                  TODO_STATUSES, TODO_ACTIONS, Todo interface, constants
  service.ts                TodosService class + CreateTodoInput/UpdateTodoInput/TodoFilter
  actions/
    todo.ts                 todoAction — op dispatch, parameter parsing, scope resolution
    todo.test.ts            Unit tests
  providers/
    current-todos.ts        currentTodosProvider — per-turn context injection
  components/
    todos/
      TodosView.tsx         Three-lane board UI component (Today / Upcoming / Someday)
      todos-view-bundle.ts  Vite entry point for bundling TodosView
      TodosView.test.tsx    Component tests
  db/
    schema.ts               drizzle pgSchema + todosTable + TodoRow/TodoInsert types
    index.ts                re-exports schema.ts
```

## Commands

```bash
bun run --cwd plugins/plugin-todos build        # bun build → dist/ (ESM) + tsc --emitDeclarationOnly
bun run --cwd plugins/plugin-todos dev          # hot-rebuild via build.ts
bun run --cwd plugins/plugin-todos test         # vitest run
bun run --cwd plugins/plugin-todos typecheck    # tsc --noEmit
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

<!-- BEGIN: evidence-and-e2e-mandate (managed; canonical standard = repo-root AGENTS.md) -->
## ⛔ NON-NEGOTIABLE — evidence, trajectories & real end-to-end tests

> The binding, repo-wide standard is **[AGENTS.md](../../AGENTS.md)**. Read it.
> Nothing in this package is *done* until it is *proven* done — a reviewer must confirm it
> works **without reading the code**, from the artifacts you attach. This applies to **every**
> feature, fix, refactor, and chore here. "Tests pass" is not proof; "CI is green" is not proof.

- **Record AND read model trajectories.** Capture the *actual* inputs and outputs of the model
  from a **live** LLM — not the deterministic proxy, not a mock: the prompt, the
  providers/context, the raw model output, every tool/action call, and the result. Then **open
  the trajectory and review it by hand.** A captured-but-unread trajectory is not evidence
  (`packages/scenario-runner/bin/eliza-scenarios run <scenario> --report <out>`).
- **Real, full-featured E2E — no larp.** Every feature ships detailed end-to-end tests that
  drive the *real* path end to end. Not the happy "front door" only: cover error paths,
  edge/empty/invalid input, concurrency, roles/permissions, and adversarial input. A test that
  asserts against a mock/stub/fixture standing in for the thing under test **does not count**.
  If the real model/device/chain/connector/account is hard to reach, **make it reachable — that
  is the work**, not an excuse to mock. If the existing tests here are shallow or mocked, fixing
  them is part of your change.
- **Screenshots + logs at every phase**, plus a **complete walkthrough video/run-through** of
  the entire feature or view, start to finish (`bun run test:e2e:record`).
- **Manually review every artifact the change touches** — never just the green check: client
  logs (console + network), server logs (`[ClassName] …`), the model trajectories in and out,
  before/after full-page screenshots, **and the domain artifacts listed below for this package.**
- **No residuals. No shortcuts.** The goal is not "done" — it is *everything* done. Clear every
  blocker by the **hard path**: build the real architecture, stand up the real
  model/device/service, actually test it. Never leave a TODO, a stub, a stepping-stone, or a
  "follow-up." When unsure, research thoroughly, weigh the options, and ship the best,
  highest-effort, production-ready version. Keep going until every possibility is exhausted.

Artifacts → attached inline in the PR (MP4 video, JPG screenshots, logs in `<details>`); attach each evidence type **or**
explicitly mark it N/A with a reason — never leave it blank. If `develop` moved and changed
behavior, **re-capture** evidence; stale proof is worse than none.

**Capture & manually review for this package — agent behavior / app plugin:**
- A **live-LLM** scenario trajectory showing the behavior end to end and asserting the **outcome**, not just that routing/an action was selected (see #9970).
- The artifacts the behavior creates — memories, knowledge, scheduled-task rows, relationships, documents, outputs — inspected after the run.
- Backend `[ClassName]` logs of the action/service/runner firing, plus error/edge/permission paths.
- The empty-state and adversarial-input behavior, not just one happy scenario.
<!-- END: evidence-and-e2e-mandate -->
