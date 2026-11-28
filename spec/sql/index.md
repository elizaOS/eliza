# PostgreSQL and PGlite persistence

[Connection and transaction lifecycle](./connectionLifecycle.md) governs adapter readiness, transaction bounds, PostgreSQL RLS session scoping, monotonic schema versions, and immutable embedding space pinning.

## Story: Attach a SQL adapter only after its schema is ready

> As a host, I can attach PostgreSQL or embedded PGlite to my agent with the necessary extensions and verified migrations, and protect data scoped to that agent.

### Applied migrations are a prefix of the desired sequence and must match their recorded checksum

The shell takes the adapter's database migration lock, reads the ordered ledger, verifies every applied entry, and applies the missing suffix transactionally. The installation is ready only when the required schema and extensions are present.

```quint
type MigrationEntry = { revision: int, checksum: str }
type MigrationDecision = MigrationCurrent | MigrationPending | MigrationConflict
pure def matchMigration(desired: List[MigrationEntry], position: int, migration: MigrationEntry): int =
  if (position >= 0 and position < desired.length() and desired[position] == migration) position + 1 else -1
pure def migrationSequenceMatches(applied: List[MigrationEntry], desired: List[MigrationEntry]): bool =
  applied.length() <= desired.length() and
    applied.foldl(0, (position, migration) => matchMigration(desired, position, migration)) == applied.length()
pure def classifyMigration(applied: List[MigrationEntry], desired: List[MigrationEntry]): MigrationDecision =
  if (not(migrationSequenceMatches(applied, desired))) MigrationConflict
  else if (applied.length() == desired.length()) MigrationCurrent
  else MigrationPending
pure def lawIdenticalLedgerIsCurrent(entries: List[MigrationEntry]): bool = classifyMigration(entries, entries) == MigrationCurrent
pure def lawExtraAppliedMigrationsConflict(applied: List[MigrationEntry], desired: List[MigrationEntry]): bool =
  applied.length() > desired.length() implies classifyMigration(applied, desired) == MigrationConflict
```

### A scoped read or mutation must name the active tenant and agent

```quint
type SqlActor = { tenantId: str, agentId: str }
type SqlRecordScope = { rowTenant: str, rowAgent: str }
pure def sqlScopeAllows(actor: SqlActor, row: SqlRecordScope): bool =
  actor.tenantId != "" and actor.agentId != "" and actor.tenantId == row.rowTenant and actor.agentId == row.rowAgent
pure def sqlReady(applied: List[MigrationEntry], desired: List[MigrationEntry], vectorReady: bool, tenantPolicyReady: bool): bool =
  classifyMigration(applied, desired) == MigrationCurrent and vectorReady and tenantPolicyReady
pure def lawUnreadySchemaCannotStart(applied: List[MigrationEntry], desired: List[MigrationEntry], vectorReady: bool, tenantPolicyReady: bool): bool =
  (not(vectorReady) or not(tenantPolicyReady)) implies not(sqlReady(applied, desired, vectorReady, tenantPolicyReady))
pure def lawSqlTenantAndAgentMustMatch(actor: SqlActor, row: SqlRecordScope): bool =
  sqlScopeAllows(actor, row) implies actor.tenantId == row.rowTenant and actor.agentId == row.rowAgent
pure val entriesValues = Set(List(), List({ revision: 1, checksum: "sha256-1" }))
pure val appliedValues = Set(List(), List({ revision: 1, checksum: "sha256-1" }), List({ revision: 1, checksum: "changed" }))
pure val desiredValues = Set(List(), List({ revision: 1, checksum: "sha256-1" }, { revision: 2, checksum: "sha256-2" }))
pure val actorValues = Set({ tenantId: "tenant", agentId: "agent" }, { tenantId: "other", agentId: "agent" })
pure val rowValues = Set({ rowTenant: "tenant", rowAgent: "agent" }, { rowTenant: "tenant", rowAgent: "other" })
```
