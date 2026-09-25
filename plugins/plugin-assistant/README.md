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

Use `query` and optional `contexts` when an action name is unknown. When contexts
are omitted, exact registered domain phrases or declared aliases in the query scope the search; the
result reports those inferred domains. Queries without a domain retain global
search, and explicit contexts or catalog reads remain available. Search ranks
complete authorized operations and prefers matching operation names over
incidental words in long descriptions. Multiple requested operations remain
eligible. Ambiguous wording falls back to the existing lexical matches; a miss
means the query found nothing, not that the capability is unavailable.

The default `mode=load` enables the selected complete schemas in the next planner
round. `mode=describe` reads descriptions and schemas without enabling them.
Exact `names` load known operations or whole named families; `names=[]` reads the
complete authorized catalog. Search and exact loads refresh permissions, and
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
