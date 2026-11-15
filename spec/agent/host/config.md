# Configuration

The host keeps its configuration as one document on disk. A write replaces
the whole document atomically: it is staged, synced and then renamed over
the committed one, so a failed write leaves the previous document intact.
Includes are followed to a bounded depth and never in a cycle. The access
scope the host computes from configuration and runtime mode is cached, and
the cache is dropped when its source changes. The research baseline is
`packages/agent/src/config/{config,includes,env-vars}.ts` and the
`runtime-config` and `api-boundaries` models. Who may change configuration
is in [route access](./access.md).

## Story: Change host configuration without losing live state

> As the owner, I change my host's configuration and either the whole new
> document takes effect or the old one stays; a change of runtime mode never
> leaves the host deciding access from stale settings.

### A write becomes the committed document only after it is synced

```quint
type WritePhase = WriteIdle | Staged | Synced
type Config = { committed: int, staged: int, phase: WritePhase, active: int, persisted: Set[int], includes: List[int], includeRefused: bool, scopeCached: bool, sourceCurrent: bool, reloadFailed: bool, writesFailed: int }
pure val initial: Config = { committed: 0, staged: -1, phase: WriteIdle, active: 0, persisted: Set(0), includes: List(), includeRefused: false, scopeCached: false, sourceCurrent: false, reloadFailed: false, writesFailed: 0 }
pure val documentValues = Set(0, 1, 2)
pure def canStage(c: Config, document: int): bool = c.phase == WriteIdle and document >= 0 and document != c.committed
pure def stage(c: Config, document: int): Config = { ...c, staged: document, phase: Staged }
pure def canSync(c: Config): bool = c.phase == Staged
pure def sync(c: Config): Config = { ...c, phase: Synced }
pure def canCommit(c: Config): bool = c.phase == Synced
pure def commit(c: Config): Config = { ...c, committed: c.staged, persisted: c.persisted.union(Set(c.staged)), staged: -1, phase: WriteIdle }
pure def alwaysStagedDocumentIsNew(c: Config): bool =
  (c.phase == WriteIdle implies c.staged == -1) and (c.phase != WriteIdle implies c.staged >= 0 and c.staged != c.committed)
pure def stepCommitOnlyAfterSync(before: Config, after: Config): bool =
  after.committed != before.committed implies before.phase == Synced and after.committed == before.staged
```

### A failed write leaves the committed document as it was

```quint
pure def canFailWrite(c: Config): bool = c.phase != WriteIdle
pure def failWrite(c: Config): Config = { ...c, staged: -1, phase: WriteIdle, writesFailed: c.writesFailed + 1 }
pure def stepFailedWriteKeepsDocument(before: Config, via: str, after: Config): bool =
  via == "failWrite" implies after.committed == before.committed
pure def sometimesWriteFailedAfterACommit(c: Config): bool = c.writesFailed > 0 and c.committed != 0
```

### The running host applies only a persisted document

```quint
pure def canActivate(c: Config): bool = c.phase == WriteIdle and c.active != c.committed
pure def activate(c: Config): Config = { ...c, active: c.committed }
pure def alwaysActiveDocumentWasPersisted(c: Config): bool = c.persisted.contains(c.active) and c.persisted.contains(c.committed)
pure def sometimesNewDocumentActive(c: Config): bool = c.active != 0
```

### Includes are followed to a depth of two and never in a cycle

The depth bound stands for the configured finite bound. An include that
names a document already on the include path is refused.

```quint
pure val includeDepth = 2
pure val includeValues = Set(1, 2)
pure def canEnterInclude(c: Config, include: int): bool = c.includes.length() < includeDepth and not(c.includes.includes(include))
pure def enterInclude(c: Config, include: int): Config = { ...c, includes: c.includes.append(include) }
pure def canLeaveInclude(c: Config): bool = c.includes.length() > 0
pure def leaveInclude(c: Config): Config = { ...c, includes: c.includes.select(i => i != c.includes.nthOr(c.includes.length() - 1, 0)) }
pure def canRefuseInclude(c: Config, include: int): bool = c.includes.includes(include)
pure def refuseInclude(c: Config, include: int): Config = { ...c, includeRefused: true }
pure def alwaysIncludesBoundedAndAcyclic(c: Config): bool =
  c.includes.length() <= includeDepth and c.includes.every(i => c.includes.select(j => j == i).length() == 1)
pure def sometimesNestedInclude(c: Config): bool = c.includes.length() == includeDepth
pure def sometimesCycleRefused(c: Config): bool = c.includeRefused
```

### A change of configuration source or runtime mode drops the cached access scope

The cached scope is used only while its source is current and its last
reload succeeded.

```quint
pure def loadScope(c: Config): Config = { ...c, scopeCached: true, sourceCurrent: true, reloadFailed: false }
pure def changeSource(c: Config): Config = { ...c, scopeCached: false, sourceCurrent: false }
pure def failReload(c: Config): Config = { ...c, scopeCached: false, sourceCurrent: false, reloadFailed: true }
pure def alwaysCachedScopeIsCurrent(c: Config): bool = c.scopeCached implies c.sourceCurrent and not(c.reloadFailed)
pure def sometimesScopeDroppedAfterFailedReload(c: Config): bool = c.reloadFailed and not(c.scopeCached)
```
