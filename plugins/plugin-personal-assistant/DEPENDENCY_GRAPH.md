# LifeOps dependency graph & de-circularization audit

Tracking issue: [#9299](https://github.com/elizaOS/eliza/issues/9299), Scope 1.

This document is the canonical record of the dependency direction between
`@elizaos/plugin-personal-assistant` (PA / LifeOps) and the sibling lifeops
plugins. Re-run the checks below before adding any new cross-plugin import; if a
new edge appears, fix the edge — do not document a new exception without a
written rationale here.

## Result: zero circular dependencies

- **Intra-plugin (relative imports):** `madge --circular` over
  `plugin-personal-assistant/src` reports **no circular dependency** across the
  full module set.

  ```bash
  bunx madge --circular --extensions ts --no-spinner \
    plugins/plugin-personal-assistant/src
  ```

- **Cross-plugin (package imports):** no sibling lifeops plugin imports
  `@elizaos/plugin-personal-assistant` in source. Every textual match is a
  doc-comment or a provider-id **string literal** (e.g.
  `"@elizaos/plugin-personal-assistant:time-window"`) — loose runtime registry
  coupling resolved by name at runtime, not a compile-time edge.

  ```bash
  # expect zero matches for every sibling:
  grep -rhnE '^\s*(import|export)\b.*from\s+["'\'']@elizaos/plugin-personal-assistant' \
    plugins/plugin-{blocker,calendar,finances,health,inbox,relationships,scheduling}/src
  ```

## Dependency direction (inward-only)

PA is the composition layer; it depends on the domain plugins, never the
reverse. Edge counts are the number of PA source files importing each sibling:

```
plugin-personal-assistant ─▶ plugin-health        (19 files)
                          ─▶ plugin-blocker        (15 files)
                          ─▶ plugin-scheduling     (11 files)
                          ─▶ plugin-inbox          (11 files)
                          ─▶ plugin-finances       (10 files)
                          ─▶ plugin-calendar        (8 files)
                          ─▶ plugin-relationships   (0 files; consumed via the
                                                     runtime KnowledgeGraphService)
```

No sibling declares `@elizaos/plugin-personal-assistant` as a dependency in its
`package.json`, and none imports it in source. The decomposition that carved the
calendar / finances / inbox / relationships / scheduling domains out of PA's
`app_lifeops` schema already inverted these edges; this audit confirms they have
stayed inverted.

## Runtime coupling that is intentionally *not* a compile-time edge

The siblings reference PA by **provider-id string** through the shared registries
(`AnchorRegistry`, `EventKindRegistry`, `ConnectorRegistry`, `ChannelRegistry`)
and the single `ScheduledTask` runner in `@elizaos/plugin-scheduling`. This is
deliberate: it keeps the dependency graph acyclic while letting PA remain the
registrar of the cross-domain providers. Routing is by structural field, never
by `promptInstructions` content (see `README.md`).

## Knowledge graph ownership

`EntityStore` / `RelationshipStore` are runtime primitives owned by
`@elizaos/agent` and surfaced through `KnowledgeGraphService`
(`resolveKnowledgeGraphService(runtime)`); the merge engine and entity/
relationship types live in `@elizaos/shared`. PA's `lifeops/entities/*` and
`lifeops/relationships/*` are thin re-export shims over those primitives — there
is no second knowledge-graph store. `plugin-relationships` owns the user-facing
graph surface (the `KNOWLEDGE_GRAPH` action + viewer).
