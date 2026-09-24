# @elizaos/plugin-relationships

Entity and relationship knowledge graph for Eliza agents.

## Purpose / role

Adds an entity / relationship knowledge graph to any Eliza agent: a single
`KNOWLEDGE_GRAPH` umbrella action for non-identity graph CRUD, an `ENTITY_GRAPH` provider that injects a projection of
the owner's ego-network into the planner each turn, a `/relationships` viewer
(React component served as a bundled view), and a read-only startup audit for
the retired `app_relationships` schema.

This package owns `KnowledgeGraphService`, `EntityStore`, and `RelationshipStore`
under its Node-only `knowledge-graph` entry. The host registers that service and
its existing `app_lifeops` schema once; plugins resolve it through
`resolveKnowledgeGraphService(runtime)`. Importing the graph entry does not load
this package's React views. Contact orchestration (the `ENTITY`
action with LLM planner + voice-grounded replies) stays in
`@elizaos/plugin-personal-assistant`.

The plugin is opt-in. PostgreSQL/PGlite uses `@elizaos/plugin-sql`; the standalone
host rewrites that bootstrap dependency to `@elizaos/plugin-sqlite` in explicit
SQLite mode. The graph uses the same agent adapter and shared merge engine.

## Plugin surface

**Action**
- `KNOWLEDGE_GRAPH` (`src/actions/entity.ts`) — single umbrella action with op-based
  dispatch. Accepted ops: `create`, `read`, `list`, `log_interaction`,
  `set_relationship`. Identity claims and merges require deterministic identity
  authority evidence and are not agent actions. Contexts: `people`, `contacts`,
  `relationships`. Owner-only (`roleGate.minRole: OWNER`).

**Provider**
- `ENTITY_GRAPH` (`src/providers/entity-graph.ts`) — injected at position `-4`
  in the `people` / `contacts` / `relationships` contexts. Projects the owner's
  recently observed entities and ego-network edges.

**Views**
- `relationships` (`src/components/relationships/RelationshipsView.tsx`) — a
  GUI view registered at path `/relationships`, bundled as
  `dist/views/bundle.js`. Displays the entity and relationship knowledge graph
  (people, organizations, identities, typed edges). Enabled in the desktop tab
  and the manager.

**Legacy schema audit**
- `LegacyRelationshipsSchemaAuditService`
  (`src/services/legacy-schema-audit.ts`) inventories the retired entities and
  relationships tables without creating or altering them. It fails startup
  closed when rows exist because the old schema lacks agent ownership and
  cannot be imported safely without operator mapping.

## Layout

```
src/
  index.ts                  Plugin export; re-exports action + provider + audit + types
  plugin.ts                 Plugin object (action + provider + audit service + views)
  types.ts                  Entity / Relationship interfaces, ENTITY_OPS, constants
  actions/
    entity.ts               entityAction — KNOWLEDGE_GRAPH op dispatch
  providers/
    entity-graph.ts         entityGraphProvider — per-turn context projection
  knowledge-graph/          Node service, stores, app_lifeops schema, and tests
  services/
    legacy-schema-audit.ts  read-only retired-schema inventory and startup guard
  db/
    schema.ts               drizzle pgSchema + entitiesTable + relationshipsTable
    index.ts                re-exports schema.ts
  components/
    relationships/
      RelationshipsView.tsx          React view component (entity/relationship graph UI)
      RelationshipsView.test.tsx     Component tests
      relationships-view-bundle.ts   Vite bundle entry for the view
```

## Commands

```bash
bun run --cwd plugins/plugin-relationships build        # tsup (JS) + vite (views bundle) + tsc (types)
bun run --cwd plugins/plugin-relationships test         # vitest run
bun run --cwd plugins/plugin-relationships typecheck    # tsc --noEmit
bun run --cwd plugins/plugin-relationships check        # typecheck + test
bun run --cwd plugins/plugin-relationships clean        # rm -rf dist .turbo
```

## Config / env vars

No plugin-specific settings keys. No API keys or external service credentials
needed.

## How to extend

**Add a new op to the KNOWLEDGE_GRAPH action:**
1. Add the op name to `ENTITY_OPS` in `src/types.ts`.
2. Extend `EntityActionParameters` in `src/actions/entity.ts` if the op needs
   new parameters.
3. Implement the op behavior alongside the existing dispatch in
   `entityAction.handler`.

**Add a new provider:**
1. Create `src/providers/<name>.ts` implementing the `Provider` interface from
   `@elizaos/core`.
2. Import and add it to the `providers` array in `src/plugin.ts`.

## Conventions / gotchas

- **Load the selected database adapter first.** PostgreSQL startup inventories
  the retired SQL schema. SQLite initializes versioned graph records in the
  existing single-agent database and requires explicit migration for unknown
  schema versions; it never interprets PostgreSQL SQL or imports legacy data.
- **`SELF_ENTITY_ID = "self"`** is the canonical id of the owner; all
  ego-network edges originate from `self`.
- **Built-in entity kinds:** `person`, `organization`, `place`, `project`,
  `concept`. The store accepts any string — kinds are open-string with an
  optional registry.
- **Built-in relationship kinds:** `follows`, `colleague_of`, `partner_of`,
  `manages`, `managed_by`, `lives_at`, `works_at`, `knows`, `owns`. Open
  string with optional metadata schema in the registry.
- **Do not register the retired schema.** Preserve it only as an audit/import
  source. Populated rows require an operator-provided agent ownership mapping;
  an automatic cross-tenant import is unsafe.
- **This plugin is NOT `ENTITY`.** The `KNOWLEDGE_GRAPH` action is the thin
  runtime graph-CRUD surface. The `ENTITY` action (rich Rolodex orchestration
  with LLM planner) belongs to `@elizaos/plugin-personal-assistant`. Keeping
  distinct names avoids duplicate action registration when both plugins load.
- **Do NOT add a second LifeOps scheduling mechanism, a second knowledge-graph
  store, or behavior keyed on `promptInstructions` text content.** This
  plugin owns *the* graph; lifeops keeps the scheduler and pipelines. See the
  root `AGENTS.md` "LifeOps + health: one scheduler" section.

## Verification

Follow the repository-wide verification and evidence standard in the [root AGENTS.md](../../AGENTS.md). Run
the package's relevant build, typecheck, lint, and test commands, then exercise
the real integration boundary changed by the work. Inspect the produced domain
artifacts and failure behavior; do not substitute mocked success for the system
under test.

## SQLite graph contract

EntityStore and RelationshipStore use the adapter's agent-bound DurableRecordStore
when present. Every public graph operation runs in one durable transaction;
identity observation, merge/edge rewrites, retirement and its audit cannot expose
intermediate writes. Explicit other-agent selection rejects before storage access.
The same shared identity decision and merge functions serve both backends.

The record namespaces reside inside the agent's existing SQLite database. No
resident map is authoritative. Store startup validates the schema version; reads
without a caller-supplied limit return the complete graph. Native close/reopen,
concurrent observation, rollback, recipient confirmation and ownership tests use
actual SQLite files and the pinned Node runtime.

This port does not migrate existing PostgreSQL state, port household grants or
personal-assistant repositories, or make the full application host SQLite-ready.
The host must still initialize its other schema owners explicitly. PostgreSQL
legacy-source archival remains a PostgreSQL migration operation. Runtime graph
retirement audit is mutable domain data, not the independent compliance archive.
Encrypted storage, backup fencing and restored consent authority remain deployment
requirements. Do not enable another plugin merely because this graph port exists.
