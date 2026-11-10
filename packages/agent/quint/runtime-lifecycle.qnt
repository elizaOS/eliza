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

// startEliza's restored-generation onRestart clears lifecycleRuntime before
// owning shutdown, then builds against the same durable database. The API
// clears an unavailable disposed runtime on failure. A later Start skips the
// already-closed runtime, and activation publishes one fresh lifecycle owner.
// Three runtime identities, four build calls and one initially admitted job
// bound the maintained actual startEliza / HTTP / PGlite restore scenario.
module runtime_restore_replacement {
  pure val Runtimes = Set(0, 1, 2)
  var s: {
    phase: str, reported: str, operation: str, attempts: int,
    apiRuntime: int, hostRuntime: int, lifecycleRuntime: int, target: int,
    created: Set[int], openAdapters: Set[int], closes: int -> int,
    workOwner: int, disposedBeforeBuild: bool, authorityOpen: bool
  }
  action initialize(withWork: bool): bool = s' = {
    phase: "idle", reported: "running", operation: "none", attempts: 0,
    apiRuntime: 0, hostRuntime: 0, lifecycleRuntime: 0, target: -1,
    created: Set(0), openAdapters: Set(0), closes: Runtimes.mapBy(_ => 0),
    workOwner: if (withWork) 0 else -1, disposedBeforeBuild: false, authorityOpen: true
  }
  action init = any { initialize(false), initialize(true) }
  action beginBuild(kind: str): bool = all {
    s.phase == "idle", s.attempts < 4,
    kind == "restart" or (kind == "start" and s.apiRuntime == -1),
    s' = { ...s, operation: kind, attempts: s.attempts + 1,
      reported: if (kind == "start") "starting" else "restarting",
      phase: if (s.lifecycleRuntime >= 0) "retiring" else "building",
      target: s.lifecycleRuntime, lifecycleRuntime: -1, disposedBeforeBuild: false }
  }
  action beginStop = all {
    s.phase == "idle", s.apiRuntime >= 0,
    s' = { ...s, operation: "stop", phase: "retiring",
      target: s.apiRuntime, lifecycleRuntime: -1, disposedBeforeBuild: false }
  }
  action stopEmpty = all {
    s.phase == "idle", s.apiRuntime == -1,
    s' = { ...s, reported: "stopped" }
  }
  action pause = all {
    s.phase == "idle", s.apiRuntime >= 0,
    s' = { ...s, reported: "paused" }
  }
  action existingStart = all {
    s.phase == "idle", s.apiRuntime >= 0,
    s' = { ...s, reported: "running" }
  }
  action finishOwnedWork = all {
    s.phase == "retiring", s.workOwner == s.target,
    s' = { ...s, workOwner: -1 }
  }
  action retire(ok: bool): bool = all {
    s.phase == "retiring", s.target >= 0, s.workOwner != s.target,
    {
      val base = { ...s,
        openAdapters: s.openAdapters.exclude(Set(s.target)),
        closes: s.closes.set(s.target, s.closes.get(s.target) + 1) }
      s' = if (s.operation == "stop")
        { ...base, phase: "idle", reported: if (ok) "stopped" else "error", apiRuntime: -1 }
      else if (ok)
        { ...base, phase: "building", disposedBeforeBuild: true }
      else
        { ...base, phase: "idle", reported: "error", apiRuntime: -1, disposedBeforeBuild: false }
    }
  }
  action buildFailure = all {
    s.phase == "building",
    // The catch clears this flag even if disposal had succeeded. No later
    // unrelated replacement may skip its own outgoing runtime's cleanup.
    s' = { ...s, phase: "idle", reported: "error", apiRuntime: -1,
      disposedBeforeBuild: false }
  }
  action buildSuccess = all {
    s.phase == "building", s.authorityOpen, s.created.size() < 3,
    {
      val fresh = s.created.size()
      s' = { ...s, phase: "idle", reported: "running",
        apiRuntime: fresh, hostRuntime: fresh, lifecycleRuntime: fresh,
        created: s.created.union(Set(fresh)), openAdapters: s.openAdapters.union(Set(fresh)),
        disposedBeforeBuild: false, target: -1 }
    }
  }
  action closeAuthority = all {
    s.phase == "idle", s.authorityOpen,
    s' = { ...s, authorityOpen: false }
  }
  action pendingControls = all { s.phase != "idle", s' = s }
  action advance = any { finishOwnedWork, retire(true), retire(false), buildSuccess, buildFailure }
  action idle = s' = s
  action step = any {
    beginBuild("start"), beginBuild("restart"), beginStop, stopEmpty,
    pause, existingStart, closeAuthority, pendingControls, advance, idle
  }
  val safety = all {
    s.attempts >= 0, s.attempts <= 4, s.created.subseteq(Runtimes),
    s.openAdapters.subseteq(s.created), s.closes.keys() == Runtimes,
    Runtimes.forall(id => s.closes.get(id) >= 0 and s.closes.get(id) <= 1),
    s.workOwner >= 0 implies s.openAdapters.contains(s.workOwner),
    s.lifecycleRuntime >= 0 implies s.lifecycleRuntime == s.hostRuntime and s.openAdapters.contains(s.lifecycleRuntime),
    s.phase == "building" implies s.lifecycleRuntime == -1 and s.workOwner == -1,
    s.phase == "retiring" implies s.lifecycleRuntime == -1 and s.openAdapters.contains(s.target),
    s.phase == "idle" and s.reported.in(Set("running", "paused")) implies
      s.apiRuntime == s.lifecycleRuntime and s.apiRuntime >= 0 and s.openAdapters.contains(s.apiRuntime),
    s.phase == "idle" and s.reported.in(Set("error", "stopped")) implies
      s.apiRuntime == -1 and s.lifecycleRuntime == -1 and not(s.disposedBeforeBuild)
  }
  temporal RequestWithoutFairness = (s.phase != "idle").leadsTo(s.phase == "idle")
  temporal RequestSettles = advance.weakFair(s).implies(RequestWithoutFairness)

  // A fast room-drain timeout throws before strict drain; shutdownRuntime then
  // closes the old adapter and returns the error while an admitted owner lives.
  action legacyFastFailure = all {
    s.phase == "retiring", s.workOwner == s.target,
    s' = { ...s, phase: "idle", reported: "error", apiRuntime: -1,
      openAdapters: s.openAdapters.exclude(Set(s.target)),
      closes: s.closes.set(s.target, s.closes.get(s.target) + 1) }
  }
  run restoreRetiresBeforeRebuildTest = initialize(true).then(beginBuild("restart"))
    .then(pendingControls).expect(safety and s.openAdapters.contains(0))
    .then(finishOwnedWork).then(retire(true)).then(buildSuccess)
    .expect(safety and s.apiRuntime == 1 and s.closes.get(0) == 1)
  run stopThenStartDoesNotCloseTwiceTest = initialize(false).then(beginStop).then(retire(true))
    .then(beginBuild("start")).then(buildSuccess)
    .expect(safety and s.apiRuntime == 1 and s.closes.get(0) == 1)
  run failedBuildDoesNotSkipLaterCleanupTest = initialize(false).then(beginBuild("restart"))
    .then(retire(true)).then(buildFailure).then(beginBuild("start")).then(buildSuccess)
    .then(beginBuild("restart")).then(retire(true)).then(buildSuccess)
    .expect(safety and s.apiRuntime == 2 and s.closes.get(0) == 1 and s.closes.get(1) == 1)
  run closedAuthorityRemainsUnavailableTest = initialize(false).then(closeAuthority)
    .then(beginBuild("restart")).then(retire(true)).then(buildFailure)
    .then(stopEmpty).then(beginBuild("start")).then(buildFailure)
    .expect(safety and s.reported == "error" and s.apiRuntime == -1 and s.created == Set(0))
  run preRestoreFastCloseWitnessTest = initialize(true).then(beginBuild("restart"))
    .then(legacyFastFailure).expect(not(safety))
}

// eliza.ts disposeReplacedRuntime reuses core's strict retirement owner after
// the fast stop cap. service-lifecycle.ts retains original callbacks after
// services.clear(); TaskService.stop and MemoryRetentionService.stop both wait
// for admitted retention work. The host closes only an unshared old adapter.
// One write and two registered stop callbacks abstract the maintained HTTP /
// SQLite scheduler-retention scenario. OS signal exit budgets remain external.
module runtime_adapter_retirement {
  pure val Callbacks = Set(0, 1)
  var s: {
    phase: str, shared: bool, activeWrite: bool, writeFailed: bool,
    pending: Set[int], failures: Set[int], calls: int -> int,
    lookupsCleared: bool, bestEffortReturned: bool, retired: bool,
    oldAdapterOpen: bool, receipt: str
  }
  action initialize(shared: bool, active: bool): bool = s' = {
    phase: "live", shared: shared, activeWrite: active, writeFailed: false,
    pending: Set(), failures: Set(), calls: Callbacks.mapBy(_ => 0),
    lookupsCleared: false, bestEffortReturned: false, retired: false,
    oldAdapterOpen: true, receipt: "pending"
  }
  action init = any {
    initialize(false, false), initialize(false, true),
    initialize(true, false), initialize(true, true)
  }
  action beginCleanup = all {
    s.phase == "live",
    s' = { ...s, phase: "stopping", pending: Callbacks,
      calls: Callbacks.mapBy(_ => 1) }
  }
  action finishWrite(ok: bool): bool = all {
    s.phase == "stopping", s.activeWrite,
    s' = { ...s, activeWrite: false, writeFailed: not(ok) }
  }
  action finishCallback(id: int): bool = all {
    s.pending.contains(id), not(s.activeWrite),
    s' = { ...s, pending: s.pending.exclude(Set(id)),
      failures: if (id == 0 and s.writeFailed) s.failures.union(Set(id)) else s.failures }
  }
  action bestEffortReturns = all {
    s.phase == "stopping", not(s.bestEffortReturned),
    // Fast timeout can clear the lookup registry while the original callback
    // remains in RuntimeRetirement. Absence from getService is not retirement.
    s' = { ...s, bestEffortReturned: true, lookupsCleared: true }
  }
  action retire = all {
    s.phase == "stopping", s.bestEffortReturned,
    s.pending.size() == 0, not(s.activeWrite),
    // Strict stop retains teardown failure; it never retries the failed hook.
    s' = { ...s, phase: "retired", retired: true }
  }
  action releaseAdapter = all {
    s.phase == "retired",
    // shutdownRuntime still attempts adapter cleanup after retirement reports a
    // callback failure. Adapter-close failures themselves are outside this case.
    s' = { ...s, phase: "done", oldAdapterOpen: s.shared,
      receipt: if (s.failures.size() > 0) "failed" else "success" }
  }
  action repeatStrictStop = all {
    s.phase.in(Set("stopping", "retired", "done")), s' = s
  }
  action advance = any {
    finishWrite(true), finishWrite(false), finishCallback(0), finishCallback(1),
    bestEffortReturns, retire, releaseAdapter
  }
  action idle = s' = s
  action step = any { beginCleanup, repeatStrictStop, advance, idle }
  val replacementAvailable = not(s.shared) or s.oldAdapterOpen
  val safety = all {
    s.pending.subseteq(Callbacks), s.failures.subseteq(Callbacks),
    s.calls.keys() == Callbacks,
    Callbacks.forall(id => s.calls.get(id) >= 0 and s.calls.get(id) <= 1),
    not(s.oldAdapterOpen) implies s.retired and s.pending.size() == 0 and not(s.activeWrite),
    replacementAvailable,
    s.retired implies s.bestEffortReturned and s.lookupsCleared and s.pending.size() == 0,
    s.phase == "done" implies s.receipt == (if (s.failures.size() > 0) "failed" else "success")
  }
  temporal RetirementWithoutFairness = (s.phase == "stopping").leadsTo(s.phase == "done")
  temporal RetirementCompletes = advance.weakFair(s).implies(RetirementWithoutFairness)

  // Before strict retirement was requested, the host could release the old
  // adapter immediately after the fast cap despite original callbacks still live.
  action legacyReleaseAtFastCap = all {
    s.bestEffortReturned,
    s' = { ...s, phase: "done", oldAdapterOpen: s.shared, receipt: "success" }
  }
  run fastCapRetainsDatabaseTest = initialize(false, true).then(beginCleanup)
    .then(bestEffortReturns).then(repeatStrictStop)
    .expect(safety and s.oldAdapterOpen and s.pending == Callbacks)
    .then(finishWrite(true)).then(finishCallback(0)).then(finishCallback(1))
    .then(retire).then(releaseAdapter).expect(safety and not(s.oldAdapterOpen) and s.receipt == "success")
  run callbackFailureStillClosesAfterDrainTest = initialize(false, true).then(beginCleanup)
    .then(bestEffortReturns).then(finishWrite(false)).then(finishCallback(0)).then(finishCallback(1))
    .then(retire).then(releaseAdapter).expect(safety and s.receipt == "failed" and not(s.oldAdapterOpen))
  run sharedConnectionSurvivesRetirementTest = initialize(true, false).then(beginCleanup)
    .then(finishCallback(0)).then(finishCallback(1)).then(bestEffortReturns)
    .then(retire).then(releaseAdapter).expect(safety and s.oldAdapterOpen and replacementAvailable)
  run fastCloseRegressionWitnessTest = initialize(false, true).then(beginCleanup)
    .then(bestEffortReturns).then(legacyReleaseAtFastCap).expect(not(safety))
}
