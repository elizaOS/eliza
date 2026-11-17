// One capture owner, one replacement capture and one new generation after Stop.
// Close and cancellation are independent receipts; neither failure drops the handle.
module VoiceAssistantCaptureOwnership {
  pure val HeldTurn = Set("await-close", "ready-to-send", "reply")
  type State = {
    owner: str, generation: int, capture: str, turn: str, muted: bool,
    closePending: bool, closeForTurn: bool, cancelPending: bool,
    releaseUnconfirmed: bool, error: bool,
    turnCloseConfirmed: bool, sent: bool, reopenIssued: bool,
    lateCapture: bool, lateCancelSettled: bool,
  }
  var s: State
  pure val initial: State = {
    owner: "live", generation: 0, capture: "owned", turn: "before-turn", muted: false,
    closePending: false, closeForTurn: false, cancelPending: false,
    releaseUnconfirmed: false, error: false,
    turnCloseConfirmed: false, sent: false, reopenIssued: false,
    lateCapture: false, lateCancelSettled: false,
  }
  action init = s' = initial
  val live = s.owner == "live"
  val held = HeldTurn.contains(s.turn)
  val ownsCapture = Set("owned", "retained").contains(s.capture)

  action submit = all {
    live and not(s.muted) and s.capture == "owned" and s.turn == "before-turn",
    s' = { ...s, capture: "retained", closePending: true, closeForTurn: true, turn: "await-close" },
  }
  action mute = all {
    live and not(s.muted),
    s' = { ...s, muted: true,
      capture: if (s.capture == "owned") "retained" else s.capture,
      closePending: s.closePending or s.capture == "owned",
    },
  }
  action unmute = all {
    live and s.muted,
    s' = { ...s, muted: false },
  }
  action settleClose(success: bool): bool = all {
    s.closePending,
    s' = { ...s,
      closePending: false,
      capture: if (success and not(s.cancelPending)) "absent" else s.capture,
      releaseUnconfirmed: if (success and not(s.cancelPending)) false
        else s.releaseUnconfirmed or (not(success) and s.capture != "absent"),
      owner: if (not(success) and live) "stopping" else s.owner,
      error: s.error or (not(success) and live),
      turn: if (success and live and s.closeForTurn) "ready-to-send" else s.turn,
      turnCloseConfirmed: s.turnCloseConfirmed or (success and s.closeForTurn),
    },
  }
  action sendTurn = all {
    live and s.turn == "ready-to-send" and s.turnCloseConfirmed,
    s' = { ...s, turn: "reply", sent: true },
  }
  action finishTurn = all {
    live and s.turn == "reply",
    s' = { ...s, turn: "finished" },
  }
  val canReopen = live and not(s.muted) and not(held) and not(s.reopenIssued)
    and s.capture == "absent" and not(s.closePending) and not(s.cancelPending)
  action requestReopen = all {
    canReopen,
    s' = { ...s, capture: "opening", reopenIssued: true },
  }
  // A failed acquisition can still return a cleanup handle when its own stop failed.
  action settleReopen(success: bool, retainedOnFailure: bool): bool = {
    val acquired = success or retainedOnFailure
    all {
      s.capture == "opening",
      s' = { ...s,
      capture: if (not(acquired)) "absent" else if (not(live) or not(success) or s.muted) "retained" else "owned",
      closePending: success and live and s.muted,
      closeForTurn: false,
      releaseUnconfirmed: not(success) and retainedOnFailure,
      owner: if (not(success) and live) "stopping" else s.owner,
      error: s.error or (not(success) and live),
      lateCapture: s.lateCapture or (not(live) and acquired),
      },
    }
  }
  // Retirement never assumes that cancelling an owned capture succeeded synchronously.
  action stop = all {
    live,
    s' = { ...s, owner: "stopping", capture: if (s.capture == "owned") "retained" else s.capture },
  }
  action requestCancel = all {
    not(live) and ownsCapture and not(s.cancelPending),
    s' = { ...s, capture: "retained", cancelPending: true },
  }
  action settleCancel(success: bool): bool = all {
    s.cancelPending,
    s' = { ...s, cancelPending: false,
      capture: if (success) "absent" else "retained",
      releaseUnconfirmed: not(success),
      lateCancelSettled: s.lateCancelSettled or (success and s.lateCapture),
    },
  }
  val canAcknowledgeStop = s.owner == "stopping" and s.capture == "absent"
    and not(s.closePending) and not(s.cancelPending) and not(s.releaseUnconfirmed)
  action acknowledgeStop = all {
    canAcknowledgeStop,
    s' = { ...s, owner: "stopped" },
  }
  val canRestart = s.owner == "stopped" and s.generation == 0 and s.capture == "absent"
    and not(s.closePending) and not(s.cancelPending) and not(s.releaseUnconfirmed)
  action restart = all {
    canRestart,
    s' = { ...initial, generation: 1 },
  }
  action closeReturns = any { settleClose(true), settleClose(false) }
  action reopenReturns = any { settleReopen(true, false), settleReopen(false, false), settleReopen(false, true) }
  action cancelReturns = any { settleCancel(true), settleCancel(false) }
  action cancelSucceeds = settleCancel(true)
  action step = any {
    submit, mute, unmute, closeReturns, sendTurn, finishTurn, requestReopen,
    reopenReturns, stop, requestCancel, cancelReturns, acknowledgeStop, restart, s' = s,
  }
  val SendNeedsConfirmedClose = s.sent implies s.turnCloseConfirmed
  val CaptureAdoptionRequiresLiveUnmutedOwner =
    s.capture == "owned" implies live and not(s.muted) and not(held)
  val FailedReleaseRetainsOwnership = s.releaseUnconfirmed implies s.capture == "retained"
  val StopWaitsForLateCancellation = and {
    s.lateCancelSettled implies s.lateCapture,
    s.owner == "stopped" implies s.capture == "absent" and not(s.closePending)
      and not(s.cancelPending) and not(s.releaseUnconfirmed)
      and (s.lateCapture implies s.lateCancelSettled),
  }
  temporal RetiredOwnerCannotSendOrReopen = always((
    (not(live) and next(s.generation) == s.generation) implies
      next(s.sent) == s.sent and next(s.reopenIssued) == s.reopenIssued and next(s.capture) != "owned"
  ).orKeep(s))
  temporal PendingCaptureOperationsSettle = and {
    s.closePending.leadsTo(not(s.closePending)),
    (s.capture == "opening").leadsTo(s.capture != "opening"),
    (s.owner == "stopping").leadsTo(s.owner == "stopped"),
    canReopen.leadsTo(not(canReopen)),
  }
  // Successful cancellation is an explicit environment assumption, not guaranteed by a retry.
  temporal UnderFairCaptureReceipts = and {
    closeReturns.weakFair(s), requestReopen.weakFair(s), reopenReturns.weakFair(s),
    requestCancel.weakFair(s), cancelSucceeds.strongFair(s), acknowledgeStop.weakFair(s),
  } implies PendingCaptureOperationsSettle

  run TurnWaitsForCloseAndReopensAfterDrainTest = init
    .then(submit).expect(not(s.sent) and s.closePending)
    .then(settleClose(true)).then(sendTurn).then(finishTurn)
    .then(requestReopen).then(settleReopen(true, false))
    .expect(s.sent and s.capture == "owned" and CaptureAdoptionRequiresLiveUnmutedOwner)
  run IdleMuteAndUnmuteTest = init.then(mute).then(settleClose(true))
    .expect(s.muted and s.capture == "absent" and not(canReopen))
    .then(unmute).then(requestReopen).then(settleReopen(true, false))
    .expect(s.capture == "owned" and not(s.sent))
  run MuteWhileReopeningAndCloseFailureTest = init
    .then(submit).then(settleClose(true)).then(sendTurn).then(finishTurn)
    .then(requestReopen).then(mute).then(settleReopen(true, false))
    .expect(s.muted and s.closePending)
    .then(settleClose(false)).expect(s.owner == "stopping" and s.capture == "retained" and s.error)
  run StopWaitsForLateReopenCancellationTest = init
    .then(submit).then(settleClose(true)).then(sendTurn).then(finishTurn)
    .then(requestReopen).then(stop).then(settleReopen(true, false))
    .expect(s.capture == "retained" and s.lateCapture and not(canAcknowledgeStop))
    .then(requestCancel).then(settleCancel(true)).then(acknowledgeStop)
    .expect(s.owner == "stopped" and s.lateCancelSettled and StopWaitsForLateCancellation)
  run RetiredMuteCloseFailureDoesNotPublishErrorTest = init
    .then(mute).then(stop).then(requestCancel).then(settleCancel(true))
    .expect(s.capture == "absent" and s.closePending and not(canAcknowledgeStop))
    .then(settleClose(false)).then(acknowledgeStop)
    .expect(s.owner == "stopped" and not(s.error) and not(s.sent))
  run FailedCancelKeepsHandleUntilRetryTest = init.then(stop).then(requestCancel)
    .then(settleCancel(false)).expect(s.releaseUnconfirmed and not(canRestart) and not(canAcknowledgeStop))
    .then(requestCancel).then(settleCancel(true)).then(acknowledgeStop).then(restart)
    .expect(s.generation == 1 and s.capture == "owned" and not(s.releaseUnconfirmed))
  run FailedReopenKeepsCleanupHandleTest = init
    .then(submit).then(settleClose(true)).then(sendTurn).then(finishTurn)
    .then(requestReopen).then(settleReopen(false, true))
    .expect(s.error and s.capture == "retained" and not(canRestart))
    .then(requestCancel).then(settleCancel(true)).then(acknowledgeStop)
    .expect(StopWaitsForLateCancellation)
}
