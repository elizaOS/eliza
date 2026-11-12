// PiiScrubService's lazy drainStart and BatchQueue/TaskDrain startup cache.
// Three request handlers can await the marker check, join a pending start,
// or trigger a retry after one storage failure. Stop retires queue admission
// synchronously, awaits startup, and disposes the normal-priority queue.
module LazyPiiDrain {
  pure val Callers = Set(0, 1, 2)
  pure val StopCallers = Set(0, 1)
  var s: {
    phase: str, handler: int -> str, start: str, cached: bool, task: bool,
    failures: int, retried: bool, accepted: int, queued: int,
    processed: int, discarded: int, stopCalls: int -> str
  }
  action init = s' = {
    phase: "open", handler: Callers.mapBy(_ => "idle"), start: "idle",
    cached: false, task: false, failures: 0, retried: false,
    accepted: 0, queued: 0, processed: 0, discarded: 0,
    stopCalls: StopCallers.mapBy(_ => "idle")
  }
  action request(c: int): bool = all {
    s.phase == "open", s.handler.get(c) == "idle",
    s' = { ...s, handler: s.handler.set(c, "checking") }
  }
  action checked(c: int): bool = all {
    s.handler.get(c) == "checking",
    s' = if (s.phase == "open") {
      ...s, handler: s.handler.set(c, "returned"),
      accepted: s.accepted + 1, queued: s.queued + 1,
      cached: true, start: if (s.start == "idle") "pending" else s.start,
      retried: s.retried or (s.start == "idle" and s.failures > 0)
    } else { ...s, handler: s.handler.set(c, "rejected") }
  }
  action startSuccess = all {
    s.start == "pending", s' = { ...s, start: "ready", task: true }
  }
  action startFailure = all {
    s.start == "pending", s.failures == 0,
    s' = { ...s, start: "idle", cached: false, failures: 1 }
  }
  action settleStart = any { startSuccess, startFailure }
  action drain = all {
    s.task, s.queued > 0, s.phase != "stopped",
    s' = { ...s, queued: s.queued - 1, processed: s.processed + 1 }
  }
  action stop = all {
    s.phase == "open",
    s' = { ...s, phase: "stopping", stopCalls: s.stopCalls.set(0, "waiting") }
  }
  // Repeated stop joins the same pending cleanup; it does not retire ownership early.
  action joinStop = all {
    s.phase == "stopping", s.stopCalls.get(1) == "idle",
    s' = { ...s, stopCalls: s.stopCalls.set(1, "waiting") }
  }
  action stopReturns(c: int): bool = all {
    s.phase == "stopped", s.stopCalls.get(c) == "waiting",
    s' = { ...s, stopCalls: s.stopCalls.set(c, "returned") }
  }
  action dispose = all {
    s.phase == "stopping", s.start != "pending",
    s' = { ...s, phase: "stopped", start: "idle", cached: false, task: false,
      queued: 0, discarded: s.discarded + s.queued }
  }
  action step = any {
    { nondet c = Callers.oneOf(); any { request(c), checked(c) } },
    { nondet c = StopCallers.oneOf(); stopReturns(c) },
    settleStart, drain, stop, joinStop, dispose, s' = s
  }
  val TypeOK = all {
    s.phase.in(Set("open", "stopping", "stopped")),
    s.start.in(Set("idle", "pending", "ready")), s.failures.in(Set(0, 1)),
    s.handler.keys() == Callers,
    Callers.forall(c => s.handler.get(c).in(Set("idle", "checking", "returned", "rejected"))),
    s.accepted >= 0, s.accepted <= 3, s.queued >= 0,
    s.processed >= 0, s.discarded >= 0, s.stopCalls.keys() == StopCallers,
    StopCallers.forall(c => s.stopCalls.get(c).in(Set("idle", "waiting", "returned")))
  }
  val WorkConserved = s.accepted == s.queued + s.processed + s.discarded
  val StartupOwned = all {
    s.cached == (s.start != "idle"), s.task == (s.start == "ready")
  }
  val StoppedReleased = s.phase == "stopped" implies
    not(s.cached) and not(s.task) and s.queued == 0 and s.start == "idle"
  val StopReturnOwned = StopCallers.forall(c =>
    s.stopCalls.get(c) == "returned" implies s.phase == "stopped")
  temporal Fairness = all {
    settleStart.weakFair(s), drain.weakFair(s), dispose.weakFair(s),
    Callers.forall(c => checked(c).weakFair(s)),
    StopCallers.forall(c => stopReturns(c).weakFair(s))
  }
  temporal StartSettles = Fairness.implies(
    (s.start == "pending").leadsTo(s.start != "pending"))
  temporal RetryRestoresDrain = Fairness.implies(
    (s.retried and s.phase == "open").leadsTo(s.task or s.phase != "open"))
  temporal ReadyWorkSettles = Fairness.implies(
    (s.task and s.queued > 0).leadsTo(s.queued == 0 or s.phase == "stopped"))
  temporal StopSettles = Fairness.implies(
    (s.phase == "stopping").leadsTo(s.phase == "stopped"))
  temporal StopCallersReturn = Fairness.implies(StopCallers.forall(c =>
    (s.stopCalls.get(c) == "waiting").leadsTo(s.stopCalls.get(c) == "returned")))
  temporal RetryWithoutFairness = (s.retried and s.queued > 0)
    .leadsTo(s.queued == 0 or s.phase == "stopped")
  // Fair storage and scheduler actions cannot manufacture a later request.
  temporal QueuedWorkWithoutFutureRequest = Fairness.implies(
    (s.queued > 0).leadsTo(s.queued == 0 or s.phase == "stopped"))

  action legacyFailedStart = all {
    s.start == "pending", s' = { ...s, start: "idle", failures: 1 }
  }
  action legacyJoinReturnsEarly = all {
    s.phase == "stopping", s.stopCalls.get(1) == "idle",
    s' = { ...s, stopCalls: s.stopCalls.set(1, "returned") }
  }
  run failedStartRetryTest = init.then(request(0)).then(checked(0))
    .then(startFailure).then(request(1)).then(checked(1)).then(startSuccess)
    .then(drain).then(drain).expect(StartupOwned and WorkConserved and s.queued == 0)
  run concurrentRequestsJoinStartTest = init.then(request(0)).then(request(1))
    .then(checked(0)).then(checked(1)).then(startSuccess)
    .expect(s.accepted == 2 and s.task and StartupOwned)
  run stopDuringStartTest = init.then(request(0)).then(checked(0))
    .then(stop).then(startSuccess).then(dispose).expect(StoppedReleased and WorkConserved)
  run repeatedStopKeepsPendingOwnerTest = init.then(request(0)).then(checked(0))
    .then(stop).then(joinStop).expect(s.phase == "stopping" and s.start == "pending"
      and s.stopCalls.get(1) == "waiting")
    .then(startSuccess).then(dispose).then(stopReturns(0)).then(stopReturns(1))
    .expect(StoppedReleased and WorkConserved and StopReturnOwned)
  run stopDuringMarkerCheckTest = init.then(request(0)).then(stop)
    .then(checked(0)).then(dispose).expect(s.accepted == 0 and StoppedReleased)
  run cachedFailedStartWitnessTest = init.then(request(0)).then(checked(0))
    .then(legacyFailedStart).expect(not(StartupOwned))
  run earlyRepeatedStopWitnessTest = init.then(request(0)).then(checked(0))
    .then(stop).then(legacyJoinReturnsEarly).expect(not(StopReturnOwned))
}
