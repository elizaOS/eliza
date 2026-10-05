# @elizaos/plugin-sqlite

Durable single-agent database adapter for Node 24.15.0 (`node:sqlite`) and Bun 1.4.2
(`bun:sqlite`).

Uses node:sqlite on pinned Node or bun:sqlite on pinned Bun. Each database file belongs
to one agent and process. Select this adapter explicitly; PostgreSQL/PGlite deployments
continue using plugin-sql. Preserve versioned migrations and cross-runtime database
compatibility.

## Development

Install dependencies with `bun install` at the repository root. Run from that root:

```bash
bun run --cwd plugins/plugin-sqlite build  # build
bun run --cwd plugins/plugin-sqlite test   # tests
```
