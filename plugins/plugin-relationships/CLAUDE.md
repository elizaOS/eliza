# @elizaos/plugin-relationships

Entity and relationship knowledge graph for Eliza agents.

## Purpose / role

Adds an entity / relationship knowledge graph to any Eliza agent: a single
`ENTITY` umbrella action (op-based dispatch over CRUD, identity claims, typed
relationships, merge), an `ENTITY_GRAPH` provider that injects a projection of
the owner's ego-network into the planner each turn, and a drizzle
`pgSchema('app_relationships')` with `entities` and `relationships` tables.
The plugin is opt-in — add it to the agent's plugin list. It hard-depends on
`@elizaos/plugin-sql` (declared as a peer dep and in
`dependencies: ["@elizaos/plugin-sql"]`).

**Status: scaffolded.** Action and provider handlers are stubs during the
plugin-lifeops decomposition. The real EntityStore, identity merge engine,
voice-observer-bridge, and RelationshipStore still live in
`@elizaos/plugin-personal-assistant`; they port over in a follow-up pass. See `README.md`
for the migration mapping.

## Plugin surface

**Action**
- `ENTITY` (`src/actions/entity.ts`) — single umbrella action with op-based
  dispatch. Accepted ops: `create`, `read`, `list`, `log_interaction`,
  `set_identity`, `set_relationship`, `merge`. Contexts: `people`, `contacts`,
  `relationships`. STUB returns a TODO marker so the plugin compiles and
  registers.

**Provider**
- `ENTITY_GRAPH` (`src/providers/entity-graph.ts`) — injected at position `-4`
  in the `people` / `contacts` / `relationships` contexts. Projects the owner's
  recently observed entities and ego-network edges. STUB returns an empty
  projection.

**Schema**
- `relationshipsSchema` / `entitiesTable` / `relationshipsTable`
  (`src/db/schema.ts`) — `pgSchema("app_relationships")` with two tables:
  - `entities` — `(id, kind, displayName, attrs jsonb, createdAt, updatedAt)`
  - `relationships` — `(id, fromEntityId, toEntityId, kind, attrs jsonb, lastObservedAt)`
  Exported from `src/index.ts` as `schema` (the drizzle schema object the
  runtime registers migrations from).

## Layout

```
src/
  index.ts                  Plugin export; re-exports action + provider + schema + types
  plugin.ts                 Plugin object (action + provider + schema)
  types.ts                  Entity / Relationship interfaces, ENTITY_OPS, constants
  actions/
    entity.ts               entityAction — op dispatch (STUB)
  providers/
    entity-graph.ts         entityGraphProvider — per-turn context projection (STUB)
  db/
    schema.ts               drizzle pgSchema + entitiesTable + relationshipsTable
    index.ts                re-exports schema.ts
```

## Commands

```bash
bun run --cwd plugins/plugin-relationships build        # bun build → dist/ (ESM) + tsc --emitDeclarationOnly
bun run --cwd plugins/plugin-relationships dev          # hot-rebuild via build.ts
bun run --cwd plugins/plugin-relationships test         # vitest run
bun run --cwd plugins/plugin-relationships typecheck    # tsgo --noEmit
bun run --cwd plugins/plugin-relationships check        # typecheck + test
bun run --cwd plugins/plugin-relationships clean        # rm -rf dist .turbo
```

## Config / env vars

No plugin-specific settings keys. No API keys or external service credentials
needed. (The lifeops merge engine + voice-observer-bridge port may introduce
its own settings keys when it lands; this scaffold has none.)

## How to extend

**Add a new op to the ENTITY action:**
1. Add the op name to `ENTITY_OPS` in `src/types.ts`.
2. Extend `EntityActionParameters` in `src/actions/entity.ts` if the op needs
   new parameters.
3. Implement the op behavior alongside the existing dispatch in
   `entityAction.handler` (once the lifeops port lands; today the handler is
   a TODO marker).

**Add a new provider:**
1. Create `src/providers/<name>.ts` implementing the `Provider` interface from
   `@elizaos/core`.
2. Import and add it to the `providers` array in `src/plugin.ts`.

## Conventions / gotchas

- **`@elizaos/plugin-sql` must be loaded first.** Schema migrations for
  `app_relationships` are registered via the plugin object's `schema` field
  and require the SQL plugin's DB to be available.
- **`SELF_ENTITY_ID = "self"`** is the canonical id of the owner; all
  ego-network edges originate from `self`.
- **Built-in entity kinds:** `person`, `organization`, `place`, `project`,
  `concept`. The store accepts any string — kinds are open-string with an
  optional registry (registry lands with the lifeops port).
- **Built-in relationship kinds:** `follows`, `colleague_of`, `partner_of`,
  `manages`, `managed_by`, `lives_at`, `works_at`, `knows`, `owns`. Open
  string with optional metadata schema in the registry.
- **No migrations runner in this plugin.** Schema registration
  (`schema: dbSchema` in the plugin object) tells the elizaOS runtime to
  handle migrations. Do not add a manual migration runner here.
- **Stubs only — for now.** `ENTITY` and `ENTITY_GRAPH` intentionally return
  a TODO / empty result while the port from `@elizaos/plugin-personal-assistant` is in
  progress. See `README.md` for the file-by-file migration map.
- **Do NOT add a second LifeOps scheduling mechanism, a second knowledge-graph
  store, or behavior keyed on `promptInstructions` text content.** This
  plugin owns *the* graph; lifeops keeps the scheduler and pipelines. See the
  root `CLAUDE.md` "LifeOps + health: one scheduler" section.

