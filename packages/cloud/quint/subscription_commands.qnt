// App-scoped subscription command authority. Sources:
// db/repositories/app-billing-command-runtime.ts: claim, recordProgress,
// recordResult, releaseLease; app-subscription-finalizer.ts: applyObservation.
// Bounds: one immutable command/scope, two workers, three lease generations,
// nine clock ticks, two competing subscription revisions. A tick abstracts
// lease expiry; provider payload validation, decimal arithmetic, external
// idempotency and special cancellation/import authorities are outside scope.
// Only committed database actions are modeled; interrupted transactions stutter.
module subscription_commands {
  type Worker = { generation: int, revision: int, observedRevision: int }
  type State = {
    phase: str, generation: int, revision: int, owner: int, until: int,
    time: int, workers: int -> Worker, hasResult: bool, applied: int,
    subscriptionRevision: int, fenced: bool,
    acceptedGeneration: int, activeAtAcceptance: int,
    acceptedScope: int, acceptedLive: bool
  }
  var s: State
  pure val workers = Set(0, 1)

  action init = s' = {
    phase: "PREPARED", generation: 0, revision: 1, owner: -1, until: 0,
    time: 0, workers: workers.mapBy(_ => {
      generation: 0, revision: 0, observedRevision: 0
    }), hasResult: false, applied: 0, subscriptionRevision: 0, fenced: false,
    acceptedGeneration: 0, activeAtAcceptance: 0, acceptedScope: 1,
    acceptedLive: true
  }

  def owns(worker: int, scope: int): bool = all {
    scope == 1, s.owner == worker,
    s.workers.get(worker).generation == s.generation,
    s.workers.get(worker).revision == s.revision
  }
  def live(worker: int, scope: int): bool = owns(worker, scope) and s.time < s.until

  action claim(worker: int): bool = all {
    s.generation < 3,
    Set("PREPARED", "OUTCOME_UNKNOWN", "SUCCEEDED").contains(s.phase),
    s.owner == -1 or s.time >= s.until,
    s.phase != "PREPARED" or not(s.fenced),
    s' = s.with("phase", if (s.phase == "PREPARED") "OUTCOME_UNKNOWN" else s.phase)
      .with("generation", s.generation + 1).with("revision", s.revision + 1)
      .with("owner", worker).with("until", s.time + 2)
      .with("workers", s.workers.set(worker, {
        generation: s.generation + 1, revision: s.revision + 1,
        observedRevision: s.subscriptionRevision
      }))
  }

  action tick = all { s.time < 8, s' = s.with("time", s.time + 1) }
  action fence = s' = s.with("fenced", true)

  // Progress preserves the command revision so the same lease can finish.
  action progress(worker: int, scope: int): bool = all {
    live(worker, scope),
    s' = s.with("hasResult", true)
      .with("acceptedGeneration", s.workers.get(worker).generation)
      .with("activeAtAcceptance", s.generation).with("acceptedScope", scope)
      .with("acceptedLive", s.time < s.until)
  }

  action recordResult(worker: int, scope: int): bool = all {
    live(worker, scope), Set("OUTCOME_UNKNOWN", "SUCCEEDED").contains(s.phase),
    s' = s.with("phase", "SUCCEEDED").with("hasResult", true)
      .with("revision", s.revision + 1).with("owner", -1).with("until", 0)
      .with("acceptedGeneration", s.workers.get(worker).generation)
      .with("activeAtAcceptance", s.generation).with("acceptedScope", scope)
      .with("acceptedLive", s.time < s.until)
  }

  // Release checks identity and revisions, but need not require a live lease.
  action release(worker: int, scope: int): bool = all {
    owns(worker, scope), s' = s.with("owner", -1).with("until", 0)
  }
  action rejectStaleRelease(worker: int, scope: int): bool = all {
    not(owns(worker, scope)), s' = s
  }
  action rejectStaleWrite(worker: int, scope: int): bool = all {
    not(live(worker, scope)), s' = s
  }

  action observeSubscription(worker: int): bool = all {
    live(worker, 1),
    s' = s.with("workers", s.workers.set(worker,
      s.workers.get(worker).with("observedRevision", s.subscriptionRevision)))
  }
  action concurrentSubscriptionChange = all {
    s.subscriptionRevision < 2,
    s' = s.with("subscriptionRevision", s.subscriptionRevision + 1)
  }
  action rejectChangedSubscription(worker: int): bool = all {
    s.workers.get(worker).observedRevision != s.subscriptionRevision, s' = s
  }
  action apply(worker: int, scope: int): bool = all {
    live(worker, scope), not(s.fenced), s.hasResult,
    Set("OUTCOME_UNKNOWN", "SUCCEEDED").contains(s.phase),
    s.workers.get(worker).observedRevision == s.subscriptionRevision,
    s' = s.with("phase", "APPLIED").with("applied", s.applied + 1)
      .with("revision", s.revision + 1).with("owner", -1).with("until", 0)
      .with("acceptedGeneration", s.workers.get(worker).generation)
      .with("activeAtAcceptance", s.generation).with("acceptedScope", scope)
      .with("acceptedLive", s.time < s.until)
  }
  action supersedeUnstarted = all {
    s.phase == "PREPARED", s.generation == 0,
    s' = s.with("phase", "SUPERSEDED").with("revision", s.revision + 1)
  }
  action idle = s' = s
  action step = {
    nondet worker = workers.oneOf()
    nondet scope = Set(1, 2).oneOf()
    any {
      claim(worker), tick, fence, progress(worker, scope), recordResult(worker, scope),
      release(worker, scope), rejectStaleRelease(worker, scope),
      rejectStaleWrite(worker, scope), observeSubscription(worker),
      concurrentSubscriptionChange, rejectChangedSubscription(worker),
      apply(worker, scope), supersedeUnstarted, idle
    }
  }

  val safety = all {
    s.acceptedGeneration == s.activeAtAcceptance, s.acceptedScope == 1,
    s.acceptedLive, s.applied <= 1,
    s.phase != "APPLIED" or (s.applied == 1 and s.hasResult and s.owner == -1),
    s.phase != "SUPERSEDED" or s.generation == 0,
    s.phase != "PREPARED" or (s.generation == 0 and not(s.hasResult))
  }

  // Negative witness: removing the generation/token predicate accepts old work.
  action unfencedProgress(worker: int): bool = s' = s.with("hasResult", true)
    .with("acceptedGeneration", s.workers.get(worker).generation)
    .with("activeAtAcceptance", s.generation).with("acceptedScope", 1)
    .with("acceptedLive", true)

  run takeoverRejectsOldWorkerTest = init.then(claim(0)).then(tick).then(tick)
    .then(claim(1)).then(rejectStaleWrite(0, 1)).then(rejectStaleRelease(0, 1))
    .then(progress(1, 1)).then(apply(1, 1))
    .expect(safety and s.phase == "APPLIED" and s.generation == 2)
  run foreignScopeRejectedTest = init.then(claim(0)).then(rejectStaleWrite(0, 2))
    .expect(safety and not(s.hasResult))
  run observedResultRecoveredTest = init.then(claim(0)).then(recordResult(0, 1))
    .then(claim(1)).then(apply(1, 1)).expect(safety and s.applied == 1)
  run concurrentRevisionRequiresFreshObservationTest = init.then(claim(0))
    .then(progress(0, 1)).then(concurrentSubscriptionChange)
    .then(rejectChangedSubscription(0))
    .then(observeSubscription(0)).then(apply(0, 1)).expect(safety and s.applied == 1)
  run unstartedCommandSupersededTest = init.then(supersedeUnstarted)
    .expect(safety and s.generation == 0)
  run staleGenerationNegativeWitnessTest = init.then(claim(0)).then(tick).then(tick)
    .then(claim(1)).then(unfencedProgress(0)).expect(not(safety))
}
