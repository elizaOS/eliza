// Two-tier tool cache with two descriptor versions and bounded TTL time classes.
// Sources: runtime/tool-call-cache/{cache,disk-store,lru,key,redact,registry}.ts.
// Hash collisions are excluded; disk writes atomically replace one complete entry.
// Invalidation is a deletion, not cancellation: outstanding calls may repopulate.
// Noncacheable calls are pass-through here; concrete effect execution is tested in code.
module runtime_cache {
  var s: { requested: int, memory: int, disk: int, inflight: Set[int], expired: bool, hit: int, executions: int }
  action init = s' = { requested: 0, memory: -1, disk: -1, inflight: Set(), expired: false, hit: -1, executions: 0 }
  action selectVersion(version: int): bool = s' = s.with("requested", version).with("hit", -1)
  action miss = all { not(s.inflight.contains(s.requested)), s.executions < 2, s' = s.with("inflight", s.inflight.union(Set(s.requested))).with("executions", s.executions + 1).with("hit", -1) }
  action complete(version: int): bool = all { s.inflight.contains(version), s' = s.with("inflight", s.inflight.exclude(Set(version))).with("memory", version).with("disk", version).with("expired", false).with("hit", -1) }
  action failCall(version: int): bool = all { s.inflight.contains(version), s' = s.with("inflight", s.inflight.exclude(Set(version))) }
  action lookup = all { not(s.expired), s.disk == s.requested, s' = s.with("memory", s.disk).with("hit", s.disk) }
  action expire = s' = s.with("expired", true).with("hit", -1)
  action invalidate = s' = s.with("memory", -1).with("disk", -1).with("hit", -1)
  action bypassSideEffect = s' = s.with("hit", -1)
  action idle = s' = s
  action step = any { selectVersion(0), selectVersion(1), miss, complete(0), complete(1), failCall(0), failCall(1), lookup, expire, invalidate, bypassSideEffect, idle }
  val safety = all { s.hit != -1 implies all { s.hit == s.requested, not(s.expired) }, s.inflight.size() <= 2, s.executions <= 2 }
  run versionMismatchNeverHitsTest = init.then(miss).then(complete(0)).then(selectVersion(1)).expect(s.disk != s.requested and safety)
  run failureReleasesSingleFlightTest = init.then(miss).then(failCall(0)).then(miss).then(complete(0)).then(lookup).expect(safety and s.hit == 0)
  run deletionDoesNotCancelExecutionTest = init.then(miss).then(invalidate).then(complete(0)).then(lookup).expect(safety and s.hit == 0)
}
