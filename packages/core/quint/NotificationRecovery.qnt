// Recovery owns one background load per runtime. Its cooldown advances with
// elapsed time. Wall-clock adjustments do not affect admission.
module NotificationRecovery {
  type RequestReceipt = { outcome: str, busy: bool, cooling: bool, availability: str }
  type State = {
    availability: str,
    phase: str,
    failures: int,
    remaining: int,
    receipt: RequestReceipt
  }
  var s: State

  pure val availabilities = Set("failed", "pending", "registering", "registered", "disabled")
  // Six represents every failure count at or above the first capped delay.
  pure val delays = List(0, 1, 2, 4, 8, 16, 30)
  pure def delay(failures: int): int = delays.nth(failures)

  action init = s' = {
    availability: "failed", phase: "idle", failures: 0, remaining: 0,
    receipt: { outcome: "none", busy: false, cooling: false, availability: "failed" }
  }

  action request = {
    // A successful load releases the recovery map before its finally runs.
    val busy = Set("loading", "failure-finally").contains(s.phase)
    val eligible = not(busy) and s.availability == "failed" and s.remaining == 0
    val registered = not(busy) and s.availability == "registered"
    s' = { ...s,
      receipt: { busy: busy, cooling: s.remaining > 0, availability: s.availability,
        outcome: if (busy) "in-flight"
          else if (s.availability != "failed") "unavailable"
          else if (s.remaining > 0) "backoff" else "started" },
      phase: if (eligible) "loading" else s.phase,
      availability: if (eligible) "registering" else s.availability,
      failures: if (registered) 0 else s.failures,
      remaining: if (registered) 0 else s.remaining }
  }

  action loaded = all {
    s.phase == "loading",
    s' = { ...s, phase: "success-finally", availability: "registered",
      failures: 0, remaining: 0 },
  }
  action failed = all {
    s.phase == "loading",
    val failures = if (s.failures == 6) 6 else s.failures + 1
    s' = { ...s, phase: "failure-finally", availability: "failed",
      failures: failures, remaining: delay(failures) },
  }
  action finalize = all {
    Set("success-finally", "failure-finally").contains(s.phase),
    s' = { ...s, phase: "idle" },
  }
  action tick = all {
    s.remaining > 0,
    s' = { ...s, remaining: s.remaining - 1 },
  }
  action cooldownElapsed = all {
    s.remaining > 0,
    s' = { ...s, remaining: 0 },
  }
  action externalAvailability(availability: str): bool = all {
    s.phase == "idle",
    s' = { ...s, availability: availability },
  }
  // A wall-clock jump or an idle observer has no effect on elapsed time.
  action wallClockAdjusted = s' = s
  action step = {
    nondet availability = availabilities.oneOf()
    any {
      request, loaded, failed, finalize, tick, cooldownElapsed,
      externalAvailability(availability), wallClockAdjusted
    }
  }

  val BusyRequestsJoin = s.receipt.busy.implies(s.receipt.outcome == "in-flight")
  val BackoffBlocksAdmission = (s.receipt.outcome == "started").implies(not(s.receipt.cooling))
  val OnlyFailedServicesStart = (s.receipt.outcome == "started").implies(s.receipt.availability == "failed")
  val BoundedCooldown = all {
    s.failures >= 0 and s.failures <= 6,
    s.remaining >= 0 and s.remaining <= delay(s.failures),
  }
  val PhaseMatchesAvailability = all {
    (s.phase == "loading").implies(s.availability == "registering"),
    (s.phase == "success-finally").implies(s.availability == "registered"),
    (s.phase == "failure-finally").implies(s.availability == "failed"),
  }
  temporal OnlyIdleEntersLoad = always((
    (s.phase != "loading" and next(s.phase) == "loading").implies(s.phase == "idle")
  ).orKeep(s))
  temporal AttemptsSettle = (loaded.weakFair(s) and failed.weakFair(s)
    and finalize.weakFair(s)).implies((s.phase != "idle").leadsTo(s.phase == "idle"))
  temporal CooldownElapses = (s.remaining > 0).leadsTo(s.remaining == 0)
  temporal FairCooldownElapses = tick.weakFair(s).implies(CooldownElapses)

  run pendingCatchStillJoinsTest = init.then(request).then(failed).then(request)
    .expect(s.receipt.outcome == "in-flight" and s.phase == "failure-finally")
    .then(finalize).then(request).expect(s.receipt.outcome == "backoff" and s.phase == "idle")
  run retryRestoresReadinessTest = init.then(request).then(failed).then(finalize).then(tick)
    .then(request).then(loaded).then(request).expect(s.receipt.outcome == "unavailable")
    .then(finalize).expect(s.availability == "registered" and s.failures == 0)
  run disabledServiceIsUnavailableTest = init.then(externalAvailability("disabled"))
    .then(request).expect(s.receipt.outcome == "unavailable" and s.phase == "idle")
  run wallAdjustmentLeavesCooldownTest = init.then(request).then(failed).then(finalize)
    .then(wallClockAdjusted).then(request).expect(s.receipt.outcome == "backoff" and s.remaining == 1)
    .then(tick).then(request).expect(s.receipt.outcome == "started")
  run capSaturatesTest = init
    .then(request).then(failed).then(finalize).then(cooldownElapsed)
    .then(request).then(failed).then(finalize).then(cooldownElapsed)
    .then(request).then(failed).then(finalize).then(cooldownElapsed)
    .then(request).then(failed).then(finalize).then(cooldownElapsed)
    .then(request).then(failed).then(finalize).then(cooldownElapsed)
    .then(request).then(failed).expect(s.remaining == 30)
    .then(finalize).then(cooldownElapsed).then(request).then(failed)
    .expect(s.failures == 6 and s.remaining == 30)
}
