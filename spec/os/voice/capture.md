# Half-duplex voice capture ownership

The voice assistant session controller owns one capture through a
half-duplex turn and one capture re-acquisition; a consumer constructs it
in its own voice adapter. Live full-duplex audio is
[live session](./liveSession.md), the decision to submit an utterance is
the [voice endpoint](./endpoint.md), and what the person heard is
[playback](./playback.md). The microphone underneath has its own owners:

- [Microphone samples](./microphoneSamples.md): the shared capture graph,
  its bounded sample prefix and speech previews.
- [Recorded transcription](./recordedTranscription.md): one recorded
  utterance and its final text for review.
- [On-device microphone ownership](./microphoneSlot.md): the process-wide
  slot, the handoff to the draft recorder, and native capture start and
  end delivery.

## Story: Submit a voice turn without retaining the microphone

> As a person talking to the assistant, I want my turn sent only once the
> microphone has really closed, so the assistant never records me while it
> thinks or speaks.

### A successful close receipt precedes turn dispatch

A half-duplex turn takes exclusive ownership while capture is closing,
while submitting and while playing the reply. Holding for the turn or
muting keeps the capture handle until its close receipt arrives. The
owner cannot send a turn until the close for that turn reports success.
A failed close retires the owner and reports an error, but keeps the
handle as unconfirmed so it can still be cancelled. Unmute alone grants
no permission to begin capture while the turn is holding that permission.
Only a live, unmuted owner whose turn is not holding capture owns an open
capture.

```quint
type CaptureCustody = CaptureOwned | CaptureRetained | CaptureAbsent | CaptureOpening
type CaptureOwner = LiveOwner | StoppingOwner | StoppedOwner
type CaptureTurn = BeforeTurn | AwaitClose | ReadyToSend | ReplyPlaying | TurnFinished
type CaptureState = { owner: CaptureOwner, generation: int, capture: CaptureCustody, turn: CaptureTurn, muted: bool,
  closePending: bool, closeForTurn: bool, cancelPending: bool, releaseUnconfirmed: bool, error: bool,
  closeConfirmed: bool, sent: bool, reopened: bool, lateCapture: bool, lateCancelSettled: bool }
pure val initial: CaptureState = { owner: LiveOwner, generation: 0, capture: CaptureOwned, turn: BeforeTurn, muted: false,
  closePending: false, closeForTurn: false, cancelPending: false, releaseUnconfirmed: false, error: false,
  closeConfirmed: false, sent: false, reopened: false, lateCapture: false, lateCancelSettled: false }
pure def turnHoldsCapture(s: CaptureState): bool =
  s.turn == AwaitClose or s.turn == ReadyToSend or s.turn == ReplyPlaying
pure def canHoldForTurn(s: CaptureState): bool =
  s.owner == LiveOwner and not(s.muted) and s.capture == CaptureOwned and s.turn == BeforeTurn
pure def holdForTurn(s: CaptureState): CaptureState =
  { ...s, capture: CaptureRetained, closePending: true, closeForTurn: true, turn: AwaitClose }
pure def canMuteCapture(s: CaptureState): bool = s.owner == LiveOwner and not(s.muted)
pure def muteCapture(s: CaptureState): CaptureState =
  { ...s, muted: true, capture: if (s.capture == CaptureOwned) CaptureRetained else s.capture,
    closePending: s.closePending or s.capture == CaptureOwned }
pure def canUnmuteCapture(s: CaptureState): bool = s.owner == LiveOwner and s.muted
pure def unmuteCapture(s: CaptureState): CaptureState = { ...s, muted: false }
pure def canCloseReceipt(s: CaptureState): bool = s.closePending
pure def closeReceipt(s: CaptureState, closeSucceeded: bool): CaptureState = {
  val released = closeSucceeded and not(s.cancelPending)
  val failedLive = not(closeSucceeded) and s.owner == LiveOwner
  { ...s, closePending: false,
    capture: if (released) CaptureAbsent else s.capture,
    releaseUnconfirmed: if (released) false else s.releaseUnconfirmed or (not(closeSucceeded) and s.capture != CaptureAbsent),
    owner: if (failedLive) StoppingOwner else s.owner,
    error: s.error or failedLive,
    turn: if (closeSucceeded and s.owner == LiveOwner and s.closeForTurn) ReadyToSend else s.turn,
    closeConfirmed: s.closeConfirmed or (closeSucceeded and s.closeForTurn) }
}
pure def canDispatchTurn(s: CaptureState): bool =
  s.owner == LiveOwner and s.turn == ReadyToSend and s.closeConfirmed
pure def dispatchTurn(s: CaptureState): CaptureState = { ...s, turn: ReplyPlaying, sent: true }
pure def canDrainReply(s: CaptureState): bool = s.owner == LiveOwner and s.turn == ReplyPlaying
pure def drainReply(s: CaptureState): CaptureState = { ...s, turn: TurnFinished }
pure def alwaysDispatchNeedsClosedCapture(s: CaptureState): bool = s.sent implies s.closeConfirmed
pure def alwaysCaptureNeedsLiveUnmutedOwner(s: CaptureState): bool =
  s.capture == CaptureOwned implies s.owner == LiveOwner and not(s.muted) and not(turnHoldsCapture(s))
pure def sometimesTurnDispatched(s: CaptureState): bool = s.sent
pure def sometimesCloseFailure(s: CaptureState): bool = s.error and s.owner == StoppingOwner and s.capture == CaptureRetained
```

## Story: Stop a voice session while capture is reopening

> As a person ending a voice conversation, I want Stop to finish only once
> the microphone is released, even if it was just reopening.

### Stop waits for capture cleanup and a late acquisition cannot become active

After the reply, a live unmuted owner with no close or cancellation
pending may reopen capture once per generation. The owner's stop request
retires the current generation immediately and never assumes that
cancelling its capture succeeded. An acquisition that resolves after
retirement is retained as a late capture and must be cancelled before
stop acknowledges. Acquisition while muted immediately starts closing
the new capture. A failed acquisition retires the owner, and may still
return a handle that needs cleanup. After retirement, no callback can
send a turn or adopt a microphone. Stop is acknowledged only with no
capture, no pending close or cancellation and no unconfirmed release.

```quint
pure def canRequestReopen(s: CaptureState): bool =
  s.owner == LiveOwner and not(s.muted) and not(turnHoldsCapture(s)) and not(s.reopened) and
    s.capture == CaptureAbsent and not(s.closePending) and not(s.cancelPending)
pure def requestReopen(s: CaptureState): CaptureState = { ...s, capture: CaptureOpening, reopened: true }
pure def canReopenReceipt(s: CaptureState): bool = s.capture == CaptureOpening
pure def reopenReceipt(s: CaptureState, openSucceeded: bool, retainedOnFailure: bool): CaptureState = {
  val acquired = openSucceeded or retainedOnFailure
  val live = s.owner == LiveOwner
  { ...s,
    capture: if (not(acquired)) CaptureAbsent
      else if (not(live) or not(openSucceeded) or s.muted) CaptureRetained else CaptureOwned,
    closePending: openSucceeded and live and s.muted,
    closeForTurn: false,
    releaseUnconfirmed: not(openSucceeded) and retainedOnFailure,
    owner: if (not(openSucceeded) and live) StoppingOwner else s.owner,
    error: s.error or (not(openSucceeded) and live),
    lateCapture: s.lateCapture or (not(live) and acquired) }
}
pure def canStopCapture(s: CaptureState): bool = s.owner == LiveOwner
pure def stopCapture(s: CaptureState): CaptureState =
  { ...s, owner: StoppingOwner, capture: if (s.capture == CaptureOwned) CaptureRetained else s.capture }
pure def canAcknowledgeStop(s: CaptureState): bool =
  s.owner == StoppingOwner and s.capture == CaptureAbsent and not(s.closePending) and
    not(s.cancelPending) and not(s.releaseUnconfirmed)
pure def acknowledgeStop(s: CaptureState): CaptureState = { ...s, owner: StoppedOwner }
pure def alwaysStoppedCaptureReleased(s: CaptureState): bool =
  (s.lateCancelSettled implies s.lateCapture) and
  (s.owner == StoppedOwner implies s.capture == CaptureAbsent and not(s.closePending) and not(s.cancelPending) and
    not(s.releaseUnconfirmed) and (s.lateCapture implies s.lateCancelSettled))
pure def stepRetiredCannotAdopt(before: CaptureState, after: CaptureState): bool =
  before.owner != LiveOwner and after.generation == before.generation implies
    after.owner != LiveOwner and after.sent == before.sent and after.reopened == before.reopened and
    after.capture != CaptureOwned
pure def sometimesReopenedAfterPlayback(s: CaptureState): bool =
  s.turn == TurnFinished and s.capture == CaptureOwned and s.reopened
pure def sometimesStopDrainsLateCapture(s: CaptureState): bool =
  s.owner == StoppedOwner and s.lateCancelSettled
```

### A failed close or cancellation keeps the handle until a cancellation succeeds

A retired owner holding a capture asks for it to be cancelled. Close and
cancellation are independent receipts. A failed cancellation leaves the
handle retained and the release unconfirmed, and the owner may ask
again; only a successful cancellation releases it. A close that succeeds
while a cancellation is pending leaves the handle to that cancellation.

```quint
pure def canRequestCancel(s: CaptureState): bool =
  s.owner != LiveOwner and (s.capture == CaptureOwned or s.capture == CaptureRetained) and not(s.cancelPending)
pure def requestCancel(s: CaptureState): CaptureState = { ...s, capture: CaptureRetained, cancelPending: true }
pure def canConfirmCancel(s: CaptureState): bool = s.cancelPending
pure def confirmCancel(s: CaptureState): CaptureState =
  { ...s, cancelPending: false, capture: CaptureAbsent, releaseUnconfirmed: false,
    lateCancelSettled: s.lateCancelSettled or s.lateCapture }
pure def canFailCancel(s: CaptureState): bool = s.cancelPending
pure def failCancel(s: CaptureState): CaptureState =
  { ...s, cancelPending: false, capture: CaptureRetained, releaseUnconfirmed: true }
pure def alwaysFailedReleaseRetainsHandle(s: CaptureState): bool =
  (s.releaseUnconfirmed implies s.capture == CaptureRetained) and
  (s.cancelPending implies s.capture == CaptureRetained and s.owner == StoppingOwner) and
  (s.closePending implies s.capture == CaptureRetained or s.capture == CaptureAbsent)
pure def sometimesFailedCancelRetainsHandle(s: CaptureState): bool =
  s.releaseUnconfirmed and s.owner == StoppingOwner and not(s.cancelPending)
```

### After a confirmed stop, one new generation may start

Once stop is acknowledged with nothing left to release, the owner may
start again exactly once, as a fresh lifecycle in a new generation.

```quint
pure def canRestartCapture(s: CaptureState): bool =
  s.owner == StoppedOwner and s.generation == 0 and s.capture == CaptureAbsent and
    not(s.closePending) and not(s.cancelPending) and not(s.releaseUnconfirmed)
pure def restartCapture(s: CaptureState): CaptureState = { ...initial, generation: 1 }
pure def alwaysOneRestart(s: CaptureState): bool = s.generation == 0 or s.generation == 1
pure def sometimesRestartedCapture(s: CaptureState): bool = s.generation == 1 and s.capture == CaptureOwned
```

### A capture callback retains the lifecycle that issued it

Discovered by the proof: a pending acquisition can only hold a live or
stopping owner, with no turn holding capture, no close or cancellation
pending, no unconfirmed release and no earlier late acquisition. A late
acquisition stays retained, with no close pending, until its
cancellation succeeds.

```quint
pure def alwaysPendingOpenRetainsFence(s: CaptureState): bool =
  s.capture == CaptureOpening implies
    (s.owner == LiveOwner or s.owner == StoppingOwner) and not(turnHoldsCapture(s)) and
    not(s.closePending) and not(s.cancelPending) and not(s.releaseUnconfirmed) and
    not(s.lateCapture) and not(s.lateCancelSettled)
pure def alwaysLateCaptureRemainsOwned(s: CaptureState): bool =
  s.lateCapture and not(s.lateCancelSettled) implies s.capture == CaptureRetained and not(s.closePending)
```

### A late acquisition record belongs to a retired owner

Discovered by the proof: a fabricated live owner could otherwise retain a
late acquisition or its cancellation receipt. Those records are created
only after the stop request retires the owner, and a restart clears them.

```quint
pure def alwaysLateCaptureNeedsRetirement(s: CaptureState): bool =
  s.lateCapture implies s.owner == StoppingOwner or s.owner == StoppedOwner
```

### A stop request is always acknowledged once its receipts arrive

When the platform keeps delivering the close and acquisition receipts it
owes, the owner keeps asking to cancel what it holds, a cancellation
asked again and again eventually succeeds, and the acknowledgement is
taken when allowed, every stopping owner is acknowledged. Nothing
promises that one cancellation attempt succeeds.

```quint
pure val fair_closeReceipt = "weak"
pure val fair_reopenReceipt = "weak"
pure val fair_requestCancel = "weak"
pure val fair_confirmCancel = "strong"
pure val fair_acknowledgeStop = "weak"
pure def leadsToStopAcknowledged(s: CaptureState, later: CaptureState): bool =
  s.owner == StoppingOwner implies later.owner == StoppedOwner
```
