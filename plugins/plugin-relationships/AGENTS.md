# @elizaos/plugin-relationships

Entity and relationship knowledge graph for Eliza agents.

## Purpose / role

Adds an entity / relationship knowledge graph to any Eliza agent: a single
`KNOWLEDGE_GRAPH` umbrella action for non-identity graph CRUD, an `ENTITY_GRAPH` provider that injects a projection of
the owner's ego-network into the planner each turn and a drizzle
`pgSchema('app_relationships')` with `entities` and `relationships` tables.

The graph stores (`EntityStore` / `RelationshipStore`) are owned by
`@elizaos/agent`'s `KnowledgeGraphService`; this plugin consumes them via
`resolveKnowledgeGraphService(runtime)`. Contact orchestration (the `ENTITY`
action with LLM planner + voice-grounded replies) stays in
`@elizaos/plugin-personal-assistant`.

The plugin is opt-in — add it to the agent's plugin list. It hard-depends on
`@elizaos/plugin-sql` (declared as a peer dep and in
`dependencies: ["@elizaos/plugin-sql"]`).

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

**View ownership**
- The app-owned Relationships view at `/apps/relationships` is the only
  first-party renderer. `/relationships` remains a shell compatibility route;
  this plugin does not register or build a view bundle.

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
    entity.ts               entityAction — KNOWLEDGE_GRAPH op dispatch
  providers/
    entity-graph.ts         entityGraphProvider — per-turn context projection
  db/
    schema.ts               drizzle pgSchema + entitiesTable + relationshipsTable
    index.ts                re-exports schema.ts
```

## Commands

```bash
bun run --cwd plugins/plugin-relationships build        # tsup (JS) + tsc (types)
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

- **`@elizaos/plugin-sql` must be loaded first.** Schema migrations for
  `app_relationships` are registered via the plugin object's `schema` field
  and require the SQL plugin's DB to be available.
- **`SELF_ENTITY_ID = "self"`** is the canonical id of the owner; all
  ego-network edges originate from `self`.
- **Built-in entity kinds:** `person`, `organization`, `place`, `project`,
  `concept`. The store accepts any string — kinds are open-string with an
  optional registry.
- **Built-in relationship kinds:** `follows`, `colleague_of`, `partner_of`,
  `manages`, `managed_by`, `lives_at`, `works_at`, `knows`, `owns`. Open
  string with optional metadata schema in the registry.
- **No migrations runner in this plugin.** Schema registration
  (`schema: dbSchema` in the plugin object) tells the elizaOS runtime to
  handle migrations. Do not add a manual migration runner here.
- **This plugin is NOT `ENTITY`.** The `KNOWLEDGE_GRAPH` action is the thin
  runtime graph-CRUD surface. The `ENTITY` action (rich Rolodex orchestration
  with LLM planner) belongs to `@elizaos/plugin-personal-assistant`. Keeping
  distinct names avoids duplicate action registration when both plugins load.
- **Do NOT add a second LifeOps scheduling mechanism, a second knowledge-graph
  store, or behavior keyed on `promptInstructions` text content.** This
  plugin owns *the* graph; lifeops keeps the scheduler and pipelines. See the
  root `CLAUDE.md` "LifeOps + health: one scheduler" section.

## Verification

Follow the repository-wide verification and evidence standard in the [root CLAUDE.md](../../CLAUDE.md). Run
the package's relevant build, typecheck, lint, and test commands, then exercise
the real integration boundary changed by the work. Inspect the produced domain
artifacts and failure behavior; do not substitute mocked success for the system
under test.
