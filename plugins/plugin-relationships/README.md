# @elizaos/plugin-relationships

Entity and relationship knowledge graph for Eliza agents.

## Runtime surface

The plugin is implemented and opt-in. It contributes:

- `KNOWLEDGE_GRAPH`, an owner-only umbrella action for `create`, `read`,
  `list`, `log_interaction`, `set_identity`, `set_relationship`, and `merge`;
- `ENTITY_GRAPH`, a planner provider that projects the owner's recent entities
  and ego-network edges in people/contact/relationship contexts;
- the `/relationships` developer view; and
- the `app_relationships` Drizzle schema with entity and relationship tables.

The authoritative stores are owned by `@elizaos/agent`'s
`KnowledgeGraphService`. This plugin resolves that service and operates on its
`EntityStore` and `RelationshipStore`; it does not maintain a second graph.
Rich contact/Rolodex orchestration remains the `ENTITY` action in
`@elizaos/plugin-personal-assistant`, so the two action names are intentionally
different.

## Installation and configuration

Add `@elizaos/plugin-relationships` to the agent's plugin list and load
`@elizaos/plugin-sql` first. The plugin has no provider credentials or
plugin-specific environment variables.

## Public modules

```text
src/
  index.ts                  public exports and default plugin
  plugin.ts                 action, provider, schema, and view registration
  actions/entity.ts         KNOWLEDGE_GRAPH validation and op dispatch
  providers/entity-graph.ts ENTITY_GRAPH context projection
  db/schema.ts              app_relationships Drizzle schema
  components/relationships relationship graph view
```

`SELF_ENTITY_ID = "self"` is the owner node. Entity and relationship kinds are
open strings with built-in defaults. Schema registration is handled by the
runtime; do not add a second migration runner.

## Commands

```bash
bun run --cwd plugins/plugin-relationships build
bun run --cwd plugins/plugin-relationships test
bun run --cwd plugins/plugin-relationships typecheck
bun run --cwd plugins/plugin-relationships lint:check
bun run --cwd plugins/plugin-relationships check
```

## Extending the graph

Add action operations to `ENTITY_OPS` and the typed parameter/handler dispatch
together. Add planner providers through `src/providers/` and register them in
`src/plugin.ts`. New behavior must continue to resolve the canonical runtime
knowledge-graph service rather than introducing a parallel store.
