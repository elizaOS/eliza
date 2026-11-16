# Cache and circuit infrastructure

The cloud's shared cache client protects every caller from a failing cache
backend with a circuit breaker, reports deletions it could not confirm,
and refreshes stale values in the background with one loader per key.

## Story: Keep serving when the cache backend fails

> As an operator, when the cache backend fails the cloud stops waiting on
> it for a cooldown, keeps answering from the source of truth, retries the
> backend only after the cooldown has really elapsed, and never tells a
> caller that a value was deleted when it does not know.

### After repeated failures the breaker refuses backend commands until a cooldown measured in elapsed time has passed

Two failures open the breaker. While it is cooling, reads report the
cache unavailable and deletions report an unconfirmed deletion, without a
backend command. The cooldown is measured on the host's monotonic clock; a
wall-clock jump neither shortens nor extends it. After the cooldown the
next command or probe half-opens the breaker; a success closes it.

```quint
type CacheOp = CacheRead | CacheBadRead | CacheDelete
type CacheReply = NoReply | ReplyPending | ReplyHit | ReplyMiss | ReplyError | ReplyUnavailable | DeleteConfirmed | DeleteUnconfirmed | DeleteUnconfigured
type PendingOp = { slot: int, op: CacheOp }
type Delivery = { load: int, delivery: DeliveryState }
type DeliveryState = DeliveryPending | DeliveryWriting | DeliveryReady | DeliveryFailed | DeliveryTimedOut
type Cache = {
  configured: bool, present: bool, elapsed: int, wall: int, failures: int, lastFailure: int, pending: List[PendingOp], reply: CacheReply, reopenedAfterCooldown: bool,
  allocated: int, owner: int, active: List[int], timers: List[int], deliveries: List[Delivery], published: List[int], timedOut: List[int]
}
pure val failureThreshold = 2
pure val cooldown = 2
pure val initial: Cache = {
  configured: true, present: true, elapsed: 0, wall: 0, failures: 0, lastFailure: 0, pending: List(), reply: NoReply, reopenedAfterCooldown: true,
  allocated: 0, owner: 0, active: List(), timers: List(), deliveries: List(), published: List(), timedOut: List()
}
pure def cooling(c: Cache): bool = c.failures >= failureThreshold and c.elapsed - c.lastFailure <= cooldown
pure def opAt(c: Cache, slot: int): PendingOp = c.pending.select(p => p.slot == slot).nthOr(0, { slot: 0, op: CacheRead })
pure def busy(c: Cache, slot: int): bool = c.pending.some(p => p.slot == slot)
pure val slotValues = Set(1, 2)
pure val wallValues = Set(0, 3, 9)
pure def canTick(c: Cache): bool = true
pure def tick(c: Cache): Cache = { ...c, elapsed: c.elapsed + 1 }
pure def canSetWall(c: Cache, wall: int): bool = true
pure def setWall(c: Cache, wall: int): Cache = { ...c, wall: wall }
pure def canBeginOp(c: Cache, slot: int, op: CacheOp): bool = slot > 0 and not(busy(c, slot))
pure def beginOp(c: Cache, slot: int, op: CacheOp): Cache =
  if (not(c.configured)) { ...c, reply: if (op == CacheDelete) DeleteUnconfigured else ReplyUnavailable }
  else if (cooling(c)) { ...c, reply: if (op == CacheDelete) DeleteUnconfirmed else ReplyUnavailable }
  else { ...c, failures: if (c.failures >= failureThreshold) 0 else c.failures, reopenedAfterCooldown: c.reopenedAfterCooldown and (c.failures < failureThreshold or c.elapsed - c.lastFailure > cooldown), pending: c.pending.append({ slot: slot, op: op }), reply: ReplyPending }
pure def canProbeBackend(c: Cache): bool = c.configured and c.failures >= failureThreshold and not(cooling(c))
pure def probeBackend(c: Cache): Cache = { ...c, failures: 0, reply: NoReply, reopenedAfterCooldown: c.reopenedAfterCooldown and c.elapsed - c.lastFailure > cooldown }
pure def alwaysReopenedOnlyAfterCooldown(c: Cache): bool = c.reopenedAfterCooldown
pure def stepWallClockDoesNotMoveTheBreaker(before: Cache, via: str, after: Cache): bool = via == "setWall" implies (cooling(after) == cooling(before) and after.failures == before.failures)
pure def sometimesBreakerCooling(c: Cache): bool = cooling(c) and c.reply == ReplyUnavailable
```

### A deletion is reported confirmed only when the backend acknowledged it

A backend command can settle after the breaker opened. A failed command
counts towards the breaker. A deletion whose reply was lost may have been
applied; it is still reported unconfirmed. A cache with no backend issues
no command, and reports a deletion as having nothing to delete.

```quint
pure def canOpFails(c: Cache, slot: int): bool = busy(c, slot)
pure def opFails(c: Cache, slot: int): Cache =
  { ...c, pending: c.pending.select(p => p.slot != slot), failures: c.failures + 1, lastFailure: c.elapsed, reply: if (opAt(c, slot).op == CacheDelete) DeleteUnconfirmed else ReplyError }
pure def canOpSucceeds(c: Cache, slot: int): bool = busy(c, slot) and opAt(c, slot).op != CacheBadRead
pure def opSucceeds(c: Cache, slot: int): Cache = {
  val op = opAt(c, slot).op
  val hit = op == CacheRead and c.present
  { ...c, pending: c.pending.select(p => p.slot != slot), present: if (op == CacheDelete) false else c.present, failures: if (op == CacheDelete or hit) 0 else c.failures,
    reply: if (op == CacheDelete) DeleteConfirmed else if (hit) ReplyHit else ReplyMiss }
}
pure def canLoseDeleteReply(c: Cache, slot: int): bool = busy(c, slot) and opAt(c, slot).op == CacheDelete
pure def loseDeleteReply(c: Cache, slot: int): Cache = { ...c, pending: c.pending.select(p => p.slot != slot), present: false, failures: c.failures + 1, lastFailure: c.elapsed, reply: DeleteUnconfirmed }
pure def canDetachBackend(c: Cache): bool = c.configured and c.pending.length() == 0
pure def detachBackend(c: Cache): Cache = { ...c, configured: false, present: false, reply: NoReply }
pure def alwaysConfirmedDeletionHasBackendAbsence(c: Cache): bool = c.reply == DeleteConfirmed implies (c.configured and not(c.present))
pure def alwaysUnconfiguredDeletionHasNoBackend(c: Cache): bool = c.reply == DeleteUnconfigured implies (not(c.configured) and not(c.present))
pure def alwaysNoCommandWithoutBackend(c: Cache): bool = not(c.configured) implies c.pending.length() == 0
pure def sometimesLostDeleteUnconfirmed(c: Cache): bool = c.reply == DeleteUnconfirmed and not(c.present)
```

## Story: Serve a stale value while one loader refreshes it

> As a caller, I get the stale value at once while one background loader
> refreshes the key; a loader that hangs keeps the key from being loaded
> twice, and a value that arrives after my wait expired is not handed to me.

### One loader owns a stale key until it settles, and a value is either delivered or timed out, never both

A stale read starts a loader only when nobody owns the key; later reads
share it. The caller's wait can expire before the loader settles; the
loader keeps ownership until it resolves or rejects, its result is
published, and only then is ownership released. Settling the loader
clears its timer.

```quint
pure val nValues = Set(1, 2, 3)
pure def deliveryOf(c: Cache, n: int): DeliveryState = c.deliveries.select(d => d.load == n).nthOr(0, { load: 0, delivery: DeliveryFailed }).delivery
pure def setDelivery(c: Cache, n: int, st: DeliveryState): List[Delivery] = c.deliveries.listMap(d => if (d.load == n) { load: n, delivery: st } else d)
pure def canStaleRead(c: Cache): bool = c.owner == 0
pure def staleRead(c: Cache): Cache = {
  val n = c.allocated + 1
  { ...c, allocated: n, owner: n, active: c.active.append(n), timers: c.timers.append(n), deliveries: c.deliveries.append({ load: n, delivery: DeliveryPending }) }
}
pure def canLoaderSettles(c: Cache, n: int, resolved: bool): bool = c.active.includes(n)
pure def loaderSettles(c: Cache, n: int, resolved: bool): Cache =
  { ...c, active: c.active.select(x => x != n), timers: c.timers.select(x => x != n),
    deliveries: if (deliveryOf(c, n) == DeliveryPending) setDelivery(c, n, if (resolved) DeliveryWriting else DeliveryFailed) else c.deliveries }
pure def canDeliveryExpires(c: Cache, n: int): bool = c.timers.includes(n) and deliveryOf(c, n) == DeliveryPending
pure def deliveryExpires(c: Cache, n: int): Cache = { ...c, timers: c.timers.select(x => x != n), deliveries: setDelivery(c, n, DeliveryTimedOut), timedOut: c.timedOut.append(n) }
pure def canPublishLoad(c: Cache, n: int): bool = deliveryOf(c, n) == DeliveryWriting and c.deliveries.some(d => d.load == n)
pure def publishLoad(c: Cache, n: int): Cache = { ...c, deliveries: setDelivery(c, n, DeliveryReady), published: c.published.append(n) }
pure def canReleaseKey(c: Cache, n: int): bool = c.owner == n and n > 0 and not(c.active.includes(n)) and (deliveryOf(c, n) == DeliveryTimedOut or deliveryOf(c, n) == DeliveryFailed or deliveryOf(c, n) == DeliveryReady)
pure def releaseKey(c: Cache, n: int): Cache = { ...c, owner: 0 }
pure def alwaysOneActiveLoader(c: Cache): bool = c.active.length() <= 1 and c.active.every(n => c.owner == n)
pure def alwaysTimersBelongToActiveLoaders(c: Cache): bool = c.timers.every(n => c.active.includes(n))
pure def alwaysDeliveredOrTimedOutNotBoth(c: Cache): bool = c.published.every(n => not(c.timedOut.includes(n)))
pure def alwaysWritingLoaderOwnsKey(c: Cache): bool = c.deliveries.every(d => d.delivery == DeliveryWriting implies c.owner == d.load)
pure def sometimesTimedOutLoaderStillOwns(c: Cache): bool = c.owner > 0 and deliveryOf(c, c.owner) == DeliveryTimedOut and c.active.includes(c.owner)
pure def sometimesRefreshPublished(c: Cache): bool = c.published.length() > 0 and c.owner == 0
```
