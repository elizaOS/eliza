# @elizaos/plugin-relationships

Entity and relationship knowledge graph for Eliza agents.

Provides the `KNOWLEDGE_GRAPH` umbrella action (non-identity entity CRUD and
typed relationships), an `ENTITY_GRAPH` context provider for the planner, and
a startup audit for the retired `app_relationships` schema.

## Status

The package owns `KnowledgeGraphService` and its stores in the Node-only
`@elizaos/plugin-relationships/knowledge-graph` entry. The host registers the
service and existing `app_lifeops` tables; the action and provider consume the
registered service. Importing the graph entry does not load the React views. It does not register the retired `app_relationships`
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

- **Load the selected database adapter first.** PostgreSQL/PGlite uses the
  declared SQL dependency; explicit SQLite hosts rewrite it to plugin-sqlite.
  The graph uses that adapter's single-agent durable record store.
- **`SELF_ENTITY_ID = "self"`** is the canonical id of the owner. All
  ego-network edges originate from `self`.
- **`relationshipType` is open-string.** The lifeops `RelationshipTypeRegistry`
  carries the built-in set (`follows`, `colleague_of`, `partner_of`, `manages`,
  …) and will be ported alongside the store.

## Native SQLite backend

In the standalone host's explicit SQLite mode, the graph stores canonical entities,
identity evidence, attributes, typed edges and retirement audits in the existing
agent database. Public graph operations are transactional, including identity
observation, merges and edge retargeting. Selecting another agent's graph rejects.
Close/reopen preserves the data; unknown record-schema versions require migration.
Full reads remain full unless the caller explicitly requests a page size.

The canonical graph service is still host-registered. Embedders must register
KnowledgeGraphService, load the SQLite adapter first, and omit PostgreSQL schema
metadata only for implemented ports. This does not port the rest of the host,
household grants or personal-assistant persistence. Existing PostgreSQL data needs
a validated migration; opening a SQLite file does not import it. Protect the
entire state directory and backups with the deployment's encryption/key policy.
Graph retirement audits are not independent immutable compliance evidence.
