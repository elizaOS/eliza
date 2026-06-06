# @elizaos/plugin-relationships

Entity and relationship knowledge graph for Eliza agents.

Provides the `ENTITY` umbrella action (person / organization / place / project /
concept CRUD with identity claims, typed relationships, and merge), an
`ENTITY_GRAPH` context provider for the planner, and a drizzle
`pgSchema('app_relationships')` with `entities` and `relationships` tables.

## Status

**Scaffolded — decomposition in progress.** Action and provider handlers are
stubs that return a TODO marker. The real EntityStore, identity merge engine,
voice-observer-bridge, and RelationshipStore still live in
`@elizaos/plugin-personal-assistant`; they will move here in a follow-up pass.

## Migration mapping from `@elizaos/plugin-personal-assistant`

| Source under `plugins/plugin-personal-assistant/src/` | Will move to |
|---|---|
| `actions/entity.ts` (`ENTITY` action) | `plugins/plugin-relationships/src/actions/entity.ts` |
| `lifeops/entities/store.ts` (`EntityStore`) | `plugins/plugin-relationships/src/services/entity-store.ts` |
| `lifeops/entities/merge.ts` (identity merge engine) | `plugins/plugin-relationships/src/services/merge.ts` |
| `lifeops/entities/voice-observer-bridge.ts` | `plugins/plugin-relationships/src/services/voice-observer-bridge.ts` |
| `lifeops/entities/voice-observer.ts` | `plugins/plugin-relationships/src/services/voice-observer.ts` |
| `lifeops/entities/voice-attribution.ts` | `plugins/plugin-relationships/src/services/voice-attribution.ts` |
| `lifeops/entities/types.ts` (Entity, registries) | folded into `plugins/plugin-relationships/src/types.ts` |
| `lifeops/relationships/store.ts` (`RelationshipStore`) | `plugins/plugin-relationships/src/services/relationship-store.ts` |
| `lifeops/relationships/extraction.ts` | `plugins/plugin-relationships/src/services/relationship-extraction.ts` |
| `lifeops/relationships/types.ts` (Relationship, registries) | folded into `plugins/plugin-relationships/src/types.ts` |
| LifeOps `lifeops` provider — entity / relationship sections | `plugins/plugin-relationships/src/providers/entity-graph.ts` |

DB rows currently live in the LifeOps schema (`app_lifeops.life_entities`,
`life_entity_identities`, `life_entity_attributes`, `life_relationships`). The
new plugin owns the dedicated `app_relationships` schema with two minimal
tables; the rich identity + attribute + edge-state shapes from lifeops will
land in a follow-up migration.

## Plugin surface

**Action**
- `ENTITY` (`src/actions/entity.ts`) — umbrella op dispatch. Accepted ops:
  `create`, `read`, `list`, `log_interaction`, `set_identity`,
  `set_relationship`, `merge`. Contexts: `people`, `contacts`,
  `relationships`. STUB returns a TODO marker.

**Provider**
- `ENTITY_GRAPH` (`src/providers/entity-graph.ts`) — injects a projection of
  the owner's known entities and ego-network edges into the planner. STUB
  returns an empty projection.

**Schema**
- `relationshipsSchema` / `entitiesTable` / `relationshipsTable`
  (`src/db/schema.ts`) — `pgSchema("app_relationships")`. Registered via the
  plugin object's `schema` field so the elizaOS runtime handles migrations.

## Layout

```
src/
  index.ts                       Public exports + default Plugin export
  plugin.ts                      Plugin object (action + provider + schema)
  types.ts                       Entity / Relationship interfaces + constants
  actions/
    entity.ts                    ENTITY umbrella action (STUB)
  providers/
    entity-graph.ts              ENTITY_GRAPH provider (STUB)
  db/
    schema.ts                    drizzle pgSchema + entities + relationships tables
    index.ts                     re-export schema
```

## Commands

```bash
bun run --cwd plugins/plugin-relationships build       # bun build → dist/ + tsc types
bun run --cwd plugins/plugin-relationships dev         # hot-rebuild via build.ts
bun run --cwd plugins/plugin-relationships test        # vitest run
bun run --cwd plugins/plugin-relationships typecheck   # tsgo --noEmit
bun run --cwd plugins/plugin-relationships check       # typecheck + test
bun run --cwd plugins/plugin-relationships clean       # rm -rf dist .turbo
```

## Conventions / gotchas

- **`@elizaos/plugin-sql` must be loaded first.** The plugin declares this in
  `dependencies: ["@elizaos/plugin-sql"]`; the runtime registers DB migrations
  for `app_relationships` automatically.
- **`SELF_ENTITY_ID = "self"`** is the canonical id of the owner. All
  ego-network edges originate from `self`.
- **`relationshipType` is open-string.** The lifeops `RelationshipTypeRegistry`
  carries the built-in set (`follows`, `colleague_of`, `partner_of`, `manages`,
  …) and will be ported alongside the store.
- **Stubs only.** Do not rely on `ENTITY` or `ENTITY_GRAPH` returning real
  data yet — both intentionally return a TODO / empty result while the port
  is in progress.
