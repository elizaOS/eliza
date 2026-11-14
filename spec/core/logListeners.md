# Log retention and listener delivery

The source is `createInMemoryDestination`, `addLogListener` and
`removeLogListener` in `packages/core/src/logger.ts` at
`72fed7e4069ecd35d61d886ab6eec5c02c137517`. The sink receives entries after
the logger's redaction and level filters. Each write snapshots listener
order and rechecks membership before each callback. A callback's nested
write runs before the outer callback returns.

## Story: Retain recent diagnostics and notify current listeners

As an operator, I can resize retention without clearing shared history.
As a listener, I receive each snapshot entry at most once. Unsubscribing
takes effect before the next callback in an existing snapshot. New
subscriptions join later entries. A failed listener warns once until it is
removed and registered again, while delivery continues to its peers.

### Retention preserves the newest entries under a positive configured cap

The default is one hundred. Invalid nonintegral or nonfinite capacities
are rejected by the input decoder, and nonpositive integers are ignored.
The records supplied here contain the already-redacted text.

```quint
type LogRecord = { id: int, text: str }
type LogDelivery = { entry: LogRecord, remaining: List[str], active: str, delivered: Set[str] }
type LogSink = { logs: List[LogRecord], capacity: int, listeners: List[str], warned: Set[str], warnings: int, deliveries: List[LogDelivery], nextEntry: int }
pure val initial: LogSink = { logs: List(), capacity: 100, listeners: List(), warned: Set(), warnings: 0, deliveries: List(), nextEntry: 1 }
pure def retained(logs: List[LogRecord], capacity: int): List[LogRecord] = logs.foldl(List(), (kept, entry) => if (capacity <= 0) List() else if (kept.length() >= capacity) kept.removeAt(0).append(entry) else kept.append(entry))
pure def resize(s: LogSink, capacity: int): LogSink = if (capacity <= 0) s else { ...s, capacity: capacity, logs: retained(s.logs, capacity) }
pure def clearLogs(s: LogSink): LogSink = { ...s, logs: List() }
pure def writeLog(s: LogSink, text: str): LogSink = {
  val entry = { id: s.nextEntry, text: text }
  { ...s, logs: retained(s.logs.append(entry), s.capacity), nextEntry: s.nextEntry + 1, deliveries: s.deliveries.append({ entry: entry, remaining: s.listeners, active: "", delivered: Set() }) }
}
pure val logsValues: Set[List[LogRecord]] = Set(List(), List({ id: 1, text: "redacted" }, { id: 2, text: "safe" }))
pure val capacityValues = Set(-1, 0, 1, 2, 100)
pure def alwaysRetainedWithinCapacity(s: LogSink): bool = s.capacity > 0 and s.logs.length() <= s.capacity
pure def alwaysFreshEntryIdentities(s: LogSink): bool = s.nextEntry > 0 and s.logs.every(entry => entry.id > 0 and entry.id < s.nextEntry)
```

### Listener registration is idempotent and reregistration resets its warning

```quint
pure def canAddListener(s: LogSink, listener: str): bool = listener != ""
pure def addListener(s: LogSink, listener: str): LogSink = if (s.listeners.includes(listener)) s else { ...s, listeners: s.listeners.append(listener), warned: s.warned.exclude(Set(listener)) }
pure def removeListener(s: LogSink, listener: str): LogSink = { ...s, listeners: s.listeners.select(existing => existing != listener) }
pure def alwaysListenerIdentityUnique(s: LogSink): bool = s.listeners.every(listener => listener != "" and s.listeners.select(other => other == listener).length() == 1)
pure val listenerValues = Set("first", "second", "third")
```

### A delivery frame advances through its captured listener order

Nested writes push frames. The outer frame retains its active callback
until the child finishes. Removing a future listener skips that callback
while preserving the original snapshot order for the remaining peers.

```quint
pure val noDelivery: LogDelivery = { entry: { id: 0, text: "" }, remaining: List(), active: "", delivered: Set() }
pure def topDelivery(s: LogSink): LogDelivery = s.deliveries.nthOr(s.deliveries.length() - 1, noDelivery)
pure def withTop(frame: LogDelivery, s: LogSink): LogSink = { ...s, deliveries: s.deliveries.removeAt(s.deliveries.length() - 1).append(frame) }
pure def canStartCallback(s: LogSink): bool = s.deliveries.length() > 0 and topDelivery(s).active == "" and topDelivery(s).remaining.length() > 0
pure def startCallback(s: LogSink): LogSink = {
  val frame = topDelivery(s)
  val listener = frame.remaining.nthOr(0, "")
  withTop({ ...frame, remaining: frame.remaining.removeAt(0), active: if (s.listeners.includes(listener)) listener else "" }, s)
}
pure def canFinishCallback(s: LogSink, succeeded: bool): bool = s.deliveries.length() > 0 and topDelivery(s).active != ""
pure def finishCallback(s: LogSink, succeeded: bool): LogSink = {
  val frame = topDelivery(s)
  val warn = not(succeeded) and not(s.warned.contains(frame.active))
  val finished = withTop({ ...frame, active: "", delivered: frame.delivered.union(Set(frame.active)) }, s)
  { ...finished, warned: if (warn) s.warned.union(Set(frame.active)) else s.warned, warnings: s.warnings + (if (warn) 1 else 0) }
}
pure def canFinishDelivery(s: LogSink): bool = s.deliveries.length() > 0 and topDelivery(s).active == "" and topDelivery(s).remaining.length() == 0
pure def finishDelivery(s: LogSink): LogSink = { ...s, deliveries: s.deliveries.removeAt(s.deliveries.length() - 1) }
pure def alwaysDeliveredListenersLeaveTheirFrame(s: LogSink): bool = s.deliveries.every(frame => frame.remaining.every(listener => not(frame.delivered.contains(listener))) and not(frame.delivered.contains(frame.active)))
pure def alwaysWarningsNonnegative(s: LogSink): bool = s.warnings >= 0
pure def sometimesNestedWrite(s: LogSink): bool = s.deliveries.length() > 1
pure def sometimesListenerFailureWarned(s: LogSink): bool = s.warnings > 0
pure def sometimesSharedRetentionResized(s: LogSink): bool = s.capacity == 1 and s.logs.length() == 1
```

### Each active callback has already left its unique pending snapshot

Discovered by the proof: a fabricated frame could leave its active
listener in the pending list, allowing a second delivery after completion.
Snapshots inherit unique nonempty listener identities, and the empty
active marker is never a delivered listener.

```quint
pure def alwaysDeliverySnapshotIdentity(s: LogSink): bool = s.deliveries.every(frame => frame.remaining.every(listener => listener != "" and frame.remaining.select(other => other == listener).length() == 1) and (frame.active != "" implies not(frame.remaining.includes(frame.active))) and not(frame.delivered.contains("")))
```
