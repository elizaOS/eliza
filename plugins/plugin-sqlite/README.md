# @elizaos/plugin-sqlite

Durable single-agent database adapter for Node 24.15.0 using node:sqlite. Each database file belongs to one agent and one process. Existing PostgreSQL/PGlite mode is unchanged.

The SQLite backend supplies serialization, transactions, schema versioning, ownership and backup. The adapter reuses storage-neutral core record behavior, rebuilding its transient vector index on restart or rollback. Every public asynchronous adapter operation runs under the same transaction queue; no caller may observe a partially written batch.

Native SQLite files are not encrypted by this plugin. In confidential deployments put the entire state directory, WAL and backups on encrypted guest storage, and keep temporary SQLite data in memory. PostgreSQL/Drizzle plugin schemas are not portable and must fail explicitly until migrated.

Use the pinned Node version. Run package test, typecheck and lint:check, repository guide parity and root verify. Tests use actual temporary SQLite files and runtime adapters; do not replace SQLite with mocks.

For the standalone Node host, set `ELIZA_DATABASE_PROVIDER=sqlite` and an absolute `SQLITE_DATABASE_PATH` within the agent state directory. Remove a configured PostgreSQL/PGlite provider. The host substitutes SQLite for the normal SQL bootstrap; it does not fall back if SQLite initialization fails. Programmatic `AgentRuntime` callers may load this plugin explicitly before other database plugins. Do not point it at a PostgreSQL or PGlite directory.


The default application plugin set is not yet portable. Plugins declaring PostgreSQL schemas or a SQL plugin dependency fail activation before preflight; plugins that use PostgreSQL directly also require a port. Scheduling/LifeOps domain tables, the generic plugin store and custom SQL migrations are not implemented here. Core Task records and transitions are supported independently of those domain tables. This package is a durable runtime storage foundation, not a completed application database migration.

Record blobs use Node's V8 serialization, preserving Dates, BigInts and undefined values. They are not directly SQL-queryable domain tables or a cross-language interchange format. Queries currently scan their record collection, and startup rebuilds the in-memory vector index; benchmark memory use and startup time with production-scale data before deployment. Existing PostgreSQL/PGlite exports require an explicit validated importer; none is implied by opening a SQLite file.

Use `adapter.backup(newAbsolutePath)` to produce a consistent standalone backup including committed WAL pages. Close the adapter before replacing/restoring the main database, retain the same agent UUID, and validate the restored adapter before serving requests. A backup is plaintext unless its storage layer encrypts it. Rollback freshness protection, attested key release, encrypted filesystem provisioning and remote backup transport belong to the deployment system.

Transactions serialize concurrent callers across awaits. Sequential nested transactions use savepoints. Overlapping sibling nested transactions are rejected and rolled back; await nested work before continuing its parent. The database is exclusively owned by one process; a second SQLite connection cannot read or write while that owner is active. The public storage connection remains privileged plugin access, not a sandbox for hostile plugin code. The per-file agent UUID prevents accidental reuse across agents; document/entity authorization still belongs to the runtime's explicit access contracts.

`createLogs` commits to this same database before resolving. Logs are mutable runtime records, not an independently tamper-evident compliance ledger. Retention and immutable off-host evidence require the deployment audit pipeline. Cache CRUD has no TTL parameter in the core adapter contract; expiry is honored when a stored cache record has an expiry field.
