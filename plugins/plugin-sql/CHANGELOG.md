# Changelog

All notable changes to `@elizaos/plugin-sql` are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

---

## [Unreleased]

### Added

- **Entity context (RLS) for batch methods** – Optional `entityContext` (or `options.entityContext`) on five methods so Postgres can run under Row-Level Security when `ENABLE_DATA_ISOLATION=true`:
  - `transaction(callback, options?)` – whole transaction runs under one entity’s RLS context; nested calls use the same connection.
  - `queryEntities(params)` – `params.entityContext` runs the query under that entity’s connection context (RLS-only; not a filter).
  - `upsertComponents(components, options?)` – `options.entityContext` scopes the upsert to that entity when RLS is on.
  - `patchComponent(componentId, ops, options?)` – same for patch.
  - `upsertMemories(memories, options?)` – same for memory upserts.

  **Why:** With `ENABLE_DATA_ISOLATION=true`, Postgres RLS policies filter by `current_entity_id()` (set via `SET LOCAL app.entity_id`). Previously, `getMemories`, `getLogs`, and `getAgentRunSummaries` used `withEntityContext` when the caller passed `entityId`; the five batch methods did not, so they bypassed RLS. This change brings those methods in line: callers can pass optional entity context for user/entity-scoped flows.

  **Why optional:** System paths (migrations, boot, admin) correctly run without a user entity; making `entityContext` required would break them. Only plugin-sql Postgres uses it for RLS; other adapters accept and ignore it.

  See plugin README section **"Entity context and RLS"** for usage and when to pass context.
