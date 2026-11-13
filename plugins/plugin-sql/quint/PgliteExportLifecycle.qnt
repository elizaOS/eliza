// pglite/manager.ts acquireDataDirExportLease, withLifecycleLock and close.
// One data-directory owner, two exporters and a closer. Query exclusivity is
// nested inside the lifecycle mutex. Archive consumption retains its lease.
module PgliteExportLifecycle {
  pure val Exporters = Set("first", "second")
  pure val None = "none"
  type State = {
    shuttingDown: bool, ready: bool, closed: bool, dataDirOwned: bool,
    lease: str, mutex: str, queryOwner: str, queue: List[str],
    phase: str -> str, closePhase: str
  }
  var s: State
  action init = s' = {
    shuttingDown: false, ready: false, closed: false, dataDirOwned: true,
    lease: None, mutex: None, queryOwner: None, queue: List(),
    phase: Exporters.mapBy(_ => "idle"), closePhase: "idle"
  }
  action Ready = all { not(s.ready), s' = { ...s, ready: true } }
  action RequestExport(e: str): bool = all {
    s.phase.get(e) == "idle",
    if (s.shuttingDown or s.lease != None) s' = { ...s, phase: s.phase.set(e, "refused") }
    else s' = { ...s, lease: e, queue: s.queue.append(e), phase: s.phase.set(e, "queued") }
  }
  action RequestClose = all {
    s.closePhase == "idle",
    s' = { ...s, shuttingDown: true, queue: s.queue.append("close"), closePhase: "queued" }
  }
  action Acquire = all {
    s.mutex == None, s.queue.length() > 0,
    { val owner = s.queue.head()
      s' = { ...s, mutex: owner, queue: s.queue.tail(),
        phase: if (Exporters.contains(owner)) s.phase.set(owner, "waitReady") else s.phase,
        closePhase: if (owner == "close") "waitLease" else s.closePhase }
    }
  }
  action BeginDump(e: str): bool = all {
    s.mutex == e, s.phase.get(e) == "waitReady", s.ready,
    s' = { ...s, queryOwner: e, phase: s.phase.set(e, "dumping") }
  }
  action EndDump(e: str): bool = {
    nondet success = Set(true, false).oneOf()
    all {
      s.mutex == e, s.phase.get(e) == "dumping",
      s' = { ...s, mutex: None, queryOwner: None,
        lease: if (success) e else None, phase: s.phase.set(e, if (success) "retained" else "failed") }
    }
  }
  action ReleaseArchive(e: str): bool = all {
    s.phase.get(e) == "retained",
    s' = { ...s, lease: if (s.lease == e) None else s.lease, phase: s.phase.set(e, "released") }
  }
  action BeginClose = all {
    s.mutex == "close", s.closePhase == "waitLease", s.lease == None, s.ready,
    s' = { ...s, queryOwner: "close", closePhase: "closing" }
  }
  action EndClose = all {
    s.closePhase == "closing",
    s' = { ...s, closed: true, dataDirOwned: false, mutex: None, queryOwner: None, closePhase: "done" }
  }
  action step = any {
    Ready, RequestClose, Acquire, BeginClose, EndClose,
    { nondet e = Exporters.oneOf()
      any { RequestExport(e), BeginDump(e), EndDump(e), ReleaseArchive(e) } }, s' = s
  }
  // The source deliberately waits forever when an archive consumer retains
  // its lease. Progress assumes readiness and each consumer eventually settle.
  temporal Fairness = and {
    Ready.weakFair(s), Acquire.weakFair(s), BeginClose.weakFair(s), EndClose.weakFair(s),
    Exporters.forall(e => BeginDump(e).weakFair(s) and EndDump(e).weakFair(s) and ReleaseArchive(e).weakFair(s))
  }
  temporal CloseCompletes = Fairness.implies(s.shuttingDown.leadsTo(s.closed))
  val NoReleaseDuringArchiveUse = (s.lease != None).implies(s.dataDirOwned and not(s.closed))
  val QueryInsideLifecycle = (s.queryOwner != None).implies(s.mutex == s.queryOwner)
  val ExportOwnerUnique = Exporters.filter(e => Set("queued", "waitReady", "dumping", "retained").contains(s.phase.get(e))).size() <= 1
  val CloseRespectsExport = Set("closing", "done").contains(s.closePhase).implies(s.lease == None)
  val NoQueryAfterClose = s.closed.implies(s.queryOwner == None and s.mutex == None)
}
