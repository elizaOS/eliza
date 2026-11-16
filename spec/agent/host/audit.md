# Security audit

Security-relevant events are captured in an audit log that delivers each
record, one at a time and in record order, to every attached sink. Some
sinks are durable, and a deployment may require that every record reach a
durable sink; until one is attached, records wait in an outbox. A record is
acknowledged only when no required sink failed and, where durability is
required, a durable sink accepted it. A failed append may still have
committed its row, and a restart keeps every committed row while records
not yet delivered are lost, never acknowledged.
Stored settings keys are [core key management](../../core/settingsKeys.md).

## Story: Keep an audit trail that survives a crash

> As the owner, every security event my agent records reaches the audit
> sinks I require, in the order it happened, and a crash never loses what
> was already written or pretends that unwritten records were.

### The sink configuration is fixed before the first record

```quint
type EntryStage = InOutbox | Queued | Delivering | Acknowledged | Refused | Lost
type AppendResult = Appended | FailedBefore | FailedAfter
type AuditEntry = { id: int, stage: EntryStage, requiredFailed: bool, durableAccepted: bool }
type AuditRow = { sink: int, entry: int }
type Audit = { configured: bool, requiresDurable: bool, durable: Set[int], required: Set[int], attached: List[int], entries: List[AuditEntry], queue: List[int], inDelivery: int, sinkOrder: List[int], sinkIndex: int, requiredFailed: bool, durableAccepted: bool, rows: List[AuditRow], nextEntry: int, crashes: int }
pure val initial: Audit = { configured: false, requiresDurable: false, durable: Set(), required: Set(), attached: List(), entries: List(), queue: List(), inDelivery: 0, sinkOrder: List(), sinkIndex: 0, requiredFailed: false, durableAccepted: false, rows: List(), nextEntry: 1, crashes: 0 }
pure val sinks = Set(1, 2)
pure val durableValues = Set(Set(), Set(1), Set(1, 2))
pure val requiredValues = Set(Set(), Set(1), Set(2))
pure def canConfigure(a: Audit, requiresDurable: bool, durable: Set[int], required: Set[int]): bool =
  not(a.configured) and durable.subseteq(sinks) and required.subseteq(sinks)
pure def configure(a: Audit, requiresDurable: bool, durable: Set[int], required: Set[int]): Audit =
  { ...a, configured: true, requiresDurable: requiresDurable, durable: durable, required: required }
pure def stepConfigurationFixed(before: Audit, after: Audit): bool =
  before.configured implies after.configured and after.requiresDurable == before.requiresDurable and
    after.durable.subseteq(before.durable) and before.durable.subseteq(after.durable) and
    after.required.subseteq(before.required) and before.required.subseteq(after.required)
```

### When durability is required, a record waits in the outbox until a durable sink is attached

```quint
pure def durableAttached(a: Audit): bool = a.attached.some(k => a.durable.contains(k))
pure def withStage(a: Audit, id: int, stage: EntryStage): List[AuditEntry] = a.entries.listMap(e => if (e.id == id) { ...e, stage: stage } else e)
pure def canRecordEntry(a: Audit): bool = a.configured
pure def recordEntry(a: Audit): Audit = {
  val held = a.requiresDurable and not(durableAttached(a))
  { ...a, entries: a.entries.append({ id: a.nextEntry, stage: if (held) InOutbox else Queued, requiredFailed: false, durableAccepted: false }),
    queue: if (held) a.queue else a.queue.append(a.nextEntry), nextEntry: a.nextEntry + 1 }
}
pure val sinkValues = Set(1, 2)
pure def canAttachSink(a: Audit, sink: int): bool = a.configured and sinks.contains(sink) and not(a.attached.includes(sink))
pure def attachSink(a: Audit, sink: int): Audit = {
  val released = if (a.durable.contains(sink)) a.entries.select(e => e.stage == InOutbox).listMap(e => e.id) else List()
  { ...a, attached: a.attached.append(sink), queue: a.queue.concat(released),
    entries: a.entries.listMap(e => if (released.includes(e.id)) { ...e, stage: Queued } else e) }
}
pure def alwaysOutboxOnlyWithoutDurableSink(a: Audit): bool =
  a.entries.every(e => e.stage == InOutbox implies a.requiresDurable and not(durableAttached(a)))
pure def sometimesHeldThenDelivered(a: Audit): bool = a.requiresDurable and a.entries.some(e => e.stage == Acknowledged) and a.attached.length() == 2
```

### Records are delivered one at a time, in record order, to every sink attached when delivery began

```quint
pure def canBeginDelivery(a: Audit): bool = a.inDelivery == 0 and a.queue.length() > 0
pure def beginDelivery(a: Audit): Audit = {
  val id = a.queue.nthOr(0, 0)
  { ...a, inDelivery: id, queue: a.queue.select(q => q != id), entries: withStage(a, id, Delivering), sinkOrder: a.attached, sinkIndex: 0, requiredFailed: false, durableAccepted: false }
}
pure val resultValues = Set(Appended, FailedBefore, FailedAfter)
pure def canAppendToSink(a: Audit, result: AppendResult): bool = a.inDelivery != 0 and a.sinkIndex < a.sinkOrder.length()
pure def appendToSink(a: Audit, result: AppendResult): Audit = {
  val sink = a.sinkOrder.nthOr(a.sinkIndex, 0)
  val committed = a.durable.contains(sink) and result != FailedBefore
  { ...a, rows: if (committed) a.rows.append({ sink: sink, entry: a.inDelivery }) else a.rows,
    requiredFailed: a.requiredFailed or (result != Appended and a.required.contains(sink)),
    durableAccepted: a.durableAccepted or (result == Appended and a.durable.contains(sink)),
    sinkIndex: a.sinkIndex + 1 }
}
type RowOrder = { prior: int, ordered: bool }
pure def rowsInRecordOrder(rows: List[AuditRow], sink: int): bool =
  rows.foldl({ prior: 0, ordered: true }, (acc, r) => if (r.sink == sink) { prior: r.entry, ordered: acc.ordered and r.entry > acc.prior } else acc).ordered
pure def alwaysOneDeliveryAtATime(a: Audit): bool =
  a.entries.select(e => e.stage == Delivering).length() == (if (a.inDelivery == 0) 0 else 1) and
  a.entries.every(e => e.stage == Delivering implies e.id == a.inDelivery)
pure def alwaysSinkRowsFollowRecordOrder(a: Audit): bool =
  rowsInRecordOrder(a.rows, 1) and rowsInRecordOrder(a.rows, 2) and a.rows.every(r => r.entry > 0 and r.entry < a.nextEntry)
```

### A record is acknowledged only when no required sink failed and, where required, a durable sink accepted it

A failed append can still have committed its row; the record is then
refused although its row exists.

```quint
pure def canFinishDelivery(a: Audit): bool = a.inDelivery != 0 and a.sinkIndex == a.sinkOrder.length()
pure def finishDelivery(a: Audit): Audit = {
  val accepted = not(a.requiredFailed) and (not(a.requiresDurable) or a.durableAccepted)
  { ...a, entries: a.entries.listMap(e => if (e.id == a.inDelivery) { ...e, stage: if (accepted) Acknowledged else Refused, requiredFailed: a.requiredFailed, durableAccepted: a.durableAccepted } else e),
    inDelivery: 0, sinkOrder: List(), sinkIndex: 0, requiredFailed: false, durableAccepted: false }
}
pure def alwaysAcknowledgedMetRequirements(a: Audit): bool =
  a.entries.every(e => e.stage == Acknowledged implies not(e.requiredFailed) and (not(a.requiresDurable) or e.durableAccepted))
pure def sometimesRefusedWithCommittedRow(a: Audit): bool = a.entries.some(e => e.stage == Refused and a.rows.some(r => r.entry == e.id))
```

### A crash keeps committed rows and loses only records not yet delivered

```quint
pure def canCrash(a: Audit): bool = a.configured
pure def crash(a: Audit): Audit =
  { ...a, entries: a.entries.listMap(e => if (e.stage == InOutbox or e.stage == Queued or e.stage == Delivering) { ...e, stage: Lost } else e),
    attached: List(), queue: List(), inDelivery: 0, sinkOrder: List(), sinkIndex: 0, requiredFailed: false, durableAccepted: false, crashes: a.crashes + 1 }
pure def stepCrashKeepsCommittedRows(before: Audit, via: str, after: Audit): bool = via == "crash" implies after.rows == before.rows
pure def stepSettledRecordsStaySettled(before: Audit, after: Audit): bool =
  before.entries.every(e => (e.stage == Acknowledged or e.stage == Refused) implies after.entries.includes(e))
pure def sometimesRowsSurviveCrash(a: Audit): bool = a.crashes > 0 and a.rows.length() > 0 and a.entries.some(e => e.stage == Lost)
```
