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

## Domain-extraction status (Scope 2 audit, #9299)

Audited the modules the issue flagged as "still embedded" in the PA monolith.
Each is already in its correct home; none is misplaced domain logic that a
sibling plugin should own:

| Module | Verdict | Why it stays in PA |
| --- | --- | --- |
| `lifeops/calendar-gate.ts` | correct PA glue | Implements `plugin-calendar`'s `CalendarHostGate` and injects PA's repository/Google-grant layer into `CalendarService`. It imports `LifeOpsService`, so moving it to `plugin-calendar` would invert the dependency (cycle). This *is* "PA composes the calendar plugin." |
| `lifeops/email-classifier.ts` | re-export shim | Real classifier already lives in `@elizaos/shared`; this 19-line file only preserves the historic import path. |
| `lifeops/entities/*`, `lifeops/relationships/*` | re-export shims | Thin shims over the runtime `EntityStore`/`RelationshipStore` (see "Knowledge graph ownership" above). |
| `lifeops/service-mixin-{calendar,inbox,scheduling}.ts` | correct PA glue | Composition mixins that wire PA's `LifeOpsService` to the domain plugins; they are the composition layer, not domain logic. |

### Flagged: `lifeops/bill-extraction.ts` (unconsumed)

`bill-extraction.ts` (457 lines of finance/bill parsing) has **no source
consumer** anywhere in `packages/` or `plugins/` — `grep -rn 'extractBill' --include='*.ts'`
matches only the file itself and doc comments. It is finance-domain logic that,
if revived, belongs in `@elizaos/plugin-finances` (PA already depends on it,
inward), not in the PA monolith. Left in place rather than relocated/deleted
because it reads as intended scaffolding for a future finances action; the repo
owner should either wire a `plugin-finances` consumer or remove it. Recorded
here so the next pass does not re-discover it cold.
