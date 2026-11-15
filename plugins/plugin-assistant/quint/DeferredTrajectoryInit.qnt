// The trajectory store's shared schema initialization for first reads and capture.
// Two callers and two initialization attempts share one legacy table migration.
// SQL inspection, migration and publication are separate. One failure may leave
// already-committed schema work intact; a later caller explicitly retries.
module DeferredTrajectoryInit {
  pure val Callers = Set(0, 1)
  pure val Attempts = Set(1, 2)
  pure val Active = Set("inspect", "alter", "publish")
  var s: {
    initialized: bool, current: int, next: int, schema: bool, failures: int,
    stage: int -> str, pc: int -> str, waiting: int -> int, calls: int -> int,
    kind: int -> str, conflict: bool
  }
  action init = s' = {
    initialized: false, current: 0, next: 1, schema: false, failures: 0,
    stage: Attempts.mapBy(_ => "unused"), pc: Callers.mapBy(_ => "idle"),
    waiting: Callers.mapBy(_ => 0), calls: Callers.mapBy(_ => 0),
    kind: Callers.mapBy(_ => "none"), conflict: false
  }
  action request(c: int, kind: str): bool = all {
    s.pc.get(c) != "waiting", s.calls.get(c) < 2,
    s.initialized or s.current != 0 or s.next <= 2,
    {
      val attempt = if (s.current != 0) s.current else s.next
      val starting = not(s.initialized) and s.current == 0
      s' = { ...s, pc: s.pc.set(c, if (s.initialized) "returned" else "waiting"),
        waiting: s.waiting.set(c, if (s.initialized) 0 else attempt),
        calls: s.calls.set(c, s.calls.get(c) + 1), kind: s.kind.set(c, kind),
        current: if (starting) attempt else s.current,
        next: if (starting) s.next + 1 else s.next,
        stage: if (starting) s.stage.set(attempt, "inspect") else s.stage }
    }
  }
  action inspect(a: int): bool = all {
    s.stage.get(a) == "inspect",
    s' = { ...s, stage: s.stage.set(a, if (s.schema) "publish" else "alter") }
  }
  action migrate(a: int): bool = all {
    s.stage.get(a) == "alter",
    s' = { ...s, schema: true, conflict: s.conflict or s.schema,
      stage: s.stage.set(a, "publish") }
  }
  action publish(a: int): bool = all {
    s.stage.get(a) == "publish",
    s' = { ...s, initialized: true, stage: s.stage.set(a, "ready"),
      current: if (s.current == a) 0 else s.current }
  }
  action storageFailure(a: int): bool = all {
    Active.contains(s.stage.get(a)), s.failures == 0,
    s' = { ...s, stage: s.stage.set(a, "failed"), failures: 1,
      current: if (s.current == a) 0 else s.current }
  }
  action settle(a: int): bool = any { inspect(a), migrate(a), publish(a), storageFailure(a) }
  action observe(c: int): bool = all {
    s.pc.get(c) == "waiting",
    s.stage.get(s.waiting.get(c)).in(Set("ready", "failed")),
    s' = { ...s, pc: s.pc.set(c,
      if (s.stage.get(s.waiting.get(c)) == "ready") "returned" else "failed") }
  }
  action step = any {
    { nondet c = Callers.oneOf(); nondet kind = Set("read", "capture").oneOf()
      any { request(c, kind), observe(c) } },
    { nondet a = Attempts.oneOf(); settle(a) }, s' = s
  }
  val TypeOK = all {
    s.current.in(Set(0, 1, 2)), s.next >= 1, s.next <= 3,
    s.failures.in(Set(0, 1)), s.stage.keys() == Attempts,
    Attempts.forall(a => s.stage.get(a).in(Active.union(Set("unused", "ready", "failed")))),
    s.pc.keys() == Callers, s.waiting.keys() == Callers, s.calls.keys() == Callers,
    Callers.forall(c => s.pc.get(c).in(Set("idle", "waiting", "returned", "failed"))
      and s.waiting.get(c).in(Set(0, 1, 2)) and s.calls.get(c) >= 0 and s.calls.get(c) <= 2)
  }
  val OneInitializer = Attempts.filter(a => Active.contains(s.stage.get(a))).size() <= 1
  val CacheOwned = s.current != 0 implies Active.contains(s.stage.get(s.current))
  val NoDuplicateMigration = not(s.conflict)
  val PublishedSchemaReady = s.initialized implies s.schema
  temporal Fairness = Attempts.forall(a => settle(a).weakFair(s))
    and Callers.forall(c => observe(c).weakFair(s))
  temporal WaitingWithoutFairness = Callers.forall(c =>
    (s.pc.get(c) == "waiting").leadsTo(s.pc.get(c) != "waiting"))
  temporal CallersSettle = Fairness.implies(WaitingWithoutFairness)
  temporal RetryInitializes = Fairness.implies(
    (s.current == 2 and s.failures == 1).leadsTo(s.initialized))

  // The old read path bypassed the capture-only memoized initializer.
  action legacySecondInitializer = all {
    s.next == 2, s.current == 1,
    s' = { ...s, next: 3, stage: s.stage.set(2, "inspect") }
  }
  run readAndCaptureShareInitializationTest = init.then(request(0, "read"))
    .then(request(1, "capture")).expect(s.next == 2 and OneInitializer)
    .then(inspect(1)).then(migrate(1)).then(publish(1)).then(observe(0)).then(observe(1))
    .expect(PublishedSchemaReady and NoDuplicateMigration)
  run failedInitializationRetriesOnNextCallTest = init.then(request(0, "read"))
    .then(storageFailure(1)).then(observe(0)).then(request(1, "capture"))
    .then(inspect(2)).then(migrate(2)).then(publish(2)).then(observe(1))
    .expect(s.initialized and CacheOwned and NoDuplicateMigration)
  run partialMigrationIsNotUndoneTest = init.then(request(0, "read"))
    .then(inspect(1)).then(migrate(1)).then(storageFailure(1)).then(observe(0))
    .then(request(0, "read")).then(inspect(2)).then(publish(2)).then(observe(0))
    .expect(s.initialized and NoDuplicateMigration)
  run concurrentLegacyMigrationWitnessTest = init.then(request(0, "read"))
    .then(legacySecondInitializer).then(inspect(1)).then(inspect(2))
    .then(migrate(1)).then(migrate(2)).expect(not(NoDuplicateMigration))
}
