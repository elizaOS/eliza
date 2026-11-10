// Runtime boot phases, deferred-task ownership, and idempotent teardown.
// Sources: runtime/boot-pipeline.ts, deferred-boot-owner.ts, process-lifecycle.ts.
// Two task identities abstract arbitrary deferred work; phase 8 is fully booted.
module runtime_lifecycle {
  var s: { phase: int, closing: bool, closed: bool, tasks: Set[int], disposed: int, failed: bool }
  action init = s' = { phase: 0, closing: false, closed: false, tasks: Set(), disposed: 0, failed: false }
  action advance = all { not(s.closing), s.phase < 8, s' = s.with("phase", s.phase + 1) }
  action registerTask(id: int): bool = all { not(s.closing), not(s.tasks.contains(id)), s' = s.with("tasks", s.tasks.union(Set(id))) }
  action settleTask(id: int): bool = all { s.tasks.contains(id), s' = s.with("tasks", s.tasks.exclude(Set(id))) }
  action beginStop = all { not(s.closing), s' = s.with("closing", true) }
  action disposeRuntime = all { s.closing, not(s.closed), s.tasks.size() == 0, s' = s.with("closed", true).with("disposed", s.disposed + 1) }
  action failTeardown = all { s.closing, not(s.closed), s' = s.with("failed", true) }
  action idle = s' = s
  action step = any { advance, registerTask(0), registerTask(1), settleTask(0), settleTask(1), beginStop, disposeRuntime, failTeardown, idle }
  val safety = all { s.phase >= 0, s.phase <= 8, s.disposed <= 1, s.closed implies s.closing, s.closed implies s.tasks.size() == 0, s.closed implies s.disposed == 1 }
  run drainBeforeDisposeTest = init.then(registerTask(0)).then(beginStop).then(settleTask(0)).then(disposeRuntime).expect(s.closed and safety)
  run failureStillDisposesTest = init.then(beginStop).then(failTeardown).then(disposeRuntime).expect(s.failed and s.closed and safety)
  // Old disposal invoked a callback before publishing its shared promise.
  action legacyBeginDispose = all { not(s.closed), s.disposed < 2, s' = s.with("closing", true).with("disposed", s.disposed + 1) }
  action legacyStep = any { legacyBeginDispose, idle }
  run reentrantDisposeWitnessTest = init.then(legacyBeginDispose).then(legacyBeginDispose).expect(not(safety))
}
