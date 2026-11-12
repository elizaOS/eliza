// PluginActivatorService registerPlugin, lazy poll and activation promise.
// One plugin, one registration, one poll failure and one permanent retirement.
// Requirements and poll queries keep their await boundaries. A callback that
// began before stop may finish afterward; its effects cannot be undone here.
module PluginActivatorLifecycle {
  var s: {
    phase: str, epoch: int, registration: str, registrationEpoch: int,
    pending: bool, timer: bool, poll: str, pollEpoch: int, pollFailures: int,
    secretsReady: bool, activation: str, callbackCount: int, lateCallback: bool
  }
  action init = s' = {
    phase: "open", epoch: 0, registration: "idle", registrationEpoch: -1,
    pending: false, timer: false, poll: "idle", pollEpoch: -1, pollFailures: 0,
    secretsReady: false, activation: "idle", callbackCount: 0, lateCallback: false
  }
  action register = all {
    s.phase == "open", s.registration == "idle",
    s' = { ...s, registration: "checking", registrationEpoch: s.epoch }
  }
  action requirements = all {
    s.registration == "checking",
    s' = if (s.phase != "open" or s.registrationEpoch != s.epoch)
      { ...s, registration: "retired" }
    else if (s.secretsReady)
      { ...s, registration: "done", activation: "scheduled" }
    else { ...s, registration: "done", pending: true, timer: true }
  }
  action requirementsFail = all {
    s.registration == "checking", s' = { ...s, registration: "failed" }
  }
  action secretsArrive = all {
    not(s.secretsReady), s' = { ...s, secretsReady: true }
  }
  action poll = all {
    s.phase == "open", s.timer, s.poll == "idle",
    s' = if (s.pending) { ...s, poll: "checking", pollEpoch: s.epoch }
      else { ...s, timer: false }
  }
  action pollResult = all {
    s.poll == "checking",
    s' = if (s.phase != "open" or s.pollEpoch != s.epoch or not(s.pending))
      { ...s, poll: "idle", timer: false }
    else if (s.secretsReady)
      { ...s, poll: "activating", activation: "scheduled" }
    else { ...s, poll: "idle" }
  }
  action pollFail = all {
    s.poll == "checking", s.pollFailures == 0,
    s' = { ...s, poll: "idle", pollFailures: 1 }
  }
  action settlePoll = any { pollResult, pollFail }
  action pollActivationSettles = all {
    s.poll == "activating", s.activation.in(Set("done", "cancelled")),
    s' = { ...s, poll: "idle", timer: s.phase == "open" and s.pending }
  }
  action requirementsSettle = any { requirements, requirementsFail }
  action dispatch = all {
    s.activation == "scheduled",
    s' = if (s.phase == "open") {
      ...s, activation: "running", callbackCount: s.callbackCount + 1,
      lateCallback: s.lateCallback or s.phase != "open"
    } else { ...s, activation: "cancelled" }
  }
  action callbackSettles = all {
    s.activation == "running", s' = { ...s, activation: "done", pending: false }
  }
  action unregister = all {
    s.phase == "open", s.pending, s.activation != "running",
    s' = { ...s, pending: false }
  }
  action stop = all {
    s.phase == "open", s' = { ...s, phase: "stopping", epoch: 1, timer: false }
  }
  action finishStop = all {
    s.phase == "stopping", s.poll == "idle",
    not(s.activation.in(Set("scheduled", "running"))),
    s' = { ...s, phase: "stopped", pending: false }
  }
  action step = any {
    register, requirementsSettle, secretsArrive, poll, settlePoll, pollActivationSettles,
    dispatch, callbackSettles, unregister, stop, finishStop, s' = s
  }
  val TypeOK = all {
    s.phase.in(Set("open", "stopping", "stopped")), s.epoch.in(Set(0, 1)),
    s.registration.in(Set("idle", "checking", "done", "retired", "failed")),
    s.registrationEpoch.in(Set(-1, 0)), s.pollEpoch.in(Set(-1, 0)),
    s.poll.in(Set("idle", "checking", "activating")), s.pollFailures.in(Set(0, 1)),
    s.activation.in(Set("idle", "scheduled", "running", "done", "cancelled")),
    s.callbackCount >= 0, s.callbackCount <= 1
  }
  val RetiredTimerStopped = s.phase != "open" implies not(s.timer)
  val NoLateCallback = not(s.lateCallback)
  val StoppedReleased = s.phase == "stopped" implies
    not(s.pending) and s.poll == "idle" and not(s.activation.in(Set("scheduled", "running")))
  temporal Fairness = all {
    requirementsSettle.weakFair(s), poll.weakFair(s),
    settlePoll.weakFair(s), pollActivationSettles.weakFair(s), dispatch.weakFair(s), callbackSettles.weakFair(s),
    finishStop.weakFair(s)
  }
  temporal ReadyWithoutFairness = (s.phase == "open" and s.pending and s.secretsReady)
    .leadsTo(s.activation == "done" or s.phase != "open" or not(s.pending))
  temporal ReadySettles = Fairness.implies(ReadyWithoutFairness)
  temporal StopSettles = Fairness.implies(
    (s.phase == "stopping").leadsTo(s.phase == "stopped"))

  action legacyRequirements = all {
    s.registration == "checking", not(s.secretsReady),
    s' = { ...s, registration: "done", pending: true, timer: true }
  }
  run lateRegistrationCannotRestartTimerTest = init.then(register).then(stop)
    .then(finishStop).then(requirements).expect(RetiredTimerStopped and StoppedReleased)
  run pendingPollCannotActivateAfterStopTest = init.then(register).then(requirements)
    .then(poll).then(stop).then(secretsArrive).then(pollResult).then(finishStop)
    .expect(NoLateCallback and s.callbackCount == 0 and StoppedReleased)
  run scheduledActivationRechecksStopTest = init.then(secretsArrive).then(register)
    .then(requirements).then(stop).then(dispatch).then(finishStop)
    .expect(NoLateCallback and s.callbackCount == 0)
  run begunCallbackCanSettleDuringStopTest = init.then(secretsArrive).then(register)
    .then(requirements).then(dispatch).then(stop).then(callbackSettles).then(finishStop)
    .expect(NoLateCallback and s.callbackCount == 1 and StoppedReleased)
  run failedPollRetriesTest = init.then(register).then(requirements).then(poll)
    .then(pollFail).then(secretsArrive).then(poll).then(pollResult).then(dispatch)
    .then(callbackSettles).expect(s.activation == "done" and NoLateCallback)
  run oldLateRegistrationWitnessTest = init.then(register).then(stop).then(finishStop)
    .then(legacyRequirements).expect(not(RetiredTimerStopped))
}
