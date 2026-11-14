# Connection reconciliation ownership

`connection.ts` serializes metadata read/merge/write by actual adapter identity and record key. The same key on different adapters is independent. It is process-local serialization, with no claim of cross-process storage isolation. The promise queue machinery is shared with [connector queues](./connectorQueues.md).

## Story: Reconcile overlapping records without lost in-process updates

### A batch acquires deduplicated recordKeys in one strict lexical order

The source sorts unique string recordKeys before nested acquisition. The boundary supplies an order rank that preserves that exact lexical order; the model checks strictly increasing ranks. The reconciliation callback starts only after acquiring every key. Rejection still settles all owned queue tickets. A 30-second warning never releases ownership or cancels the database write. Queue cleanup removes only the exact current tail; an adapter registry disappears when no tails remain for it.
Discovered by the proof: a call's acquisition cursor stays within its key list,
and its held-ticket count equals that cursor until callback entry. Call
identities remain unique, and the embedded queue retains its complete
allocation and settled-entry invariants.

```quint
import connectorQueues as Q from "./connectorQueues"
type RecordKey = { key: str, rank: int }
type ReconcilePhase = AcquiringRecords | ExecutingRecords | ReleasingRecords | Reconciled
type Reconciliation = { id: int, adapter: str, recordKeys: List[RecordKey], position: int, waiting: int, held: List[int], phase: ReconcilePhase, failed: bool, warned: bool }
type Reconciliations = { queue: Q::ConnectorQueues, calls: List[Reconciliation], keyCatalog: List[RecordKey] }
type KeyOrder = { prior: int, valid: bool }
pure val initial: Reconciliations = { queue: Q::initial, calls: List(), keyCatalog: List() }
pure val noKey: RecordKey = { key: "", rank: -1 }
pure val noCall: Reconciliation = { id: 0, adapter: "", recordKeys: List(), position: 0, waiting: 0, held: List(), phase: Reconciled, failed: false, warned: false }
pure def orderedKeys(recordKeys: List[RecordKey]): bool = recordKeys.foldl({ prior: -1, valid: true }, (check, key) => { prior: key.rank, valid: check.valid and key.rank > check.prior }).valid and recordKeys.every(key => recordKeys.select(other => other.key == key.key).length() == 1)
pure def callAt(s: Reconciliations, id: int): Reconciliation = s.calls.select(call => call.id == id).nthOr(0, noCall)
pure def canAdmit(s: Reconciliations, id: int, recordKeys: List[RecordKey]): bool = id > 0 and not(s.calls.some(call => call.id == id)) and orderedKeys(recordKeys) and recordKeys.every(key => s.keyCatalog.every(known => (known.key != key.key or known.rank == key.rank) and (known.rank != key.rank or known.key == key.key)))
pure def admit(s: Reconciliations, id: int, adapter: str, recordKeys: List[RecordKey]): Reconciliations = { ...s, keyCatalog: s.keyCatalog.concat(recordKeys.select(key => not(s.keyCatalog.some(known => known.key == key.key)))), calls: s.calls.append({ id: id, adapter: adapter, recordKeys: recordKeys, position: 0, waiting: 0, held: List(), phase: if (recordKeys.length() == 0) ExecutingRecords else AcquiringRecords, failed: false, warned: false }) }
pure def canEnqueueKey(s: Reconciliations, id: int): bool = callAt(s, id).phase == AcquiringRecords and callAt(s, id).waiting == 0
pure def enqueueKey(s: Reconciliations, id: int): Reconciliations = {
  val call = callAt(s, id)
  val key = call.recordKeys.nthOr(call.position, noKey)
  { ...s, queue: Q::admit(s.queue, { owner: call.adapter, provider: key.key }), calls: s.calls.listMap(entry => if (entry.id == id) { ...entry, waiting: s.queue.serial } else entry) }
}
pure def canAcquireKey(s: Reconciliations, id: int): bool = callAt(s, id).phase == AcquiringRecords and callAt(s, id).waiting > 0 and Q::canBegin(s.queue, callAt(s, id).waiting)
pure def acquireKey(s: Reconciliations, id: int): Reconciliations = {
  val call = callAt(s, id)
  { ...s, queue: Q::begin(s.queue, call.waiting), calls: s.calls.listMap(entry => if (entry.id == id) { ...entry, held: entry.held.append(entry.waiting), waiting: 0, position: entry.position + 1, phase: if (entry.position + 1 == entry.recordKeys.length()) ExecutingRecords else AcquiringRecords } else entry) }
}
pure def canWarn(s: Reconciliations, id: int): bool = callAt(s, id).held.length() > 0 and callAt(s, id).phase != Reconciled
pure def warn(s: Reconciliations, id: int): Reconciliations = { ...s, calls: s.calls.listMap(call => if (call.id == id) { ...call, warned: true } else call) }
pure def canCallbackReturns(s: Reconciliations, id: int): bool = callAt(s, id).phase == ExecutingRecords
pure def callbackReturns(s: Reconciliations, id: int, success: bool): Reconciliations = { ...s, calls: s.calls.listMap(call => if (call.id == id) { ...call, phase: if (call.held.length() == 0) Reconciled else ReleasingRecords, failed: not(success) } else call) }
pure def canReleaseKey(s: Reconciliations, id: int): bool = callAt(s, id).phase == ReleasingRecords and callAt(s, id).held.length() > 0
pure def releaseKey(s: Reconciliations, id: int): Reconciliations = {
  val call = callAt(s, id)
  val ticket = call.held.nthOr(call.held.length() - 1, 0)
  { ...s, queue: Q::cleanup(Q::finish(s.queue, ticket, not(call.failed)), ticket), calls: s.calls.listMap(entry => if (entry.id == id) { ...entry, held: entry.held.select(value => value != ticket), phase: if (entry.held.length() == 1) Reconciled else ReleasingRecords } else entry) }
}
pure def alwaysQueueMutualExclusion(s: Reconciliations): bool = Q::alwaysOneRunningPerScope(s.queue) and Q::alwaysStartedAfterPredecessors(s.queue) and Q::alwaysAllocatedTickets(s.queue) and Q::alwaysCompletedEntrySettled(s.queue)
pure def alwaysCallIdentitiesUnique(s: Reconciliations): bool = s.calls.every(call => call.id > 0 and s.calls.select(other => other.id == call.id).length() == 1)
pure def alwaysAcquisitionCursor(s: Reconciliations): bool = s.calls.every(call => call.position >= 0 and call.position <= call.recordKeys.length() and (call.phase == AcquiringRecords implies call.position < call.recordKeys.length()) and ((call.phase == AcquiringRecords or call.phase == ExecutingRecords) implies call.held.length() == call.position))
pure def alwaysCallbackOwnsEveryKey(s: Reconciliations): bool = s.calls.every(call => call.phase != ExecutingRecords or call.held.length() == call.recordKeys.length())
pure def alwaysWaitingTicketIsQueued(s: Reconciliations): bool = s.calls.every(call => call.waiting > 0 implies call.phase == AcquiringRecords and s.queue.entries.some(entry => entry.ticket == call.waiting and not(entry.running) and not(entry.complete)))
pure def alwaysHeldTicketsAreRunning(s: Reconciliations): bool = s.calls.every(call => call.held.every(ticket => s.queue.entries.some(entry => entry.ticket == ticket and entry.running)))
pure def alwaysOneCallOwnsEachTicket(s: Reconciliations): bool = s.calls.every(call => call.held.every(ticket => ticket > 0 and ticket != call.waiting and call.held.select(other => other == ticket).length() == 1) and s.calls.every(other => other.id == call.id or ((call.waiting == 0 or (other.waiting != call.waiting and not(other.held.includes(call.waiting)))) and call.held.every(ticket => other.waiting != ticket and not(other.held.includes(ticket))))))
pure def stepWarningRetainsAllLocks(before: Reconciliations, via: str, after: Reconciliations): bool = via == "warn" implies before.queue == after.queue
pure def sometimesIndependentAdapterWork(s: Reconciliations): bool = s.calls.some(call => call.phase == ExecutingRecords and s.calls.some(other => other.phase == ExecutingRecords and other.adapter != call.adapter))
pure val idValues = Set(1, 2, 3)
pure val adapterValues = Set("adapter1", "adapter2")
pure val recordKeysValues = Set(List({ key: "entity:a", rank: 1 }), List({ key: "entity:a", rank: 1 }, { key: "world:b", rank: 2 }), List({ key: "world:b", rank: 2 }))
```
