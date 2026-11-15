# Process-wide microphone slot

On Android, on-device speech uses one process-wide microphone slot shared by
independent capture owners: live speech controllers and the draft recorder.
Each reservation gets a fresh token. A release receipt for an older token
changes nothing. [Microphone handoff](./microphoneHandoff.md) moves the
microphone between a running capture and the draft recorder;
[voice capture](./capture.md) owns the turn around it.

## Story: Share the device microphone between independent capture owners

> As a person using voice in more than one place in the app, I want only
> one of them to hold the microphone at a time, and a stuck release never
> to hand my microphone to someone else.

### One owner holds the slot, and others are refused while it does

A reservation succeeds only when the slot is empty and takes a new token.
A second owner's reservation while the slot is held is refused and
recorded, and the holder keeps the slot. Only the holder's microphone may
be open.

```quint
type SlotPhase = SlotIdle | SlotOpening | SlotRunning | SlotClosing | SlotUnconfirmed
type MicrophoneSlot = { owner: int, draftOwner: bool, token: int, issued: int, phase: SlotPhase, open: bool, refused: int }
pure val initial: MicrophoneSlot = { owner: 0, draftOwner: false, token: 0, issued: 0, phase: SlotIdle, open: false, refused: 0 }
pure def canReserveSlot(m: MicrophoneSlot, owner: int, draftRecorder: bool): bool = owner > 0
pure def reserveSlot(m: MicrophoneSlot, owner: int, draftRecorder: bool): MicrophoneSlot =
  if (m.owner == 0)
    { ...m, owner: owner, draftOwner: draftRecorder, token: m.issued + 1, issued: m.issued + 1, phase: SlotOpening, refused: 0 }
  else { ...m, refused: owner }
pure val ownerValues = Set(0, 1, 2)
pure def canOpenedSlot(m: MicrophoneSlot): bool = m.phase == SlotOpening
pure def openedSlot(m: MicrophoneSlot): MicrophoneSlot = { ...m, phase: SlotRunning, open: true }
pure def alwaysOnlyAnOwnerMayOpen(m: MicrophoneSlot): bool = m.open implies m.owner != 0 and m.token != 0
pure def alwaysEmptySlotIsIdle(m: MicrophoneSlot): bool =
  (m.owner == 0) == (m.phase == SlotIdle and m.token == 0 and not(m.open))
pure def sometimesSecondOwnerRefused(m: MicrophoneSlot): bool = m.refused > 0 and m.owner > 0 and m.refused != m.owner
```

### The slot is freed only by its own release receipt

Cancelling an opening or running capture starts closing it; a source that
finishes opening after its cancellation is still closed. Only a release
receipt frees the slot. A release that cannot be confirmed leaves the slot
held, except for the draft recorder, whose unconfirmed release may be
retried until it frees the slot. A release receipt for an earlier token
changes nothing.

```quint
pure def canCancelSlot(m: MicrophoneSlot): bool = m.phase == SlotOpening or m.phase == SlotRunning
pure def cancelSlot(m: MicrophoneSlot): MicrophoneSlot = { ...m, phase: SlotClosing }
pure def canLateOpen(m: MicrophoneSlot): bool = m.phase == SlotClosing and not(m.open)
pure def lateOpen(m: MicrophoneSlot): MicrophoneSlot = { ...m, open: true }
pure def canReleaseSlot(m: MicrophoneSlot): bool =
  m.phase == SlotOpening or m.phase == SlotClosing or (m.phase == SlotUnconfirmed and m.draftOwner)
pure def releaseSlot(m: MicrophoneSlot): MicrophoneSlot =
  { ...m, owner: 0, draftOwner: false, token: 0, phase: SlotIdle, open: false }
pure def canReleaseUnconfirmed(m: MicrophoneSlot): bool = m.phase == SlotOpening or m.phase == SlotClosing
pure def releaseUnconfirmed(m: MicrophoneSlot): MicrophoneSlot = { ...m, phase: SlotUnconfirmed }
pure def canStaleRelease(m: MicrophoneSlot, ticket: int): bool = ticket > 0 and ticket <= m.issued and ticket != m.token
pure def staleRelease(m: MicrophoneSlot, ticket: int): MicrophoneSlot = m
pure val ticketValues = Set(1, 2, 3)
pure def alwaysHeldSlotHasCurrentToken(m: MicrophoneSlot): bool =
  m.phase != SlotIdle implies m.owner > 0 and m.token == m.issued and m.token > 0
pure def stepStaleReleaseChangesNothing(before: MicrophoneSlot, via: str, after: MicrophoneSlot): bool =
  via == "staleRelease" implies after == before
pure def sometimesUnconfirmedReleaseHoldsSlot(m: MicrophoneSlot): bool = m.phase == SlotUnconfirmed and not(m.draftOwner)
pure def sometimesSlotReused(m: MicrophoneSlot): bool = m.issued >= 2 and m.phase == SlotRunning
```

### A closing capture always reports its outcome

When release receipts keep arriving, a closing capture leaves closing:
released, or held unconfirmed.

```quint
pure val fair_releaseSlot = "weak"
pure val fair_releaseUnconfirmed = "weak"
pure def leadsToClosingReports(m: MicrophoneSlot, later: MicrophoneSlot): bool =
  m.phase == SlotClosing implies later.phase != SlotClosing
```
