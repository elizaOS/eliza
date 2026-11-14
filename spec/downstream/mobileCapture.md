# Half-duplex voice assistant capture ownership

Alpha stages Eliza's `packages/voice/src/voice-assistant-session.ts` in
`scripts/prepare-client-features.ts`. Its renderer re-exports the
controller from `apps/app/src/runtime/voice-assistant.ts` and constructs
it in `apps/app/src/prototype/voice-adapter.ts`. This contract follows
`VoiceAssistantCaptureOwnership.qnt` at Alpha's pinned producer revision.
It models one half-duplex turn and one capture re-acquisition. Live
full-duplex audio, semantic end-of-turn signals and the native audio
transport remain separate ports.

## Story: Submit a voice turn without retaining the microphone

### A successful close receipt precedes turn dispatch

A half-duplex turn takes exclusive ownership while capture is closing,
while submitting and while playing the reply. The owner cannot send a
turn until the close reports success. A failed close retires the owner.
Mute closes an owned capture. Unmute alone grants no permission to
begin capture while the turn is holding that permission.

```quint
type CapturePhase = Capturing | TurnClosing | MuteClosing | CaptureAbsent | Opening | CancelLate
type CaptureOwner = LiveOwner | FailedOwner | StoppingOwner | StoppedOwner
type CaptureTurn = BeforeTurn | AwaitClose | ReadyToSend | ReplyPlaying | TurnFinished
type CaptureState = { owner: CaptureOwner, capture: CapturePhase, turn: CaptureTurn, muted: bool, closeConfirmed: bool, sent: bool, reopened: bool, lateCapture: bool, lateCancelSettled: bool }
pure val initial: CaptureState = { owner: LiveOwner, capture: Capturing, turn: BeforeTurn, muted: false, closeConfirmed: false, sent: false, reopened: false, lateCapture: false, lateCancelSettled: false }
pure def turnHoldsCapture(s: CaptureState): bool =
  s.turn == AwaitClose or s.turn == ReadyToSend or s.turn == ReplyPlaying
pure def canHoldForTurn(s: CaptureState): bool =
  s.owner == LiveOwner and not(s.muted) and s.capture == Capturing and s.turn == BeforeTurn
pure def holdForTurn(s: CaptureState): CaptureState =
  { ...s, capture: TurnClosing, turn: AwaitClose }
pure def canMuteCapture(s: CaptureState): bool = s.owner == LiveOwner and not(s.muted)
pure def muteCapture(s: CaptureState): CaptureState =
  { ...s, muted: true, capture: if (s.capture == Capturing) MuteClosing else s.capture }
pure def canUnmuteCapture(s: CaptureState): bool = s.owner == LiveOwner and s.muted
pure def unmuteCapture(s: CaptureState): CaptureState = { ...s, muted: false }
pure def canCloseReceipt(s: CaptureState): bool = s.capture == TurnClosing or s.capture == MuteClosing
pure def closeReceipt(s: CaptureState, closeSucceeded: bool): CaptureState =
  if (s.owner != LiveOwner) { ...s, capture: CaptureAbsent }
  else if (not(closeSucceeded)) { ...s, capture: CaptureAbsent, owner: FailedOwner }
  else if (s.capture == TurnClosing) { ...s, capture: CaptureAbsent, turn: ReadyToSend, closeConfirmed: true }
  else { ...s, capture: CaptureAbsent }
pure def canDispatchTurn(s: CaptureState): bool =
  s.owner == LiveOwner and s.turn == ReadyToSend and s.closeConfirmed
pure def dispatchTurn(s: CaptureState): CaptureState =
  { ...s, turn: ReplyPlaying, sent: true }
pure def canDrainReply(s: CaptureState): bool = s.owner == LiveOwner and s.turn == ReplyPlaying
pure def drainReply(s: CaptureState): CaptureState = { ...s, turn: TurnFinished }
pure def alwaysDispatchNeedsClosedCapture(s: CaptureState): bool = s.sent implies s.closeConfirmed
pure def alwaysCaptureNeedsLiveUnmutedOwner(s: CaptureState): bool =
  s.capture == Capturing implies s.owner == LiveOwner and not(s.muted) and not(turnHoldsCapture(s))
pure def sometimesTurnDispatched(s: CaptureState): bool = s.sent
pure def sometimesCloseFailure(s: CaptureState): bool = s.owner == FailedOwner
```

## Story: Stop a voice session while capture is reopening

### Stop waits for capture cleanup and a late acquisition cannot become active

The owner's stop request retires the current generation immediately.
If capture is opening, a late successful acquisition must cancel before
stop acknowledges. Acquisition while muted immediately starts closing
the new capture. After retirement, no callback can send a turn or
adopt a microphone. The source has one reopen per modeled trace. A
later turn uses a new projection of this lifecycle.

```quint
pure def canRequestReopen(s: CaptureState): bool =
  s.owner == LiveOwner and not(s.muted) and not(turnHoldsCapture(s)) and not(s.reopened) and s.capture == CaptureAbsent
pure def requestReopen(s: CaptureState): CaptureState = { ...s, capture: Opening, reopened: true }
pure def canReopenReceipt(s: CaptureState): bool = s.capture == Opening
pure def reopenReceipt(s: CaptureState, openSucceeded: bool): CaptureState =
  if (s.owner != LiveOwner) {
    ...s, capture: if (openSucceeded) CancelLate else CaptureAbsent, lateCapture: openSucceeded
  } else if (openSucceeded) {
    ...s, capture: if (s.muted) MuteClosing else Capturing
  } else { ...s, capture: CaptureAbsent, owner: FailedOwner }
pure def canStopCapture(s: CaptureState): bool = s.owner == LiveOwner
pure def stopCapture(s: CaptureState): CaptureState =
  { ...s, owner: StoppingOwner, capture: if (s.capture == Capturing) CaptureAbsent else s.capture }
pure def canLateCancelReceipt(s: CaptureState): bool = s.owner == StoppingOwner and s.capture == CancelLate
pure def lateCancelReceipt(s: CaptureState): CaptureState = { ...s, capture: CaptureAbsent, lateCancelSettled: true }
pure def canAcknowledgeStop(s: CaptureState): bool =
  s.owner == StoppingOwner and s.capture == CaptureAbsent and (not(s.lateCapture) or s.lateCancelSettled)
pure def acknowledgeStop(s: CaptureState): CaptureState = { ...s, owner: StoppedOwner }
pure def alwaysLateCancellationNeedsCapture(s: CaptureState): bool = s.lateCancelSettled implies s.lateCapture
pure def alwaysStoppedCaptureReleased(s: CaptureState): bool =
  s.owner == StoppedOwner implies s.capture == CaptureAbsent and (not(s.lateCapture) or s.lateCancelSettled)
pure def stepRetiredCannotAdopt(before: CaptureState, after: CaptureState): bool =
  before.owner != LiveOwner implies after.owner != LiveOwner and after.sent == before.sent and
  after.reopened == before.reopened and after.capture != Capturing
pure def sometimesReopenedAfterPlayback(s: CaptureState): bool =
  s.turn == TurnFinished and s.capture == Capturing and s.reopened
pure def sometimesStopDrainsLateCapture(s: CaptureState): bool =
  s.owner == StoppedOwner and s.lateCancelSettled
```

### A capture callback retains the lifecycle that issued it

Discovered by the proof: a fabricated stopped owner cannot have an open
acquisition callback. A pending open can only hold a live or stopping
owner and never carries an earlier late cancellation receipt. A pending
open also retains the original turn fence because it starts only while
no turn holds capture. A late capture stays owned until its cleanup
finishes.

```quint
pure def alwaysPendingOpenRetainsFence(s: CaptureState): bool =
  s.capture == Opening implies
    (s.owner == LiveOwner or s.owner == StoppingOwner) and not(turnHoldsCapture(s)) and
    not(s.lateCapture) and not(s.lateCancelSettled)
pure def alwaysLateCaptureRemainsOwned(s: CaptureState): bool =
  (s.capture == CancelLate implies s.owner == StoppingOwner and s.lateCapture) and
  (s.lateCapture and not(s.lateCancelSettled) implies s.capture == CancelLate)
```

### A late acquisition record belongs to a retired owner

Discovered by the proof: a fabricated live owner with a cleared capture
could otherwise retain a late acquisition or its cancellation receipt.
Those records are created only after the stop request retires the
owner. A live owner opening capture starts without either record.

```quint
pure def alwaysLateCaptureNeedsRetirement(s: CaptureState): bool =
  s.lateCapture implies s.owner == StoppingOwner or s.owner == StoppedOwner
```
