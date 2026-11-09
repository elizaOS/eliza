// Recovery admission through the static NotificationService coordinator.
// Catch and finally are separate phases so a retry can arrive between them.
module NotificationRecovery {
  var s: { enabled: bool, instance: bool, status: str, phase: str, mappedBusy: bool,
    attempts: int, settled: int, failures: int, cooldown: int,
    outcome: str, observedBusy: bool, observedCooldown: int, observedAvailability: str }
  action init = s' = { enabled: true, instance: false, status: "failed", phase: "idle", mappedBusy: false,
    attempts: 0, settled: 0, failures: 0, cooldown: 0, outcome: "none",
    observedBusy: false, observedCooldown: 0, observedAvailability: "failed" }
  val availability = if (s.instance) "registered" else if (not(s.enabled)) "disabled"
    else if (Set("pending", "registering").contains(s.status)) s.status
    else if (Set("failed", "registered").contains(s.status)) "failed" else "pending"
  action request = {
    val eligible = not(s.mappedBusy) and availability == "failed" and s.cooldown == 0
    all {
      not(eligible) or s.attempts < 2,
      s' = { ...s, outcome: if (s.mappedBusy) "in-flight"
        else if (availability != "failed") "unavailable"
        else if (s.cooldown > 0) "backoff" else "started",
        observedBusy: s.mappedBusy, observedCooldown: s.cooldown, observedAvailability: availability,
        attempts: s.attempts + (if (eligible) 1 else 0),
        mappedBusy: s.mappedBusy or eligible,
        phase: if (eligible) "loading" else s.phase,
        status: if (eligible) "registering" else s.status,
        failures: if (s.instance and not(s.mappedBusy)) 0 else s.failures,
        cooldown: if (s.instance and not(s.mappedBusy)) 0 else s.cooldown },
    }
  }
  action loaded = all {
    s.phase == "loading",
    s' = { ...s, phase: "success-finally", instance: true, status: "registered",
      mappedBusy: false, settled: s.settled + 1, failures: 0, cooldown: 0 },
  }
  action failed = all {
    s.phase == "loading",
    s' = { ...s, phase: "failure-finally", status: "failed", settled: s.settled + 1,
      failures: s.failures + 1, cooldown: s.failures + 1 },
  }
  action finalize = all {
    Set("success-finally", "failure-finally").contains(s.phase),
    s' = { ...s, phase: "idle", mappedBusy: false },
  }
  action tick = s' = { ...s, cooldown: if (s.cooldown > 0) s.cooldown - 1 else 0 }
  action externalState(serviceEnabled: bool, instance: bool, status: str): bool = all {
    s.phase == "idle",
    s' = { ...s, enabled: serviceEnabled, instance: instance, status: status },
  }
  action step = {
    nondet serviceEnabled = Set(true, false).oneOf()
    nondet instance = Set(true, false).oneOf()
    nondet status = Set("failed", "pending", "registering", "registered", "unknown").oneOf()
    any { request, loaded, failed, finalize, tick, externalState(serviceEnabled, instance, status), s' = s }
  }
  val SingleLoad = s.attempts - s.settled >= 0 and s.attempts - s.settled <= 1
  val BusyRequestsJoin = s.observedBusy.implies(s.outcome == "in-flight")
  val BackoffBlocksAdmission = (s.outcome == "started").implies(s.observedCooldown == 0)
  val OnlyFailedServicesStart = (s.outcome == "started").implies(s.observedAvailability == "failed")
  val BoundedCooldown = s.cooldown >= 0 and s.cooldown <= 2 and s.failures <= 2
  temporal AttemptsSettle = (loaded.weakFair(s) and failed.weakFair(s)
    and finalize.weakFair(s)).implies((s.phase != "idle").leadsTo(s.phase == "idle"))
  run pendingCatchStillJoinsTest = init.then(request).then(failed).then(request)
    .expect(s.outcome == "in-flight" and s.attempts == 1).then(finalize).then(request)
    .expect(s.outcome == "backoff" and s.attempts == 1)
  run retryRestoresReadinessTest = init.then(request).then(failed).then(finalize).then(tick)
    .then(request).then(loaded).then(request).expect(s.outcome == "unavailable")
    .then(finalize).expect(s.instance and s.attempts == 2)
  run missingRegisteredInstanceIsFailureTest = init.then(externalState(true, false, "registered"))
    .then(request).expect(s.outcome == "started")
  run disabledServiceIsUnavailableTest = init.then(externalState(false, false, "failed"))
    .then(request).expect(s.outcome == "unavailable" and s.attempts == 0)
}
