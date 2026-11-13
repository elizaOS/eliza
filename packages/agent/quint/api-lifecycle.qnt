// agent-lifecycle-routes.ts and agent-admin-routes.ts share one live runtime.
// A running-runtime restart retains that runtime while the replacement builds.
// Repeated start requests preserve the pending phase. The replacement closes
// room admission and drains existing turns before publishing. Two active turns
// bound the queue projection. Host disposal and process failures are external.
module api_lifecycle {
  var s: {
    phase: str,
    runtime: bool,
    boot: bool,
    stopping: bool,
    active: int,
    cordoned: bool
  }

  action init = s' = {
    phase: "not_started",
    runtime: false,
    boot: false,
    stopping: false,
    active: 0,
    cordoned: false
  }

  // /start begins one boot when no runtime or other lifecycle owner exists.
  action start = all {
    not(s.runtime),
    not(s.boot),
    not(s.stopping),
    s' = { ...s, phase: "starting", boot: true }
  }

  // /start reports the same pending phase during initial boot or restart.
  action startRetry = all { s.boot, not(s.stopping), s' = s }

  action existingStart = all {
    s.runtime,
    not(s.boot),
    not(s.stopping),
    s' = { ...s, phase: "running" }
  }

  action bootSuccess = all {
    s.phase == "starting",
    s.boot,
    s' = { ...s, runtime: true, boot: false, phase: "running" }
  }

  action bootFailure = all {
    s.phase == "starting",
    s.boot,
    s' = { ...s, boot: false, phase: "error" }
  }

  // The bounded restart case begins from running, retaining the old runtime.
  action restart = all {
    s.runtime,
    s.phase == "running",
    not(s.boot),
    not(s.stopping),
    s' = { ...s, phase: "restarting", boot: true }
  }

  // A build failure before quiescence preserves the previous running runtime.
  action restartFailure = all {
    s.phase == "restarting",
    not(s.cordoned),
    s' = { ...s, phase: "running", boot: false }
  }

  // /stop rejects starting/restarting before any teardown is admitted.
  action stop = all {
    not(s.phase.in(Set("starting", "restarting"))),
    not(s.stopping),
    s' = if (s.runtime)
      { ...s, stopping: true, cordoned: true }
    else
      { ...s, phase: "stopped" }
  }

  action stopSettles = all {
    s.stopping,
    s.active == 0,
    s' = {
      ...s,
      stopping: false,
      runtime: false,
      phase: "stopped",
      cordoned: false
    }
  }

  action pause = all {
    s.runtime,
    not(s.boot),
    not(s.stopping),
    s' = { ...s, phase: "paused" }
  }

  action resume = all {
    s.runtime,
    not(s.boot),
    not(s.stopping),
    not(s.cordoned),
    s' = { ...s, phase: "running" }
  }

  // Existing runtime calls can drain while a replacement is being built.
  action enterTurn = all {
    s.runtime,
    s.phase.in(Set("running", "restarting")),
    not(s.cordoned),
    not(s.stopping),
    s.active < 2,
    s' = { ...s, active: s.active + 1 }
  }

  action exitTurn = all {
    s.active > 0,
    s' = { ...s, active: s.active - 1 }
  }

  // runtime-replacement-ownership.ts closes admission before quiesceAll.
  action cordon = all {
    s.runtime,
    not(s.stopping),
    s' = { ...s, cordoned: true }
  }

  action replace = all {
    s.cordoned,
    not(s.stopping),
    s.active == 0,
    s' = { ...s, cordoned: false, phase: "running", boot: false }
  }

  action legacyResume = s' = { ...s, phase: "running" }
  action legacyPause = s' = { ...s, phase: "paused" }
  // The old existing-runtime /start branch erased the pending restart phase.
  action legacyExistingStart = all {
    s.runtime,
    not(s.stopping),
    s' = { ...s, phase: "running" }
  }
  action legacyRestartDuringBoot = all {
    s.phase == "starting",
    s' = { ...s, phase: "restarting" }
  }
  action idle = s' = s
  action step = any {
    start, startRetry, existingStart, bootSuccess, bootFailure, restart,
    restartFailure, stop, stopSettles, pause, resume, enterTurn, exitTurn,
    cordon, replace, idle
  }
  action legacyStep = any {
    step, legacyResume, legacyPause, legacyExistingStart, legacyRestartDuringBoot
  }

  val safety = all {
    s.phase == "running" implies s.runtime,
    s.phase == "restarting" implies s.runtime,
    s.active >= 0,
    s.active <= 2,
    s.phase.in(Set(
      "not_started", "starting", "running", "paused", "stopped",
      "restarting", "error"
    )),
    s.boot implies s.phase.in(Set("starting", "restarting")),
    s.stopping implies s.runtime and not(s.boot)
  }

  run resumeWithoutRuntimeRegressionTest = init
    .then(legacyResume).expect(not(safety))
  run pauseDuringBootRegressionTest = init
    .then(start).then(legacyPause).expect(not(safety))
  run startDuringRestartRegressionTest = init.then(start).then(bootSuccess)
    .then(restart).then(legacyExistingStart).expect(not(safety))
  run restartDuringInitialBootRegressionTest = init.then(start)
    .then(legacyRestartDuringBoot).expect(not(safety))
  run pendingRestartKeepsFenceTest = init.then(start).then(bootSuccess)
    .then(restart).then(startRetry).expect(s.phase == "restarting" and safety)
    .then(cordon).then(replace).expect(s.phase == "running" and safety)
  run stopDrainsRuntimeTest = init.then(start).then(bootSuccess)
    .then(enterTurn).then(stop).then(exitTurn).then(stopSettles)
    .expect(not(s.runtime) and s.phase == "stopped")
  run restartDrainsOldRuntimeTest = init.then(start).then(bootSuccess)
    .then(enterTurn).then(restart).then(startRetry).then(cordon)
    .then(exitTurn).then(replace).expect(safety and not(s.boot))
  run drainBeforeReplaceTest = init.then(start).then(bootSuccess)
    .then(enterTurn).then(cordon).then(exitTurn).then(replace).expect(safety)
}
