// CacheClient.getWithOutcome, delConfirmed, recordFailure, resetFailures,
// and isCircuitOpen. One client and one cached value. Backend commands can
// settle after the breaker opens. The threshold/cooldown are scaled to two.
// This projection assumes a monotonic host performance clock.
module cache_breaker_receipts {
  type State = {
    configured: bool, present: bool,
    elapsed: int, wall: int, failures: int,
    lastFailure: int, lastFailureWall: int,
    pending: int -> str, reply: str, reopenRespectedDelay: bool,
  }
  var s: State
  pure val slots = Set(0, 1)
  pure val operations = Set("read", "miss", "bad-read", "delete")
  val cooling = s.failures >= 2 and s.elapsed - s.lastFailure <= 2

  action initConfigured = s' = {
    configured: true, present: true, elapsed: 0, wall: 0, failures: 0,
    lastFailure: 0, lastFailureWall: 0,
    pending: slots.mapBy(_ => "idle"), reply: "none", reopenRespectedDelay: true,
  }
  action initUnconfigured = s' = {
    configured: false, present: false, elapsed: 0, wall: 0, failures: 0,
    lastFailure: 0, lastFailureWall: 0,
    pending: slots.mapBy(_ => "idle"), reply: "none", reopenRespectedDelay: true,
  }
  action tick = all {
    s.elapsed < 3, s' = s.with("elapsed", s.elapsed + 1),
  }
  action setWall(value: int): bool = s' = s.with("wall", value)

  action begin(slot: int, operation: str): bool = all {
    s.pending.get(slot) == "idle",
    s' = if (not(s.configured))
      s.with("reply", if (operation == "delete") "unconfigured-delete" else "unavailable")
    else if (cooling)
      s.with("reply", if (operation == "delete") "unconfirmed-delete" else "unavailable")
    else
      s.with("failures", if (s.failures >= 2) 0 else s.failures)
        .with("pending", s.pending.set(slot, operation)).with("reply", "pending"),
  }

  // isAvailable also probes the breaker. The alternate clock reproduces the
  // old wall-clock decision only in an executable regression trace.
  action probe(useWall: bool): bool = {
    val clockAdvanced = if (useWall) s.wall - s.lastFailureWall > 2
      else s.elapsed - s.lastFailure > 2
    val reopens = s.configured and s.failures >= 2 and clockAdvanced
    s' = if (reopens)
      s.with("failures", 0).with("reply", "none")
        .with("reopenRespectedDelay", s.elapsed - s.lastFailure > 2)
    else s
  }
  action failed(slot: int): bool = all {
    s.pending.get(slot) != "idle",
    s' = s.with("pending", s.pending.set(slot, "idle"))
      .with("failures", s.failures + 1)
      .with("lastFailure", s.elapsed).with("lastFailureWall", s.wall)
      .with("reply", if (s.pending.get(slot) == "delete") "unconfirmed-delete" else "error"),
  }
  action succeeded(slot: int): bool = all {
    s.pending.get(slot) != "idle", s.pending.get(slot) != "bad-read",
    val operation = s.pending.get(slot)
    val hit = operation == "read" and s.present
    val deleted = operation == "delete"
    s' = s.with("pending", s.pending.set(slot, "idle"))
      .with("present", if (deleted) false else s.present)
      .with("failures", if (deleted or hit) 0 else s.failures)
      .with("reply", if (deleted) "confirmed-delete" else if (hit) "hit" else "miss"),
  }
  // A lost transport response can hide an applied delete. Failure is still an
  // unconfirmed receipt. The conformance case injects loss after a real Redis DEL.
  action lostDeleteReply(slot: int): bool = all {
    s.pending.get(slot) == "delete",
    s' = s.with("pending", s.pending.set(slot, "idle")).with("present", false)
      .with("failures", s.failures + 1)
      .with("lastFailure", s.elapsed).with("lastFailureWall", s.wall)
      .with("reply", "unconfirmed-delete"),
  }
  action step = any {
    tick, probe(false),
    { nondet wall = 0.to(4).oneOf(); setWall(wall) },
    {
      nondet slot = slots.oneOf()
      nondet operation = operations.oneOf()
      begin(slot, operation)
    },
    { nondet slot = slots.oneOf(); any { failed(slot), succeeded(slot), lostDeleteReply(slot) } },
  }

  val counterBound = s.failures >= 0 and s.failures <= 3
  val cooldownUsesElapsedTime = s.reopenRespectedDelay
  val confirmedDeletionHasBackendAbsence =
    s.reply == "confirmed-delete" implies (s.configured and not(s.present))
  val unconfiguredConfirmationHasNoBackend =
    s.reply == "unconfigured-delete" implies (not(s.configured) and not(s.present))
  val noCommandWithoutBackend = not(s.configured) implies
    slots.forall(slot => s.pending.get(slot) == "idle")
  val safety = counterBound and cooldownUsesElapsedTime and confirmedDeletionHasBackendAbsence
    and unconfiguredConfirmationHasNoBackend and noCommandWithoutBackend

  temporal EligibleProbeReopens = probe(false).weakFair(s) implies
    always((s.configured and s.failures >= 2 and not(cooling)) implies
      eventually(s.failures < 2 or cooling))

  run forwardWallJumpCannotReopenTest = initConfigured.then(begin(0, "bad-read"))
    .then(failed(0)).then(begin(0, "bad-read")).then(failed(0))
    .then(setWall(4)).then(probe(false)).then(begin(0, "delete"))
    .expect(s.reply == "unconfirmed-delete" and s.present and safety)
  run legacyWallJumpWouldReopenEarlyTest = initConfigured.then(begin(0, "bad-read"))
    .then(failed(0)).then(begin(0, "bad-read")).then(failed(0))
    .then(setWall(4)).then(probe(true)).expect(not(cooldownUsesElapsedTime))
  run backwardWallJumpCannotDelayRecoveryTest = initConfigured.then(setWall(4))
    .then(begin(0, "bad-read")).then(failed(0)).then(begin(0, "bad-read")).then(failed(0))
    .then(setWall(0)).then(tick).then(tick).then(probe(false))
    .expect(s.failures == 2 and safety)
    .then(tick).then(begin(0, "delete")).then(succeeded(0))
    .expect(s.reply == "confirmed-delete" and not(s.present) and safety)
  run outstandingFailureOutlivesOpeningTest = initConfigured.then(begin(0, "bad-read"))
    .then(failed(0)).then(begin(0, "bad-read")).then(begin(1, "bad-read"))
    .then(failed(0)).then(failed(1)).expect(s.failures == 3 and safety)
  run lateHitCanCloseBreakerTest = initConfigured.then(begin(0, "bad-read")).then(failed(0))
    .then(begin(0, "bad-read")).then(begin(1, "read")).then(failed(0))
    .then(succeeded(1)).expect(s.failures == 0 and s.reply == "hit" and safety)
  run missDoesNotResetFailuresTest = initConfigured.then(begin(0, "bad-read")).then(failed(0))
    .then(begin(0, "miss")).then(succeeded(0))
    .expect(s.failures == 1 and s.reply == "miss" and safety)
  run lostDeleteResponseIsUnconfirmedTest = initConfigured.then(begin(0, "delete"))
    .then(lostDeleteReply(0)).expect(s.reply == "unconfirmed-delete" and not(s.present) and safety)
  run noSelectedBackendNeedsNoDeleteTest = initUnconfigured.then(begin(0, "delete"))
    .expect(s.reply == "unconfigured-delete" and safety)
}
