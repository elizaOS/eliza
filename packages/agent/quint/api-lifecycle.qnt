// agent-lifecycle-routes.ts and agent-admin-routes.ts share one live runtime.
// A running-runtime restart retains that runtime while the replacement builds.
// Repeated start requests preserve the pending phase. The replacement closes
// room admission and drains existing turns before publishing. Two active turns
// bound the queue projection. One persisted wallet configuration change during
// initial Start is deferred rather than entering a second host boot callback.
// Host disposal and process failures are external.
module api_lifecycle {
  var s: {
    phase: str,
    runtime: bool,
    boot: bool,
    stopping: bool,
    active: int,
    cordoned: bool,
    configSaved: bool,
    reloadPublished: bool,
    pendingReload: bool
  }

  action init = s' = {
    phase: "not_started",
    runtime: false,
    boot: false,
    stopping: false,
    active: 0,
    cordoned: false,
    configSaved: false,
    reloadPublished: false,
    pendingReload: false
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
    s.phase == "restarting",
    s.boot,
    not(s.stopping),
    s' = { ...s, cordoned: true }
  }

  action replace = all {
    s.cordoned,
    s.phase == "restarting",
    s.boot,
    not(s.stopping),
    s.active == 0,
    s' = { ...s, cordoned: false, phase: "running", boot: false,
      reloadPublished: true, pendingReload: false }
  }

  // The checked scenario holds initial boot until the wallet request settles.
  // Its real config write persists, applyRuntimeRestart declines during Start,
  // and triggerWalletRuntimeReload records the pending restart reason.
  action walletReloadDuringStart = all {
    s.phase == "starting", s.boot, not(s.configSaved),
    s' = { ...s, configSaved: true, reloadPublished: false, pendingReload: true }
  }
  action finishInitialBoot = any { bootSuccess, bootFailure }
  temporal InitialBootWithoutFairness = (s.phase == "starting").leadsTo(s.phase != "starting")
  temporal InitialBootSettles = finishInitialBoot.weakFair(s).implies(InitialBootWithoutFairness)

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
    cordon, replace, walletReloadDuringStart, idle
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
    s.stopping implies s.runtime and not(s.boot),
    s.configSaved and not(s.reloadPublished) implies s.pendingReload
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
    .then(enterTurn).then(restart).then(cordon).then(exitTurn).then(replace).expect(safety)
  run walletReloadDefersToInitialBootOwnerTest = init.then(start).then(walletReloadDuringStart)
    .expect(safety and s.phase == "starting" and s.boot)
    .then(bootSuccess).expect(safety and s.configSaved and s.pendingReload and not(s.reloadPublished))
    .then(restart).then(cordon).then(replace)
    .expect(safety and not(s.pendingReload) and s.reloadPublished)
}

// agent-admin-routes.ts retains the old runtime and reported phase if a normal
// replacement build returns null or throws. A successful build calls the shared
// runtime-replacement-ownership.ts helper: closeAdmissions is synchronous, then
// quiesceAll waits for admitted work before state.runtime is replaced. This
// projection uses distinct outgoing/replacement runtimes, one room, two FIFO
// callbacks, their shared abort signal and three build attempts. Native/restored
// dispose-before-build is a separate path.
module api_runtime_replacement {
  pure val Slots = Set(0, 1)
  pure def pending(work: int -> str): Set[int] =
    Slots.filter(i => work.get(i).in(Set("queued", "active")))
  pure def settled(work: int -> str): bool = pending(work).size() == 0
  var s: {
    phase: str, reported: str, prior: str, attempts: int,
    current: str, closed: bool, aborted: bool, work: int -> str,
    publishedWithPending: bool, executed: Set[int], cancelled: Set[int]
  }
  action init = s' = {
    phase: "idle", reported: "running", prior: "running", attempts: 0,
    current: "old", closed: false, aborted: false,
    work: Slots.mapBy(_ => "absent"),
    publishedWithPending: false, executed: Set(), cancelled: Set()
  }
  action pause = all {
    s.phase.in(Set("idle", "failed")),
    s' = { ...s, phase: "idle", reported: "paused" }
  }
  action resume = all {
    s.phase.in(Set("idle", "failed")),
    s' = { ...s, phase: "idle", reported: "running" }
  }
  action admit(slot: int): bool = all {
    not(s.closed), not(s.aborted), s.work.get(slot) == "absent",
    slot == 0 or s.work.get(0) != "absent",
    {
      val admitted = if (Slots.exists(i => s.work.get(i) == "active")) "queued" else "active"
      s' = { ...s, work: s.work.set(slot, admitted),
        executed: if (admitted == "active") s.executed.union(Set(slot)) else s.executed }
    }
  }
  action abort = all {
    not(s.aborted),
    // room-handler-queue.ts onAbort only removes queued callbacks. An active
    // callback keeps ownership and may still commit its database operation.
    s' = { ...s, aborted: true,
      cancelled: s.cancelled.union(Slots.filter(i => s.work.get(i) == "queued")),
      work: Slots.mapBy(i => if (s.work.get(i) == "queued") "cancelled" else s.work.get(i)) }
  }
  action settle(slot: int, success: bool): bool = all {
    s.work.get(slot) == "active",
    {
      val result = s.work.set(slot, if (success) "succeeded" else "failed")
      val advanced = if (slot == 0 and result.get(1) == "queued") result.set(1, "active") else result
      s' = { ...s, work: advanced,
        executed: if (slot == 0 and result.get(1) == "queued") s.executed.union(Set(1)) else s.executed }
    }
  }
  action restart = all {
    s.phase.in(Set("idle", "failed")), s.attempts < 3,
    s' = { ...s, phase: "building", prior: s.reported,
      reported: "restarting", attempts: s.attempts + 1 }
  }
  action buildFailure = all {
    s.phase == "building",
    // Null and thrown build failures take the same branch before quiescence.
    s' = { ...s, phase: "failed", reported: s.prior }
  }
  action buildSuccess = all {
    s.phase == "building",
    s' = { ...s, phase: "draining", closed: true }
  }
  action publish = all {
    s.phase == "draining", settled(s.work),
    s' = { ...s, phase: "published", current: "new", reported: "running",
      publishedWithPending: not(settled(s.work)) }
  }
  action advance = any { settle(0, true), settle(0, false), settle(1, true), settle(1, false), publish }
  action idle = s' = s
  action step = any {
    pause, resume, admit(0), admit(1), abort, restart,
    buildFailure, buildSuccess, advance, idle
  }
  val safety = all {
    s.attempts >= 0, s.attempts <= 3,
    s.work.keys() == Slots,
    Slots.forall(i => s.work.get(i).in(Set("absent", "queued", "active", "succeeded", "failed", "cancelled"))),
    Slots.filter(i => s.work.get(i) == "active").size() <= 1,
    s.executed.subseteq(Slots), s.cancelled.subseteq(Slots),
    s.executed.intersect(s.cancelled).size() == 0,
    s.cancelled.forall(i => s.work.get(i) == "cancelled"),
    not(s.publishedWithPending),
    s.phase == "failed" implies s.current == "old" and not(s.closed) and s.reported == s.prior,
    s.phase.in(Set("building", "draining")) implies s.reported == "restarting" and s.current == "old",
    s.phase == "draining" implies s.closed,
    s.current == "new" implies s.closed and settled(s.work) and s.reported == "running"
  }
  // Fair completion permits either success or failure; cancellation alone does
  // not settle active I/O. There is no time bound or assumption of build success.
  temporal ReplacementWithoutFairness = (s.phase == "draining").leadsTo(s.phase == "published")
  temporal ReplacementCompletes = advance.weakFair(s).implies(ReplacementWithoutFairness)

  action legacyPublish = s' = { ...s, phase: "published", current: "new", reported: "running",
    publishedWithPending: not(settled(s.work)) }
  run pausedBuildFailureRetriesTest = init.then(pause).then(restart).then(buildFailure)
    .expect(safety and s.reported == "paused" and not(s.closed))
    .then(restart).then(buildFailure).then(resume).then(restart).then(buildSuccess).then(publish)
    .expect(safety and s.current == "new" and s.attempts == 3)
  run cancelQueuedKeepsActiveOwnerTest = init.then(admit(0)).then(admit(1)).then(restart)
    .then(buildSuccess).then(abort)
    .expect(safety and s.work.get(0) == "active" and s.work.get(1) == "cancelled" and s.current == "old")
    .then(settle(0, true)).then(publish).expect(safety and s.current == "new")
  run failedActiveWorkStillDrainsTest = init.then(admit(0)).then(admit(1)).then(restart)
    .then(buildSuccess).then(settle(0, false)).then(settle(1, true)).then(publish).expect(safety)
  run publishingBeforeDrainWitnessTest = init.then(admit(0)).then(restart).then(buildSuccess)
    .then(legacyPublish).expect(not(safety))
}
