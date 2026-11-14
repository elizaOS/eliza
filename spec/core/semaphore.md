# Cancellable semaphore ownership

A configured positive permit count controls concurrency without reducing the set of possible caller identities. Sources include [task-scheduling.ts](https://github.com/elizaOS/eliza/blob/72fed7e4069ecd35d61d886ab6eec5c02c137517/packages/core/src/utils/task-scheduling.ts) and [Semaphore.qnt](https://github.com/elizaOS/eliza/blob/72fed7e4069ecd35d61d886ab6eec5c02c137517/packages/core/quint/Semaphore.qnt).

## Story: Acquire cancellable capacity

As an asynchronous caller I acquire in FIFO order and an aborted queued request never receives a permit.

### A permit is always available or owned by one caller

Capacity is supplied during setup. Immediate acquisitions consume a permit and queued acquisitions retain increasing tickets.

```quint
type Waiter = { id: int, ticket: int }
type SemaphoreState = { capacity: int, available: int, configured: bool, holders: Set[int], waiters: List[Waiter], granted: List[Waiter], aborted: Set[int], queuedAbort: Set[int], completed: Set[int], rejected: Set[int], nextTicket: int }
pure val initial: SemaphoreState = { capacity: 0, available: 0, configured: false, holders: Set(), waiters: List(), granted: List(), aborted: Set(), queuedAbort: Set(), completed: Set(), rejected: Set(), nextTicket: 1 }
pure val capacityValues = Set(1, 2)
pure val callerValues = Set(1, 2, 3, 4)
pure def canConfigureSemaphore(s: SemaphoreState, capacity: int): bool = not(s.configured) and capacity > 0
pure def configureSemaphore(s: SemaphoreState, capacity: int): SemaphoreState = { ...s, capacity: capacity, available: capacity, configured: true }
pure def canAcquire(s: SemaphoreState, caller: int): bool = s.configured and caller > 0 and not(s.holders.contains(caller)) and not(s.waiters.some(w => w.id == caller)) and not(s.completed.contains(caller)) and not(s.rejected.contains(caller))
pure def acquire(s: SemaphoreState, caller: int): SemaphoreState =
  if (s.aborted.contains(caller)) { ...s, rejected: s.rejected.union(Set(caller)) }
  else if (s.available > 0) { ...s, available: s.available - 1, holders: s.holders.union(Set(caller)) }
  else { ...s, waiters: s.waiters.append({id: caller, ticket: s.nextTicket}), nextTicket: s.nextTicket + 1 }
pure def alwaysPermitConservation(s: SemaphoreState): bool = s.available >= 0 and s.available + s.holders.size() == s.capacity
pure def alwaysNoIdlePermitWithWaiters(s: SemaphoreState): bool = s.available > 0 implies s.waiters.length() == 0
pure def alwaysWaitersUnique(s: SemaphoreState): bool = s.waiters.every(w => w.id > 0 and w.ticket > 0 and w.ticket < s.nextTicket and s.waiters.select(x => x.id == w.id).length() == 1 and not(s.holders.contains(w.id)))
pure def sometimesCallerWaits(s: SemaphoreState): bool = s.waiters.length() > 0
```

### A release skips cancelled waiters before granting the oldest live ticket

Signal observation and cancellation listener execution remain separate so a release can observe an aborted caller first.

```quint
pure def canAbortWaiter(s: SemaphoreState, caller: int): bool = caller > 0 and not(s.aborted.contains(caller))
pure def abortWaiter(s: SemaphoreState, caller: int): SemaphoreState = { ...s, aborted: s.aborted.union(Set(caller)), queuedAbort: if (s.waiters.some(w => w.id == caller)) s.queuedAbort.union(Set(caller)) else s.queuedAbort }
pure def canCancelListener(s: SemaphoreState, caller: int): bool = s.aborted.contains(caller) and s.waiters.some(w => w.id == caller)
pure def cancelListener(s: SemaphoreState, caller: int): SemaphoreState = { ...s, waiters: s.waiters.select(w => w.id != caller), rejected: s.rejected.union(Set(caller)) }
pure def canRelease(s: SemaphoreState, caller: int): bool = s.holders.contains(caller)
pure def release(s: SemaphoreState, caller: int): SemaphoreState = {
  val live = s.waiters.select(w => not(s.aborted.contains(w.id)))
  val selected = live.nthOr(0, {id: 0, ticket: s.nextTicket})
  val skipped = s.waiters.select(w => w.ticket < selected.ticket).foldl(Set(), (ids, w) => ids.union(Set(w.id)))
  { ...s, available: if (live.length() == 0) s.available + 1 else s.available,
    holders: if (live.length() == 0) s.holders.exclude(Set(caller)) else s.holders.exclude(Set(caller)).union(Set(selected.id)),
    completed: s.completed.union(Set(caller)), granted: if (live.length() == 0) s.granted else s.granted.append(selected), rejected: s.rejected.union(skipped),
    waiters: if (live.length() == 0) List() else s.waiters.select(w => w.ticket > selected.ticket) }
}
pure def alwaysCancelledQueuedNeverOwns(s: SemaphoreState): bool = s.queuedAbort.intersect(s.holders).size() == 0 and s.queuedAbort.intersect(s.completed).size() == 0
pure def alwaysTerminalCallersDoNotWait(s: SemaphoreState): bool = s.waiters.every(w => not(s.rejected.contains(w.id)) and not(s.completed.contains(w.id)))
pure def sometimesAbortListenerRaceSettles(s: SemaphoreState): bool = s.queuedAbort.size() > 0 and s.rejected.intersect(s.queuedAbort).size() > 0 and s.waiters.length() == 0
pure def alwaysFIFOGrants(s: SemaphoreState): bool = s.waiters.every(w => s.granted.every(g => g.ticket < w.ticket))
pure def sometimesAllPermitsReturned(s: SemaphoreState): bool = s.completed.size() > 0 and s.available == s.capacity
```

### Every queued caller eventually acquires or is rejected under fair release

Permit holders eventually release, and cancellation listeners eventually run. FIFO admission gives each already queued caller an outcome.

```quint
pure val fair_release = "weak"
pure val fair_cancelListener = "weak"
pure def leadsToWaiterServed(s: SemaphoreState, later: SemaphoreState): bool = s.waiters.every(w => later.holders.contains(w.id) or later.completed.contains(w.id) or later.rejected.contains(w.id))
```

### Every occupied semaphore has an enabled release or cancellation step

An empty holder and waiter set is quiescent. Otherwise an existing holder can release or an already aborted waiter can be removed.

```quint
pure def semaphoreQuiescent(s: SemaphoreState): bool = s.holders.size() == 0 and s.waiters.length() == 0
pure def semaphoreProgressEnabled(s: SemaphoreState): bool = s.holders.exists(caller => canRelease(s, caller)) or s.waiters.some(w => canCancelListener(s, w.id))
pure def alwaysSemaphoreDeadlockFree(s: SemaphoreState): bool = semaphoreQuiescent(s) or semaphoreProgressEnabled(s)
pure def alwaysConfiguredSemaphoreHasCapacity(s: SemaphoreState): bool = (s.configured iff s.capacity > 0) and (not(s.configured) implies s.waiters.length() == 0 and s.holders.size() == 0)
```
