// Native renderer ownership and last-owner-turn timing publication.
// Two host revisions and two overlapping turns; string IDs do not convey authority.
module api_native {
  var s: { host: int, renderer: bool, stopped: bool, revision: int, latestTurn: int, capturedRevision: int, timingTurn: int, completed: Set[int] }
  action init = s' = { host: 0, renderer: false, stopped: false, revision: 0, latestTurn: 0, capturedRevision: -1, timingTurn: 0, completed: Set() }
  action bindHost(h: int): bool = all { s.host == 0, not(s.stopped), s' = s.with("host", h) }
  action connect = all { s.host != 0, not(s.stopped), not(s.renderer), s' = s.with("renderer", true) }
  action unbind(h: int): bool = if (s.host == h) s' = s.with("host", 0).with("renderer", false) else s' = s
  action stop = s' = s.with("stopped", true).with("renderer", false)
  action capture(t: int): bool = all { t > s.latestTurn, s' = s.with("latestTurn", t).with("capturedRevision", s.revision).with("timingTurn", 0) }
  action complete(t: int): bool = all { not(s.completed.contains(t)), s' = s.with("completed", s.completed.union(Set(t))).with("timingTurn", if (t == s.latestTurn and s.capturedRevision == s.revision) t else s.timingTurn) }
  action rotate = all { s.revision < 2, s' = s.with("revision", s.revision + 1).with("timingTurn", 0) }
  action idle = s' = s
  action step = any { bindHost(1), bindHost(2), connect, unbind(1), unbind(2), stop, capture(1), capture(2), complete(1), complete(2), rotate, idle }
  val safety = all { s.renderer implies (s.host != 0 and not(s.stopped)), s.timingTurn != 0 implies (s.timingTurn == s.latestTurn and s.capturedRevision == s.revision) }
  run olderTurnCannotReplaceNewerTest = init.then(capture(1)).then(capture(2)).then(complete(1)).expect(s.timingTurn == 0).then(complete(2)).expect(s.timingTurn == 2)
  run changedOwnerInvalidatesTimingTest = init.then(capture(1)).then(rotate).then(complete(1)).expect(s.timingTurn == 0)
  run staleHostCannotCloseNewOwnerTest = init.then(bindHost(1)).then(unbind(1)).then(bindHost(2)).then(connect).then(unbind(1)).expect(s.renderer and s.host == 2)
}
