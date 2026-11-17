# Voice turn timing

Each voice turn keeps one in-memory timing record: when recording began,
when its transcript was ready and when the turn was sent. Marks change
only the record in memory; a deferred or explicit flush writes it to
diagnostic storage. Timing never decides whether or when a turn is sent,
which is the [voice endpoint](./endpoint.md)'s job, and a storage failure
may lose unsaved timing. A [live session](./liveSession.md) produces the
turns it times.

## Story: See where time went in a voice turn

> As a person diagnosing a slow voice reply, I want each turn's timing
> marks in order, without the diagnostics ever holding up the turn.

### Timing marks belong to one turn and are monotonic

A timing record begins for one turn. Its ready and sent marks name that
same turn, come in that order, and carry times no earlier than the mark
before them. A sent mark needs a ready mark, and a record is active only
once it has begun.

```quint
type TurnTiming = { turnId: int, begun: bool, active: bool, ready: bool, sent: bool,
  begunAt: int, readyAt: int, sentAt: int, dirty: bool, scheduled: bool, stored: bool, cleared: bool, writes: int }
pure val initial: TurnTiming = { turnId: 0, begun: false, active: false, ready: false, sent: false,
  begunAt: 0, readyAt: 0, sentAt: 0, dirty: false, scheduled: false, stored: false, cleared: false, writes: 0 }
pure def canBeginTiming(t: TurnTiming, turnId: int, at: int): bool = not(t.begun) and turnId > 0 and at >= 0
pure def beginTiming(t: TurnTiming, turnId: int, at: int): TurnTiming =
  { ...t, turnId: turnId, begun: true, active: true, begunAt: at, dirty: true, scheduled: true }
pure def canMarkReady(t: TurnTiming, turnId: int, at: int): bool =
  t.active and not(t.ready) and turnId == t.turnId and at >= t.begunAt
pure def markReady(t: TurnTiming, turnId: int, at: int): TurnTiming =
  { ...t, ready: true, readyAt: at, dirty: true, scheduled: true }
pure def canMarkSent(t: TurnTiming, turnId: int, at: int): bool =
  t.active and t.ready and not(t.sent) and turnId == t.turnId and at >= t.readyAt
pure def markSent(t: TurnTiming, turnId: int, at: int): TurnTiming =
  { ...t, sent: true, sentAt: at, dirty: true, scheduled: true }
pure val turnIdValues = Set(0, 1, 2)
pure val atValues = Set(0, 40, 90)
pure def alwaysMarksAreMonotonic(t: TurnTiming): bool =
  t.begunAt >= 0 and (t.ready implies t.begun and t.readyAt >= t.begunAt) and
  (t.sent implies t.ready and t.sentAt >= t.readyAt) and (t.begun implies t.turnId > 0) and
  (t.active implies t.begun)
pure def sometimesTurnFullyTimed(t: TurnTiming): bool = t.sent and t.sentAt > t.begunAt
```

### Timing is diagnostic and never gates a turn

A mark never writes storage. A storage failure drops the unsaved change but
leaves the turn exactly as active as it was. Finishing and clearing the
record end only the record; only a begun record is cleared, clearing
removes what was stored, and nothing can bring it back.

```quint
pure def canFlushTiming(t: TurnTiming): bool = t.dirty
pure def flushTiming(t: TurnTiming): TurnTiming =
  { ...t, dirty: false, scheduled: false, stored: true, writes: t.writes + 1 }
pure def canFailTimingStorage(t: TurnTiming): bool = t.dirty
pure def failTimingStorage(t: TurnTiming): TurnTiming = { ...t, dirty: false, scheduled: false }
pure def canFinishTiming(t: TurnTiming): bool = t.active
pure def finishTiming(t: TurnTiming): TurnTiming = { ...t, active: false }
pure def canClearTiming(t: TurnTiming): bool = t.begun
pure def clearTiming(t: TurnTiming): TurnTiming =
  { ...t, active: false, dirty: false, stored: false, cleared: true }
pure def canStaleTimer(t: TurnTiming): bool = t.scheduled and not(t.dirty)
pure def staleTimer(t: TurnTiming): TurnTiming = { ...t, scheduled: false }
pure def stepMarksDoNoStorageWrite(before: TurnTiming, via: str, after: TurnTiming): bool =
  (via == "beginTiming" or via == "markReady" or via == "markSent") implies after.writes == before.writes
pure def stepStorageFailureKeepsTurn(before: TurnTiming, via: str, after: TurnTiming): bool =
  via == "failTimingStorage" implies after.active == before.active and after.ready == before.ready and after.sent == before.sent
pure def alwaysClearedTimingStaysGone(t: TurnTiming): bool =
  t.cleared implies t.begun and not(t.stored) and not(t.dirty) and not(t.active)
pure def sometimesStorageFailureKeepsTurn(t: TurnTiming): bool = t.active and t.ready and not(t.dirty) and not(t.stored)
pure def sometimesClearedTiming(t: TurnTiming): bool = t.cleared and t.writes > 0
```

### A pending timing change is eventually flushed or dropped

When the deferred flush keeps running, every unsaved change is written,
or dropped by a storage failure.

```quint
pure val fair_flushTiming = "weak"
pure def leadsToPendingWriteSettles(t: TurnTiming, later: TurnTiming): bool = t.dirty implies not(later.dirty)
```
