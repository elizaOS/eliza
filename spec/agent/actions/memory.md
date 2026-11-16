# Background memory and the trajectory store

After conversations, the agent distils memories in the background. A
memory task reads its evidence in pages; each page of each task revision is
evaluated by a model call that settles once. A page whose evaluation failed
for good is blocked and never read again, but the task keeps the pages
still pending and finishes only when none is left. When the evidence is
reconciled the task gets a new revision, and a result from an older
revision, or from a cancelled task, never writes the current task's row.
Shutting down aborts the call in flight without consuming its page.

The trajectory store that records the agent's runs initializes its schema
on first use, whether that use is a read or a capture. One initializer runs
at a time and every caller waits for it; a failure fails the waiting
callers, and the next caller retries without redoing the migration that
already committed. The research baseline is `plugins/plugin-assistant`
`features/advanced-memory`, `features/trajectories` and the
`BackgroundMemoryDeferredPage` and `DeferredTrajectoryInit` models. What
trajectories record is in [trajectories](../trajectories.md).

## Story: Distil memories in the background without losing evidence

> As the owner, my agent learns from our conversations in the background,
> and a failure on one part of a conversation never makes it forget the
> rest or write stale conclusions.

### A blocked page has failed for good and is never evaluated again

```quint
type TaskPhase = Live | Finished | Cancelled
type PageStatus = Pending | Evaluated | PageFailed
type InitStage = NoInit | Inspecting | Migrating | Publishing
type Memory = { task: TaskPhase, revision: int, blocked: Set[int], pages: int -> PageStatus, running: int, attemptRevision: int, settlements: int -> int, retryUsed: bool, backoff: bool, shutdown: bool, initialized: bool, initStage: InitStage, schemaMigrated: bool, migrations: int, waiting: Set[int], failedCallers: Set[int], initFailures: int }
pure val pageIds = Set(1, 2)
pure val allPending: int -> PageStatus = Map().put(1, Pending).put(2, Pending)
pure val initial: Memory = { task: Live, revision: 0, blocked: Set(), pages: allPending, running: 0, attemptRevision: 0, settlements: Map(), retryUsed: false, backoff: false, shutdown: false, initialized: false, initStage: NoInit, schemaMigrated: false, migrations: 0, waiting: Set(), failedCallers: Set(), initFailures: 0 }
pure def pageStatus(m: Memory, page: int): PageStatus = m.pages.getOr(page, Pending)
pure def pageKey(revision: int, page: int): int = revision * 2 + page
pure def nextPage(m: Memory): int =
  if (m.task != Live) 0
  else if (pageStatus(m, 1) == Pending and not(m.blocked.contains(1))) 1
  else if (pageStatus(m, 2) == Pending and not(m.blocked.contains(2))) 2
  else 0
pure def ownsRow(m: Memory): bool = m.task == Live and m.attemptRevision == m.revision
pure def alwaysBlockedPageFailed(m: Memory): bool =
  pageIds.forall(p => m.blocked.contains(p) implies pageStatus(m, p) == PageFailed) and
  ((m.running != 0 and ownsRow(m)) implies not(m.blocked.contains(m.running)))
```

### Evaluating a page starts only for a live task, outside backoff and shutdown

```quint
pure def canStartPage(m: Memory): bool = m.running == 0 and not(m.shutdown) and not(m.backoff) and nextPage(m) != 0
pure def startPage(m: Memory): Memory = { ...m, running: nextPage(m), attemptRevision: m.revision }
pure def canRetryPage(m: Memory): bool = m.running != 0 and not(m.shutdown)
pure def retryPage(m: Memory): Memory = { ...m, running: 0, retryUsed: true, backoff: true }
pure def canWakeFromBackoff(m: Memory): bool = m.backoff
pure def wakeFromBackoff(m: Memory): Memory = { ...m, backoff: false }
pure def sometimesRetriedThenSettled(m: Memory): bool = m.retryUsed and pageStatus(m, 1) != Pending
```

### A page of a revision settles at most once, and the task finishes only when no page is pending

```quint
pure def canFinishPage(m: Memory, failed: bool): bool = m.running != 0 and not(m.shutdown)
pure def finishOwnedPage(m: Memory, failed: bool): Memory = {
  val p = m.running
  val k = pageKey(m.revision, p)
  val updated = m.pages.put(p, if (failed) PageFailed else Evaluated)
  val other = pageIds.exists(q => q != p and updated.getOr(q, Pending) == Pending)
  { ...m, running: 0, task: if (other) Live else Finished, pages: updated,
    blocked: if (failed) m.blocked.union(Set(p)) else m.blocked,
    settlements: m.settlements.put(k, m.settlements.getOr(k, 0) + 1) }
}
pure def finishPage(m: Memory, failed: bool): Memory =
  if (not(ownsRow(m))) { ...m, running: 0 } else finishOwnedPage(m, failed)
pure def alwaysPendingPageKeepsTask(m: Memory): bool = m.task == Finished implies pageIds.forall(p => pageStatus(m, p) != Pending)
pure def alwaysPageSettlesOnce(m: Memory): bool =
  pageIds.forall(p => m.settlements.getOr(pageKey(m.revision, p), 0) <= 1) and (pageIds.forall(p => pageStatus(m, p) == Pending) implies pageIds.forall(p => m.settlements.getOr(pageKey(m.revision, p), 0) == 0))
pure def sometimesDeferredPageOutlivesFailure(m: Memory): bool = m.task == Live and m.blocked.size() == 1 and pageIds.exists(p => pageStatus(m, p) == Pending)
```

### A result from an older revision or a cancelled task never writes the current task's row

Reconciling the evidence starts a new revision with every page pending. A
cancelled task replaced under the same identity gets a new revision too.

```quint
pure def canReviseTask(m: Memory): bool = m.task == Live
pure def reviseTask(m: Memory): Memory = { ...m, revision: m.revision + 1, blocked: Set(), pages: allPending }
pure def canCancelTask(m: Memory): bool = m.task == Live
pure def cancelTask(m: Memory): Memory = { ...m, task: Cancelled }
pure def canReplaceCancelled(m: Memory): bool = m.task == Cancelled
pure def replaceCancelled(m: Memory): Memory = { ...m, task: Live, revision: m.revision + 1, blocked: Set(), backoff: false, pages: allPending }
pure def stepStaleResultWritesNothing(before: Memory, via: str, after: Memory): bool =
  (via == "finishPage" and not(ownsRow(before))) implies
    (after.task == before.task and after.revision == before.revision and after.blocked.subseteq(before.blocked) and before.blocked.subseteq(after.blocked) and after.running == 0)
pure def sometimesOldResultIgnoredAfterRevision(m: Memory): bool = m.revision > 0 and m.attemptRevision < m.revision and m.task == Live
```

### Shutdown aborts the call in flight without consuming its page

```quint
pure def canCloseAdmissions(m: Memory): bool = not(m.shutdown)
pure def closeAdmissions(m: Memory): Memory = { ...m, shutdown: true }
pure def canAbortClosed(m: Memory): bool = m.shutdown and m.running != 0
pure def abortClosed(m: Memory): Memory = { ...m, running: 0 }
pure def canReopen(m: Memory): bool = m.shutdown
pure def reopen(m: Memory): Memory = { ...m, shutdown: false }
pure def stepShutdownKeepsPages(before: Memory, via: str, after: Memory): bool =
  via == "abortClosed" implies pageIds.forall(p => pageStatus(after, p) == pageStatus(before, p))
pure def sometimesPageKeptAcrossShutdown(m: Memory): bool = m.shutdown and m.task == Live and m.running == 0 and pageStatus(m, 1) == Pending
```

## Story: Initialize the trajectory store once

> As the owner, the first look at my agent's history and the first record
> of a run share one setup of the store, and a failed setup is simply tried
> again.

### One initializer runs at a time, and callers that arrive meanwhile wait for it

```quint
pure val callerValues = Set(1, 2)
pure def canRequestStore(m: Memory, caller: int): bool = not(m.initialized) and caller > 0 and not(m.waiting.contains(caller))
pure def requestStore(m: Memory, caller: int): Memory =
  { ...m, waiting: m.waiting.union(Set(caller)), failedCallers: m.failedCallers.exclude(Set(caller)), initStage: if (m.initStage == NoInit) Inspecting else m.initStage }
pure def alwaysWaitersHaveAnInitializer(m: Memory): bool = (m.waiting.size() > 0) iff (m.initStage != NoInit)
pure def sometimesTwoCallersShareInitialization(m: Memory): bool = m.waiting.size() == 2
```

### The schema migration runs at most once, and the store is published only with its schema

```quint
pure def canInspectSchema(m: Memory): bool = m.initStage == Inspecting
pure def inspectSchema(m: Memory): Memory = { ...m, initStage: if (m.schemaMigrated) Publishing else Migrating }
pure def canMigrateSchema(m: Memory): bool = m.initStage == Migrating
pure def migrateSchema(m: Memory): Memory = { ...m, schemaMigrated: true, migrations: m.migrations + 1, initStage: Publishing }
pure def canPublishStore(m: Memory): bool = m.initStage == Publishing
pure def publishStore(m: Memory): Memory = { ...m, initialized: true, initStage: NoInit, waiting: Set() }
pure def alwaysMigrationOnce(m: Memory): bool =
  m.migrations == (if (m.schemaMigrated) 1 else 0) and (m.initialized implies m.schemaMigrated) and (m.initStage == Migrating implies not(m.schemaMigrated))
pure def sometimesPublished(m: Memory): bool = m.initialized
```

### A failed initialization fails its waiting callers, and the next caller retries without redoing the migration

```quint
pure def canInitFailed(m: Memory): bool = m.initStage != NoInit
pure def initFailed(m: Memory): Memory = { ...m, initStage: NoInit, failedCallers: m.failedCallers.union(m.waiting), waiting: Set(), initFailures: m.initFailures + 1 }
pure def sometimesRetrySucceededAfterPartialMigration(m: Memory): bool = m.initialized and m.initFailures == 1 and m.migrations == 1
```
