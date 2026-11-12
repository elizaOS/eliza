// Sources: cloud/sdk/native-host/cloud-services.mjs accountAccess/readAccountAccess
// and agent/native-host/gateway.mjs admitMessage/ensureCurrent.
// Three calls and three physical reads, generation/revision 0..2. No tokens,
// provider authorization, network liveness, or TypeScript refinement are proved.
// Revisions prevent joining older reads; only account generation fences replies.
module native_access_coalescing {
  pure val Calls = Set(0, 1, 2)
  pure val Reads = Set(0, 1, 2)
  var s: {
    generation: int, revision: int, cache: int, allocated: int,
    readGeneration: int -> int, readRevision: int -> int, settled: Set[int],
    callRead: int -> int, phase: int -> str,
    joinsCurrentRevision: bool, returnedAtGeneration: int -> int,
    last: str, previousCache: int, lastSettledRead: int
  }
  action init = s' = {
    generation: 0, revision: 0, cache: -1, allocated: 0,
    readGeneration: Reads.mapBy(_ => -1), readRevision: Reads.mapBy(_ => -1),
    settled: Set(), callRead: Calls.mapBy(_ => -1), phase: Calls.mapBy(_ => "idle"),
    joinsCurrentRevision: true, returnedAtGeneration: Calls.mapBy(_ => -1),
    last: "init", previousCache: -1, lastSettledRead: -1
  }
  val cacheMatches = s.cache >= 0 and
    s.readGeneration.get(s.cache) == s.generation and s.readRevision.get(s.cache) == s.revision
  action begin(c: int): bool = all {
    s.phase.get(c) == "idle", cacheMatches or s.allocated < 3,
    { val r = if (cacheMatches) s.cache else s.allocated
      s' = { ...s, cache: r, allocated: if (cacheMatches) s.allocated else s.allocated + 1,
        readGeneration: if (cacheMatches) s.readGeneration else s.readGeneration.set(r, s.generation),
        readRevision: if (cacheMatches) s.readRevision else s.readRevision.set(r, s.revision),
        last: "begin", callRead: s.callRead.set(c, r), phase: s.phase.set(c, "waiting"),
        joinsCurrentRevision: s.joinsCurrentRevision and (s.cache != r or
          (s.readGeneration.get(r) == s.generation and s.readRevision.get(r) == s.revision)) }
    }
  }
  action changeRevision = all { s.revision < 2, s' = { ...s, last: "revision", revision: s.revision + 1 } }
  action changeAccount = all { s.generation < 2, s' = { ...s, last: "account", generation: s.generation + 1 } }
  action settle(r: int): bool = all {
    r < s.allocated, not(s.settled.contains(r)),
    s' = { ...s, settled: s.settled.union(Set(r)),
      cache: if (s.cache == r) -1 else s.cache,
      last: "settle", previousCache: s.cache, lastSettledRead: r }
  }
  // The transport deadline aborts headers/body and settles the matching shared read.
  // Timer scheduling and elapsed milliseconds remain environment assumptions.
  action deadline(r: int): bool = settle(r)
  action deliver(c: int): bool = all {
    s.phase.get(c) == "waiting", s.settled.contains(s.callRead.get(c)),
    { val current = s.readGeneration.get(s.callRead.get(c)) == s.generation
      s' = { ...s, phase: s.phase.set(c, if (current) "delivered" else "rejected"),
        last: "deliver", returnedAtGeneration: s.returnedAtGeneration.set(c, s.generation) }
    }
  }
  // A real transition that records any incorrect cache clear for a successor.
  action legacySettleClearsSuccessor(r: int): bool = all {
    r < s.allocated, not(s.settled.contains(r)), s.cache >= 0, s.cache != r,
    s' = { ...s, settled: s.settled.union(Set(r)), cache: -1,
      last: "settle", previousCache: s.cache, lastSettledRead: r }
  }
  action legacyJoinOldRevision(c: int): bool = all {
    s.phase.get(c) == "idle", s.cache >= 0, not(cacheMatches),
    s' = { ...s, callRead: s.callRead.set(c, s.cache), phase: s.phase.set(c, "waiting"),
      joinsCurrentRevision: s.joinsCurrentRevision and
        (s.readGeneration.get(s.cache) == s.generation and s.readRevision.get(s.cache) == s.revision) }
  }
  action step = any {
    { nondet c = Calls.oneOf(); any { begin(c), deliver(c) } },
    { nondet r = Reads.oneOf(); any { settle(r), deadline(r) } }, changeRevision, changeAccount, s' = s
  }
  val safety = all {
    s.joinsCurrentRevision,
    (s.last == "settle" and s.previousCache != s.lastSettledRead) implies s.cache == s.previousCache,
    s.cache >= -1 and s.cache < s.allocated,
    s.cache >= 0 implies not(s.settled.contains(s.cache)),
    Calls.forall(c => s.phase.get(c) == "delivered" implies
      s.readGeneration.get(s.callRead.get(c)) == s.returnedAtGeneration.get(c))
  }
  run concurrentCallsShareOneReadTest = init.then(begin(0)).then(begin(1))
    .expect(s.allocated == 1 and s.callRead.get(0) == s.callRead.get(1) and safety)
  run revisionChangeStartsFreshReadTest = init.then(begin(0)).then(changeRevision).then(begin(1))
    .expect(s.allocated == 2 and s.callRead.get(0) != s.callRead.get(1) and safety)
  run oldFinallyCannotClearSuccessorTest = init.then(begin(0)).then(changeRevision)
    .then(begin(1)).then(settle(0)).then(begin(2))
    .expect(s.allocated == 2 and s.cache == 1 and s.callRead.get(2) == 1 and safety)
  run accountChangeRejectsPendingReadTest = init.then(begin(0)).then(changeAccount)
    .then(settle(0)).then(deliver(0)).expect(s.phase.get(0) == "rejected" and safety)
  run stalledReadDeadlineAllowsRetryTest = init.then(begin(0)).then(begin(1))
    .then(deadline(0)).then(begin(2)).expect(s.allocated == 2 and s.cache == 1 and safety)
  run settledReadIsNotCachedTest = init.then(begin(0)).then(settle(0)).then(begin(1))
    .expect(s.allocated == 2 and safety)
  run staleRevisionJoinDetectedTest = init.then(begin(0)).then(changeRevision)
    .then(legacyJoinOldRevision(1)).expect(not(safety))
  run legacyFinallyClearDetectedTest = init.then(begin(0)).then(changeRevision)
    .then(begin(1)).then(legacySettleClearsSuccessor(0)).expect(not(safety))
}
