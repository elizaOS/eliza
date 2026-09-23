# @elizaos/plugin-sqlite

Durable single-agent database adapter for Node 24.15.0 using node:sqlite. Each database file belongs to one agent and one process. Existing PostgreSQL/PGlite mode is unchanged.

The SQLite backend supplies serialization, transactions, schema versioning, ownership and backup. The adapter reuses storage-neutral core record behavior, rebuilding its transient vector index on restart or rollback. Every public asynchronous adapter operation runs under the same transaction queue; no caller may observe a partially written batch.

Native SQLite files are not encrypted by this plugin. In confidential deployments put the entire state directory, WAL and backups on encrypted guest storage, and keep temporary SQLite data in memory. PostgreSQL/Drizzle plugin schemas are not portable and must fail explicitly until migrated.

Use the pinned Node version. Run package test, typecheck and lint:check, repository guide parity and root verify. Tests use actual temporary SQLite files and runtime adapters; do not replace SQLite with mocks.
