# Per-agent SQLite persistence

## Story: Reopen my agent's SQLite database in the owning runtime

> As a host, I can reopen the same SQLite data file on Node and run its current migrations while protecting it against a competing writer.

### A file opens for its bound agent only under a current process lease

The shell validates the configured absolute path, obtains exclusive writer ownership and reads the durable agent marker. For a new file it binds ownership transactionally before repository operations begin.

```quint
type DatabaseOwner = UnboundSqlite | BoundSqlite({ agent: str })
type SqliteLease = { processKey: str, leaseGeneration: int }
type OpenRequest = { requestedAgent: str, requestingProcess: str, observedGeneration: int, absolutePath: bool }
pure def ownedBy(owner: DatabaseOwner, agentId: str): bool = match owner {
  | UnboundSqlite => true
  | BoundSqlite(actual) => actual.agent == agentId
}
pure def mayOpenSqlite(owner: DatabaseOwner, lease: SqliteLease, request: OpenRequest): bool =
  request.absolutePath and request.requestedAgent != "" and request.requestingProcess != "" and
  lease.processKey == request.requestingProcess and lease.leaseGeneration > 0 and lease.leaseGeneration == request.observedGeneration and
  ownedBy(owner, request.requestedAgent)
pure def lawOtherAgentCannotOpenSqlite(actual: str, lease: SqliteLease, request: OpenRequest): bool =
  actual != request.requestedAgent implies not(mayOpenSqlite(BoundSqlite({ agent: actual }), lease, request))
pure def lawStaleLeaseCannotOpenSqlite(owner: DatabaseOwner, lease: SqliteLease, request: OpenRequest): bool =
  lease.leaseGeneration != request.observedGeneration implies not(mayOpenSqlite(owner, lease, request))
```

### Only the next unapplied migration can change the SQLite schema version

```quint
pure def mayApplySqliteMigration(appliedVersion: int, desiredVersion: int, migrationVersion: int): bool =
  appliedVersion >= 0 and migrationVersion == appliedVersion + 1 and migrationVersion <= desiredVersion
pure def lawAppliedSqliteVersionNeverRunsAgain(appliedVersion: int, desiredVersion: int, migrationVersion: int): bool =
  migrationVersion <= appliedVersion implies not(mayApplySqliteMigration(appliedVersion, desiredVersion, migrationVersion))
pure val leaseValues = Set({ processKey: "host-1", leaseGeneration: 2 }, { processKey: "host-2", leaseGeneration: 3 })
pure val requestValues = Set({ requestedAgent: "agent", requestingProcess: "host-1", observedGeneration: 2, absolutePath: true }, { requestedAgent: "agent", requestingProcess: "host-1", observedGeneration: 1, absolutePath: false })
pure val ownerValues = Set(UnboundSqlite, BoundSqlite({ agent: "agent" }), BoundSqlite({ agent: "other" }))
```
