# Native trace queue

The native host keeps consented diagnostic traces in a durable local queue
and uploads them in batches. One upload is in flight at a time; its receipt
retires exactly the traces it covered. Withdrawing consent clears the queue
for good. What a trace contains and who may receive it belong to the
consumer that records it; this spec owns the queue's durability and
receipts.

## Story: Upload each trace once and keep it until the upload is confirmed

> As a device owner who consented to diagnostics, every trace is uploaded
> once, kept until the service confirms it, and nothing is kept or sent
> after I withdraw consent.

### The queue holds at most its capacity, and a replay or conflict adds no row

A new trace is queued while there is room. A full queue drops it and counts
the gap. A trace whose identity is already queued is a replay if it is the
same document and a conflict otherwise; neither adds a row.

```quint
type TraceResult = TraceNone | TraceQueued | TraceReplay | TraceConflict | TraceFull | TraceWithdrawn | TraceCheckpoint | TraceBusy | TraceEmpty | TracePending | TraceAcknowledged | TraceFailed | TraceClosed | TraceCloseRefused | TraceReopened
type TraceQueue = { rows: Set[int], batch: Set[int], dropped: int, cursor: int, withdrawn: bool, closed: bool, result: TraceResult }
pure val queueCapacity = 2
pure val initial: TraceQueue = { rows: Set(), batch: Set(), dropped: 0, cursor: -1, withdrawn: false, closed: false, result: TraceNone }
pure def canEnqueueTrace(q: TraceQueue, trace: int): bool = not(q.closed) and trace > 0
pure def enqueueTrace(q: TraceQueue, trace: int, sameDocument: bool): TraceQueue =
  if (q.withdrawn) { ...q, result: TraceWithdrawn }
  else if (q.rows.contains(trace)) { ...q, result: if (sameDocument) TraceReplay else TraceConflict }
  else if (q.rows.size() >= queueCapacity) { ...q, dropped: q.dropped + 1, result: TraceFull }
  else { ...q, rows: q.rows.union(Set(trace)), result: TraceQueued }
pure def canCheckpointTrace(q: TraceQueue, cursor: int): bool = not(q.closed) and not(q.withdrawn) and cursor >= 0
pure def checkpointTrace(q: TraceQueue, cursor: int): TraceQueue = { ...q, cursor: cursor, result: TraceCheckpoint }
pure val traceValues = Set(0, 1, 2, 3)
pure val cursorValues = Set(-1, 0, 1)
pure def alwaysQueueWithinCapacity(q: TraceQueue): bool =
  q.rows.size() <= queueCapacity and q.batch.size() <= queueCapacity and q.dropped >= 0 and q.rows.forall(t => t > 0)
pure def sometimesFullQueueCountsGap(q: TraceQueue): bool = q.result == TraceFull and q.rows.size() == queueCapacity
pure def sometimesReplayKeepsRows(q: TraceQueue): bool = q.result == TraceReplay
```

### An upload receipt retires exactly its batch, and an inexact receipt retires nothing

A flush snapshots the queued rows as the batch, unless a batch is already in
flight or the queue is empty. The upload's receipt retires the batch only if
it is durable and names exactly the batch's traces and count; any other
receipt keeps every row. Traces queued after the snapshot stay queued.
Assuming the service eventually answers, every batch settles.

```quint
pure def canFlushTraces(q: TraceQueue): bool = not(q.closed)
pure def flushTraces(q: TraceQueue): TraceQueue =
  if (q.batch.size() > 0) { ...q, result: TraceBusy }
  else if (q.rows.size() == 0) { ...q, result: TraceEmpty }
  else { ...q, batch: q.rows, result: TracePending }
pure def receiptExact(q: TraceQueue, durable: bool, accepted: Set[int], count: int): bool =
  durable and accepted.subseteq(q.batch) and q.batch.subseteq(accepted) and count == q.batch.size()
pure def canSettleUpload(q: TraceQueue): bool = q.batch.size() > 0
pure def settleUpload(q: TraceQueue, durable: bool, accepted: Set[int], count: int): TraceQueue =
  if (receiptExact(q, durable, accepted, count)) { ...q, batch: Set(), rows: q.rows.exclude(q.batch), result: TraceAcknowledged }
  else { ...q, batch: Set(), result: TraceFailed }
pure val acceptedValues = Set(Set(), Set(1), Set(1, 2), Set(1, 3))
pure val countValues = Set(0, 1, 2, 3)
pure def alwaysBatchIsQueued(q: TraceQueue): bool = not(q.withdrawn) implies q.batch.subseteq(q.rows)
pure def stepReceiptRetiresOnlyItsBatch(before: TraceQueue, via: str, after: TraceQueue): bool =
  (via == "settleUpload") implies
    (if (after.result == TraceAcknowledged) (after.rows.subseteq(before.rows.exclude(before.batch)) and before.rows.exclude(before.batch).subseteq(after.rows))
     else (after.rows.subseteq(before.rows) and before.rows.subseteq(after.rows)))
pure def sometimesLaterTraceSurvivesReceipt(q: TraceQueue): bool = q.result == TraceAcknowledged and q.rows.size() > 0
pure def sometimesInexactReceiptKeepsRows(q: TraceQueue): bool = q.result == TraceFailed and q.rows.size() > 0
pure def leadsToUploadSettles(q: TraceQueue, later: TraceQueue): bool = q.batch.size() > 0 implies later.batch.size() == 0
pure val fair_settleUpload = "weak"
```

### Withdrawing consent clears the queue and its cursor for good

Withdrawal deletes every queued trace and the cursor, and every later trace
is refused, including after a late receipt, a close and a reopen.

```quint
pure def canWithdrawTraces(q: TraceQueue): bool = not(q.closed)
pure def withdrawTraces(q: TraceQueue): TraceQueue = { ...q, rows: Set(), cursor: -1, withdrawn: true, result: TraceWithdrawn }
pure def alwaysWithdrawalClearsCapture(q: TraceQueue): bool = q.withdrawn implies (q.rows.size() == 0 and q.cursor == -1)
pure def stepWithdrawalPersists(before: TraceQueue, after: TraceQueue): bool = before.withdrawn implies after.withdrawn
pure def sometimesWithdrawnRefusesTraces(q: TraceQueue): bool = q.withdrawn and q.result == TraceWithdrawn and q.batch.size() == 0
```

### The queue closes only with no upload in flight, and reopens with its rows

Closing is refused while a batch is in flight. A closed queue reopens with
the rows, cursor and gap count it had.

```quint
pure def canCloseQueue(q: TraceQueue): bool = not(q.closed)
pure def closeQueue(q: TraceQueue): TraceQueue = if (q.batch.size() == 0) { ...q, closed: true, result: TraceClosed } else { ...q, result: TraceCloseRefused }
pure def canReopenQueue(q: TraceQueue): bool = q.closed
pure def reopenQueue(q: TraceQueue): TraceQueue = { ...q, closed: false, result: TraceReopened }
pure def alwaysClosedHasNoUpload(q: TraceQueue): bool = q.closed implies q.batch.size() == 0
pure def sometimesReopenedWithRows(q: TraceQueue): bool = q.result == TraceReopened and q.rows.size() > 0 and q.cursor >= 0
pure def sometimesCloseRefused(q: TraceQueue): bool = q.result == TraceCloseRefused
```
