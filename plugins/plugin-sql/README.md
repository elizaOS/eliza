# @elizaos/plugin-sql

SQL database adapter plugin for elizaOS — provides persistent storage via PostgreSQL or
embedded PGlite (WASM), with Drizzle ORM, automatic schema migrations, and optional Row
Level Security.

Provides PostgreSQL or embedded PGlite storage. PostgreSQL requires the vector
extension. Create adapters through createDatabaseAdapter, register the selected adapter
before dependent plugins, and preserve tenant-scoped authorization and migrations.

## Development

Install dependencies with `bun install` at the repository root. Run from that root:

```bash
bun run --cwd plugins/plugin-sql build  # build
bun run --cwd plugins/plugin-sql test   # tests
```
