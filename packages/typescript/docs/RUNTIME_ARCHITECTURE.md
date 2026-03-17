# Runtime architecture and deployment patterns

This document describes how `AgentRuntime` is structured after the "Runtime Diet" refactor and how to use it in different deployment environments. It focuses on **what** changed and **why**.

For **building blocks** to load characters and create runtimes (e.g. `loadCharacters`, `createRuntimes`, the bootstrap vs runtime settings divide), see [Runtime composition](RUNTIME_COMPOSITION.md).

---

## Design goals (WHY the refactor)

1. **Lean runtime**  
   The runtime should be a request handler: register plugins, route messages, run actions. Heavy one-time setup (migrations, agent/entity/room creation, embedding dimension) does not belong in every `initialize()` call.

2. **Explicit adapter**  
   The database adapter is required in the constructor. **WHY:** Callers own connection lifecycle and avoid races (e.g. migrations running before an adapter is set). Plugins no longer "register" an adapter; the host provides it.

3. **Lazy services**  
   Services (task, approval, etc.) are started on first `getService()` call, not during `initialize()`. **WHY:** Reduces startup cost and allows runtimes that never use tasks (or other features) to avoid that work entirely.

4. **Opt-in timers**  
   The task poll timer is not started in `initialize()`. Daemon entry points start it explicitly (e.g. after calling `getService("task")` and `startTimer()`). **WHY:** Ephemeral and edge runtimes typically don’t want background timers; only long-lived processes do.

5. **Edge compatibility**  
   A dedicated edge entry point (`index.edge.ts`) and build exclude Node-only code (provisioning, character-loader, etc.). **WHY:** Edge runtimes (Vercel Edge, Cloudflare Workers) cannot load Node modules; a separate surface keeps bundles small and startup fast.

6. **Companion URL (optional)**  
   When `companionUrl` is set, embedding generation and task-dirty notifications are sent to that URL as fire-and-forget HTTP calls. **WHY:** Thin runtimes (serverless/edge) can delegate heavy or stateful work to a long-lived companion without blocking the request.

---

## Core concepts

### AgentRuntime

- **Constructor:** Requires `adapter` and optionally `character`, `plugins`, `companionUrl`, etc. No default adapter; use `InMemoryDatabaseAdapter` for in-memory or tests.
- **`initialize()`:** Registers plugins (bootstrap + character plugins), ensures adapter is ready, creates the message service. Does **not** run migrations or create agent/entity/room rows.
- **`getService(name)`:** Async. Returns the service instance or `null`; on first call for a type, the service is started (lazy). Always use `await runtime.getService(...)`.

### Provisioning (Node only)

Lives in `provisioning.ts`, exported from the Node entry point only. **WHY:** Uses `process.env` and is not suitable for edge/browser.

- **`runPluginMigrations(runtime)`** – Runs plugin schema migrations (DDL) via the runtime’s adapter.
- **`ensureAgentInfrastructure(runtime)`** – Ensures agent row, entity, self-room, and self-participant exist (batch adapter APIs).
- **`ensureEmbeddingDimension(runtime)`** – Sets embedding dimension on the adapter from the `EMBEDDING_DIMENSION` setting; no LLM call. **WHY:** Avoids an LLM call at boot; dimension must be set in character settings when using this path.
- **`provisionAgent(runtime, options)`** – Orchestrator: runs migrations (if `runMigrations: true`), then agent infrastructure, then embedding dimension. Call once after `initialize()` in daemon mode.
- **`mergeDbSettings(character, adapter, agentId)`** – Loads agent from DB and merges settings/secrets into the given character. Call **before** constructing the runtime so the runtime gets merged config. **WHY:** Ensures DB-backed secrets and settings are available without the runtime touching the DB at construction time.

### Connection module

Lives in `connection.ts`, usable from both Node and edge.

- **`ensureConnections(adapter, params)`** – Batch: upsert entities, worlds, rooms; then add participants per room. **WHY:** Fewer round-trips than doing one connection at a time.
- **`ensureConnection(adapter, params)`** – Single-connection wrapper around `ensureConnections`. The runtime’s `ensureConnection()` delegates to this with `runtime.adapter`.

---

## Deployment patterns

### 1. Daemon (long-lived process)

**Use case:** Milaidy, Telegram bot, Discord bot, etc.

**Steps:**

1. Create adapter (e.g. `createDatabaseAdapter(...)` from plugin-sql or `InMemoryDatabaseAdapter`), then `await adapter.initialize()`.
2. Optionally: `character = await mergeDbSettings(character, adapter, agentId)` so the runtime gets DB-backed settings/secrets.
3. `const runtime = new AgentRuntime({ character, adapter, plugins, ... })`.
4. `await runtime.initialize()`.
5. `await provisionAgent(runtime, { runMigrations: true })`.
6. If you need task polling:  
   `const task = await runtime.getService("task"); if (task?.startTimer) task.startTimer();`

**WHY:** Provisioning runs once at boot. The task timer is started only if the daemon uses scheduled tasks.

### 2. Ephemeral with DB (e.g. API route, serverless with DB)

**Use case:** Next.js API route, serverless function with Postgres.

**Steps:**

1. Create adapter (e.g. from plugin-sql or in-memory), `await adapter.initialize()`.
2. Optionally: `character = await mergeDbSettings(character, adapter, agentId)`.
3. `const runtime = new AgentRuntime({ character, adapter, plugins, ... })`.
4. `await runtime.initialize()`.
5. Do **not** call `provisionAgent()` on every request if provisioning was already done at agent creation. Call it only when creating or migrating an agent.

**WHY:** Ephemeral runtimes handle one request at a time; no background timers, no repeated migrations per request.

### 3. Edge / in-memory only

**Use case:** Vercel Edge, Cloudflare Workers, browser demo.

**Steps:**

1. Use the **edge** entry point (e.g. `import { AgentRuntime, InMemoryDatabaseAdapter } from "@elizaos/core/edge"` or the package’s edge export).
2. `const adapter = new InMemoryDatabaseAdapter(); await adapter.initialize()`.
3. `const runtime = new AgentRuntime({ character, adapter, ... })`.
4. `await runtime.initialize()`.
5. No provisioning, no Node-only modules, no `process.env` in code paths that run on the edge.

**WHY:** Edge runtimes cannot use Node APIs or heavy bootstrap; in-memory adapter and the edge build keep the surface compatible.

### 4. Tests

**Steps:**

1. `const adapter = new InMemoryDatabaseAdapter(); await adapter.initialize()` (or use a test double).
2. `const runtime = new AgentRuntime({ character, adapter, plugins, ... })`.
3. `await runtime.initialize()`.
4. Use `await runtime.getService(...)` whenever a test needs a service.

**WHY:** Explicit adapter and async `getService` make tests deterministic and avoid hidden global state.

---

## Companion URL (fire-and-forget)

When `companionUrl` is set on the runtime:

- **Embedding generation:** `runtime.queueEmbeddingGeneration(memory)` sends a POST to `{companionUrl}/embedding-generation` and returns without waiting. **WHY:** Embedding can be computed on the companion; the thin runtime doesn’t block.
- **Task dirty:** When tasks are created/updated, the runtime sends a POST to `{companionUrl}/task-dirty` with `{ agentId }`. **WHY:** The companion can poll or process task work without the thin runtime running a timer.

Both use `void fetch(...).catch(() => {})` so failures are not thrown back to the caller.

---

## File layout (reference)

| File / module        | Purpose |
|---------------------|--------|
| `runtime.ts`        | `AgentRuntime`: constructor (adapter required), slim `initialize()`, async `getService()`, `ensureConnection()` delegate, companion URL handling. |
| `provisioning.ts`   | Node-only: `provisionAgent`, `runPluginMigrations`, `ensureAgentInfrastructure`, `ensureEmbeddingDimension`, `mergeDbSettings`. |
| `connection.ts`     | Standalone: `ensureConnections`, `ensureConnection` (batch-first). |
| `runtime-composition.ts` | Node-only: `loadCharacters`, `getBootstrapSettings`, `mergeSettingsInto`, `createRuntimes`. See [Runtime composition](RUNTIME_COMPOSITION.md). |
| `index.node.ts`     | Node entry point; exports provisioning, connection, and runtime composition. |
| `index.edge.ts`     | Edge entry point; does **not** export provisioning; exports connection, runtime, in-memory adapter. |
| `services/task.ts`   | `TaskService`; `startTimer()` is public for explicit daemon use. |

---

## Summary of WHYs

| Decision | WHY |
|----------|-----|
| Adapter required in constructor | Single source of truth; no plugin registration races; caller owns DB lifecycle. |
| Slim `initialize()` | Request handler stays fast; provisioning is one-time at deploy/daemon boot. |
| Async `getService()` + lazy start | Services start only when used; startup cost and dependencies stay minimal. |
| Task timer not in `initialize()` | Only daemons need polling; edge/ephemeral don’t run timers. |
| `provisionAgent()` separate | Daemon runs it once; ephemeral/edge skip it or run only at agent creation. |
| `mergeDbSettings()` before runtime | Runtime gets DB-backed settings without touching DB in constructor. |
| Edge entry point | Edge runtimes can’t load Node modules; separate surface avoids pulling them in. |
| Companion URL | Thin runtime delegates embeddings and task notifications to a long-lived process. |
| Connection module batch-first | Fewer DB round-trips when ensuring many entities/rooms/participants. |
