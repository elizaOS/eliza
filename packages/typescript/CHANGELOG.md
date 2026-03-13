# Changelog

All notable changes to `@elizaos/core` are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

---

## [Unreleased]

### Added

- **Provisioning module** (`provisioning.ts`): Standalone functions for agent provisioning, exported from the Node entry point only.
  - **WHY:** Provisioning (migrations, agent/entity/room setup, embedding dimension) is a one-time bootstrap step at deploy or daemon boot. Keeping it out of `AgentRuntime.initialize()` keeps the runtime a lean request handler and allows edge/ephemeral runtimes to skip provisioning entirely.
- **Connection module** (`connection.ts`): Standalone batch-first helpers `ensureConnections()` and `ensureConnection()` for entity/world/room/participant setup.
  - **WHY:** Callers can use these with any adapter without going through the runtime. Batch operations reduce round-trips when handling many connections.
- **Edge entry point** (`index.edge.ts`): Dedicated build and exports for edge runtimes (Vercel Edge, Cloudflare Workers, Deno Deploy).
  - **WHY:** Edge environments cannot use Node-only modules (e.g. `provisioning`, character-loader, some utils). A separate entry point avoids pulling in incompatible code and keeps bundle size and startup predictable.

### Changed

- **AgentRuntime constructor**
  - **`adapter` is required.** Pass `InMemoryDatabaseAdapter` for in-memory or tests; use a real adapter (e.g. from `@elizaos/plugin-sql`) for persistent storage.
  - **WHY:** Requiring the adapter at construction removes the need for plugins to “register” an adapter later and avoids race conditions (e.g. migrations running before the adapter is set). The caller owns connection lifecycle.
- **`initialize()` is slim.** It only registers plugins (including bootstrap), ensures the adapter is ready, and creates the message service. It does **not** run migrations, create agent/entity/room rows, or set embedding dimension.
  - **WHY:** Those steps belong to provisioning and run once at deploy/daemon boot. Ephemeral and edge runtimes often don’t need them; keeping them out of `initialize()` avoids unnecessary work and Node-only dependencies in short-lived or edge contexts.
- **`getService()` is async** and returns `Promise<T | null>`. Services are started lazily on first `getService()` call.
  - **WHY:** Lazy service startup defers work until a feature is actually used (e.g. task polling only when the task service is requested). All callers must `await runtime.getService(...)`.
- **TaskService: `startTimer()` is public.** Daemon entry points may call it explicitly to start or restart the task poll timer.
  - **WHY:** The timer is not started during `initialize()`. Making `startTimer()` public lets deployers explicitly enable task polling when they want it, and restart it if needed.
- **Companion URL:** When `companionUrl` is set, embedding generation and task-dirty notifications are sent to the companion as fire-and-forget HTTP requests instead of being handled in-process.
  - **WHY:** Allows a thin runtime (e.g. serverless or edge) to delegate heavy or stateful work (embeddings, task scheduling) to a long-lived companion process without blocking the request.

### Deprecated

- **`runtime.registerDatabaseAdapter(adapter)`:** Adapter must be passed in the constructor. This method is retained only for plugins that still expose `plugin.adapter`; it logs a warning and no-ops if an adapter is already set.
  - **WHY:** Constructor injection is the single source of truth and avoids ordering/race issues. The deprecated method allows existing plugins to keep working during the transition.

### Removed

- **Automatic provisioning from `initialize()`:** Migrations, agent/entity/room creation, and embedding dimension are no longer run inside `initialize()`. Use `provisionAgent(runtime, { runMigrations: true })` after `initialize()` in daemon mode.
- **`ALLOW_NO_DATABASE` behavior:** The runtime no longer falls back to an in-memory adapter when no adapter is registered. You must always pass an adapter (e.g. `new InMemoryDatabaseAdapter()` for tests or stateless usage).
  - **WHY:** Explicit adapter choice makes deployment behavior clear and avoids hidden fallbacks.

### Migration guide (summary)

1. **Daemon (long-lived process):** Create and initialize your adapter → optionally `mergeDbSettings(character, adapter, agentId)` → `new AgentRuntime({ character, adapter, ... })` → `await runtime.initialize()` → `await provisionAgent(runtime, { runMigrations: true })` → start task timer if needed: `(await runtime.getService('task'))?.startTimer?.()`.
2. **Ephemeral with DB (e.g. API route):** Create adapter → `mergeDbSettings` if you need DB-backed settings → `new AgentRuntime({ character, adapter, ... })` → `await runtime.initialize()`. Skip provisioning if it was done at agent creation.
3. **Edge / in-memory only:** Use `InMemoryDatabaseAdapter`, pass it to the constructor, and use the edge entry point. Do not use provisioning or Node-only modules.
4. **Tests:** Use `InMemoryDatabaseAdapter` (or a test double), pass it in the constructor, and `await runtime.getService(...)` wherever you use a service.

---

## [Previous versions]

See git history for earlier changes.
