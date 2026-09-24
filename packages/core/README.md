# @elizaos/core

Node runtime kernel for Eliza agents: plugin registration, authorization, state, model
dispatch, memory, and cancellation.

Import from `@elizaos/core`. Hosts explicitly supply database adapters, model providers,
and `@elizaos/plugin-assistant` for conversational behavior. The root entrypoint is the Node runtime. Explicit leaf exports provide wire
contracts and pure utilities without loading that runtime. Core does not own host
route tables or install assistant behavior implicitly. Runtime settings are per-agent and do not implicitly read process.env.

The root also exports route DTOs, Markdown, and LifeOps helpers. Use
`KnowledgeGraphEntity` / `KnowledgeGraphRelationship` for graph records and
`FirstRunMessageExample` for setup examples; the existing `Entity`, `Relationship`,
and `MessageExample` names retain their runtime meanings.

## Development

Install dependencies with `bun install` at the repository root. Run from that root:

```bash
bun run --cwd packages/core build  # build
bun run --cwd packages/core test   # tests
```

View declaration types remain in core; browser-safe visibility and surface-policy
helpers live in `@elizaos/core/views/*`; renderers import those leaves directly.
