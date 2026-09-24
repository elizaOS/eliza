# @elizaos/plugin-relationships

Entity and relationship knowledge graph for Eliza agents.

Load the database adapter before this graph plugin. EntityStore, RelationshipStore, and
the merge engine are shared owners of identity. Legacy imports require explicit
ownership mapping; never import records across tenants automatically.

## Development

Install dependencies with `bun install` at the repository root. Run from that root:

```bash
bun run --cwd plugins/plugin-relationships build  # build
bun run --cwd plugins/plugin-relationships test   # tests
```
