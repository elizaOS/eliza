// DiscordInstallWelcomeQueue, discordWelcomeStore and DiscordWelcomeState.
// One valid job, one managed owner, at most two starts. An admitted recovery
// or drain retains its original work until it settles. A retry can temporarily
// have a pending copy and an original processing copy of the same job.
module DiscordWelcomeQueue {
  type State = {
    phase: str, work: str, starts: int, pending: bool, processing: bool,
    accepted: bool, marker: bool,
  }
  var s: State

  action initialize(inProcessing: bool, marked: bool): bool = s' = {
    phase: "stopped", work: "idle", starts: 0,
    pending: not(inProcessing), processing: inProcessing,
    accepted: marked, marker: marked,
  }
  action init = any {
    initialize(false, false), initialize(true, false), initialize(true, true),
  }
  action start = all {
    s.phase == "stopped", s.starts < 2,
    s' = { ...s, phase: "starting", work: "recover", starts: s.starts + 1 },
  }
  action recoverRow = all {
    s.work == "recover", s.processing,
    s' = { ...s, processing: false, pending: true },
  }
  action finishRecovery = all {
    s.work == "recover", not(s.processing),
    // Starting the timer and admitting the immediate drain share this step.
    s' = if (s.phase == "starting") {
      ...s, phase: "running", work: if (s.pending) "claim" else "idle",
    } else { ...s, work: "idle" },
  }
  action recoveryRejected = all {
    s.work == "recover",
    s' = { ...s, work: "idle", phase: if (s.phase == "starting") "stopped" else "stopping" },
  }
  action stop = all {
    s.phase.in(Set("starting", "running")), s' = { ...s, phase: "stopping" },
  }
  action finishStop = all {
    s.phase == "stopping", s.work == "idle", s' = { ...s, phase: "stopped" },
  }

  action poll = all {
    s.phase == "running", s.work == "idle", s.pending,
    s' = { ...s, work: "claim" },
  }
  action claim = all {
    s.work == "claim", s.pending, not(s.processing),
    s' = { ...s, pending: false, processing: true, work: "inspect" },
  }
  action inspectMarker = all {
    s.work == "inspect",
    s' = { ...s, work: if (s.marker) "ack" else "send" },
  }
  action providerAccepted = all {
    s.work == "send", s' = { ...s, accepted: true, work: "record" },
  }
  action providerRetry = all { s.work == "send", s' = { ...s, work: "retry" } }
  action providerRejected = all { s.work == "send", s' = { ...s, work: "drop" } }
  action recordMarker = all {
    s.work == "record", s' = { ...s, marker: true, work: "ack" },
  }
  action pushRetry = all {
    s.work == "retry", s' = { ...s, pending: true, work: "retryAck" },
  }
  action removeClaim = all {
    s.work.in(Set("ack", "retryAck", "drop")),
    s' = { ...s, processing: false, work: "idle" },
  }

  action settle = any {
    recoverRow, finishRecovery, recoveryRejected, claim, inspectMarker,
    providerAccepted, providerRetry, providerRejected, recordMarker,
    pushRetry, removeClaim,
  }
  action step = any { start, stop, finishStop, poll, settle, s' = s }

  val draining = not(s.work.in(Set("idle", "recover")))
  val TypeOK = and {
    s.phase.in(Set("stopped", "starting", "running", "stopping")),
    s.work.in(Set("idle", "recover", "claim", "inspect", "send", "record", "ack", "retry", "retryAck", "drop")),
    s.starts.in(0.to(2)),
  }
  val StopRequiresQuiescence = (s.phase == "stopped").implies(s.work == "idle")
  val MarkerRequiresObservedAcceptance = s.marker.implies(s.accepted)
  val RetainedMarkerSkipsProvider = s.marker.implies(s.work != "send")
  val RetryRetainsBothCopies = (s.work == "retryAck").implies(s.pending and s.processing)

  temporal StopClosesAdmission = always((s.phase == "stopping").implies(
    next(s.phase).in(Set("stopping", "stopped")) and
    (s.work != "claim").implies(next(s.work) != "claim")
  ).orKeep(s))
  temporal ProcessingRemovalRequiresOutcome = always((s.processing and not(next(s.processing))).implies(or {
    s.work == "recover" and next(s.pending),
    s.work == "ack" and s.marker,
    s.work == "retryAck" and s.pending,
    s.work == "drop",
  }).orKeep(s))
  temporal DrainSettles = settle.weakFair(s).implies(draining.leadsTo(not(draining)))
  temporal StopWithoutFairness = (s.phase == "stopping").leadsTo(s.phase == "stopped")
  temporal StopSettles = (settle.weakFair(s) and finishStop.weakFair(s)).implies(StopWithoutFairness)

  run stopJoinsRecoveryTest = initialize(true, false).then(start).then(recoverRow)
    .then(stop).expect(s.work == "recover" and s.phase == "stopping")
    .then(finishRecovery).then(finishStop)
    .expect(s.pending and s.phase == "stopped" and not(s.marker))
    .then(start).then(finishRecovery).then(claim).then(inspectMarker)
    .expect(s.work == "send" and s.starts == 2)
  run stopJoinsAdmittedDeliveryTest = initialize(false, false).then(start)
    .then(finishRecovery).then(claim).then(inspectMarker).then(stop)
    .then(providerAccepted).then(recordMarker).then(removeClaim).then(finishStop)
    .expect(s.phase == "stopped" and s.marker and not(s.processing))
  run retainedMarkerAcknowledgesWithoutSendingTest = initialize(true, true).then(start)
    .then(recoverRow).then(finishRecovery).then(claim).then(inspectMarker)
    .expect(s.work == "ack").then(removeClaim).expect(s.marker and not(s.processing))
  run transientFailurePublishesRetryBeforeAcknowledgingTest = initialize(false, false)
    .then(start).then(finishRecovery).then(claim).then(inspectMarker)
    .then(providerRetry).then(pushRetry).expect(s.pending and s.processing and not(s.marker))
    .then(stop).then(removeClaim).then(finishStop).expect(s.pending and not(s.processing))
  run failedRecoveryRetainsOriginalClaimTest = initialize(true, false).then(start)
    .then(stop).then(recoveryRejected).then(finishStop)
    .expect(s.phase == "stopped" and s.processing and not(s.marker))
}
