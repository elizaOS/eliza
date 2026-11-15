// DiscordInstallWelcomeQueue, discordWelcomeStore and DiscordWelcomeState.
// One valid job, one managed owner, at most two starts. An admitted recovery
// or drain retains its original work until it settles. A retry atomically
// replaces the original processing row with a pending row.
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
  action replaceWithRetry = all {
    s.work == "retry", s' = { ...s, pending: true, processing: false, work: "idle" },
  }
  action removeClaim = all {
    s.work.in(Set("ack", "drop")),
    s' = { ...s, processing: false, work: "idle" },
  }

  action settle = any {
    recoverRow, finishRecovery, recoveryRejected, claim, inspectMarker,
    providerAccepted, providerRetry, providerRejected, recordMarker,
    replaceWithRetry, removeClaim,
  }
  action step = any { start, stop, finishStop, poll, settle, s' = s }

  val draining = not(s.work.in(Set("idle", "recover")))
  val TypeOK = and {
    s.phase.in(Set("stopped", "starting", "running", "stopping")),
    s.work.in(Set("idle", "recover", "claim", "inspect", "send", "record", "ack", "retry", "drop")),
    s.starts.in(0.to(2)),
  }
  val StopRequiresQuiescence = (s.phase == "stopped").implies(s.work == "idle")
  val MarkerRequiresObservedAcceptance = s.marker.implies(s.accepted)
  val RetainedMarkerSkipsProvider = s.marker.implies(s.work != "send")
  val NoOverlappingRetryCopies = not(s.pending and s.processing)

  temporal StopClosesAdmission = always((s.phase == "stopping").implies(
    next(s.phase).in(Set("stopping", "stopped")) and
    (s.work != "claim").implies(next(s.work) != "claim")
  ).orKeep(s))
  temporal ProcessingRemovalRequiresOutcome = always((s.processing and not(next(s.processing))).implies(or {
    s.work == "recover" and next(s.pending),
    s.work == "ack" and s.marker,
    s.work == "retry" and next(s.pending),
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
  run transientFailureReplacesClaimInOneCommitTest = initialize(false, false)
    .then(start).then(finishRecovery).then(claim).then(inspectMarker)
    .then(providerRetry).then(stop).expect(not(s.pending) and s.processing and not(s.marker))
    .then(replaceWithRetry).then(finishStop).expect(s.pending and not(s.processing))
  run failedRecoveryRetainsOriginalClaimTest = initialize(true, false).then(start)
    .then(stop).then(recoveryRejected).then(finishStop)
    .expect(s.phase == "stopped" and s.processing and not(s.marker))
}

// One original processing claim after the provider outcome. SQLite mutation
// and the transport reply are separate. A failed receipt keeps the effects
// already applied. The restart ends at the next provider or retry decision.
module DiscordWelcomeReceiptRecovery {
  type State = {
    phase: str, original: str, retryCopies: int,
    marker: bool, providerAccepted: bool,
  }
  var s: State

  action initialize(accepted: bool): bool = s' = {
    phase: if (accepted) "mark" else "push", original: "processing",
    retryCopies: 0, marker: false, providerAccepted: accepted,
  }
  action init = any { initialize(true), initialize(false) }
  val writing = s.phase.in(Set("mark", "marked", "push", "pushed", "remove", "removed"))
  val recovering = s.phase.in(Set("restart", "claim", "readMarker", "ackReplay"))

  action applyMarker = all {
    s.phase == "mark", s' = { ...s, phase: "marked", marker: true },
  }
  action applyRetry = all {
    s.phase == "push",
    s' = if (s.original == "processing") {
      ...s, phase: "pushed", original: "absent", retryCopies: s.retryCopies + 1,
    } else { ...s, phase: "failed" },
  }
  action applyRemoval = all {
    s.phase == "remove", s' = { ...s, phase: "removed", original: "absent" },
  }
  action acknowledge = all {
    s.phase.in(Set("marked", "pushed", "removed")),
    s' = { ...s, phase: if (s.phase == "marked") "remove" else "done" },
  }
  // Before-apply rejection and after-apply reply loss retain different rows.
  action receiptFailure = all { writing, s' = { ...s, phase: "failed" } }
  // A transport can retry the same operation after losing the first reply.
  action replayRetry = all {
    s.phase == "failed", s.retryCopies > 0, s' = { ...s, phase: "push" },
  }
  action restart = all { s.phase == "failed", s' = { ...s, phase: "restart" } }
  action recover = all {
    s.phase == "restart",
    s' = {
      ...s, original: if (s.original == "processing") "pending" else "absent",
      phase: if (s.retryCopies > 0) "retryAvailable"
        else if (s.original == "processing") "claim" else "done",
    },
  }
  action claim = all {
    s.phase == "claim", s.original == "pending",
    s' = { ...s, phase: "readMarker", original: "processing" },
  }
  action readMarker = all {
    s.phase == "readMarker",
    s' = { ...s, phase: if (s.marker) "ackReplay" else "needsSend" },
  }
  action acknowledgeReplay = all {
    s.phase == "ackReplay", s' = { ...s, phase: "done", original: "absent" },
  }
  action settleWrite = any { applyMarker, applyRetry, applyRemoval, acknowledge, receiptFailure }
  action settleRecovery = any { recover, claim, readMarker, acknowledgeReplay }
  action step = any { settleWrite, replayRetry, restart, settleRecovery, s' = s }

  val AcceptedClaimWithoutMarkerSurvives = (s.providerAccepted and not(s.marker)).implies(s.original != "absent")
  val AcceptedDeliveryHasNoRetryCopy = s.providerAccepted.implies(s.retryCopies == 0)
  val RemovalRequiresDurableReplacement = (s.original == "absent").implies(s.marker or s.retryCopies > 0)
  val RetryRetiresOriginal = (s.retryCopies > 0).implies(s.original == "absent")
  val NoDuplicateRetry = s.retryCopies.in(0.to(1))
  val MarkerPreventsRecoverySend = s.marker.implies(s.phase != "needsSend")
  temporal FailedReceiptRetainsStorage = always((writing and next(s.phase) == "failed").implies(
    next(s.original) == s.original and next(s.marker) == s.marker and next(s.retryCopies) == s.retryCopies
  ).orKeep(s))
  temporal MarkerSurvivesRestart = always(s.marker.implies(next(s.marker)).orKeep(s))
  temporal WriteSettles = settleWrite.weakFair(s).implies(writing.leadsTo(not(writing)))
  temporal RecoverySettles = settleRecovery.weakFair(s).implies(recovering.leadsTo(not(recovering)))

  run rejectedMarkerRetainsClaimTest = initialize(true).then(receiptFailure)
    .then(restart).then(recover).then(claim).then(readMarker)
    .expect(s.phase == "needsSend" and AcceptedClaimWithoutMarkerSurvives)
  run lostMarkerReplySkipsProviderTest = initialize(true).then(applyMarker).then(receiptFailure)
    .then(restart).then(recover).then(claim).then(readMarker).then(acknowledgeReplay)
    .expect(s.phase == "done" and s.marker and s.original == "absent" and s.retryCopies == 0)
  run lostRemovalReplyKeepsCompletedStateTest = initialize(true).then(applyMarker)
    .then(acknowledge).then(applyRemoval).then(receiptFailure).then(restart).then(recover)
    .expect(s.phase == "done" and s.marker and s.original == "absent")
  run lostRetryReplyKeepsOnlyRetryTest = initialize(false).then(applyRetry).then(receiptFailure)
    .then(replayRetry).then(applyRetry).expect(s.phase == "failed" and s.retryCopies == 1)
    .then(restart).then(recover)
    .expect(s.phase == "retryAvailable" and s.original == "absent" and s.retryCopies == 1 and not(s.marker))
  run rejectedRetryRetainsClaimTest = initialize(false).then(receiptFailure)
    .then(restart).then(recover).then(claim).then(readMarker)
    .expect(s.phase == "needsSend" and s.original == "processing" and s.retryCopies == 0)
}

// One admitted marker lookup for a retained processing row. The reply is
// delivered separately from the Worker version that computed its header.
// Recovery uses the same queue's ordinary empty-pending fallback.
module DiscordWelcomeCompatibility {
  var s: { capable: bool, phase: str }
  action initialize(capable: bool): bool = s' = { capable: capable, phase: "reading" }
  action init = any { initialize(false), initialize(true) }
  action upgrade = all { not(s.capable), s' = { ...s, capable: true } }
  action readMarker = all {
    s.phase == "reading",
    s' = { ...s, phase: if (s.capable) "supportedReply" else "legacyReply" },
  }
  action deliver = all {
    s.phase.in(Set("legacyReply", "supportedReply")),
    s' = { ...s, phase: if (s.phase == "legacyReply") "blocked" else "admitted" },
  }
  action recover = all { s.phase == "blocked", s' = { ...s, phase: "pending" } }
  action claim = all { s.phase == "pending", s' = { ...s, phase: "reading" } }
  action dispatch = all { s.phase == "admitted", s' = { ...s, phase: "dispatched" } }
  action advance = any { readMarker, deliver, recover, claim, dispatch }
  action step = any { upgrade, advance, s' = s }

  val TypeOK = s.phase.in(Set("reading", "legacyReply", "supportedReply", "blocked", "pending", "admitted", "dispatched"))
  val LegacyWorkerCannotAdmit = not(s.capable).implies(not(s.phase.in(Set("admitted", "dispatched"))))
  temporal LegacyReplyRemainsUntrusted = always((s.phase == "legacyReply").implies(
    next(s.phase).in(Set("legacyReply", "blocked"))
  ).orKeep(s))
  temporal DispatchRequiresSupport = always((s.phase != "dispatched" and next(s.phase) == "dispatched").implies(
    s.phase == "admitted"
  ).orKeep(s))
  temporal UpgradeAllowsProgress = advance.weakFair(s).implies(s.capable.leadsTo(s.phase == "dispatched"))

  run oldReplyStaysBlockedThroughUpgradeTest = initialize(false).then(readMarker)
    .then(upgrade).then(deliver).expect(s.phase == "blocked")
    .then(recover).then(claim).then(readMarker).then(deliver).then(dispatch)
    .expect(s.phase == "dispatched" and s.capable)
  run oldWorkerKeepsRetainedClaimTest = initialize(false).then(readMarker).then(deliver)
    .then(recover).then(claim).then(readMarker).then(deliver)
    .expect(s.phase == "blocked" and LegacyWorkerCannotAdmit)
}
