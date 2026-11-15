# Calendar

The calendar package reads, links and changes the owner's calendars. A
consumer's agent reads only what the owner reviewed, writes only the
exact event or series scope the owner chose, and keeps a resident
calendar in step with a linked provider calendar without overwriting an
independent edit. Provider access for managed accounts is the Cloud's
[managed Google](../cloud/managedGoogle/connection.md) connection.

| Area | Specifications |
| --- | --- |
| Reading | [Reviewed reads](./reviewedReads.md), [availability](./availability.md), [read clock](./readClock.md), [occurrence grouping](./aggregateMerge.md) |
| Changing | [Event and series scope](./seriesScope.md), [mutation ledger](./mutationLedger.md) |
| Linked sync | [Sync control](./linkedSync.md), [reconciliation](./linkedReconcile.md), [sync settlement](./syncSettlement.md), [managed feed](./managedFeed.md) |

## Story: Read a relative date range on the day the run was admitted

> As the owner, I want a reviewed read of "today" or "this week" to mean
> the day my run was admitted, not the day it happens to execute.

### A relative range needs a peer that speaks the matching protocol

An absolute range is understood by any peer. A relative range needs
protocol 4, and a relative range anchored to the run's admitted day
needs protocol 5. A peer below that version cannot review it.

```quint
pure def relativeRangeProtocol(anchored: bool): int = if (anchored) 5 else 4
pure def peerUnderstandsRange(relative: bool, anchored: bool, peerProtocol: int): bool =
  not(relative) or peerProtocol >= relativeRangeProtocol(anchored)
pure def lawAbsoluteRangeNeedsNoProtocol(anchored: bool, peerProtocol: int): bool =
  peerUnderstandsRange(false, anchored, peerProtocol)
pure def lawAnchoredRangeRefusesOldPeer(peerProtocol: int): bool =
  peerProtocol < 5 implies not(peerUnderstandsRange(true, true, peerProtocol))
pure val peerProtocolValues = Set(3, 4, 5)
```

### A relative range stays on the day it captured, with a carryover only until it ends

An anchored range always reads the day the run was admitted, however
late it executes. A queued unanchored range reads the day it captured;
right after midnight it may still read the previous day until the
carryover ends, and after that its window is no longer current and the
read is refused rather than rebound to the new day.

```quint
pure def rangeWindowCurrent(relative: bool, anchored: bool, capturedDay: int, runDay: int, today: int, carryover: bool): bool =
  not(relative) or (if (anchored) capturedDay == runDay else capturedDay == today or (carryover and capturedDay == today - 1))
pure def lawAnchoredRangeKeepsRunDay(runDay: int, today: int, carryover: bool): bool =
  rangeWindowCurrent(true, true, runDay, runDay, today, carryover)
pure def lawExpiredWindowIsNotRebound(capturedDay: int, runDay: int, today: int): bool =
  capturedDay < today implies not(rangeWindowCurrent(true, false, capturedDay, runDay, today, false))
pure val capturedDayValues = Set(-1, 0, 1)
pure val todayValues = Set(0, 1)
pure val runDayValues = Set(0, 1)
```
