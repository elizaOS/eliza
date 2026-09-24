# @elizaos/plugin-todos

Durable, tenant-scoped Todos for Node and edge-hosted Eliza agents.

Node and edge hosts share TodoStore and its tenant-scoped implementation. Hosts own
database migrations. A Todo write does not schedule a notification; use the
scheduling/reminder domain for timed delivery.

## Development

Install dependencies with `bun install` at the repository root. Run from that root:

```bash
bun run --cwd plugins/plugin-todos build  # build
bun run --cwd plugins/plugin-todos test   # tests
```
