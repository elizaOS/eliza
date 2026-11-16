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
the gap. A trace whose identity is already queued adds no row: the caller
is told it is a replay if it is the same document and a conflict
otherwise. After withdrawal every trace is refused.

```quint
type TraceAnswer = NoAnswer | TraceQueued | TraceReplay | TraceConflict | TraceFull | TraceRefused | FlushBusy | FlushEmpty | UploadPending | UploadAcknowledged | UploadRejected | QueueClosed | CloseRefused
type TraceQueue = { rows: Set[int], batch: Set[int], dropped: int, cursor: int, withdrawn: bool, closed: bool, answer: TraceAnswer }
pure val queueCapacity = 2
pure val initial: TraceQueue = { rows: Set(), batch: Set(), dropped: 0, cursor: -1, withdrawn: false, closed: false, answer: NoAnswer }
pure def canEnqueueTrace(q: TraceQueue, trace: int, sameDocument: bool): bool = not(q.closed) and trace > 0
pure def enqueueTrace(q: TraceQueue, trace: int, sameDocument: bool): TraceQueue =
  if (q.withdrawn) { ...q, answer: TraceRefused }
  else if (q.rows.contains(trace)) { ...q, answer: if (sameDocument) TraceReplay else TraceConflict }
  else if (q.rows.size() >= queueCapacity) { ...q, dropped: q.dropped + 1, answer: TraceFull }
  else { ...q, rows: q.rows.union(Set(trace)), answer: TraceQueued }
pure val sameDocumentValues = Set(true, false)
pure def canCheckpointTrace(q: TraceQueue, cursor: int): bool = not(q.closed) and not(q.withdrawn) and cursor >= 0
pure def checkpointTrace(q: TraceQueue, cursor: int): TraceQueue = { ...q, cursor: cursor }
pure val traceValues = Set(0, 1, 2, 3)
pure val cursorValues = Set(-1, 0, 1)
pure def alwaysQueueWithinCapacity(q: TraceQueue): bool =
  q.rows.size() <= queueCapacity and q.batch.size() <= queueCapacity and q.dropped >= 0 and q.rows.forall(t => t > 0)
pure def stepOnlyAQueuedAnswerAddsARow(before: TraceQueue, via: str, after: TraceQueue): bool =
  via == "enqueueTrace" implies (if (after.answer == TraceQueued) after.rows.size() == before.rows.size() + 1 else (after.rows.subseteq(before.rows) and before.rows.subseteq(after.rows)))
pure def sometimesFullQueueCountsGap(q: TraceQueue): bool = q.answer == TraceFull and q.rows.size() == queueCapacity
pure def sometimesReplayKeepsRows(q: TraceQueue): bool = q.answer == TraceReplay
pure def sometimesConflictKeepsRows(q: TraceQueue): bool = q.answer == TraceConflict
```

### An upload receipt retires exactly its batch, and an inexact receipt retires nothing

A flush snapshots the queued rows as the batch and answers that the upload
is pending; with a batch already in flight it answers busy, and with no
rows, empty. The upload's receipt retires the batch only if
it is durable and names exactly the batch's traces and count; any other
receipt keeps every row and is answered as rejected. Traces queued after
the snapshot stay queued.
Assuming the service eventually answers, every batch settles.

```quint
pure def canFlushTraces(q: TraceQueue): bool = not(q.closed)
pure def flushTraces(q: TraceQueue): TraceQueue =
  if (q.batch.size() > 0) { ...q, answer: FlushBusy }
  else if (q.rows.size() == 0) { ...q, answer: FlushEmpty }
  else { ...q, batch: q.rows, answer: UploadPending }
pure def receiptExact(q: TraceQueue, durable: bool, accepted: Set[int], count: int): bool =
  durable and accepted.subseteq(q.batch) and q.batch.subseteq(accepted) and count == q.batch.size()
pure def canSettleUpload(q: TraceQueue): bool = q.batch.size() > 0
pure def settleUpload(q: TraceQueue, durable: bool, accepted: Set[int], count: int): TraceQueue =
  if (receiptExact(q, durable, accepted, count)) { ...q, batch: Set(), rows: q.rows.exclude(q.batch), answer: UploadAcknowledged }
  else { ...q, batch: Set(), answer: UploadRejected }
pure val acceptedValues = Set(Set(), Set(1), Set(1, 2), Set(1, 3))
pure val countValues = Set(0, 1, 2, 3)
pure def alwaysBatchIsQueued(q: TraceQueue): bool = not(q.withdrawn) implies q.batch.subseteq(q.rows)
pure def stepReceiptRetiresOnlyItsBatch(before: TraceQueue, via: str, after: TraceQueue): bool =
  (via == "settleUpload") implies
    (if (after.answer == UploadAcknowledged) (after.rows.subseteq(before.rows.exclude(before.batch)) and before.rows.exclude(before.batch).subseteq(after.rows))
     else (after.rows.subseteq(before.rows) and before.rows.subseteq(after.rows)))
pure def sometimesLaterTraceSurvivesReceipt(q: TraceQueue): bool = q.answer == UploadAcknowledged and q.rows.size() > 0
pure def sometimesInexactReceiptKeepsRows(q: TraceQueue): bool = q.answer == UploadRejected and q.rows.size() > 0
pure def sometimesFlushBusy(q: TraceQueue): bool = q.answer == FlushBusy
pure def leadsToUploadSettles(q: TraceQueue, later: TraceQueue): bool = q.batch.size() > 0 implies later.batch.size() == 0
pure val fair_settleUpload = "weak"
```

### Withdrawing consent clears the queue and its cursor for good

Withdrawal deletes every queued trace and the cursor, and every later trace
is refused, including after a late receipt, a close and a reopen.

```quint
pure def canWithdrawTraces(q: TraceQueue): bool = not(q.closed)
pure def withdrawTraces(q: TraceQueue): TraceQueue = { ...q, rows: Set(), cursor: -1, withdrawn: true }
pure def alwaysWithdrawalClearsCapture(q: TraceQueue): bool = q.withdrawn implies (q.rows.size() == 0 and q.cursor == -1)
pure def stepWithdrawalPersists(before: TraceQueue, after: TraceQueue): bool = before.withdrawn implies after.withdrawn
pure def sometimesWithdrawnAfterLateReceipt(q: TraceQueue): bool = q.withdrawn and q.batch.size() == 0 and (q.answer == UploadAcknowledged or q.answer == UploadRejected)
pure def sometimesWithdrawnRefusesTraces(q: TraceQueue): bool = q.withdrawn and q.answer == TraceRefused
```

### The queue closes only with no upload in flight, and reopens with its rows

Closing while a batch is in flight is refused, and the caller is told so.
A closed queue reopens with the rows, cursor and gap count it had.

```quint
pure def canCloseQueue(q: TraceQueue): bool = not(q.closed)
pure def closeQueue(q: TraceQueue): TraceQueue = if (q.batch.size() == 0) { ...q, closed: true, answer: QueueClosed } else { ...q, answer: CloseRefused }
pure def canReopenQueue(q: TraceQueue): bool = q.closed
pure def reopenQueue(q: TraceQueue): TraceQueue = { ...q, closed: false }
pure def alwaysClosedHasNoUpload(q: TraceQueue): bool = q.closed implies q.batch.size() == 0
pure def stepReopenKeepsQueue(before: TraceQueue, via: str, after: TraceQueue): bool =
  via == "reopenQueue" implies after.rows.subseteq(before.rows) and before.rows.subseteq(after.rows) and after.cursor == before.cursor and after.dropped == before.dropped
pure def sometimesClosedWithRows(q: TraceQueue): bool = q.closed and q.rows.size() > 0 and q.cursor >= 0
pure def sometimesCloseRefused(q: TraceQueue): bool = q.answer == CloseRefused
```
