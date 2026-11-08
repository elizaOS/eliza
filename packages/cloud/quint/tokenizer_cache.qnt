// Source: plugins/plugin-elizacloud/src/models/tokenization.ts, PR #39051.
// One retained cache slot, two encoding kinds, three loads and two callers.
// Timer cancellation is atomic, as for callbacks in one JS event loop. Rank
// module bytes, BPE correctness, GC, elapsed milliseconds and liveness are not proved.
module tokenizer_cache {
  pure val Callers = Set(0, 1)
  pure val Loads = Set(0, 1, 2)
  var s: {
    cache: int, allocated: int, encoding: int -> int, status: int -> str,
    callLoad: int -> int, wanted: int -> int, result: int -> int, phase: int -> str,
    event: str, previousCache: int, completed: int
  }
  action init = s' = {
    cache: -1, allocated: 0, encoding: Loads.mapBy(_ => -1), status: Loads.mapBy(_ => "unused"),
    callLoad: Callers.mapBy(_ => -1), wanted: Callers.mapBy(_ => -1),
    result: Callers.mapBy(_ => -1), phase: Callers.mapBy(_ => "idle"),
    event: "init", previousCache: -1, completed: -1
  }
  def matches(e: int): bool = s.cache >= 0 and s.encoding.get(s.cache) == e
  action request(c: int, e: int): bool = all {
    s.phase.get(c) == "idle", matches(e) or s.allocated < 3,
    { val n = if (matches(e)) s.cache else s.allocated
      s' = { ...s, cache: n, allocated: if (matches(e)) s.allocated else s.allocated + 1,
        encoding: if (matches(e)) s.encoding else s.encoding.set(n, e),
        status: if (matches(e)) s.status else s.status.set(n, "pending"),
        callLoad: s.callLoad.set(c, n), wanted: s.wanted.set(c, e), phase: s.phase.set(c, "waiting"), event: "request" }
    }
  }
  action resolve(n: int): bool = all {
    s.status.get(n) == "pending", s' = { ...s, status: s.status.set(n, "ready"), event: "resolve" }
  }
  action reject(n: int): bool = all {
    s.status.get(n) == "pending",
    s' = { ...s, status: s.status.set(n, "failed"), cache: if (s.cache == n) -1 else s.cache,
      event: "reject", previousCache: s.cache, completed: n }
  }
  action idleTimeout(n: int): bool = all {
    s.cache == n, s' = { ...s, cache: -1, event: "timeout" }
  }
  action observe(c: int): bool = all {
    s.phase.get(c) == "waiting", s.status.get(s.callLoad.get(c)) != "pending",
    { val ok = s.status.get(s.callLoad.get(c)) == "ready"
      s' = { ...s, phase: s.phase.set(c, if (ok) "returned" else "failed"),
        result: s.result.set(c, if (ok) s.encoding.get(s.callLoad.get(c)) else -1), event: "observe" }
    }
  }
  action legacyRejectClearsNewLoad(n: int): bool = all {
    s.status.get(n) == "pending", s.cache != n, s.cache >= 0,
    s' = { ...s, status: s.status.set(n, "failed"), cache: -1,
      event: "reject", previousCache: s.cache, completed: n }
  }
  action step = any {
    { nondet c = Callers.oneOf(); nondet e = Set(0, 1).oneOf(); any { request(c, e), observe(c) } },
    { nondet n = Loads.oneOf(); any { resolve(n), reject(n), idleTimeout(n) } }, s' = s
  }
  val safety = all {
    (s.event == "reject" and s.previousCache != s.completed) implies s.cache == s.previousCache,
    Callers.forall(c => s.phase.get(c) == "returned" implies s.result.get(c) == s.wanted.get(c)),
    s.cache >= -1 and s.cache < s.allocated,
    s.cache >= 0 implies s.status.get(s.cache) != "failed"
  }
  run pendingSameEncodingIsSharedTest = init.then(request(0, 0)).then(request(1, 0))
    .expect(s.allocated == 1 and s.callLoad.get(0) == s.callLoad.get(1) and safety)
  run oldFailureKeepsReplacementTest = init.then(request(0, 0)).then(request(1, 1)).then(reject(0))
    .expect(s.cache == 1 and safety)
  run replacementDoesNotChangeCallerEncodingTest = init.then(request(0, 0)).then(request(1, 1))
    .then(resolve(0)).then(observe(0)).expect(s.result.get(0) == 0 and s.cache == 1 and safety)
  run timeoutAllowsFreshLoadTest = init.then(request(0, 0)).then(idleTimeout(0)).then(request(1, 0))
    .expect(s.allocated == 2 and safety)
  run failedCurrentLoadIsReleasedTest = init.then(request(0, 0)).then(reject(0)).then(request(1, 0))
    .expect(s.cache == 1 and safety)
  run staleRejectionBugIsDetectedTest = init.then(request(0, 0)).then(request(1, 1))
    .then(legacyRejectClearsNewLoad(0)).expect(not(safety))
}
