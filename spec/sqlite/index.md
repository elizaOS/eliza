# Per-agent SQLite persistence

[Backup publication](./backupPublication.md) governs atomic, crash-safe backup snapshots with hard-link publication and ancestor directory flushes.

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

## Story: Bound nested component-data filter walks against hostile payloads

> As a host querying component data in memory, I want depth, node, and cycle limits enforced so deeply nested or cyclic payloads fail explicitly instead of exhausting the call stack.

### Filter walks never exceed the depth limit, node budget, or re-enter an active container

```quint
pure val MAX_FILTER_DEPTH = 32
pure val MAX_FILTER_NODES = 2048
pure def mayAdvanceFilterWalk(depth: int, visitedNodes: int, deltaNodes: int, cyclic: bool): bool =
  not(cyclic) and
  depth >= 0 and depth <= MAX_FILTER_DEPTH and
  visitedNodes >= 0 and deltaNodes >= 0 and
  visitedNodes + deltaNodes <= MAX_FILTER_NODES
pure def lawCyclicFilterAlwaysRejected(depth: int, visitedNodes: int, deltaNodes: int): bool =
  not(mayAdvanceFilterWalk(depth, visitedNodes, deltaNodes, true))
pure def lawDeepFilterAlwaysRejected(depth: int, visitedNodes: int, deltaNodes: int): bool =
  depth > MAX_FILTER_DEPTH implies not(mayAdvanceFilterWalk(depth, visitedNodes, deltaNodes, false))
pure def lawOverBudgetFilterAlwaysRejected(depth: int, visitedNodes: int, deltaNodes: int): bool =
  visitedNodes + deltaNodes > MAX_FILTER_NODES implies not(mayAdvanceFilterWalk(depth, visitedNodes, deltaNodes, false))
pure val depthValues = Set(0, 16, 32, 33)
pure val visitedNodesValues = Set(0, 1024, 2048)
pure val deltaNodesValues = Set(0, 1, 1025)
```

## Story: Keep a single consistent embedding space and dimension per SQLite database

> As a host, I want a named embedding representation to stay pinned to one dimension and identifier so incompatible vectors never mix in the same HNSW index.

### Embedding dimension changes are refused once a named space is bound

```quint
pure def maySetEmbeddingDimension(hasActiveSpace: bool, currentDimension: int, nextDimension: int): bool =
  nextDimension > 0 and (not(hasActiveSpace) or currentDimension == nextDimension)
pure def mayBindEmbeddingSpace(currentSpace: str, nextSpace: str): bool =
  nextSpace != "" and (currentSpace == "" or currentSpace == nextSpace)
pure def lawBoundSpaceCannotChangeDimension(currentDimension: int, nextDimension: int): bool =
  currentDimension != nextDimension implies not(maySetEmbeddingDimension(true, currentDimension, nextDimension))
pure def lawBoundSpaceCannotSwitchIdentifier(currentSpace: str, nextSpace: str): bool =
  (currentSpace != "" and currentSpace != nextSpace) implies not(mayBindEmbeddingSpace(currentSpace, nextSpace))
pure val currentDimensionValues = Set(0, 384, 1536)
pure val nextDimensionValues = Set(0, 384, 768, 1536)
pure val currentSpaceValues = Set("", "openai:text-embedding-3-small")
pure val nextSpaceValues = Set("", "openai:text-embedding-3-small", "local:bge-small")
```
