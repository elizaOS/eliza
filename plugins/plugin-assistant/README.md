# @elizaos/plugin-assistant

Explicitly registered conversational behavior for the Node runtime.

## Development

Install dependencies with `bun install` at the repository root. Run from that root:

```bash
bun run --cwd plugins/plugin-assistant build  # build
bun run --cwd plugins/plugin-assistant test   # tests
```

The public OAuth provider catalog remains here; connection flows belong to
hosts, connectors, and cloud services. The unused OAuth callback bus and
plugin-configuration action plugin have been removed.

## Planner action discovery

`DISCOVER_ACTIONS` is a real per-turn `Action`, exposed to the planner as a native
function tool with typed arguments. It searches the registered action catalog;
it is not a prompt-only instruction or a second model call. Stage 1 chooses
contexts without receiving the action catalog. The planner can request more
operations throughout the turn.

Exact action hints stay selected. For other selected domains with pending
intents, the existing authorized retriever loads matching operations before
planning, avoiding a discovery round caused solely by an incomplete hint list.
Negated mutation clauses do not supply positive action hints.

Historical receipt wrappers may use compact row tables when their shapes are
uniform and the representation is smaller. Every value and source binding stays
available; original context events and restoration are unchanged. Shared source
review descriptions appear once in the planner instructions without weakening
the native tool schemas.

Use `query` and optional `contexts` when an action name is unknown. When contexts
are omitted, exact registered domain phrases or declared aliases in the query scope the search; the
result reports those inferred domains. Queries without a domain retain global
search, and explicit contexts or catalog reads remain available. Search ranks
complete authorized operations and prefers matching operation names over
incidental words in long descriptions. Multiple requested operations remain
eligible. Ambiguous wording falls back to the existing lexical matches; a miss
means the query found nothing, not that the capability is unavailable.

Automatic initial selection and query/context search select at most ten complete
operation definitions, retaining domain coverage before filling remaining slots
by rank. Explicit Stage-1 hints remain selected even when they exceed that automatic
budget. Search reports total `matchCount`, `selectedCount`, and `deferredCount`;
`completeMatches` is false when any matching operations were deferred. Neither
the underlying catalog nor the ranker is capped. This bounds lexical/contextual
selection; it does not add vector retrieval or a semantic reranker.

The default `mode=load` enables the selected complete schemas in the next planner
round. `mode=describe` reads descriptions and schemas without enabling them.
Exact `names` load known operations or whole named families; `names=[]` reads the
complete authorized catalog. These explicit paths are not limited to ten, and
no selected definition is truncated. Search and exact loads refresh permissions, and
execution checks them again. Discovery does not execute domain work. There is
one canonical planner discovery action. `SEARCH_ACTIONS` remains a cloud MCP
simile for connector discovery, not a separate planner registry;
`GET_ACTION_FROM_ALL` is not implemented. `DISCOVER_TOOLS` is its declared compatibility
simile: persisted or older model calls resolve to the same admitted action,
while new native schemas advertise only `DISCOVER_ACTIONS`.

Planner work continues across distinct operations and tool discovery by default.
Explicit `maxToolCalls` and `maxMemorySearchRounds` ceilings remain available;
discovery does not consume the domain-call ceiling. The default cumulative
prompt-token budget remains 1.5 million. Repeated failures, redundant mutations,
and repeated unchanged observations stop stalled work. A resource limit or
planner timeout returns an incomplete result with the full settled trajectory
and pending calls intact; it never reports earlier committed effects as undone
or automatically retries the turn.
