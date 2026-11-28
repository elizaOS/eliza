# SQL connection and transaction lifecycle

## Story: Enforce safe SQL connection lifecycle, transaction scoping, and immutable embedding space pinning

> As a host running an Eliza agent on PostgreSQL or embedded PGlite, I want database adapters to track connection readiness, bound concurrent transactions, scope per-entity RLS cleanly to active transactions, keep schema versions monotonic, and prevent silent embedding space mutations once pinned.

### Adapter lifecycle transitions preserve transaction, RLS, schema, and embedding invariants

An adapter connects from `Disconnected` to `Ready` with a positive non-rewinding `schemaVersion`, binding PostgreSQL RLS (`rlsServerBound`) only on `PgBackend` and never on `PgliteBackend`, while capping concurrent transactions at `maxTransactions == 2` and ensuring `entityScopeActive` holds only while `activeTransactions > 0`. Once pinned in `Ready`, the embedding dimension is restricted to `{384, 768, 1536}` and remains immutable across all subsequent transitions, and `finishClose` moves a `ShuttingDown` adapter to `Closed` only after `activeTransactions == 0`, clearing both `rlsServerBound` and `entityScopeActive`.

```quint
type SqlBackend = PgBackend | PgliteBackend
type AdapterPhase = Disconnected | Connecting | Ready | ShuttingDown | Closed

type ConnectionState = {
  backend: SqlBackend,
  phase: AdapterPhase,
  activeTransactions: int,
  maxTransactions: int,
  rlsServerBound: bool,
  entityScopeActive: bool,
  schemaVersion: int,
  embeddingDimension: int,
  embeddingSpacePinned: bool
}

pure val initial: ConnectionState = {
  backend: PgliteBackend,
  phase: Disconnected,
  activeTransactions: 0,
  maxTransactions: 2,
  rlsServerBound: false,
  entityScopeActive: false,
  schemaVersion: 0,
  embeddingDimension: 0,
  embeddingSpacePinned: false
}

pure def validEmbeddingDimension(dim: int): bool =
  dim == 384 or dim == 768 or dim == 1536

pure def canBeginConnect(s: ConnectionState, backend: SqlBackend): bool =
  s.phase == Disconnected

pure def beginConnect(s: ConnectionState, backend: SqlBackend): ConnectionState =
  { ...s, backend: backend, phase: Connecting, rlsServerBound: false, entityScopeActive: false }

pure def canCompleteConnect(s: ConnectionState, schemaVersion: int): bool =
  s.phase == Connecting and schemaVersion >= s.schemaVersion and schemaVersion > 0

pure def completeConnect(s: ConnectionState, schemaVersion: int): ConnectionState =
  {
    ...s,
    phase: Ready,
    schemaVersion: schemaVersion,
    rlsServerBound: s.backend == PgBackend
  }

pure def canFailConnect(s: ConnectionState): bool =
  s.phase == Connecting

pure def failConnect(s: ConnectionState): ConnectionState =
  { ...s, phase: Disconnected, rlsServerBound: false, entityScopeActive: false }

pure def canBeginTransaction(s: ConnectionState, withEntityScope: bool): bool =
  s.phase == Ready and s.activeTransactions < s.maxTransactions and
  (not(withEntityScope) or s.activeTransactions == 0)

pure def beginTransaction(s: ConnectionState, withEntityScope: bool): ConnectionState =
  {
    ...s,
    activeTransactions: s.activeTransactions + 1,
    entityScopeActive: s.entityScopeActive or withEntityScope
  }

pure def canEndTransaction(s: ConnectionState): bool =
  (s.phase == Ready or s.phase == ShuttingDown) and s.activeTransactions > 0

pure def endTransaction(s: ConnectionState): ConnectionState =
  val nextTx = s.activeTransactions - 1
  {
    ...s,
    activeTransactions: nextTx,
    entityScopeActive: if (nextTx == 0) false else s.entityScopeActive
  }

pure def canPinEmbeddingSpace(s: ConnectionState, dim: int): bool =
  s.phase == Ready and validEmbeddingDimension(dim) and
  (not(s.embeddingSpacePinned) or s.embeddingDimension == dim)

pure def pinEmbeddingSpace(s: ConnectionState, dim: int): ConnectionState =
  { ...s, embeddingDimension: dim, embeddingSpacePinned: true }

pure def canBeginShutdown(s: ConnectionState): bool =
  s.phase == Ready

pure def beginShutdown(s: ConnectionState): ConnectionState =
  { ...s, phase: ShuttingDown }

pure def canFinishClose(s: ConnectionState): bool =
  s.phase == ShuttingDown and s.activeTransactions == 0

pure def finishClose(s: ConnectionState): ConnectionState =
  { ...s, phase: Closed, rlsServerBound: false, entityScopeActive: false }

pure def alwaysConnectionBounds(s: ConnectionState): bool =
  s.maxTransactions == 2 and
  s.activeTransactions >= 0 and s.activeTransactions <= s.maxTransactions and
  (s.phase == Disconnected or s.phase == Connecting or s.phase == Closed implies s.activeTransactions == 0) and
  (s.entityScopeActive implies s.activeTransactions > 0) and
  (s.backend == PgliteBackend implies not(s.rlsServerBound)) and
  (s.phase == Closed implies not(s.rlsServerBound) and not(s.entityScopeActive)) and
  s.schemaVersion >= 0

pure def alwaysPinnedEmbeddingValid(s: ConnectionState): bool =
  s.embeddingSpacePinned implies validEmbeddingDimension(s.embeddingDimension)

pure def stepSchemaVersionNeverRewinds(before: ConnectionState, via: str, after: ConnectionState): bool =
  after.schemaVersion >= before.schemaVersion

pure def stepEmbeddingSpaceImmutableOncePinned(before: ConnectionState, via: str, after: ConnectionState): bool =
  before.embeddingSpacePinned implies (after.embeddingSpacePinned and after.embeddingDimension == before.embeddingDimension)

pure val schemaVersionValues = Set(0, 1, 2)
pure val dimValues = Set(0, 384, 768, 1536)

pure def sometimesReadyWithEntityTx(s: ConnectionState): bool =
  s.phase == Ready and s.rlsServerBound and s.entityScopeActive and s.activeTransactions == 1

pure def sometimesPinnedEmbedding(s: ConnectionState): bool =
  s.embeddingSpacePinned and s.embeddingDimension == 1536

pure def sometimesCleanlyClosed(s: ConnectionState): bool =
  s.phase == Closed and s.schemaVersion > 0

pure val eval_witness_sometimesCleanlyClosed = (
  ("beginConnect", PgBackend),
  ("completeConnect", 1),
  ("beginTransaction", true),
  ("pinEmbeddingSpace", 1536),
  ("beginShutdown"),
  ("endTransaction"),
  ("finishClose")
)
```
