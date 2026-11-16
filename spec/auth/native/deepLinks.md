# Device deep links

A deep link, such as a sign-in return, reaches the app in three ways: the
URL of a cold launch, a warm event to the running app, and a query the
renderer makes once it is ready. The native host captures each link with a
receipt before the app framework dispatches it, joins all three channels by
that receipt, keeps the link until the renderer acknowledges it, and
replays it otherwise. A browser sign-in that returns through a link is then
admitted by [browser return](./browserReturn.md).

## Story: Open the link I followed exactly once, even across a cold start

> As a person following a sign-in or app link, I want the app to open it
> once it is ready, without opening it twice and without losing it if the
> app view was re-created.

### Every channel joins its link by the capture receipt, and a link waits until the renderer is ready

The initial Intent of a cold launch is forwarded without minting a second
receipt, and the app keeps warm events that arrived before its listener.
Delivering a receipt before the renderer is ready queues it; readiness
starts every queued receipt. Delivering a receipt joins its attempt in
flight or confirms a completed one. A re-created renderer drops its local
bookkeeping, and the durable native slot stays replayable.

```quint
type LinkOutcome = LinkApplied | LinkRejected | LinkFailed
type DeepLinks = { captured: int, pendingNative: int, warmQueue: Set[int], peekReplies: List[int], ready: bool, queued: Set[int],
  inFlight: Set[int], completed: Set[int], attemptLog: List[int], acknowledgements: Set[int], applied: Set[int], rejected: Set[int],
  cleared: Set[int], replaced: bool }
pure val initial: DeepLinks = { captured: 0, pendingNative: 0, warmQueue: Set(), peekReplies: List(), ready: false, queued: Set(), inFlight: Set(),
  completed: Set(), attemptLog: List(), acknowledgements: Set(), applied: Set(), rejected: Set(), cleared: Set(), replaced: false }
pure def attemptsOf(r: DeepLinks, id: int): int = r.attemptLog.select(a => a == id).length()
pure def capture(r: DeepLinks, emitWarm: bool): DeepLinks = {
  val id = r.captured + 1
  { ...r, captured: id, pendingNative: id, warmQueue: if (emitWarm) r.warmQueue.union(Set(id)) else r.warmQueue }
}
pure def canDispatchWarm(r: DeepLinks, id: int): bool = id > 0 and id <= r.captured
pure def dispatchWarm(r: DeepLinks, id: int): DeepLinks = { ...r, warmQueue: r.warmQueue.union(Set(id)) }
pure def canPeekPending(r: DeepLinks): bool = r.pendingNative != 0
pure def peekPending(r: DeepLinks): DeepLinks = { ...r, peekReplies: if (r.peekReplies.includes(r.pendingNative)) r.peekReplies else r.peekReplies.append(r.pendingNative) }
pure def canRendererReady(r: DeepLinks): bool = not(r.ready)
pure def rendererReady(r: DeepLinks): DeepLinks = { ...r, ready: true, queued: Set(), inFlight: r.inFlight.union(r.queued) }
pure def canDeliverWarm(r: DeepLinks, id: int): bool = r.warmQueue.contains(id)
pure def deliverWarm(r: DeepLinks, id: int): DeepLinks = joined(id, { ...r, warmQueue: r.warmQueue.exclude(Set(id)) })
pure def canDeliverPeek(r: DeepLinks): bool = r.peekReplies.length() > 0
pure def deliverPeek(r: DeepLinks): DeepLinks = joined(r.peekReplies.nthOr(0, 0), { ...r, peekReplies: r.peekReplies.select(id => id != r.peekReplies.nthOr(0, 0)) })
pure def joined(id: int, r: DeepLinks): DeepLinks = {
  val known = r.completed.contains(id) or r.inFlight.contains(id)
  val starts = r.ready and not(known)
  val queues = not(r.ready) and not(known or r.queued.contains(id))
  { ...r,
    queued: if (known or r.ready) r.queued else r.queued.union(Set(id)),
    inFlight: if (starts) r.inFlight.union(Set(id)) else r.inFlight,
    attemptLog: if (starts or queues) r.attemptLog.append(id) else r.attemptLog,
    acknowledgements: if (r.completed.contains(id)) r.acknowledgements.union(Set(id)) else r.acknowledgements }
}
pure def canReplaceRenderer(r: DeepLinks): bool = not(r.replaced)
pure def replaceRenderer(r: DeepLinks): DeepLinks = { ...r, peekReplies: List(), ready: false, queued: Set(), inFlight: Set(), completed: Set(), replaced: true }
pure val idValues = Set(1, 2, 3)
pure def alwaysLinksWaitForTheRenderer(r: DeepLinks): bool = (r.ready implies r.queued.size() == 0) and (not(r.ready) implies r.inFlight.size() == 0)
pure def sometimesLinkWaitsForTheRenderer(r: DeepLinks): bool = not(r.ready) and r.queued.size() > 0
```

### A captured link is always started, and one that waits for the renderer starts once the renderer is ready

The renderer queries the native slot and delivers the replies in the
order it asked, so a captured link reaches an attempt unless a newer
capture takes the slot first.

```quint
pure val fair_peekPending = "weak"
pure val fair_deliverPeek = "weak"
pure val fair_rendererReady = "weak"
pure def leadsToCapturedLinkStarts(r: DeepLinks, later: DeepLinks): bool =
  r.pendingNative > 0 implies (later.attemptLog.includes(r.pendingNative) or later.pendingNative != r.pendingNative)
pure def leadsToQueuedLinkStarts(r: DeepLinks, later: DeepLinks): bool = r.queued.size() > 0 implies later.queued.size() == 0
```

### The native receipt is cleared only after the renderer applied or rejected the link

An attempt that finishes applied or explicitly rejected completes; a
failed one keeps its retry. Only a completed attempt is acknowledged, and
the native host clears its pending link only on an acknowledgement for
that exact receipt.

```quint
pure def canApplyReceipt(r: DeepLinks, id: int, linkOutcome: LinkOutcome): bool = r.inFlight.contains(id)
pure def applyReceipt(r: DeepLinks, id: int, linkOutcome: LinkOutcome): DeepLinks = {
  val failed = linkOutcome == LinkFailed
  { ...r, inFlight: r.inFlight.exclude(Set(id)),
    completed: if (failed) r.completed else r.completed.union(Set(id)),
    acknowledgements: if (failed) r.acknowledgements else r.acknowledgements.union(Set(id)),
    applied: if (linkOutcome == LinkApplied) r.applied.union(Set(id)) else r.applied,
    rejected: if (linkOutcome == LinkRejected) r.rejected.union(Set(id)) else r.rejected }
}
pure def canAcknowledgeReceipt(r: DeepLinks, id: int): bool = r.acknowledgements.contains(id)
pure def acknowledgeReceipt(r: DeepLinks, id: int): DeepLinks =
  { ...r, acknowledgements: r.acknowledgements.exclude(Set(id)),
    pendingNative: if (r.pendingNative == id) 0 else r.pendingNative,
    cleared: if (r.pendingNative == id) r.cleared.union(Set(id)) else r.cleared }
pure def alwaysClearedOnlyAfterTerminal(r: DeepLinks): bool = r.cleared.subseteq(r.applied.union(r.rejected))
pure def sometimesLinkAcknowledged(r: DeepLinks): bool = r.cleared.size() > 0
pure def sometimesFailedAttemptRetried(r: DeepLinks): bool = r.applied.exists(id => attemptsOf(r, id) == 2)
```

## Story: Keep two links I followed apart, even when they are the same URL

> As a person who followed two links quickly, I want each opened once, and
> neither lost because the other was handled first.

### Each capture keeps its own receipt, and only its exact acknowledgement clears it

Two captures of the same URL get distinct receipts, which never wrap;
distinct receipts stay independent. The native host compares both URL and
receipt under one lock, so an acknowledgement clears the pending slot only
when it still holds that receipt. A renderer that sends no receipt cannot
consume the slot.

```quint
pure def alwaysReceiptsStayDistinct(r: DeepLinks): bool =
  r.queued.intersect(r.inFlight).size() == 0 and r.completed.intersect(r.inFlight).size() == 0 and
    r.completed.intersect(r.queued).size() == 0 and r.acknowledgements.subseteq(r.applied.union(r.rejected)) and
    r.pendingNative >= 0 and r.pendingNative <= r.captured
pure def sometimesSecondReceiptSurvivesFirst(r: DeepLinks): bool = r.cleared.contains(1) and r.pendingNative == 2
```
