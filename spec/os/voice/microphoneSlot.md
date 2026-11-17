# On-device microphone ownership

On Android, on-device speech shares one process-wide microphone slot
between independent capture owners: live speech controllers and the draft
recorder. This spec owns that slot and its reservation tokens, the
handoff from a running capture to the draft recorder and back, and one
native live capture's start and end delivery, all for one assistant host
that may retire. [Voice capture](./capture.md) owns the turn around it,
and the capture feeds a [live session](./liveSession.md).

## Story: Share the device microphone between independent capture owners

> As a person using voice in more than one place in the app, I want only
> one of them to hold the microphone at a time, and a stuck release never
> to hand my microphone to someone else.

### One owner holds the slot, and others are refused while it does

A reservation succeeds only when the slot is empty and takes a new token;
tokens are counted up from zero, so every token taken is positive.
A second owner's reservation while the slot is held is refused and
recorded, and the holder keeps the slot. Only the holder's microphone may
be open.

```quint
type SlotPhase = SlotIdle | SlotOpening | SlotRunning | SlotClosing | SlotUnconfirmed
type EarlierCapture = EarlierStarting | EarlierRunning | EarlierStopping | EarlierReleased | EarlierFailed
type LiveRequest = LiveIdle | FinishingDraft | AcquiringLive | LiveAcquired | LiveRefused
type NativeCapturePhase = CaptureReserved | CaptureStarting | CaptureRunning | EndPending | CaptureEnded | StartRefused
type SlotReservation = { owner: int, draftOwner: bool, token: int, issued: int, phase: SlotPhase, open: bool, refused: int }
type DraftHandoff = { earlier: EarlierCapture, earlierOwns: bool, requested: bool, fence: bool, draft: bool,
  acknowledged: bool, drainRefused: bool, staleQueued: bool, autoRefused: bool, user: LiveRequest, live: bool }
type NativeCapture = { phase: NativeCapturePhase, startAllowed: bool, reported: bool,
  discarded: bool, delivered: bool, deliveryRequired: bool, consumed: bool }
type Microphone = { slot: SlotReservation, handoff: DraftHandoff, capture: NativeCapture, hostOpen: bool }
pure val initial: Microphone = {
  slot: { owner: 0, draftOwner: false, token: 0, issued: 0, phase: SlotIdle, open: false, refused: 0 },
  handoff: { earlier: EarlierStarting, earlierOwns: false, requested: false, fence: false, draft: false,
    acknowledged: false, drainRefused: false, staleQueued: true, autoRefused: false, user: LiveIdle, live: false },
  capture: { phase: CaptureReserved, startAllowed: true, reported: false, discarded: false, delivered: false,
    deliveryRequired: false, consumed: false },
  hostOpen: true
}
pure def canReserveSlot(m: Microphone, owner: int, draftRecorder: bool): bool = owner > 0
pure def reserveSlot(m: Microphone, owner: int, draftRecorder: bool): Microphone =
  if (m.slot.owner == 0)
    { ...m, slot: { ...m.slot, owner: owner, draftOwner: draftRecorder, token: m.slot.issued + 1, issued: m.slot.issued + 1, phase: SlotOpening, refused: 0 } }
  else { ...m, slot: { ...m.slot, refused: owner } }
pure val ownerValues = Set(0, 1, 2)
pure def canOpenedSlot(m: Microphone): bool = m.slot.phase == SlotOpening
pure def openedSlot(m: Microphone): Microphone = { ...m, slot: { ...m.slot, phase: SlotRunning, open: true } }
pure def alwaysOnlyAnOwnerMayOpen(m: Microphone): bool = m.slot.open implies m.slot.owner != 0 and m.slot.token != 0
pure def alwaysEmptySlotIsIdle(m: Microphone): bool =
  (m.slot.owner == 0) == (m.slot.phase == SlotIdle and m.slot.token == 0 and not(m.slot.open))
pure def alwaysTokensCountUpFromZero(m: Microphone): bool = m.slot.issued >= 0
pure def sometimesSecondOwnerRefused(m: Microphone): bool = m.slot.refused > 0 and m.slot.owner > 0 and m.slot.refused != m.slot.owner
```

### The slot is freed only by its own release receipt

Cancelling an opening or running capture starts closing it; a source that
finishes opening after its cancellation is still closed. Only a release
receipt frees the slot. A release that cannot be confirmed leaves the slot
held, except for the draft recorder, whose unconfirmed release may be
retried until it frees the slot. A release receipt for an earlier token
changes nothing.

```quint
pure def canCancelSlot(m: Microphone): bool = m.slot.phase == SlotOpening or m.slot.phase == SlotRunning
pure def cancelSlot(m: Microphone): Microphone = { ...m, slot: { ...m.slot, phase: SlotClosing } }
pure def canLateOpen(m: Microphone): bool = m.slot.phase == SlotClosing and not(m.slot.open)
pure def lateOpen(m: Microphone): Microphone = { ...m, slot: { ...m.slot, open: true } }
pure def canReleaseSlot(m: Microphone): bool =
  m.slot.phase == SlotOpening or m.slot.phase == SlotClosing or (m.slot.phase == SlotUnconfirmed and m.slot.draftOwner)
pure def releaseSlot(m: Microphone): Microphone =
  { ...m, slot: { ...m.slot, owner: 0, draftOwner: false, token: 0, phase: SlotIdle, open: false } }
pure def canReleaseUnconfirmed(m: Microphone): bool = m.slot.phase == SlotOpening or m.slot.phase == SlotClosing
pure def releaseUnconfirmed(m: Microphone): Microphone = { ...m, slot: { ...m.slot, phase: SlotUnconfirmed } }
pure def canStaleRelease(m: Microphone, ticket: int): bool = ticket > 0 and ticket <= m.slot.issued and ticket != m.slot.token
pure def staleRelease(m: Microphone, ticket: int): Microphone = m
pure val ticketValues = Set(1, 2, 3)
pure def alwaysHeldSlotHasCurrentToken(m: Microphone): bool =
  m.slot.phase != SlotIdle implies m.slot.owner > 0 and m.slot.token == m.slot.issued and m.slot.token > 0
pure def stepStaleReleaseChangesNothing(before: Microphone, via: str, after: Microphone): bool =
  via == "staleRelease" implies after == before
pure def sometimesUnconfirmedReleaseHoldsSlot(m: Microphone): bool = m.slot.phase == SlotUnconfirmed and not(m.slot.draftOwner)
pure def sometimesSlotReused(m: Microphone): bool = m.slot.issued >= 2 and m.slot.phase == SlotRunning
```

### A closing capture always reports its outcome

When release receipts keep arriving, a closing capture leaves closing:
released, or held unconfirmed.

```quint
pure val fair_releaseSlot = "weak"
pure val fair_releaseUnconfirmed = "weak"
pure def leadsToClosingReports(m: Microphone, later: Microphone): bool =
  m.slot.phase == SlotClosing implies later.slot.phase != SlotClosing
```

## Story: Dictate a draft while a live capture was running

> As a person who starts dictating while the assistant was listening, I
> want the earlier capture released before my draft records, and the
> assistant never to reopen its microphone over my draft.

### The draft records only after the earlier capture's release is confirmed

A draft request fences automatic reopening and asks the earlier capture to
stop; a capture still starting finishes opening first and is then stopped.
The draft is acknowledged only once the earlier capture reports it released
the microphone and the host is still open, and records only once
acknowledged. A failed release, or a retired
host, refuses the draft. A reservation queued before the request does not
clear its fence. The earlier capture holds the microphone from the moment
it finishes starting until its release is confirmed; a failed release
leaves it holding the microphone.

```quint
pure def canRequestDraft(m: Microphone): bool = not(m.handoff.requested) and m.handoff.user == LiveIdle
pure def requestDraft(m: Microphone): Microphone = { ...m, handoff: { ...m.handoff, requested: true, fence: true } }
pure def canFinishEarlierStart(m: Microphone): bool = m.handoff.earlier == EarlierStarting
pure def finishEarlierStart(m: Microphone): Microphone = { ...m, handoff: { ...m.handoff, earlier: EarlierRunning, earlierOwns: true } }
pure def canStopEarlier(m: Microphone): bool = m.handoff.requested and m.handoff.earlier == EarlierRunning
pure def stopEarlier(m: Microphone): Microphone = { ...m, handoff: { ...m.handoff, earlier: EarlierStopping } }
pure def canReleaseEarlier(m: Microphone): bool = m.handoff.earlier == EarlierStopping
pure def releaseEarlier(m: Microphone): Microphone = { ...m, handoff: { ...m.handoff, earlier: EarlierReleased, earlierOwns: false } }
pure def canFailEarlierRelease(m: Microphone): bool = m.handoff.earlier == EarlierStopping
pure def failEarlierRelease(m: Microphone): Microphone = { ...m, handoff: { ...m.handoff, earlier: EarlierFailed } }
pure def canSettleDrain(m: Microphone): bool =
  m.handoff.requested and not(m.handoff.acknowledged) and not(m.handoff.drainRefused) and
    (m.handoff.earlier == EarlierReleased or m.handoff.earlier == EarlierFailed)
pure def settleDrain(m: Microphone): Microphone =
  if (m.handoff.earlier == EarlierReleased and m.hostOpen) { ...m, handoff: { ...m.handoff, draft: true, acknowledged: true } }
  else { ...m, handoff: { ...m.handoff, drainRefused: true } }
pure def canStaleStart(m: Microphone): bool = m.handoff.requested and m.handoff.staleQueued
pure def staleStart(m: Microphone): Microphone = { ...m, handoff: { ...m.handoff, staleQueued: false } }
pure def alwaysReleaseReceiptPrecedesDraft(m: Microphone): bool =
  (m.handoff.acknowledged or m.handoff.draft or m.handoff.live) implies
    m.handoff.earlier == EarlierReleased and not(m.handoff.earlierOwns) and m.handoff.requested
pure def alwaysDraftIsAcknowledged(m: Microphone): bool = m.handoff.draft implies m.handoff.acknowledged
pure def alwaysEarlierOwnershipMatchesPhase(m: Microphone): bool =
  m.handoff.earlierOwns == (m.handoff.earlier == EarlierRunning or m.handoff.earlier == EarlierStopping or m.handoff.earlier == EarlierFailed)
pure def alwaysFailedReleaseFencesDraft(m: Microphone): bool =
  m.handoff.earlier == EarlierFailed implies not(m.handoff.draft) and not(m.handoff.live) and not(m.handoff.acknowledged)
pure def stepStaleStartKeepsFence(before: Microphone, via: str, after: Microphone): bool =
  via == "staleStart" implies after.handoff.fence == before.handoff.fence
pure def sometimesDraftAcknowledged(m: Microphone): bool = m.handoff.draft and m.handoff.acknowledged
pure def sometimesFailedReleaseRefused(m: Microphone): bool = m.handoff.drainRefused and m.handoff.earlier == EarlierFailed
pure val weight_requestDraft = 3
pure val weight_finishEarlierStart = 3
pure val weight_stopEarlier = 3
pure val weight_releaseEarlier = 3
pure val weight_settleDrain = 3
pure val weight_requestUserLive = 3
pure val weight_finishDraft = 3
pure val weight_acquireLive = 3
```

### Automatic reopening is refused while the draft holds the microphone

The fence set by the draft request stays up until the person asks for live
capture. While it is up an automatic reopen is refused.

```quint
pure def canAutomaticReopen(m: Microphone): bool = m.handoff.draft and m.handoff.fence
pure def automaticReopen(m: Microphone): Microphone = { ...m, handoff: { ...m.handoff, autoRefused: true } }
pure def alwaysReopenFenced(m: Microphone): bool = (m.handoff.requested and m.handoff.user == LiveIdle) implies m.handoff.fence
pure def sometimesAutomaticReopenRefused(m: Microphone): bool = m.handoff.autoRefused and m.handoff.draft
```

### One microphone owner at a time

The person's live request first finishes the draft and only then acquires
live capture, which a retired host refuses. The earlier capture, the draft
and live capture never hold the microphone together.

```quint
pure def canRequestUserLive(m: Microphone): bool = m.handoff.draft and m.hostOpen and m.handoff.user == LiveIdle
pure def requestUserLive(m: Microphone): Microphone = { ...m, handoff: { ...m.handoff, user: FinishingDraft, fence: false } }
pure def canFinishDraft(m: Microphone): bool = m.handoff.user == FinishingDraft
pure def finishDraft(m: Microphone): Microphone = { ...m, handoff: { ...m.handoff, draft: false, user: AcquiringLive } }
pure def canAcquireLive(m: Microphone): bool = m.handoff.user == AcquiringLive
pure def acquireLive(m: Microphone): Microphone =
  if (m.hostOpen) { ...m, handoff: { ...m.handoff, live: true, user: LiveAcquired } } else { ...m, handoff: { ...m.handoff, user: LiveRefused } }
pure def alwaysOneMicrophoneOwner(m: Microphone): bool =
  not(m.handoff.earlierOwns and (m.handoff.draft or m.handoff.live)) and not(m.handoff.draft and m.handoff.live)
pure def alwaysLiveFollowsFinishedDraft(m: Microphone): bool =
  (m.handoff.user != LiveIdle implies m.handoff.acknowledged) and
  ((m.handoff.user == AcquiringLive or m.handoff.user == LiveAcquired or m.handoff.user == LiveRefused) implies not(m.handoff.draft)) and
  (m.handoff.live implies m.handoff.user == LiveAcquired)
pure def sometimesLiveAfterDraft(m: Microphone): bool = m.handoff.live
```

### A requested draft always settles

When the earlier capture keeps starting, stopping and releasing, and the
drain is settled, a draft request ends acknowledged or refused.

```quint
pure val fair_finishEarlierStart = "weak"
pure val fair_stopEarlier = "weak"
pure val fair_releaseEarlier = "weak"
pure val fair_settleDrain = "weak"
pure def leadsToDrainSettles(m: Microphone, later: Microphone): bool =
  m.handoff.requested implies (later.handoff.acknowledged or later.handoff.drainRefused)
```

## Story: Keep a live capture's ending even when a call interrupts it

> As a person whose call interrupts live dictation, I want the assistant to
> learn that the capture ended, and a capture that never really started to
> leave no trace.

### A start the host never heard about is discarded

A native start goes ahead only while the host is open and starts are
allowed, and it counts as started only once it is reported to that same
host. A start blocked before its report is refused and discarded, never
reported. A phone call blocks new starts without revoking delivery to the
host that already admitted the capture, and a retired host never becomes
the original host again.

```quint
pure def canNativeStart(m: Microphone): bool = m.capture.phase == CaptureReserved
pure def nativeStart(m: Microphone): Microphone =
  if (m.hostOpen and m.capture.startAllowed) { ...m, capture: { ...m.capture, phase: CaptureStarting } }
  else { ...m, capture: { ...m.capture, phase: StartRefused, discarded: true } }
pure def canReportStart(m: Microphone): bool = m.capture.phase == CaptureStarting
pure def reportStart(m: Microphone): Microphone =
  if (m.hostOpen and m.capture.startAllowed) { ...m, capture: { ...m.capture, phase: CaptureRunning, reported: true } }
  else { ...m, capture: { ...m.capture, phase: StartRefused, discarded: true } }
pure def canBlockStarts(m: Microphone): bool = m.capture.startAllowed
pure def blockStarts(m: Microphone): Microphone = { ...m, capture: { ...m.capture, startAllowed: false } }
pure def canAllowStarts(m: Microphone): bool = not(m.capture.startAllowed)
pure def allowStarts(m: Microphone): Microphone = { ...m, capture: { ...m.capture, startAllowed: true } }
pure def canRetireHost(m: Microphone): bool = m.hostOpen
pure def retireHost(m: Microphone): Microphone = { ...m, hostOpen: false }
pure def stepRetiredHostStaysRetired(before: Microphone, after: Microphone): bool = not(before.hostOpen) implies not(after.hostOpen)
pure def alwaysRefusedStartDiscarded(m: Microphone): bool =
  m.capture.phase == StartRefused implies m.capture.discarded and not(m.capture.reported)
pure def alwaysReportFollowsStart(m: Microphone): bool =
  ((m.capture.phase == CaptureReserved or m.capture.phase == CaptureStarting) implies not(m.capture.reported) and not(m.capture.discarded)) and
  ((m.capture.phase == CaptureRunning or m.capture.phase == EndPending or m.capture.phase == CaptureEnded) implies m.capture.reported and not(m.capture.discarded))
pure def sometimesLateBlockDiscards(m: Microphone): bool = m.capture.phase == StartRefused and m.hostOpen
```

### An admitted capture's end reaches its still-current host

An interruption of a reported capture is owed to the host as an end event;
an interruption before the report discards the capture. The end is
delivered to the host that admitted the capture whenever that host is still
open, even while new starts are blocked by a call. A retired host is not
sent it.

```quint
pure def canInterruptCapture(m: Microphone): bool =
  m.capture.phase == CaptureReserved or m.capture.phase == CaptureStarting or m.capture.phase == CaptureRunning
pure def interruptCapture(m: Microphone): Microphone =
  if (m.capture.reported) { ...m, capture: { ...m.capture, phase: EndPending } }
  else { ...m, capture: { ...m.capture, phase: StartRefused, discarded: true } }
pure def canDeliverEnd(m: Microphone): bool = m.capture.phase == EndPending
pure def deliverEnd(m: Microphone): Microphone =
  { ...m, capture: { ...m.capture, phase: CaptureEnded, consumed: true, deliveryRequired: m.hostOpen, delivered: m.hostOpen } }
pure def alwaysTerminalDelivered(m: Microphone): bool = m.capture.consumed and m.capture.deliveryRequired implies m.capture.delivered
pure def alwaysNoUnreportedEnd(m: Microphone): bool = m.capture.delivered implies m.capture.reported and not(m.capture.discarded)
pure def sometimesEndDeliveredDuringCall(m: Microphone): bool = m.capture.delivered and not(m.capture.startAllowed)
pure def sometimesRetiredHostNotSent(m: Microphone): bool = m.capture.phase == CaptureEnded and not(m.capture.delivered)
pure val fair_deliverEnd = "weak"
pure def leadsToEndSettles(m: Microphone, later: Microphone): bool =
  m.capture.phase == EndPending implies (later.capture.delivered or not(later.hostOpen))
```
