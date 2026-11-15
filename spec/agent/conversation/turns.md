# Room turn slots and abort receipts

Each conversation room runs at most one agent turn at a time. Stop asks the
running turn to abort; the [core turn registry](../../core/turnControllers.md)
signals its controller, and the [client turn controller](../client/conversation.md)
waits for the Stop receipt before it sends again. This spec owns the room's
slot on the server: when it is released, and what a Stop reports when the
turn does not confirm that it stopped.

## Story: Stop a reply and know whether it really stopped

> As a user, when I press Stop I am told either that the reply stopped or
> that its outcome is uncertain, and my next message never runs beside a
> turn that may still be working.

### A room starts a new turn only when its slot is free

A turn takes the room's slot with a fresh identity. A second turn cannot
start while the slot is held by a running, aborting or uncertain turn.

```quint
type SlotPhase = SlotFree | TurnRunning | TurnAborting | TurnUncertain
type TurnOutcome = NoTurnOutcome | TurnReplied | TurnCancelled | TurnOutcomeUnknown
type RoomSlot = { phase: SlotPhase, turn: int, nextTurn: int, outcome: TurnOutcome, abortedTurn: int }
pure val initial: RoomSlot = { phase: SlotFree, turn: 0, nextTurn: 1, outcome: NoTurnOutcome, abortedTurn: 0 }
pure def canStartTurn(r: RoomSlot): bool = r.phase == SlotFree
pure def startTurn(r: RoomSlot): RoomSlot = { ...r, phase: TurnRunning, turn: r.nextTurn, nextTurn: r.nextTurn + 1, outcome: NoTurnOutcome, abortedTurn: 0 }
pure def canFinishTurn(r: RoomSlot): bool = r.phase == TurnRunning
pure def finishTurn(r: RoomSlot): RoomSlot = { ...r, phase: SlotFree, turn: 0, outcome: TurnReplied }
pure def alwaysHeldSlotHasATurn(r: RoomSlot): bool =
  (r.phase == SlotFree) == (r.turn == 0) and r.turn < r.nextTurn and r.turn >= 0
pure def sometimesTurnReplied(r: RoomSlot): bool = r.outcome == TurnReplied
```

### An abort releases the slot only after the turn confirms it stopped

Stop moves a running turn to aborting. The slot is released as cancelled
only when that turn confirms it stopped.

```quint
pure def canRequestAbort(r: RoomSlot): bool = r.phase == TurnRunning
pure def requestAbort(r: RoomSlot): RoomSlot = { ...r, phase: TurnAborting, abortedTurn: r.turn }
pure def canConfirmAbort(r: RoomSlot): bool = r.phase == TurnAborting
pure def confirmAbort(r: RoomSlot): RoomSlot = { ...r, phase: SlotFree, turn: 0, outcome: TurnCancelled }
pure def stepCancelledOnlyByConfirmation(before: RoomSlot, via: str, after: RoomSlot): bool =
  (after.outcome == TurnCancelled and before.outcome != TurnCancelled) implies (via == "confirmAbort" and before.phase == TurnAborting)
pure def sometimesAbortConfirmed(r: RoomSlot): bool = r.outcome == TurnCancelled
```

### An abort that is not confirmed in time reports an uncertain outcome

If the turn does not confirm within the abort deadline, Stop reports the
outcome as uncertain, never as cancelled, and the turn keeps the slot until
its own cleanup returns.

```quint
pure def canAbortDeadline(r: RoomSlot): bool = r.phase == TurnAborting
pure def abortDeadline(r: RoomSlot): RoomSlot = { ...r, phase: TurnUncertain, outcome: TurnOutcomeUnknown }
pure def canCleanUpUncertain(r: RoomSlot): bool = r.phase == TurnUncertain
pure def cleanUpUncertain(r: RoomSlot): RoomSlot = { ...r, phase: SlotFree, turn: 0 }
pure def alwaysUncertainTurnHoldsItsSlot(r: RoomSlot): bool =
  (r.phase == TurnUncertain implies (r.outcome == TurnOutcomeUnknown and r.turn == r.abortedTurn and r.turn > 0)) and
  (r.phase == TurnAborting implies r.turn == r.abortedTurn)
pure def sometimesUncertainSlotReleased(r: RoomSlot): bool = r.phase == SlotFree and r.outcome == TurnOutcomeUnknown
```
