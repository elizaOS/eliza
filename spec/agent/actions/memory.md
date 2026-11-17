# Background memory

After conversations, the agent distils memories in the background, one
page of evidence per settled model call. The store that records the
agent's runs is [trajectory capture](../trajectories.md)'s.

## Story: Distil memories in the background without losing evidence

> As the owner, my agent learns from our conversations in the background,
> and a failure on one part of a conversation never makes it forget the
> rest or write stale conclusions.

### A blocked page has failed for good and is never evaluated again

```quint
type TaskPhase = Live | Finished | Cancelled
type PageStatus = Pending | Evaluated | PageFailed
type Memory = { task: TaskPhase, revision: int, blocked: Set[int], pages: int -> PageStatus, running: int, attemptRevision: int, settlements: int -> int, retryUsed: bool, backoff: bool, shutdown: bool }
pure val pageIds = Set(1, 2)
pure val allPending: int -> PageStatus = Map().put(1, Pending).put(2, Pending)
pure val initial: Memory = { task: Live, revision: 0, blocked: Set(), pages: allPending, running: 0, attemptRevision: 0, settlements: Map(), retryUsed: false, backoff: false, shutdown: false }
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

A call in flight evaluates one of the task's pages, for the task's revision
or an older one. While the call is for the current revision and the task is
live, its page is still pending. A page still pending in the current
revision has not settled; a new revision starts with no settlements.

```quint
pure def canFinishPage(m: Memory, failed: bool): bool = m.running != 0 and not(m.shutdown)
pure def settleOwnedPage(failed: bool, m: Memory): Memory = {
  val p = m.running
  val k = pageKey(m.revision, p)
  val updated = m.pages.put(p, if (failed) PageFailed else Evaluated)
  val other = pageIds.exists(q => q != p and updated.getOr(q, Pending) == Pending)
  { ...m, running: 0, task: if (other) Live else Finished, pages: updated,
    blocked: if (failed) m.blocked.union(Set(p)) else m.blocked,
    settlements: m.settlements.put(k, m.settlements.getOr(k, 0) + 1) }
}
pure def finishPage(m: Memory, failed: bool): Memory =
  if (not(ownsRow(m))) { ...m, running: 0 } else settleOwnedPage(failed, m)
pure def alwaysPendingPageKeepsTask(m: Memory): bool = m.task == Finished implies pageIds.forall(p => pageStatus(m, p) != Pending)
pure def alwaysPageSettlesOnce(m: Memory): bool =
  pageIds.forall(p => m.settlements.getOr(pageKey(m.revision, p), 0) <= 1) and (pageIds.forall(p => pageStatus(m, p) == Pending) implies pageIds.forall(p => m.settlements.getOr(pageKey(m.revision, p), 0) == 0))
pure def alwaysRunningPageIsCurrentAndPending(m: Memory): bool =
  m.attemptRevision <= m.revision and (m.running == 0 or pageIds.contains(m.running)) and
  ((m.running != 0 and ownsRow(m)) implies pageStatus(m, m.running) == Pending)
pure def alwaysPendingPageUnsettled(m: Memory): bool =
  pageIds.forall(p => pageStatus(m, p) == Pending implies m.settlements.getOr(pageKey(m.revision, p), 0) == 0)
pure def sometimesDeferredPageOutlivesFailure(m: Memory): bool = m.task == Live and m.blocked.size() == 1 and pageIds.exists(p => pageStatus(m, p) == Pending)
```

### A result from an older revision or a cancelled task never writes the current task's row

Reconciling the evidence starts a new revision with every page pending and
none settled. A cancelled task replaced under the same identity gets a new
revision too.

```quint
pure def canReviseTask(m: Memory): bool = m.task == Live
pure def reviseTask(m: Memory): Memory = { ...m, revision: m.revision + 1, blocked: Set(), pages: allPending, settlements: Map() }
pure def canCancelTask(m: Memory): bool = m.task == Live
pure def cancelTask(m: Memory): Memory = { ...m, task: Cancelled }
pure def canReplaceCancelled(m: Memory): bool = m.task == Cancelled
pure def replaceCancelled(m: Memory): Memory = { ...m, task: Live, revision: m.revision + 1, blocked: Set(), backoff: false, pages: allPending, settlements: Map() }
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
