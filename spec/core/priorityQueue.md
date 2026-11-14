# Priority queue ordering and pressure

Queue priority controls dequeue order while maxSize is a pressure threshold. It is not a hard capacity unless the installed pressure callback rejects admission. Source [batch-queue.ts](https://github.com/elizaOS/eliza/blob/72fed7e4069ecd35d61d886ab6eec5c02c137517/packages/core/src/utils/batch-queue.ts).

## Story: Enqueue and drain ordered work

As a producer I preserve FIFO within each priority and receive explicit admission results under pressure.

### High priority precedes normal priority which precedes low priority

Every enqueue gets a unique ticket even when the same payload value is enqueued more than once. Invalid priority is normalized to normal and warns once.

```quint
type QueuePriority = High | Normal | Low | InvalidPriority
type QueueItem = { ticket: int, payload: str, priority: QueuePriority }
type ItemSplit = { taken: List[QueueItem], kept: List[QueueItem], position: int }
type PriorityState = { high: List[QueueItem], normal: List[QueueItem], low: List[QueueItem], nextTicket: int, maxSize: int, hasMax: bool, hasPressure: bool, configured: bool, pendingPayload: str, pendingPriority: QueuePriority, pressurePending: bool, lastAccepted: bool, lastRemoved: List[QueueItem], invalidPriorityWarned: bool, overflowWarnings: int }
pure val initial: PriorityState = { high: List(), normal: List(), low: List(), nextTicket: 1, maxSize: 0, hasMax: false, hasPressure: false, configured: false, pendingPayload: "", pendingPriority: Normal, pressurePending: false, lastAccepted: false, lastRemoved: List(), invalidPriorityWarned: false, overflowWarnings: 0 }
pure val payloadValues = Set("job-a", "job-b")
pure val maxSizeValues = Set(0, 1, 3)
pure val countValues = Set(-1, 0, 1, 3)
pure val ticketsValues = Set(Set(1), Set(2), Set(1, 2))
pure def queueSize(s: PriorityState): int = s.high.length() + s.normal.length() + s.low.length()
pure def queuedItems(s: PriorityState): List[QueueItem] = s.high.concat(s.normal).concat(s.low)
pure def canConfigureQueue(s: PriorityState, maxSize: int, hasMax: bool, hasPressure: bool): bool = not(s.configured) and maxSize >= 0
pure def configureQueue(s: PriorityState, maxSize: int, hasMax: bool, hasPressure: bool): PriorityState = { ...s, configured: true, maxSize: maxSize, hasMax: hasMax, hasPressure: hasPressure }
pure def insertPayload(payload: str, priority: QueuePriority, s: PriorityState): PriorityState = {
  val actual = if (priority == InvalidPriority) Normal else priority
  val job = {ticket: s.nextTicket, payload: payload, priority: actual}
  { ...s, nextTicket: s.nextTicket + 1, high: if (actual == High) s.high.append(job) else s.high, normal: if (actual == Normal) s.normal.append(job) else s.normal, low: if (actual == Low) s.low.append(job) else s.low, lastAccepted: true, invalidPriorityWarned: s.invalidPriorityWarned or priority == InvalidPriority }
}
pure def canEnqueue(s: PriorityState, payload: str, priority: QueuePriority): bool = s.configured and not(s.pressurePending)
pure def enqueue(s: PriorityState, payload: str, priority: QueuePriority): PriorityState =
  if (s.hasMax and queueSize(s) >= s.maxSize and s.hasPressure) { ...s, pressurePending: true, pendingPayload: payload, pendingPriority: priority, lastAccepted: false }
  else insertPayload(payload, priority, { ...s, overflowWarnings: s.overflowWarnings + (if (s.hasMax and queueSize(s) >= s.maxSize) 1 else 0) })
pure def canResolvePressure(s: PriorityState, accepted: bool): bool = s.pressurePending
pure def resolvePressure(s: PriorityState, accepted: bool): PriorityState = if (accepted) insertPayload(s.pendingPayload, s.pendingPriority, { ...s, pressurePending: false }) else { ...s, pressurePending: false, lastAccepted: false }
pure def alwaysPriorityBucketsAgree(s: PriorityState): bool = s.high.every(j => j.priority == High) and s.normal.every(j => j.priority == Normal) and s.low.every(j => j.priority == Low)
pure def alwaysQueueTicketsUnique(s: PriorityState): bool = queuedItems(s).every(j => j.ticket > 0 and j.ticket < s.nextTicket and queuedItems(s).select(other => other.ticket == j.ticket).length() == 1)
pure def sometimesSoftThresholdExceeded(s: PriorityState): bool = s.hasMax and not(s.hasPressure) and queueSize(s) > s.maxSize
pure def sometimesPressureRejected(s: PriorityState): bool = s.hasPressure and s.configured and not(s.pressurePending) and not(s.lastAccepted) and s.nextTicket > 1
```

### Dequeue returns a bounded prefix and selective drain preserves all other items

A nonpositive dequeue count removes nothing. Draining and clearing are explicit queue mutations, including inside the pressure callback.

```quint
pure def splitItem(limit: int, acc: ItemSplit, job: QueueItem): ItemSplit = if (acc.position < limit) {taken: acc.taken.append(job), kept: acc.kept, position: acc.position + 1} else {taken: acc.taken, kept: acc.kept.append(job), position: acc.position + 1}
pure val emptyItemSplit: ItemSplit = {taken: List(), kept: List(), position: 0}
pure def splitQueue(s: PriorityState, count: int): ItemSplit = queuedItems(s).foldl(emptyItemSplit, (acc, job) => splitItem(count, acc, job))
pure def canDequeue(s: PriorityState, count: int): bool = s.configured
pure def dequeue(s: PriorityState, count: int): PriorityState = {
  val parts = splitQueue(s, count)
  { ...s, high: parts.kept.select(j => j.priority == High), normal: parts.kept.select(j => j.priority == Normal), low: parts.kept.select(j => j.priority == Low), lastRemoved: parts.taken }
}
pure def canDrainTickets(s: PriorityState, tickets: Set[int]): bool = s.configured
pure def drainTickets(s: PriorityState, tickets: Set[int]): PriorityState = { ...s, high: s.high.select(j => not(tickets.contains(j.ticket))), normal: s.normal.select(j => not(tickets.contains(j.ticket))), low: s.low.select(j => not(tickets.contains(j.ticket))), lastRemoved: queuedItems(s).select(j => tickets.contains(j.ticket)) }
pure def canClearQueue(s: PriorityState): bool = s.configured
pure def clearQueue(s: PriorityState): PriorityState = { ...s, high: List(), normal: List(), low: List(), lastRemoved: queuedItems(s) }
pure def sometimesQueueDrained(s: PriorityState): bool = s.nextTicket > 1 and queueSize(s) == 0
```
