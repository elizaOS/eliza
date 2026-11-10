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

// One runtime can replace its mapped recovery while an older load receipt is
// still being delivered. Each callback retains its own coordinator record.
module NotificationRecoveryOwnership {
  type Recovery = { phase: str, cooling: bool }
  val Owners = Set(1, 2)
  val availabilities = Set("failed", "pending", "registering", "registered", "disabled")
  val busyPhases = Set("loading", "returned", "failure-finally")
  var s: { availability: str, mapped: int, allocated: int, records: int -> Recovery,
    receipt: { outcome: str, busy: bool, cooling: bool, availability: str } }
  val mappedBusy = if (s.mapped == 0) false else busyPhases.contains(s.records.get(s.mapped).phase)
  val mappedCooling = if (s.mapped == 0) false else s.records.get(s.mapped).cooling

  action init = s' = { availability: "failed", mapped: 0, allocated: 0,
    records: Owners.mapBy(_ => { phase: "idle", cooling: false }),
    receipt: { outcome: "none", busy: false, cooling: false, availability: "failed" } }
  action request = {
    val eligible = not(mappedBusy) and s.availability == "failed" and not(mappedCooling)
    val owner = if (s.mapped != 0) s.mapped else if (s.allocated == 0) 1 else 2
    all {
      not(eligible) or s.mapped != 0 or s.allocated < 2,
      s' = { ...s, receipt: { busy: mappedBusy, cooling: mappedCooling, availability: s.availability,
          outcome: if (mappedBusy) "in-flight" else if (s.availability != "failed") "unavailable"
            else if (mappedCooling) "backoff" else "started" },
        mapped: if (eligible) owner else if (not(mappedBusy) and s.availability == "registered") 0 else s.mapped,
        allocated: if (eligible and s.mapped == 0) s.allocated + 1 else s.allocated,
        records: if (eligible) s.records.set(owner, { phase: "loading", cooling: false }) else s.records,
        availability: if (eligible) "registering" else s.availability },
    }
  }
  action externalAvailability(availability: str): bool = s' = { ...s, availability: availability }
  action observeRegistered = all {
    s.availability == "registered", s' = { ...s, mapped: 0 },
  }
  action returnLoad(owner: int): bool = all {
    s.records.get(owner).phase == "loading", s.availability == "registered",
    s' = { ...s, records: s.records.set(owner, { ...s.records.get(owner), phase: "returned" }) },
  }
  action succeed(owner: int): bool = all {
    s.records.get(owner).phase == "returned",
    s' = { ...s, mapped: if (s.mapped == owner) 0 else s.mapped,
      records: s.records.set(owner, { ...s.records.get(owner), phase: "success-finally" }) },
  }
  action loadFailed(owner: int): bool = all {
    s.records.get(owner).phase == "loading",
    s' = { ...s, records: s.records.set(owner, { phase: "failure-finally", cooling: true }) },
  }
  action finalize(owner: int): bool = all {
    Set("success-finally", "failure-finally").contains(s.records.get(owner).phase),
    s' = { ...s, records: s.records.set(owner, { ...s.records.get(owner), phase: "idle" }) },
  }
  action cooldownElapsed(owner: int): bool = all {
    s.records.get(owner).cooling,
    s' = { ...s, records: s.records.set(owner, { ...s.records.get(owner), cooling: false }) },
  }
  // The logger, runtime error boundary and event bus catch their observers.
  action diagnosticObserverThrows = s' = s
  action complete(owner: int): bool = any {
    returnLoad(owner), succeed(owner), loadFailed(owner), finalize(owner),
  }
  action step = {
    nondet owner = Owners.oneOf()
    nondet availability = availabilities.oneOf()
    any { request, externalAvailability(availability), observeRegistered, complete(owner),
      cooldownElapsed(owner), diagnosticObserverThrows }
  }

  val BusyRequestsJoin = s.receipt.busy.implies(s.receipt.outcome == "in-flight")
  val CoolingCurrentEntryBacksOff = (not(s.receipt.busy) and s.receipt.cooling
    and s.receipt.availability == "failed").implies(s.receipt.outcome == "backoff")
  val SuccessfulReceiptReleasesItsOwnMap = (s.mapped != 0)
    .implies(s.records.get(s.mapped).phase != "success-finally")
  temporal StaleSuccessPreservesCurrentOwner = always(Owners.forall(owner =>
    (s.records.get(owner).phase == "returned" and next(s.records.get(owner).phase) == "success-finally"
      and s.mapped != owner).implies(next(s.mapped) == s.mapped)).orKeep(s))
  temporal StaleFailurePreservesCurrentOwner = always(Owners.forall(owner =>
    (s.records.get(owner).phase == "loading" and next(s.records.get(owner).phase) == "failure-finally"
      and s.mapped != owner).implies(next(s.mapped) == s.mapped)).orKeep(s))
  temporal DetachedFinallyPreservesCurrentOwner = always(Owners.forall(owner =>
    (Set("success-finally", "failure-finally").contains(s.records.get(owner).phase)
      and next(s.records.get(owner).phase) == "idle" and s.mapped != owner)
        .implies(next(s.mapped) == s.mapped)).orKeep(s))
  temporal AttemptsSettle = Owners.forall(owner => complete(owner).weakFair(s))
    .implies(Owners.forall(owner => (s.records.get(owner).phase != "idle")
      .leadsTo(s.records.get(owner).phase == "idle")))

  run lateSuccessRetainsReplacementBackoffTest = init.then(request)
    .then(externalAvailability("registered")).then(returnLoad(1)).then(observeRegistered)
    .then(externalAvailability("failed")).then(request).then(succeed(1))
    .expect(s.mapped == 2).then(externalAvailability("failed"))
    .then(loadFailed(2)).then(diagnosticObserverThrows).then(finalize(2))
    .then(finalize(1)).then(request).expect(s.receipt.outcome == "backoff")
  run diagnosticFailureDoesNotClearCooldownTest = init.then(request)
    .then(externalAvailability("failed")).then(loadFailed(1))
    .then(diagnosticObserverThrows).then(finalize(1)).then(request)
    .expect(s.receipt.outcome == "backoff" and s.mapped == 1)
}
