# Files view ownership

A request made from the shown Files view belongs to that view and to the
exact rows it showed. Replacing the rows, leaving the view or
cancelling makes a late grant come back released rather than opened.
Batches of operations, the view's busy state, its filter, what it claims
about an empty or complete listing, and how it opens a file each have an
owner too. [Direct admission](./admission.md) covers requests that
arrive before the view exists; [reviewed operations](./reviewedOperations.md)
covers mutation of each reviewed row.

## Story: Open only the rows I was shown

> As the owner, I want a file I picked from the list to open only if the
> list still shows what I picked from.

### A shown-row request opens only while its snapshot and view are current

A request captures the rows' snapshot and the view it was made from.
Access and then the grant must arrive while the view is active, the same
view, the same snapshot and not cancelled. A request that loses any of
these is refused, and a grant that arrives after it is released, never
retained. The receipt reports success only for a grant retained for
the current snapshot.

```quint
type ShownPhase = ShownIdle | ShownAwaitingAccess | ShownAwaitingGrant | ShownSettled
type ShownResult = NoShownResult | ShownOpened | ShownRefused
type ShownSelection = { phase: ShownPhase, generation: int, epoch: int, active: bool, cancelled: bool, snapshot: int,
  owner: int, granted: bool, retained: bool, released: bool, result: ShownResult, admitted: bool }
pure val initial: ShownSelection = { phase: ShownIdle, generation: 0, epoch: 0, active: true, cancelled: false, snapshot: 0,
  owner: 0, granted: false, retained: false, released: false, result: NoShownResult, admitted: false }
pure def shownCurrent(s: ShownSelection): bool =
  s.active and not(s.cancelled) and s.generation == s.snapshot and s.epoch == s.owner
pure def canBeginShown(s: ShownSelection): bool = s.phase == ShownIdle
pure def beginShown(s: ShownSelection): ShownSelection = { ...s, phase: ShownAwaitingAccess, snapshot: s.generation, owner: s.epoch }
pure def canReplaceRows(s: ShownSelection): bool = true
pure def replaceRows(s: ShownSelection): ShownSelection = { ...s, generation: s.generation + 1 }
pure def canLeaveView(s: ShownSelection): bool = s.active
pure def leaveView(s: ShownSelection): ShownSelection = { ...s, active: false, epoch: s.epoch + 1 }
pure def canEnterView(s: ShownSelection): bool = not(s.active)
pure def enterView(s: ShownSelection): ShownSelection = { ...s, active: true }
pure def canCancelShown(s: ShownSelection): bool =
  (s.phase == ShownAwaitingAccess or s.phase == ShownAwaitingGrant) and not(s.cancelled)
pure def cancelShown(s: ShownSelection): ShownSelection = { ...s, cancelled: true }
pure def canShownAccessReply(s: ShownSelection): bool = s.phase == ShownAwaitingAccess
pure def shownAccessReply(s: ShownSelection, allowed: bool): ShownSelection =
  if (allowed and shownCurrent(s)) { ...s, phase: ShownAwaitingGrant } else { ...s, phase: ShownSettled, result: ShownRefused }
pure def canShownGrantReply(s: ShownSelection): bool = s.phase == ShownAwaitingGrant
pure def shownGrantReply(s: ShownSelection, granted: bool): ShownSelection =
  { ...s, phase: ShownSettled, granted: granted, retained: granted and shownCurrent(s), released: granted and not(shownCurrent(s)),
    result: if (granted and shownCurrent(s)) ShownOpened else ShownRefused, admitted: shownCurrent(s) }
pure def alwaysTruthfulSnapshotReceipt(s: ShownSelection): bool =
  s.result == ShownOpened implies s.admitted and s.retained and s.granted
pure def alwaysOneGrantDisposition(s: ShownSelection): bool =
  not(s.retained and s.released) and (s.granted implies (s.retained or s.released))
pure def alwaysNoCancelledSuccess(s: ShownSelection): bool = s.cancelled implies s.result != ShownOpened
pure def sometimesShownOpened(s: ShownSelection): bool = s.result == ShownOpened
pure def sometimesLateGrantReleased(s: ShownSelection): bool = s.released and s.generation == s.snapshot
pure def sometimesReplacedRowsRefused(s: ShownSelection): bool = s.result == ShownRefused and s.generation > s.snapshot
pure val fair_beginShown = "weak"
pure val fair_shownAccessReply = "weak"
pure val fair_shownGrantReply = "weak"
pure def leadsToShownRequestSettles(s: ShownSelection, later: ShownSelection): bool = later.phase == ShownSettled
```

## Story: Keep every batch outcome, including the ones I cannot be sure of

> As the owner, I want a batch of file operations to stop when I leave,
> keep an undo for every chunk that was confirmed, and never pretend an
> unknown chunk succeeded.

### A retired batch dispatches nothing new, and an unknown chunk is never confirmed

A batch sends its chunks one at a time, each at most once. Once the
batch is retired, no new chunk is sent; the one already sent still
settles. A confirmed chunk keeps its undo. A chunk whose outcome is
unknown may have taken effect, so it is neither confirmed nor undone
automatically, and the batch stops there. A refused chunk stops the
batch and keeps the confirmations before it.

```quint
type ChunkOutcome = ChunkConfirmed | ChunkUnknown | ChunkRefused
type ChunkRecord = { confirmed: bool, undoKept: bool, unknown: bool, batchContinues: bool }
pure def mayDispatchChunk(retired: bool, chunkPending: bool, alreadySent: bool): bool =
  not(retired) and not(chunkPending) and not(alreadySent)
pure def settleChunk(verdict: ChunkOutcome, retired: bool, lastChunk: bool): ChunkRecord =
  if (verdict == ChunkConfirmed) { confirmed: true, undoKept: true, unknown: false, batchContinues: not(retired or lastChunk) }
  else if (verdict == ChunkUnknown) { confirmed: false, undoKept: false, unknown: true, batchContinues: false }
  else { confirmed: false, undoKept: false, unknown: false, batchContinues: false }
pure def lawRetiredBatchSendsNothing(chunkPending: bool, alreadySent: bool): bool =
  not(mayDispatchChunk(true, chunkPending, alreadySent))
pure def lawChunkSentOnce(retired: bool, chunkPending: bool): bool = not(mayDispatchChunk(retired, chunkPending, true))
pure def lawUnknownNeverConfirmed(retired: bool, lastChunk: bool): bool =
  val record = settleChunk(ChunkUnknown, retired, lastChunk)
  not(record.confirmed) and not(record.batchContinues)
pure def lawConfirmedKeepsUndo(retired: bool, lastChunk: bool): bool =
  val record = settleChunk(ChunkConfirmed, retired, lastChunk)
  record.confirmed and record.undoKept
```

## Story: Tell me only what the Files view actually knows

> As the owner, I want the Files view to keep my filter, show busy while
> my operations run, and never claim a folder is empty or complete when
> it could not know.

### The view claims empty or complete only from a full, known listing

A listing is complete only when its metadata is known, it is not
partial and it did not fail; it is empty only when it is complete and
has no rows. The filter stays as the owner left it, however long they
were away, until they clear it. The view is busy exactly while one of
its own operations is pending, and a share sends the whole authorized
selection.

```quint
pure def listingComplete(metadataKnown: bool, partial: bool, failed: bool): bool = metadataKnown and not(partial) and not(failed)
pure def listingEmpty(metadataKnown: bool, partial: bool, failed: bool, anyRows: bool): bool =
  listingComplete(metadataKnown, partial, failed) and not(anyRows)
pure def filterShown(filterSet: bool, cleared: bool): bool = filterSet and not(cleared)
pure def viewBusy(pendingOperations: int): bool = pendingOperations > 0
pure def sharedCount(authorizedSelection: int): int = authorizedSelection
pure def lawUnknownMetadataClaimsNothing(partial: bool, failed: bool, anyRows: bool): bool =
  not(listingComplete(false, partial, failed)) and not(listingEmpty(false, partial, failed, anyRows))
pure def lawAbsenceKeepsFilter(filterSet: bool): bool = filterShown(filterSet, false) == filterSet
pure def lawShareSendsWholeSelection(authorizedSelection: int): bool = sharedCount(authorizedSelection) == authorizedSelection
pure def lawBusyExactlyWhilePending(pendingOperations: int): bool = viewBusy(pendingOperations) iff pendingOperations > 0
pure def lawEmptyClaimNeedsCompleteListing(metadataKnown: bool, partial: bool, failed: bool, anyRows: bool): bool =
  listingEmpty(metadataKnown, partial, failed, anyRows) implies listingComplete(metadataKnown, partial, failed) and not(anyRows)
pure val authorizedSelectionValues = Set(0, 100, 101, 1200)
pure val pendingOperationsValues = Set(0, 1, 2)
```

## Story: Open a file the way it can be opened

> As the owner, I want a file the app cannot preview to open in another
> app when one is available, and a late answer to be put away.

### Opening routes to an external app only for an unpreviewable file, and a fallback needs a real capability for the same view

A file opens in another app only when it cannot be previewed here and an
external opener exists; otherwise it is previewed. When the reply
selects a fallback, it is accepted only if it carries a real capability
and the view that asked is still active; if the view left, the
capability is released. An external app's receipt opens nothing here,
and a malformed reply is never accepted.

```quint
type OpenRoute = PreviewHere | OpenExternally
type OpenReply = ExternalOpened | FallbackSelected | OpenRefused | OpenCancelled | MalformedFallback
pure def openRoute(previewable: bool, externalPort: bool): OpenRoute =
  if (not(previewable) and externalPort) OpenExternally else PreviewHere
pure def acceptsFallback(openReply: OpenReply, viewActive: bool): bool = viewActive and openReply == FallbackSelected
pure def releasesFallback(openReply: OpenReply, viewActive: bool): bool = not(viewActive) and openReply == FallbackSelected
pure def lawMalformedReplyNeverAccepted(viewActive: bool): bool = not(acceptsFallback(MalformedFallback, viewActive))
pure def lawOneFallbackDisposition(openReply: OpenReply, viewActive: bool): bool =
  openReply == FallbackSelected implies acceptsFallback(openReply, viewActive) != releasesFallback(openReply, viewActive)
pure def lawExternalReceiptSelectsNothing(viewActive: bool): bool =
  not(acceptsFallback(ExternalOpened, viewActive)) and not(releasesFallback(ExternalOpened, viewActive))
pure def lawPreviewableStaysHere(externalPort: bool): bool = openRoute(true, externalPort) == PreviewHere
```
