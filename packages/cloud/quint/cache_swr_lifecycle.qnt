// Source: cloud/shared/src/lib/cache/client.ts getWithSWR.
// One stale cache key, three sequential background loaders. Delivery expiry,
// loader completion, cache publication and ownership release are separate.
// A permanently hung uncancellable loader retains ownership indefinitely.
// Loaders do not recursively await a cold read of the same owned key; in-tree
// SWR callers delegate to leaf database queries or provider catalog reads.
// Cold-only loads are not coalesced; cross-process ownership, cache failures,
// invalidation and elapsed wall time are not proved by this model.
module cache_swr_lifecycle {
  pure val Loads = Set(0, 1, 2)
  var s: {
    allocated: int, owner: int, active: Set[int], timers: Set[int],
    delivery: int -> str, published: Set[int], timedOut: Set[int], last: str
  }
  action init = s' = {
    allocated: 0, owner: -1, active: Set(), timers: Set(),
    delivery: Loads.mapBy(_ => "unused"), published: Set(), timedOut: Set(), last: "init"
  }
  action staleRead = all {
    s.owner == -1, s.allocated < 3,
    s' = { ...s, allocated: s.allocated + 1, owner: s.allocated,
      active: s.active.union(Set(s.allocated)), timers: s.timers.union(Set(s.allocated)),
      delivery: s.delivery.set(s.allocated, "pending"), last: "start" }
  }
  action readWhileOwned = all { s.owner >= 0, s' = { ...s, last: "coalesced" } }
  action loaderResolves(n: int): bool = all {
    s.active.contains(n),
    s' = { ...s, active: s.active.exclude(Set(n)), timers: s.timers.exclude(Set(n)),
      delivery: if (s.delivery.get(n) == "pending") s.delivery.set(n, "writing") else s.delivery,
      last: "resolved" }
  }
  action loaderRejects(n: int): bool = all {
    s.active.contains(n),
    s' = { ...s, active: s.active.exclude(Set(n)), timers: s.timers.exclude(Set(n)),
      delivery: if (s.delivery.get(n) == "pending") s.delivery.set(n, "failed") else s.delivery,
      last: "rejected" }
  }
  action deliveryExpires(n: int): bool = all {
    s.timers.contains(n), s.delivery.get(n) == "pending",
    s' = { ...s, timers: s.timers.exclude(Set(n)), delivery: s.delivery.set(n, "timeout"),
      timedOut: s.timedOut.union(Set(n)), last: "timeout" }
  }
  action publish(n: int): bool = all {
    s.delivery.get(n) == "writing",
    s' = { ...s, delivery: s.delivery.set(n, "ready"), published: s.published.union(Set(n)),
      last: "published" }
  }
  action release(n: int): bool = all {
    s.owner == n, not(s.active.contains(n)),
    Set("timeout", "failed", "ready").contains(s.delivery.get(n)),
    s' = { ...s, owner: -1, last: "released" }
  }
  // Negative witnesses for the two former resource bugs; excluded from step.
  action legacyReleaseAtTimeout(n: int): bool = all {
    s.owner == n, s.delivery.get(n) == "timeout",
    s' = { ...s, owner: -1, last: "legacyRelease" }
  }
  action legacyResolveKeepsTimer(n: int): bool = all {
    s.active.contains(n), s.delivery.get(n) == "pending",
    s' = { ...s, active: s.active.exclude(Set(n)), delivery: s.delivery.set(n, "writing"),
      last: "legacyTimer" }
  }
  action step = any {
    staleRead, readWhileOwned,
    { nondet n = Loads.oneOf(); any {
      loaderResolves(n), loaderRejects(n), deliveryExpires(n), publish(n), release(n)
    } },
    s' = s
  }
  val safety = all {
    s.active.size() <= 1,
    s.active.forall(n => s.owner == n),
    s.timers.subseteq(s.active),
    s.published.intersect(s.timedOut) == Set(),
    s.delivery.keys().forall(n => s.delivery.get(n) == "writing" implies s.owner == n),
    s.owner >= -1 and s.owner < s.allocated
  }
  run pendingReadsCoalesceTest = init.then(staleRead).then(readWhileOwned)
    .expect(s.allocated == 1 and safety)
  run timeoutRetainsLoaderOwnershipTest = init.then(staleRead).then(deliveryExpires(0))
    .then(readWhileOwned).expect(s.owner == 0 and s.active == Set(0) and safety)
  run lateResultCannotPublishTest = init.then(staleRead).then(deliveryExpires(0))
    .then(loaderResolves(0)).then(release(0)).expect(s.published == Set() and safety)
  run successfulLoadClearsTimerTest = init.then(staleRead).then(loaderResolves(0))
    .expect(s.timers == Set() and s.owner == 0 and safety)
  run failedLoadClearsTimerTest = init.then(staleRead).then(loaderRejects(0)).then(release(0))
    .expect(s.timers == Set() and s.owner == -1 and safety)
  run publicationRetainsOwnershipTest = init.then(staleRead).then(loaderResolves(0))
    .then(readWhileOwned).then(publish(0)).then(release(0)).expect(s.published == Set(0) and safety)
  run settledTimedOutLoadAllowsRetryTest = init.then(staleRead).then(deliveryExpires(0))
    .then(loaderRejects(0)).then(release(0)).then(staleRead).expect(s.owner == 1 and safety)
  run formerTimeoutReleaseIsDetectedTest = init.then(staleRead).then(deliveryExpires(0))
    .then(legacyReleaseAtTimeout(0)).then(staleRead).expect(not(safety))
  run formerDetachedTimerIsDetectedTest = init.then(staleRead).then(legacyResolveKeepsTimer(0))
    .expect(not(safety))
}
