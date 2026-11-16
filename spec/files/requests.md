# Files requests

A request to open a file belongs to the view and the exact rows it was
made from. A direct request, such as the agent asking to show a file, may
arrive before the Files view exists; it first waits for the view, and its
rows are those of the view it commits. Access and the owner's selection
are separate steps, and the view's own reload runs independently.
[Reviewed operations](./reviewedOperations.md) cover mutation of each
reviewed row.

## Story: Open the file I asked for, and only from what I was shown

> As the owner, I want a request to open Files to work even when Files was
> not open, a file I picked to open only if the list still shows what I
> picked from, and nothing to open after I cancelled or moved on.

### A request waits for the view, then access, then the owner's selection, while it stays current

A request captures the view and the rows it was made from, and waits for
the view first if Files is not active. Committing the view needs the
owner's confirmation and that nothing was cancelled or replaced
meanwhile; it starts a new view, whose rows the request now belongs to,
and starts its reload. Access and then the selection must each be granted
while the request is current: the view active, the same view and rows it
captured, and not cancelled. Otherwise the request is refused.

```quint
type RequestPhase = RequestIdle | AwaitingView | AwaitingAccess | AwaitingSelection | FileOpened | RequestRefused
type ViewLoad = Unread | Loading | Loaded | LoadFailed
type FileRequest = { phase: RequestPhase, active: bool, epoch: int, owner: int, generation: int, snapshot: int, cancelled: bool,
  load: ViewLoad, opened: bool, released: bool, grantDelivered: bool }
pure val initial: FileRequest = { phase: RequestIdle, active: false, epoch: 0, owner: 0, generation: 0, snapshot: 0, cancelled: false,
  load: Unread, opened: false, released: false, grantDelivered: false }
pure def requestPending(s: FileRequest): bool = s.phase == AwaitingView or s.phase == AwaitingAccess or s.phase == AwaitingSelection
pure def requestCurrent(s: FileRequest): bool = s.active and not(s.cancelled) and s.epoch == s.owner and s.generation == s.snapshot
pure def canBeginRequest(s: FileRequest): bool = s.phase == RequestIdle
pure def beginRequest(s: FileRequest): FileRequest =
  { ...s, phase: if (s.active) AwaitingAccess else AwaitingView, owner: s.epoch, snapshot: s.generation }
pure def canCommitView(s: FileRequest): bool = s.phase == AwaitingView
pure def commitView(s: FileRequest, confirmed: bool): FileRequest =
  if (confirmed and not(s.cancelled) and not(s.active) and s.epoch == s.owner)
    { ...s, phase: AwaitingAccess, active: true, epoch: s.epoch + 1, owner: s.epoch + 1, generation: s.generation + 1, snapshot: s.generation + 1, load: Loading }
  else { ...s, phase: RequestRefused }
pure def canAccessReply(s: FileRequest): bool = s.phase == AwaitingAccess
pure def accessReply(s: FileRequest, granted: bool): FileRequest =
  { ...s, phase: if (granted and requestCurrent(s)) AwaitingSelection else RequestRefused }
pure def canCancelRequest(s: FileRequest): bool = requestPending(s) and not(s.cancelled)
pure def cancelRequest(s: FileRequest): FileRequest = { ...s, cancelled: true }
pure def alwaysCancelledNeverOpened(s: FileRequest): bool = s.cancelled implies not(s.opened)
pure def sometimesRefusedAfterCancel(s: FileRequest): bool = s.phase == RequestRefused and s.cancelled
pure def sometimesReplacedRowsRefused(s: FileRequest): bool = s.phase == RequestRefused and s.generation > s.snapshot
pure val fair_commitView = "weak"
pure val fair_accessReply = "weak"
pure val fair_selectionReply = "weak"
pure def leadsToRequestSettles(s: FileRequest, later: FileRequest): bool =
  requestPending(s) implies (later.phase == FileOpened or later.phase == RequestRefused)
```

### The view's reload never retires the request

Entering Files starts a new view and its reload; leaving ends the view.
Replacing the shown rows retires a request made from them. A reload reply
only records whether the list loaded; it never changes the request's
stage, view or rows, so a file can open while the list is still loading.

```quint
pure def canEnterFiles(s: FileRequest): bool = not(s.active)
pure def enterFiles(s: FileRequest): FileRequest = { ...s, active: true, epoch: s.epoch + 1, generation: s.generation + 1, load: Loading }
pure def canLeaveFiles(s: FileRequest): bool = s.active
pure def leaveFiles(s: FileRequest): FileRequest = { ...s, active: false, epoch: s.epoch + 1 }
pure def canReplaceRows(s: FileRequest): bool = s.active
pure def replaceRows(s: FileRequest): FileRequest = { ...s, generation: s.generation + 1 }
pure def canLoadReply(s: FileRequest): bool = s.active and s.load == Loading
pure def loadReply(s: FileRequest, success: bool): FileRequest = { ...s, load: if (success) Loaded else LoadFailed }
pure def stepReloadDoesNotRetireRequest(before: FileRequest, via: str, after: FileRequest): bool =
  via == "loadReply" implies after.phase == before.phase and after.owner == before.owner and after.snapshot == before.snapshot and after.generation == before.generation
pure def sometimesOpenedWhileLoading(s: FileRequest): bool = s.opened and s.load == Loading
```

### A granted selection opens only for the current request; a late one is released

When the owner's selection is granted while the request is current, the
file opens, and only then does the request report success. A selection
granted after the owner left, the rows were replaced, or the request was
cancelled is released: it never opens, and every granted selection is
either opened or released, not both.

```quint
pure def canSelectionReply(s: FileRequest): bool = s.phase == AwaitingSelection
pure def selectionReply(s: FileRequest, granted: bool): FileRequest =
  { ...s, phase: if (granted and requestCurrent(s)) FileOpened else RequestRefused,
    opened: granted and requestCurrent(s), released: granted and not(requestCurrent(s)), grantDelivered: granted }
pure def alwaysOneGrantOutcome(s: FileRequest): bool =
  not(s.opened and s.released) and ((s.phase == FileOpened) iff s.opened) and (s.grantDelivered iff (s.opened or s.released))
pure def stepRetiredGrantIsReleased(before: FileRequest, via: str, after: FileRequest): bool =
  via == "selectionReply" and not(requestCurrent(before)) implies not(after.opened) and after.released == after.grantDelivered
pure def sometimesLateGrantReleased(s: FileRequest): bool = s.released
pure def sometimesFileOpened(s: FileRequest): bool = s.phase == FileOpened
```

### An unpreviewable file opens in another app, and a fallback capability that arrives after the view left is released

An opened file is previewed here unless it cannot be previewed and an
external opener exists; then it opens in another app. When that app's
reply selects a fallback, the fallback is accepted only while the view
that asked is still active; otherwise its capability is released, never
both. A malformed reply and an external app's receipt are never accepted
and release nothing.

```quint
type OpenRoute = PreviewHere | OpenExternally
type OpenReply = ExternalOpened | FallbackSelected | OpenRefused | OpenCancelled | MalformedFallback
pure def openRoute(previewable: bool, externalPort: bool): OpenRoute =
  if (not(previewable) and externalPort) OpenExternally else PreviewHere
pure def acceptsFallback(openReply: OpenReply, viewActive: bool): bool = viewActive and openReply == FallbackSelected
pure def releasesFallback(openReply: OpenReply, viewActive: bool): bool = not(viewActive) and openReply == FallbackSelected
pure def lawPreviewableStaysHere(externalPort: bool): bool = openRoute(true, externalPort) == PreviewHere
pure def lawOneFallbackDisposition(openReply: OpenReply, viewActive: bool): bool =
  openReply == FallbackSelected implies acceptsFallback(openReply, viewActive) != releasesFallback(openReply, viewActive)
pure def lawOnlyAFallbackIsAcceptedOrReleased(openReply: OpenReply, viewActive: bool): bool =
  openReply != FallbackSelected implies not(acceptsFallback(openReply, viewActive)) and not(releasesFallback(openReply, viewActive))
```

## Story: Claim an empty or complete folder only when the listing knows

> As the owner, I want Files never to tell me a folder is empty or
> complete when it could not know.

### An empty or complete claim needs a full, known listing

A listing is complete only when its metadata is known, it is not partial
and it did not fail; it is empty only when it is complete and has no rows.

```quint
pure def listingComplete(metadataKnown: bool, partial: bool, failed: bool): bool = metadataKnown and not(partial) and not(failed)
pure def listingEmpty(metadataKnown: bool, partial: bool, failed: bool, anyRows: bool): bool =
  listingComplete(metadataKnown, partial, failed) and not(anyRows)
pure def lawUnknownMetadataClaimsNothing(partial: bool, failed: bool, anyRows: bool): bool =
  not(listingComplete(false, partial, failed)) and not(listingEmpty(false, partial, failed, anyRows))
```
