// One manager owns one serialized Redis publication queue. Snapshot capture
// happens only after a heartbeat owns that queue; retirement releases the local
// entry only after route removal acknowledges. Redis calls can fail or stall.
// Bounds: one local agent, one replacement owner, and at most three queued jobs.
module agent_routing {
  type State = {
    local: bool, owner: int, serverVisible: bool,
    queue: List[str], active: str, snapshot: bool,
    released: bool, closed: bool, closedCleaned: bool, reassigned: bool
  }
  var s: State
  action init = s' = {
    local: true, owner: 1, serverVisible: true,
    queue: List(), active: "none", snapshot: false,
    released: false, closed: false, closedCleaned: false, reassigned: false
  }
  action heartbeat = all {
    not(s.closed), s.queue.length() < 3,
    s' = s.with("queue", s.queue.append("heartbeat"))
  }
  action retire = all {
    s.queue.length() < 3,
    s' = s.with("queue", s.queue.append("retire"))
  }
  action close = all {
    not(s.closed), s.queue.length() < 3,
    s' = s.with("closed", true).with("queue", s.queue.append("close"))
  }
  action begin = all {
    s.active == "none", s.queue.length() > 0,
    s' = s.with("queue", s.queue.tail())
      .with("active", if (s.queue.head() == "heartbeat" and s.closed) "none" else s.queue.head())
      .with("snapshot", if (s.queue.head() == "heartbeat") s.local else false)
  }
  action published = all {
    s.active == "heartbeat",
    s' = s.with("owner", if (s.snapshot) 1 else s.owner)
      .with("serverVisible", true).with("active", "none")
  }
  action removed = all {
    s.active == "retire",
    s' = s.with("owner", if (s.owner == 1) 0 else s.owner)
      .with("local", false).with("released", true).with("active", "none")
  }
  action closed = all {
    s.active == "close",
    s' = s.with("serverVisible", false).with("closedCleaned", true).with("active", "none")
  }
  // A failed operation keeps the local entry or cleanup intent retryable.
  action failed = all { s.active != "none", s' = s.with("active", "none") }
  action replacement = all {
    s.released,
    s' = s.with("owner", 2).with("reassigned", true)
  }
  action idle = s' = s
  action step = any { heartbeat, retire, close, begin, published, removed, closed, failed, replacement, idle }
  val safety = all {
    s.released implies not(s.local) and s.owner != 1,
    s.closedCleaned implies not(s.serverVisible),
    s.reassigned implies s.owner == 2
  }
  run staleHeartbeatCannotRestoreDeletedRouteTest = init.then(heartbeat).then(begin)
    .then(retire).then(heartbeat).then(published).then(begin).then(removed)
    .then(begin).then(published).expect(s.owner == 0 and safety)
  run failedCleanupRetainsLocalEntryTest = init.then(retire).then(begin).then(failed)
    .expect(s.local and not(s.released) and safety)
  run retriedCleanupReleasesEntryTest = init.then(retire).then(begin).then(failed)
    .then(retire).then(begin).then(removed).expect(not(s.local) and safety)
  run closeFencesQueuedPublicationTest = init.then(heartbeat).then(begin)
    .then(heartbeat).then(close).then(published).then(begin).then(begin).then(closed)
    .expect(s.closedCleaned and not(s.serverVisible) and safety)
  run oldCleanupPreservesReplacementTest = init.then(retire).then(begin).then(removed)
    .then(replacement).then(retire).then(begin).then(removed).expect(s.owner == 2 and safety)
  action legacyUnserializedRemoval = s' = s.with("owner", 0).with("local", false).with("released", true)
  run legacyHeartbeatRaceDetectedTest = init.then(heartbeat).then(begin)
    .then(legacyUnserializedRemoval).then(published).expect(not(safety))
}
