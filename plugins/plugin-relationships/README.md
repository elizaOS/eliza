# @elizaos/plugin-relationships

Entity and relationship knowledge graph for Eliza agents.

Provides the `KNOWLEDGE_GRAPH` umbrella action (non-identity entity CRUD and
typed relationships), an `ENTITY_GRAPH` context provider for the planner, and
a startup audit for the retired `app_relationships` schema.

## Status

The action and provider are implemented facades over the runtime-owned
`KnowledgeGraphService`. It does not register the retired `app_relationships`
schema. Startup fails closed when that schema contains rows because its legacy
tables do not carry the agent ownership needed for an automatic import.
Identity observation, verification, and merging are deliberately absent from
the planner action surface: those mutations must enter through deterministic
authority evidence.

## Plugin surface

**Action**
- `KNOWLEDGE_GRAPH` (`src/actions/entity.ts`) — umbrella op dispatch. Accepted
  ops: `create`, `read`, `list`, `log_interaction`, `set_relationship`.
  Identity claims and merges require deterministic authority evidence and are
  not agent actions. Contexts: `people`, `contacts`, `relationships`.

**Provider**
- `ENTITY_GRAPH` (`src/providers/entity-graph.ts`) — injects a projection of
  the owner's known entities and ego-network edges into the planner.

**Legacy schema audit**
- `LegacyRelationshipsSchemaAuditService`
  (`src/services/legacy-schema-audit.ts`) — inventories the retired tables
  without creating or altering them and blocks startup when operator-guided
  ownership mapping is required.

## Layout

```
src/
  index.ts                       Public exports + default Plugin export
  plugin.ts                      Plugin object (action + provider + audit service)
  types.ts                       Entity / Relationship interfaces + constants
  actions/
    entity.ts                    Runtime knowledge-graph CRUD action
  providers/
    entity-graph.ts              Runtime knowledge-graph context provider
  services/
    legacy-schema-audit.ts       Read-only audit for retired schema rows
  db/
    schema.ts                    drizzle pgSchema + entities + relationships tables
    index.ts                     re-export schema
```

## Commands

```bash
bun run --cwd plugins/plugin-relationships build       # bun build → dist/ + tsc types
bun run --cwd plugins/plugin-relationships test        # vitest run
bun run --cwd plugins/plugin-relationships typecheck   # tsgo --noEmit
bun run --cwd plugins/plugin-relationships check       # typecheck + test
bun run --cwd plugins/plugin-relationships clean       # rm -rf dist .turbo
```

## Conventions / gotchas

- **`@elizaos/plugin-sql` must be loaded first.** The plugin declares this in
  `dependencies: ["@elizaos/plugin-sql"]`; the legacy audit resolves its
  database adapter during startup.
- **`SELF_ENTITY_ID = "self"`** is the canonical id of the owner. All
  ego-network edges originate from `self`.
- **`relationshipType` is open-string.** The lifeops `RelationshipTypeRegistry`
  carries the built-in set (`follows`, `colleague_of`, `partner_of`, `manages`,
  …) and will be ported alongside the store.
