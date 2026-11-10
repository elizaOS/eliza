// stores/task-wake.ts atomic SQL patch. Two callers capture revisions and
// consume them after new wake requests, including a combined consume/request.
module TaskWake {
  pure val Clients = Set("one", "two")
  pure val Times = Set(1, 2, 3)
  type State = {
    revision: int, wakeAt: int, observed: str -> int, reads: Set[str],
    requests: int, expected: Set[int], failures: int
  }
  var s: State
  // wakeAt == 0 means the JSON field is absent.
  action init = s' = { revision: 0, wakeAt: 0, observed: Clients.mapBy(_ => 0), reads: Set(), requests: 0, expected: Set(), failures: 0 }
  action Read(c: str): bool = all {
    not(s.reads.contains(c)),
    s' = { ...s, observed: s.observed.set(c, s.revision), reads: s.reads.union(Set(c)) }
  }
  action Request(at: int): bool = all {
    s.requests < 3,
    s' = { ...s, revision: s.revision + 1, requests: s.requests + 1,
      wakeAt: if (s.wakeAt == 0 or at < s.wakeAt) at else s.wakeAt,
      expected: s.expected.union(Set(at)) }
  }
  action Consume(c: str): bool = all {
    s.reads.contains(c),
    if (s.observed.get(c) == s.revision)
      s' = { ...s, wakeAt: 0, expected: Set(), reads: s.reads.exclude(Set(c)) }
    else s' = { ...s, reads: s.reads.exclude(Set(c)) }
  }
  action ConsumeAndRequest(c: str, at: int): bool = all {
    s.reads.contains(c), s.requests < 3,
    { val retained = if (s.observed.get(c) == s.revision) 0 else s.wakeAt
      val outstanding = if (s.observed.get(c) == s.revision) Set() else s.expected
      s' = { ...s, revision: s.revision + 1, requests: s.requests + 1,
        wakeAt: if (retained == 0 or at < retained) at else retained,
        expected: outstanding.union(Set(at)), reads: s.reads.exclude(Set(c)) }
    }
  }
  action ReplaceMetadata = s' = s
  action InvalidInput = all { s.failures < 1, s' = { ...s, failures: s.failures + 1 } }
  action step = any {
    { nondet c = Clients.oneOf()
      any { Read(c), Consume(c) } },
    { nondet at = Times.oneOf()
      any { Request(at), { nondet c = Clients.oneOf()
        ConsumeAndRequest(c, at) } } }, ReplaceMetadata, InvalidInput
  }
  val RevisionMonotonic = s.revision == s.requests
  val EarliestOutstandingWake = if (s.expected.size() == 0) s.wakeAt == 0
    else s.expected.contains(s.wakeAt) and s.expected.forall(at => s.wakeAt <= at)
  val TypeOK = s.revision >= 0 and s.revision <= 3 and Times.union(Set(0)).contains(s.wakeAt) and s.expected.subseteq(Times)
}
