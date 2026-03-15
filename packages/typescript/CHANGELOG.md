# Changelog

All notable changes to `@elizaos/core` are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

---

## [Unreleased]

### Added

- **Runtime composition module** (`runtime-composition.ts`): Building blocks for loading characters and creating runtimes, exported from the Node entry point only.
  - **WHY:** Daemon, cloud, serverless, and milaidy (and future hosts) need to set up runtimes without duplicating adapter creation, plugin resolution, or settings merge logic. Composable functions let each host use the pieces it needs (e.g. cloud may use only `getBootstrapSettings` and `mergeSettingsInto` with its own adapter pool).
  - **`loadCharacters(sources)`** – Load characters from file paths and/or inline `CharacterInput` objects. Reuses existing character-loader and character validation. **WHY:** Single API for file-based and programmatic config.
  - **`getBootstrapSettings(character, env?)`** – Flatten character settings/secrets and env into a string-only record for adapter factories. **WHY:** Adapter factories run before the DB is connected; they must not depend on settings that exist only in the DB (those are merged later).
  - **`mergeSettingsInto(character, agentRecord)`** – Pure merge of DB agent settings/secrets into a character (same semantics as `mergeDbSettings`, no DB call). **WHY:** Custom hosts that load agent records themselves (e.g. from cache) can reuse the merge logic without calling `mergeDbSettings`.
  - **`createRuntimes(characters, options?)`** – Full pipeline: resolve plugins once (batch), create adapters from plugin adapter factory, init adapters (deduped), batch merge DB settings per unique adapter, create and initialize runtimes; optional `provision: true`. **WHY:** Covers the common daemon/CLI path in one call; batch operations reduce plugin resolution and DB round-trips when multiple characters share a DB.
  - **Adapter factory on Plugin** – `Plugin.adapter` is now an optional `AdapterFactory` function `(agentId, settings) => IDatabaseAdapter | Promise<IDatabaseAdapter>`. Called by the composition layer before runtime construction; the runtime no longer calls `registerDatabaseAdapter` for it. **WHY:** Adapter must exist before the runtime is created; letting plugins declare a factory keeps adapter creation extensible (e.g. plugin-sql, future plugin-mongo) without hard-coding in core.
  - **plugin-sql** – Exported `plugin` now implements `adapter(agentId, settings)` (Node/TS: Postgres or PGlite via `POSTGRES_URL`/`DATABASE_URL`/`PGLITE_DATA_DIR`; browser: PGlite only). **WHY:** Enables createRuntimes to discover and use the SQL adapter without direct `createDatabaseAdapter` calls from the host.
  - See [Runtime composition](docs/RUNTIME_COMPOSITION.md) for settings divide (bootstrap vs runtime), API details, and usage examples.

- **Provisioning module** (`provisioning.ts`): Standalone functions for agent provisioning, exported from the Node entry point only.
  - **WHY:** Provisioning (migrations, agent/entity/room setup, embedding dimension) is a one-time bootstrap step at deploy or daemon boot. Keeping it out of `AgentRuntime.initialize()` keeps the runtime a lean request handler and allows edge/ephemeral runtimes to skip provisioning entirely.
- **Connection module** (`connection.ts`): Standalone batch-first helpers `ensureConnections()` and `ensureConnection()` for entity/world/room/participant setup.
  - **WHY:** Callers can use these with any adapter without going through the runtime. Batch operations reduce round-trips when handling many connections.
- **Edge entry point** (`index.edge.ts`): Dedicated build and exports for edge runtimes (Vercel Edge, Cloudflare Workers, Deno Deploy).
  - **WHY:** Edge environments cannot use Node-only modules (e.g. `provisioning`, character-loader, some utils). A separate entry point avoids pulling in incompatible code and keeps bundle size and startup predictable.

### Changed

- **`registerPlugin` and `Plugin.adapter`:** When a plugin has `adapter` set, the runtime now only logs that the adapter is "handled pre-construction" and does **not** call `registerDatabaseAdapter`. The adapter is always supplied to the constructor by the host (e.g. via `createRuntimes` or custom pipeline). **WHY:** Adapter creation is done by the composition layer (or host) before the runtime exists; the runtime never receives an adapter from a plugin at register time anymore.

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

### Removed

- **`runtime.registerDatabaseAdapter(adapter)`:** Adapter must be passed in the constructor (or supplied via `createRuntimes` using a plugin’s adapter factory). **WHY:** Constructor injection is the single source of truth and avoids ordering/race issues.

- **Automatic provisioning from `initialize()`:** Migrations, agent/entity/room creation, and embedding dimension are no longer run inside `initialize()`. Use `provisionAgent(runtime, { runMigrations: true })` after `initialize()` in daemon mode.
- **`ALLOW_NO_DATABASE` behavior:** The runtime no longer falls back to an in-memory adapter when no adapter is registered. You must always pass an adapter (e.g. `new InMemoryDatabaseAdapter()` for tests or stateless usage).
  - **WHY:** Explicit adapter choice makes deployment behavior clear and avoids hidden fallbacks.

### Migration guide (summary)

1. **Daemon (long-lived process):** Prefer **runtime composition**: `const characters = await loadCharacters([...])` then `const runtimes = await createRuntimes(characters, { provision: true })`. Alternatively: create and initialize your adapter → optionally `mergeDbSettings(character, adapter, agentId)` → `new AgentRuntime({ character, adapter, ... })` → `await runtime.initialize()` → `await provisionAgent(runtime, { runMigrations: true })` → start task timer if needed.
2. **Ephemeral with DB (e.g. API route):** Use `loadCharacters` + `createRuntimes(..., { provision: false })` or the manual path: create adapter → `mergeDbSettings` if needed → `new AgentRuntime({ character, adapter, ... })` → `await runtime.initialize()`.
3. **Edge / in-memory only:** Use `InMemoryDatabaseAdapter`, pass it to the constructor, and use the edge entry point. Do not use provisioning or Node-only modules (runtime composition is Node-only).
4. **Tests:** Use `InMemoryDatabaseAdapter` (or a test double), pass it in the constructor, and `await runtime.getService(...)` wherever you use a service.

---

## [Previous versions]

See git history for earlier changes.
