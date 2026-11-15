// One exact content/ruleset key and two requests. Admission and processing
// check the same marker, but simultaneous misses do not claim the key.
module PiiScrubSettlement {
  pure val Requests = Set(0, 1)
  pure val MaxAttempts = 4
  type Request = { phase: str, attempts: int, committedAt: int, notice: str }
  var s: { marker: bool, requests: int -> Request }

  action init = s' = {
    marker: false,
    requests: Requests.mapBy(_ => {
      phase: "idle", attempts: 0, committedAt: 0, notice: "none"
    })
  }
  def entry(id: int): Request = s.requests.get(id)
  action update(id: int, request: Request): bool =
    s' = { ...s, requests: s.requests.set(id, request) }

  action submit(id: int): bool = all {
    entry(id).phase == "idle",
    update(id, { ...entry(id), phase: if (s.marker) "deduplicated" else "queued" })
  }
  action beginAttempt(id: int): bool = all {
    entry(id).phase == "queued", entry(id).attempts < MaxAttempts,
    update(id, { ...entry(id), attempts: entry(id).attempts + 1,
      phase: if (s.marker) "deduplicated" else "scrubbing"
    })
  }
  action failAttempt(id: int): bool =
    update(id, { ...entry(id),
      phase: if (entry(id).attempts == MaxAttempts) "failing" else "queued"
    })
  action settleScrub(id: int, ok: bool): bool = all {
    entry(id).phase == "scrubbing",
    if (ok) update(id, { ...entry(id), phase: "marking" }) else failAttempt(id)
  }
  action settleMarker(id: int, confirmed: bool): bool = all {
    entry(id).phase == "marking",
    if (confirmed) s' = { marker: true,
      requests: s.requests.set(id, { ...entry(id),
        phase: "notifying", committedAt: entry(id).attempts
      })
    } else failAttempt(id)
  }
  action settleNotice(id: int, ok: bool): bool = all {
    entry(id).phase == "notifying",
    update(id, { ...entry(id), phase: "done", notice: if (ok) "sent" else "rejected" })
  }
  action settleFailureNotice(id: int): bool = all {
    entry(id).phase == "failing",
    update(id, { ...entry(id), phase: "exhausted" })
  }
  action advance(id: int): bool = any {
    beginAttempt(id), settleFailureNotice(id),
    { nondet ok = Bool.oneOf(); any {
      settleScrub(id, ok), settleMarker(id, ok), settleNotice(id, ok)
    } }
  }
  action step = any {
    { nondet id = Requests.oneOf(); any { submit(id), advance(id) } },
    s' = s
  }

  val CompletionRequiresReceipt = Requests.forall(id =>
    (entry(id).phase == "notifying" or entry(id).notice != "none") implies
      (s.marker and entry(id).committedAt > 0))
  val ConfirmedAttemptCannotRetry = Requests.forall(id =>
    (entry(id).committedAt > 0) implies all {
      entry(id).attempts == entry(id).committedAt,
      entry(id).phase.in(Set("notifying", "done"))
    })
  val NoPrematureExhaustion = Requests.forall(id =>
    entry(id).phase.in(Set("failing", "exhausted")) implies
      (entry(id).attempts == MaxAttempts and entry(id).committedAt == 0))
  val DeduplicationRequiresMarker = Requests.forall(id =>
    (entry(id).phase == "deduplicated") implies s.marker)
  temporal MarkerPersists = always((s.marker implies next(s.marker)).orKeep(s))
  def terminal(id: int): bool = entry(id).phase.in(Set("done", "exhausted", "deduplicated"))
  temporal RequestsSettle = Requests.forall(id =>
    (entry(id).phase != "idle").leadsTo(terminal(id)))
  temporal FairRequestsSettle = Requests.forall(id => advance(id).weakFair(s))
    .implies(RequestsSettle)

  run refusedMarkerRetriesBeforeCompletionTest = init.then(submit(0))
    .then(beginAttempt(0)).then(settleScrub(0, true)).then(settleMarker(0, false))
    .expect(not(s.marker) and entry(0).phase == "queued")
    .then(beginAttempt(0)).then(settleScrub(0, true)).then(settleMarker(0, true))
    .then(settleNotice(0, true)).expect(s.marker and terminal(0) and entry(0).attempts == 2)
  run refusedMarkerCanExhaustWithoutCompletionTest = init.then(submit(0))
    .then(beginAttempt(0)).then(settleScrub(0, true)).then(settleMarker(0, false))
    .then(beginAttempt(0)).then(settleScrub(0, true)).then(settleMarker(0, false))
    .then(beginAttempt(0)).then(settleScrub(0, true)).then(settleMarker(0, false))
    .then(beginAttempt(0)).then(settleScrub(0, true)).then(settleMarker(0, false))
    .then(settleFailureNotice(0))
    .expect(not(s.marker) and entry(0).phase == "exhausted" and entry(0).notice == "none")
  run observerRejectionRetainsReceiptTest = init.then(submit(0)).then(beginAttempt(0))
    .then(settleScrub(0, true)).then(settleMarker(0, true)).then(settleNotice(0, false))
    .then(submit(1)).expect(s.marker and terminal(0) and entry(0).notice == "rejected"
      and entry(0).attempts == 1 and entry(1).phase == "deduplicated")
  run overlappingMissesMayBothCommitTest = init.then(submit(0)).then(submit(1))
    .then(beginAttempt(0)).then(beginAttempt(1)).then(settleScrub(0, true))
    .then(settleMarker(0, true)).then(settleScrub(1, true)).then(settleMarker(1, true))
    .then(settleNotice(0, false)).then(settleNotice(1, true))
    .expect(CompletionRequiresReceipt and terminal(0) and terminal(1))
}
