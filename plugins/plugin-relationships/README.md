# @elizaos/plugin-relationships

Entity and relationship knowledge graph for Eliza agents.

Load the database adapter before this graph plugin. EntityStore, RelationshipStore, and
the merge engine are shared owners of identity. Legacy imports require explicit
ownership mapping; never import records across tenants automatically.

Import graph stores, `KnowledgeGraphService`, and `knowledgeGraphSchema` from
`@elizaos/plugin-relationships`. Renderer hosts import `registerRelationshipsApp()` from the browser-safe
`@elizaos/plugin-relationships/register` leaf to register the signed page; importing the package
alone does not register it. The app's manifest loader invokes this function through
`elizaos.appRegister.export`.
The app renderer resolves that root to `src/browser.ts`, which exposes the views
and registration without loading database adapters or runtime services in Vite.

## Development

Install dependencies with `bun install` at the repository root. Run from that root:

```bash
bun run --cwd plugins/plugin-relationships build  # build
bun run --cwd plugins/plugin-relationships test   # tests
```
