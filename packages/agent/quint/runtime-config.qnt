// Atomic host configuration persistence and bounded include traversal.
// Sources: config/{config,includes,env-vars,dev-cloud-env-authority}.ts.
// Values abstract two complete documents; fsync/rename atomicity is assumed.
// Include depth two represents the configurable finite depth bound, not its value.
module runtime_config {
  var s: { committed: int, staged: int, phase: str, depth: int, stack: Set[int], rejected: bool }
  action init = s' = { committed: 0, staged: -1, phase: "idle", depth: 0, stack: Set(), rejected: false }
  action stage = all { s.phase == "idle", s' = s.with("staged", 1 - s.committed).with("phase", "writing") }
  action sync = all { s.phase == "writing", s' = s.with("phase", "synced") }
  action commit = all { s.phase == "synced", s' = s.with("committed", s.staged).with("staged", -1).with("phase", "idle") }
  action writeFailed = all { s.phase != "idle", s' = s.with("staged", -1).with("phase", "idle") }
  action include(id: int): bool = all { s.depth < 2, not(s.stack.contains(id)), s' = s.with("depth", s.depth + 1).with("stack", s.stack.union(Set(id))) }
  action leave(id: int): bool = all { s.stack.contains(id), s' = s.with("depth", s.depth - 1).with("stack", s.stack.exclude(Set(id))) }
  action rejectCycle(id: int): bool = all { s.stack.contains(id), s' = s.with("rejected", true) }
  action idle = s' = s
  action step = any { stage, sync, commit, writeFailed, include(0), include(1), leave(0), leave(1), rejectCycle(0), rejectCycle(1), idle }
  val safety = all { Set(0, 1).contains(s.committed), s.depth == s.stack.size(), s.depth <= 2, s.phase == "idle" implies s.staged == -1, s.phase != "idle" implies s.staged != s.committed }
  run failedWritePreservesDocumentTest = init.then(stage).then(writeFailed).expect(s.committed == 0 and safety)
  run atomicPublicationTest = init.then(stage).then(sync).then(commit).expect(s.committed == 1 and safety)
  run circularIncludeRejectsTest = init.then(include(0)).then(rejectCycle(0)).expect(s.rejected and safety)
}
