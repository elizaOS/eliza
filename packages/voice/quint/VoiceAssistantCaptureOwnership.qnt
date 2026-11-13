// One half-duplex capture, one turn and one replacement capture. The port's
// close, reopen and cancel promises settle independently of controller calls.
module VoiceAssistantCaptureOwnership {
  pure val Closing = Set("turn-close", "mute-close")
  pure val HeldTurn = Set("await-close", "ready-to-send", "reply")
  type State = {
    owner: str, capture: str, turn: str, muted: bool,
    turnCloseConfirmed: bool, sent: bool, reopenIssued: bool,
    lateCapture: bool, lateCancelSettled: bool,
  }

  var s: State

  action init = s' = {
    owner: "live", capture: "owned", turn: "before-turn", muted: false,
    turnCloseConfirmed: false, sent: false, reopenIssued: false,
    lateCapture: false, lateCancelSettled: false,
  }

  val live = s.owner == "live"
  val closing = Closing.contains(s.capture)
  val held = HeldTurn.contains(s.turn)

  action submit = all {
    live and not(s.muted) and s.capture == "owned" and s.turn == "before-turn",
    s' = { ...s, capture: "turn-close", turn: "await-close" },
  }

  action mute = all {
    live and not(s.muted),
    s' = { ...s, muted: true, capture: if (s.capture == "owned") "mute-close" else s.capture },
  }

  action unmute = all {
    live and s.muted,
    s' = { ...s, muted: false },
  }

  action settleClose(success: bool): bool = all {
    closing,
    s' = if (not(live)) { ...s, capture: "absent" }
      else if (not(success)) { ...s, capture: "absent", owner: "failed" }
      else if (s.capture == "turn-close") {
        ...s, capture: "absent", turn: "ready-to-send", turnCloseConfirmed: true,
      } else { ...s, capture: "absent" },
  }

  action sendTurn = all {
    live and s.turn == "ready-to-send" and s.turnCloseConfirmed,
    s' = { ...s, turn: "reply", sent: true },
  }

  // The modeled reply has settled and its playback has drained.
  action finishTurn = all {
    live and s.turn == "reply",
    s' = { ...s, turn: "finished" },
  }

  val canReopen = live and not(s.muted) and not(held) and not(s.reopenIssued)
    and s.capture == "absent"

  action requestReopen = all {
    canReopen,
    s' = { ...s, capture: "opening", reopenIssued: true },
  }

  action settleReopen(success: bool): bool = all {
    s.capture == "opening",
    s' = if (not(live)) {
      ...s, capture: if (success) "cancel-late" else "absent", lateCapture: success,
    } else if (success) {
      ...s, capture: if (s.muted) "mute-close" else "owned",
    } else { ...s, capture: "absent", owner: "failed" },
  }

  // Generation retirement is immediate. An already-owned capture's cancel is
  // synchronous in this case. Pending close or acquisition work remains owned.
  action stop = all {
    live,
    s' = { ...s, owner: "stopping", capture: if (s.capture == "owned") "absent" else s.capture },
  }

  action settleLateCancel = all {
    s.owner == "stopping" and s.capture == "cancel-late",
    s' = { ...s, capture: "absent", lateCancelSettled: true },
  }

  action acknowledgeStop = all {
    s.owner == "stopping" and s.capture == "absent",
    s' = { ...s, owner: "stopped" },
  }

  action closeReturns = any { settleClose(true), settleClose(false) }
  action reopenReturns = any { settleReopen(true), settleReopen(false) }
  action step = any {
    submit, mute, unmute, closeReturns, sendTurn, finishTurn, requestReopen,
    reopenReturns, stop, settleLateCancel, acknowledgeStop, s' = s,
  }

  val SendNeedsConfirmedClose = s.sent implies s.turnCloseConfirmed

  val CaptureAdoptionRequiresLiveUnmutedOwner =
    s.capture == "owned" implies live and not(s.muted) and not(held)

  val StopWaitsForLateCancellation = and {
    s.lateCancelSettled implies s.lateCapture,
    s.owner == "stopped" implies s.capture == "absent" and
      (s.lateCapture implies s.lateCancelSettled),
  }

  temporal RetiredOwnerCannotSendOrReopen = always((
    not(live) implies next(s.sent) == s.sent and next(s.reopenIssued) == s.reopenIssued
      and next(s.capture) != "owned"
  ).orKeep(s))

  temporal PendingCaptureOperationsSettle = and {
    closing.leadsTo(not(closing)),
    (s.capture == "opening").leadsTo(s.capture != "opening"),
    (s.owner == "stopping").leadsTo(s.owner == "stopped"),
    canReopen.leadsTo(not(canReopen)),
  }

  temporal UnderFairCaptureReceipts = and {
    closeReturns.weakFair(s), requestReopen.weakFair(s), reopenReturns.weakFair(s),
    settleLateCancel.weakFair(s), acknowledgeStop.weakFair(s),
  } implies PendingCaptureOperationsSettle

  run TurnWaitsForCloseAndReopensAfterDrainTest = init
    .then(submit).expect(not(s.sent) and s.capture == "turn-close")
    .then(settleClose(true)).then(sendTurn).then(finishTurn)
    .then(requestReopen).then(settleReopen(true))
    .expect(s.sent and s.capture == "owned" and CaptureAdoptionRequiresLiveUnmutedOwner)

  run IdleMuteAndUnmuteTest = init.then(mute).then(settleClose(true))
    .expect(s.muted and s.capture == "absent" and not(canReopen))
    .then(unmute).then(requestReopen).then(settleReopen(true))
    .expect(s.capture == "owned" and not(s.sent))

  run MuteWhileReopeningAndCloseFailureTest = init
    .then(submit).then(settleClose(true)).then(sendTurn).then(finishTurn)
    .then(requestReopen).then(mute).then(settleReopen(true))
    .expect(s.muted and s.capture == "mute-close")
    .then(settleClose(false)).expect(s.owner == "failed" and s.capture == "absent")

  run StopWaitsForLateReopenCancellationTest = init
    .then(submit).then(settleClose(true)).then(sendTurn).then(finishTurn)
    .then(requestReopen).then(stop).then(settleReopen(true))
    .expect(s.owner == "stopping" and s.capture == "cancel-late" and not(s.lateCancelSettled))
    .then(settleLateCancel).then(acknowledgeStop)
    .expect(s.owner == "stopped" and s.lateCancelSettled and StopWaitsForLateCancellation)

  run RetiredMuteCloseFailureDoesNotPublishErrorTest = init
    .then(mute).then(stop).then(settleClose(false)).then(acknowledgeStop)
    .expect(s.owner == "stopped" and not(s.sent) and not(s.reopenIssued))

  run ReopenRefusalDoesNotAdoptCaptureTest = init
    .then(submit).then(settleClose(true)).then(sendTurn).then(finishTurn)
    .then(requestReopen).then(settleReopen(false))
    .expect(s.owner == "failed" and s.capture == "absent" and s.reopenIssued)
}
