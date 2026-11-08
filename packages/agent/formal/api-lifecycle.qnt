// Agent lifecycle routes and runtime replacement ownership on develop.
// One boot owner, two admitted turns; stop is rejected during start/restart.
// The legacy action is a negative control, deliberately excluded from step.
module api_lifecycle {
  var s: { phase: str, runtime: bool, boot: bool, stopping: bool, active: int, cordoned: bool }
  action init = s' = { phase: "not_started", runtime: false, boot: false, stopping: false, active: 0, cordoned: false }
  action start = all {
    not(s.runtime), not(s.boot), not(s.stopping),
    s' = s.with("phase", "starting").with("boot", true)
  }
  action bootSuccess = all { s.boot, s' = s.with("runtime", true).with("boot", false).with("phase", "running") }
  action bootFailure = all { s.boot, s' = s.with("boot", false).with("phase", "error") }
  action stop = all { not(s.boot), not(s.stopping), s' = if (s.runtime) s.with("stopping", true).with("cordoned", true) else s.with("phase", "stopped") }
  action stopSettles = all { s.stopping, s.active == 0, s' = s.with("stopping", false).with("runtime", false).with("phase", "stopped").with("cordoned", false) }
  action pause = all { s.runtime, not(s.boot), not(s.stopping), s' = s.with("phase", "paused") }
  action resume = all { s.runtime, not(s.boot), not(s.stopping), not(s.cordoned), s' = s.with("phase", "running") }
  action enterTurn = all { s.runtime, s.phase == "running", not(s.cordoned), s.active < 2, s' = s.with("active", s.active + 1) }
  action exitTurn = all { s.active > 0, s' = s.with("active", s.active - 1) }
  action cordon = all { s.runtime, s' = s.with("cordoned", true) }
  action replace = all { s.cordoned, not(s.stopping), s.active == 0, s' = s.with("cordoned", false).with("phase", "running") }
  action legacyResume = s' = s.with("phase", "running")
  action legacyPause = s' = s.with("phase", "paused")
  action idle = s' = s
  action step = any { start, bootSuccess, bootFailure, stop, stopSettles, pause, resume, enterTurn, exitTurn, cordon, replace, idle }
  action legacyStep = any { step, legacyResume, legacyPause }
  val safety = all {
    s.phase == "running" implies s.runtime,
    s.active >= 0, s.active <= 2,
    s.phase.in(Set("not_started", "starting", "running", "paused", "stopped", "error")),
    s.boot implies s.phase == "starting",
    s.stopping implies s.runtime
  }
  run resumeWithoutRuntimeRegressionTest = init.then(legacyResume).expect(not(safety))
  run pauseDuringBootRegressionTest = init.then(start).then(legacyPause).expect(not(safety))
  run stopDrainsRuntimeTest = init.then(start).then(bootSuccess).then(enterTurn).then(stop).then(exitTurn).then(stopSettles).expect(not(s.runtime) and s.phase == "stopped")
  run drainBeforeReplaceTest = init.then(start).then(bootSuccess).then(enterTurn).then(cordon).then(exitTurn).then(replace).expect(safety)
}
