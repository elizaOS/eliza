# Device deep links

A deep link, such as a sign-in return, reaches the app in three ways: the
URL of a cold launch, a warm event to the running app, and a query the
renderer makes once it is ready. The native host captures each link with a
receipt (`MainActivity` before Capacitor dispatches the Intent), keeps it
until the renderer acknowledges it, and replays it otherwise. An older
bridge (version 1) has URL delivery only; a receipt bridge (version 2) joins
all channels by the capture receipt. A browser sign-in that returns through
a link is then admitted by [browser return](./browserReturn.md).

## Story: Open the link I followed exactly once, even across a cold start

> As a person following a sign-in or app link, I want the app to open it
> once it is ready, without opening it twice and without losing it if the
> app view was re-created.

### Before the replay deadline a receipt bridge waits for the receipt, then a cold URL falls back

Before the renderer is ready, every attempt waits; readiness starts the
queued ones. The renderer asks which bridge it has. A receipt bridge joins
the cold URL, the query and the warm event by the capture receipt, and a
failed query cannot disprove a receipt still in flight; until the existing
15-second replay window ends, it starts no URL attempt and at most two
calls. When the window ends with the bridge still unknown, the cold URL is
applied the old way, so a launch is never left unopened. Closing the
document ends its delivery duty.

```quint
type LinkMode = PendingMode | LegacyMode | ReceiptMode
type AttemptKind = ColdAttempt | WarmAttempt | ReceiptAttempt
type LinkDiscovery = { bridgeKnown: bool, receiptBridge: bool, mode: LinkMode, ready: bool, closed: bool, launchDelivered: bool,
  peekDelivered: bool, appDelivered: bool, expired: bool, pendingLaunch: bool, urlOwner: int, receiptOwner: int, admitted: int,
  kinds: List[AttemptKind], queued: Set[int], inFlight: Set[int], completed: Set[int], calls: int, receiptApplied: bool,
  acknowledgement: bool, nativePending: bool }
type CaptureReceipts = { captured: int, pendingNative: int, warmQueue: Set[int], peekReplies: Set[int], ready: bool, queued: Set[int],
  inFlight: Set[int], completed: Set[int], attemptLog: List[int], acknowledgements: Set[int], applied: Set[int], rejected: Set[int],
  cleared: Set[int], replaced: bool }
type DeepLinks = { discovery: LinkDiscovery, receipts: CaptureReceipts }
pure val initial: DeepLinks = {
  discovery: { bridgeKnown: false, receiptBridge: false, mode: PendingMode, ready: false, closed: false, launchDelivered: false,
    peekDelivered: false, appDelivered: false, expired: false, pendingLaunch: false, urlOwner: 0, receiptOwner: 0, admitted: 0,
    kinds: List(), queued: Set(), inFlight: Set(), completed: Set(), calls: 0, receiptApplied: false, acknowledgement: false, nativePending: true },
  receipts: { captured: 0, pendingNative: 0, warmQueue: Set(), peekReplies: Set(), ready: false, queued: Set(), inFlight: Set(),
    completed: Set(), attemptLog: List(), acknowledgements: Set(), applied: Set(), rejected: Set(), cleared: Set(), replaced: false } }
pure def startAttempt(kind: AttemptKind, x: LinkDiscovery): LinkDiscovery = {
  val id = x.admitted + 1
  { ...x, admitted: id, kinds: x.kinds.append(kind),
    urlOwner: if (kind == ReceiptAttempt) x.urlOwner else id, receiptOwner: if (kind == ReceiptAttempt) id else x.receiptOwner,
    queued: if (x.ready) x.queued else x.queued.union(Set(id)), inFlight: if (x.ready) x.inFlight.union(Set(id)) else x.inFlight,
    calls: x.calls + (if (x.ready) 1 else 0) }
}
pure def captureUrl(x: LinkDiscovery): LinkDiscovery = if (x.urlOwner != 0) x else startAttempt(ColdAttempt, x)
pure def captureReceipt(x: LinkDiscovery): LinkDiscovery =
  if (x.receiptOwner == 0) startAttempt(ReceiptAttempt, x)
  else if (x.completed.contains(x.receiptOwner)) { ...x, acknowledgement: true }
  else x
pure def legacyMode(x: LinkDiscovery): LinkDiscovery = {
  val changed = { ...x, mode: LegacyMode, pendingLaunch: false }
  if (x.pendingLaunch) captureUrl(changed) else changed
}
pure def receiptMode(x: LinkDiscovery): LinkDiscovery = { ...x, mode: ReceiptMode, pendingLaunch: false }
pure def canChooseBridge(d: DeepLinks): bool = not(d.discovery.bridgeKnown)
pure def chooseBridge(d: DeepLinks, receiptBridge: bool): DeepLinks = { ...d, discovery: { ...d.discovery, bridgeKnown: true, receiptBridge: receiptBridge } }
pure def linksOpen(d: DeepLinks): bool = d.discovery.bridgeKnown and not(d.discovery.closed)
pure def canShellReady(d: DeepLinks): bool = linksOpen(d) and not(d.discovery.ready)
pure def shellReady(d: DeepLinks): DeepLinks = { ...d, discovery: { ...d.discovery, ready: true, queued: Set(),
  inFlight: d.discovery.inFlight.union(d.discovery.queued), calls: d.discovery.calls + d.discovery.queued.size() } }
pure def canLaunchUrl(d: DeepLinks): bool = linksOpen(d) and not(d.discovery.launchDelivered)
pure def launchUrl(d: DeepLinks): DeepLinks = {
  val x = d.discovery
  val changed = if (x.mode == PendingMode) { ...x, pendingLaunch: true } else if (x.mode == LegacyMode) captureUrl(x) else x
  { ...d, discovery: { ...changed, launchDelivered: true } }
}
pure def canQueryBridge(d: DeepLinks): bool = linksOpen(d) and not(d.discovery.peekDelivered)
pure def queryBridge(d: DeepLinks, answered: bool): DeepLinks = {
  val x = d.discovery
  val changed = if (not(answered)) x else if (x.receiptBridge) captureReceipt(receiptMode(x)) else captureUrl(legacyMode(x))
  { ...d, discovery: { ...changed, peekDelivered: true } }
}
pure def canWarmEvent(d: DeepLinks): bool = linksOpen(d) and not(d.discovery.appDelivered)
pure def warmEvent(d: DeepLinks): DeepLinks = {
  val x = d.discovery
  val changed = if (x.receiptBridge) captureReceipt(receiptMode(x)) else legacyMode(startAttempt(WarmAttempt, x))
  { ...d, discovery: { ...changed, appDelivered: true } }
}
pure def canReplayDeadline(d: DeepLinks): bool = linksOpen(d) and not(d.discovery.expired)
pure def replayDeadline(d: DeepLinks): DeepLinks = {
  val x = d.discovery
  { ...d, discovery: { ...(if (x.mode == PendingMode) legacyMode(x) else x), expired: true } }
}
pure def canCloseDocument(d: DeepLinks): bool = linksOpen(d)
pure def closeDocument(d: DeepLinks): DeepLinks = { ...d, discovery: { ...d.discovery, closed: true } }
pure def alwaysReceiptBeforeFallback(d: DeepLinks): bool =
  (d.discovery.receiptBridge and not(d.discovery.expired)) implies (d.discovery.urlOwner == 0 and d.discovery.calls <= 2)
pure def alwaysDeadlineReleasesCold(d: DeepLinks): bool =
  (d.discovery.launchDelivered and d.discovery.ready and d.discovery.expired) implies d.discovery.calls > 0
pure def alwaysAttemptsAccounted(d: DeepLinks): bool =
  d.discovery.calls >= 0 and d.discovery.calls <= d.discovery.admitted and d.discovery.kinds.length() == d.discovery.admitted and
    d.discovery.queued.intersect(d.discovery.inFlight).size() == 0
pure def sometimesReceiptJoinedLaunch(d: DeepLinks): bool = d.discovery.receiptBridge and d.discovery.receiptApplied and d.discovery.launchDelivered
pure def sometimesColdFallbackAtDeadline(d: DeepLinks): bool = not(d.discovery.receiptBridge) and d.discovery.expired and d.discovery.calls > 0
```

### The native receipt is cleared only after the renderer applied or rejected the link

An attempt that finishes applied or explicitly rejected completes; a
failed or unconfirmed one keeps its retry. Only a completed receipt
attempt is acknowledged, and the native host clears its pending link
only on an acknowledgement for that exact receipt.

```quint
pure def canFinishAttempt(d: DeepLinks, attempt: int, applied: bool): bool = linksOpen(d) and d.discovery.inFlight.contains(attempt)
pure def finishAttempt(d: DeepLinks, attempt: int, applied: bool): DeepLinks = {
  val x = d.discovery
  val isReceipt = x.kinds.nthOr(attempt - 1, ColdAttempt) == ReceiptAttempt
  { ...d, discovery: { ...x, inFlight: x.inFlight.exclude(Set(attempt)),
    completed: if (applied) x.completed.union(Set(attempt)) else x.completed.exclude(Set(attempt)),
    urlOwner: if (not(applied) and x.urlOwner == attempt) 0 else x.urlOwner,
    receiptOwner: if (not(applied) and x.receiptOwner == attempt) 0 else x.receiptOwner,
    receiptApplied: x.receiptApplied or (isReceipt and applied), acknowledgement: x.acknowledgement or (isReceipt and applied) } }
}
pure def canAcknowledgeLink(d: DeepLinks): bool = linksOpen(d) and d.discovery.acknowledgement
pure def acknowledgeLink(d: DeepLinks): DeepLinks = { ...d, discovery: { ...d.discovery, acknowledgement: false, nativePending: false } }
pure val attemptValues = Set(1, 2, 3)
pure def alwaysAcknowledgementRequiresApplication(d: DeepLinks): bool =
  (d.discovery.acknowledgement or not(d.discovery.nativePending)) implies d.discovery.receiptApplied
pure def sometimesLinkAcknowledged(d: DeepLinks): bool = not(d.discovery.nativePending)
```

### A cold launch link is always started unless the document closes first

Once the renderer becomes ready and the replay window ends, which both
happen unless the document closes, a delivered cold launch has started at
least one attempt, whichever bridge the device has.

```quint
pure val fair_shellReady = "weak"
pure val fair_replayDeadline = "weak"
pure def leadsToColdLaunchStarted(d: DeepLinks, later: DeepLinks): bool =
  d.discovery.launchDelivered implies (later.discovery.closed or later.discovery.calls > 0)
```

## Story: Keep two links I followed apart, even when they are the same URL

> As a person who followed two links quickly, I want each opened once, and
> neither lost because the other was handled first.

### Each capture keeps its own receipt, and only its exact acknowledgement clears it

Two captures of the same URL get distinct receipts, which never wrap. The
initial Intent of a cold launch is forwarded without minting a second
receipt, and the app keeps warm events that arrived before its listener.
Delivering a receipt joins its attempt in flight or confirms a completed
one; distinct receipts stay independent. The native host compares both
URL and receipt under one lock, so an acknowledgement clears the pending
slot only when it still holds that receipt. A renderer that sends no
receipt cannot consume the slot. A re-created renderer drops its local
bookkeeping, and the durable slot stays replayable.

```quint
pure def attemptsOf(r: CaptureReceipts, id: int): int = r.attemptLog.select(a => a == id).length()
pure def capture(d: DeepLinks, emitWarm: bool): DeepLinks = {
  val id = d.receipts.captured + 1
  { ...d, receipts: { ...d.receipts, captured: id, pendingNative: id,
    warmQueue: if (emitWarm) d.receipts.warmQueue.union(Set(id)) else d.receipts.warmQueue } }
}
pure def canDispatchWarm(d: DeepLinks, id: int): bool = id > 0 and id <= d.receipts.captured
pure def dispatchWarm(d: DeepLinks, id: int): DeepLinks = { ...d, receipts: { ...d.receipts, warmQueue: d.receipts.warmQueue.union(Set(id)) } }
pure def canPeekPending(d: DeepLinks): bool = d.receipts.pendingNative != 0
pure def peekPending(d: DeepLinks): DeepLinks = { ...d, receipts: { ...d.receipts, peekReplies: d.receipts.peekReplies.union(Set(d.receipts.pendingNative)) } }
pure def canRendererReady(d: DeepLinks): bool = not(d.receipts.ready)
pure def rendererReady(d: DeepLinks): DeepLinks = { ...d, receipts: { ...d.receipts, ready: true, queued: Set(),
  inFlight: d.receipts.inFlight.union(d.receipts.queued) } }
pure def canDeliverReceipt(d: DeepLinks, id: int, warm: bool): bool =
  if (warm) d.receipts.warmQueue.contains(id) else d.receipts.peekReplies.contains(id)
pure def deliverReceipt(d: DeepLinks, id: int, warm: bool): DeepLinks = {
  val r = d.receipts
  val starts = r.ready and not(r.completed.contains(id)) and not(r.inFlight.contains(id))
  val queues = not(r.ready) and not(r.completed.contains(id) or r.inFlight.contains(id) or r.queued.contains(id))
  { ...d, receipts: { ...r,
    warmQueue: if (warm) r.warmQueue.exclude(Set(id)) else r.warmQueue,
    peekReplies: if (warm) r.peekReplies else r.peekReplies.exclude(Set(id)),
    queued: if (r.completed.contains(id) or r.inFlight.contains(id) or r.ready) r.queued else r.queued.union(Set(id)),
    inFlight: if (starts) r.inFlight.union(Set(id)) else r.inFlight,
    attemptLog: if (starts or queues) r.attemptLog.append(id) else r.attemptLog,
    acknowledgements: if (r.completed.contains(id)) r.acknowledgements.union(Set(id)) else r.acknowledgements } }
}
pure def canApplyReceipt(d: DeepLinks, id: int, linkOutcome: LinkOutcome): bool = d.receipts.inFlight.contains(id)
pure def applyReceipt(d: DeepLinks, id: int, linkOutcome: LinkOutcome): DeepLinks = {
  val r = d.receipts
  val failed = linkOutcome == LinkFailed
  { ...d, receipts: { ...r, inFlight: r.inFlight.exclude(Set(id)),
    completed: if (failed) r.completed else r.completed.union(Set(id)),
    acknowledgements: if (failed) r.acknowledgements else r.acknowledgements.union(Set(id)),
    applied: if (linkOutcome == LinkApplied) r.applied.union(Set(id)) else r.applied,
    rejected: if (linkOutcome == LinkRejected) r.rejected.union(Set(id)) else r.rejected } }
}
pure def canAcknowledgeReceipt(d: DeepLinks, id: int): bool = d.receipts.acknowledgements.contains(id)
pure def acknowledgeReceipt(d: DeepLinks, id: int): DeepLinks = {
  val r = d.receipts
  { ...d, receipts: { ...r, acknowledgements: r.acknowledgements.exclude(Set(id)),
    pendingNative: if (r.pendingNative == id) 0 else r.pendingNative,
    cleared: if (r.pendingNative == id) r.cleared.union(Set(id)) else r.cleared } }
}
pure def canReplaceRenderer(d: DeepLinks): bool = not(d.receipts.replaced)
pure def replaceRenderer(d: DeepLinks): DeepLinks = { ...d, receipts: { ...d.receipts, peekReplies: Set(), ready: false, queued: Set(),
  inFlight: Set(), completed: Set(), replaced: true } }
type LinkOutcome = LinkApplied | LinkRejected | LinkFailed
pure val idValues = Set(1, 2, 3)
pure def alwaysClearedOnlyAfterTerminal(d: DeepLinks): bool = d.receipts.cleared.subseteq(d.receipts.applied.union(d.receipts.rejected))
pure def alwaysReceiptsStayDistinct(d: DeepLinks): bool = {
  val r = d.receipts
  r.queued.intersect(r.inFlight).size() == 0 and r.completed.intersect(r.inFlight).size() == 0 and
    r.completed.intersect(r.queued).size() == 0 and r.acknowledgements.subseteq(r.applied.union(r.rejected)) and
    r.pendingNative >= 0 and r.pendingNative <= r.captured
}
pure def sometimesSecondReceiptSurvivesFirst(d: DeepLinks): bool = d.receipts.cleared.contains(1) and d.receipts.pendingNative == 2
pure def sometimesFailedAttemptRetried(d: DeepLinks): bool = d.receipts.applied.exists(id => attemptsOf(d.receipts, id) == 2)
```
