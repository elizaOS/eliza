# AlphaPhone saved media request and native video result

AlphaPhone `8d44dfe52b0a6e2f3462b5da85dd3f8037518f43` owns the shared
request slot in `apps/app/src/runtime/media-copy-intent.ts` and publishes
results through `apps/app/src/prototype/camera-adapter.ts`. The
[Android video copy](../mobileVideoCopy.md), [still-photo copy](../mobilePhotoCopyRecovery.md)
and [photo replacement](../mobilePhotoReplace.md) own the native receipts at
Eliza `c518127a025ab173874af9c7d304f26b25213b0d`.

## Story: Check my pending save before another edit replaces it

### A save claims the empty slot and only a matching terminal result clears it

The slot is `alpha.photos.pending-copy.v1`. Decode a token of 1–200
ASCII word characters or hyphens and an optional 36-character revision
made of lowercase hex digits and hyphens. Reject a malformed archive
and preserve its recovery path. Android uses local storage and reads
back every write. The browser uses the domain document with a compare
against the exact decoded archive. Read-only access leaves a missing
document absent. A fresh browser admission uses a new UUID revision.
An imported legacy browser token can lack one. Android compares the
token alone. New Android native operations have fresh operation tokens,
and a deliberately reused token denotes the same request at this port.

Reserve before native or browser dispatch. If cancellation or source
retirement happens before dispatch, clear only the admission this call
holds. Once dispatched, reopening checks its receipt with `editResult`.
A matching saved result requires a nonempty media ID. Failed, unchanged,
not-started and stale are terminal. Incomplete, unknown, an identity
mismatch or an unconfirmed compare-and-exchange keeps the exact request.
The browser may forget its operation receipt only after acknowledgement.
This machine follows the durable slot. Pending provider work can outlive
it only when the acknowledged operation has returned a terminal receipt.

```quint
type CopyPlatform = BrowserCopySlot | AndroidCopySlot
type MediaIntent = { token: int, admissionRevision: int }
type CopySlot = { occupied: bool, request: MediaIntent }
type MediaReply = SavedCopyReply | FailedCopyReply | UnchangedCopyReply | NotStartedCopyReply | StaleCopyReply | IncompleteCopyReply | UnknownCopyReply
pure val noMediaIntent: MediaIntent = { token: 0, admissionRevision: 0 }
pure val initial: CopySlot = { occupied: false, request: noMediaIntent }
pure def acceptsCopyIdentity(platform: CopyPlatform, requested: MediaIntent): bool =
  requested.token > 0 and (if (platform == AndroidCopySlot) requested.admissionRevision == 0 else requested.admissionRevision > 0)
pure def sameMediaIntent(expected: MediaIntent, held: MediaIntent): bool =
  expected.token == held.token and expected.admissionRevision == held.admissionRevision
pure def terminalCopyReceipt(reply: MediaReply, hasMediaId: bool): bool =
  (reply == SavedCopyReply and hasMediaId) or reply == FailedCopyReply or reply == UnchangedCopyReply or
    reply == NotStartedCopyReply or reply == StaleCopyReply
pure def canAdmitCopyIntent(s: CopySlot, platform: CopyPlatform, requested: MediaIntent, committed: bool): bool =
  not(s.occupied) and acceptsCopyIdentity(platform,requested) and committed
pure def admitCopyIntent(s: CopySlot, platform: CopyPlatform, requested: MediaIntent, committed: bool): CopySlot =
  { occupied: true, request: requested }
pure def canLoadLegacyCopyIntent(s: CopySlot, requested: MediaIntent, readable: bool): bool =
  not(s.occupied) and readable and requested.token > 0 and requested.admissionRevision == 0
pure def loadLegacyCopyIntent(s: CopySlot, requested: MediaIntent, readable: bool): CopySlot =
  { occupied: true, request: requested }
type Acknowledgment = { held: MediaIntent, reply: MediaReply, exactReceiptToken: bool,
  hasMediaId: bool, canceledBeforeDispatch: bool, committed: bool }
pure def canAcknowledgeCopyIntent(s: CopySlot, ack: Acknowledgment): bool =
  s.occupied and sameMediaIntent(s.request,ack.held) and ack.committed and
    (ack.canceledBeforeDispatch or (ack.exactReceiptToken and terminalCopyReceipt(ack.reply,ack.hasMediaId)))
pure def acknowledgeCopyIntent(s: CopySlot, ack: Acknowledgment): CopySlot = initial
pure def alwaysOccupiedCopyHasIdentity(s: CopySlot): bool =
  (s.occupied iff s.request.token > 0) and s.request.admissionRevision >= 0
pure def stepASecondCopyCannotReplace(before: CopySlot, via: str, after: CopySlot): bool =
  before.occupied and after.occupied implies after.request == before.request
pure def stepOnlyAcknowledgmentEmptiesCopySlot(before: CopySlot, via: str, after: CopySlot): bool =
  before.occupied and not(after.occupied) implies via == "acknowledgeCopyIntent"
pure def lawUnknownCopyHoldsIntent(s: CopySlot, ack: Acknowledgment): bool =
  (ack.reply == IncompleteCopyReply or ack.reply == UnknownCopyReply) and not(ack.canceledBeforeDispatch) implies
    not(canAcknowledgeCopyIntent(s,ack))
pure def lawStaleBrowserCopyCannotAcknowledge(s: CopySlot, ack: Acknowledgment): bool =
  s.request.admissionRevision != ack.held.admissionRevision implies not(canAcknowledgeCopyIntent(s,ack))
pure def sometimesBrowserIntent(s: CopySlot): bool = s.occupied and s.request.admissionRevision > 0
pure def sometimesTokenOnlyIntent(s: CopySlot): bool = s.occupied and s.request.admissionRevision == 0
pure val firstCopy: MediaIntent = { token: 1, admissionRevision: 1 }
pure val requestedValues = Set(firstCopy, { ...firstCopy, admissionRevision: 2 }, { ...firstCopy, admissionRevision: 0 },
  { token: 2, admissionRevision: 1 }, { token: 2, admissionRevision: 0 }, noMediaIntent)
pure val settledCopy: Acknowledgment = { held: firstCopy, reply: SavedCopyReply, exactReceiptToken: true,
  hasMediaId: true, canceledBeforeDispatch: false, committed: true }
pure val ackValues = Set(settledCopy, { ...settledCopy, hasMediaId: false }, { ...settledCopy, committed: false },
  { ...settledCopy, exactReceiptToken: false }, { ...settledCopy, held: { ...firstCopy, admissionRevision: 2 } },
  { ...settledCopy, held: { ...firstCopy, admissionRevision: 0 } },
  { ...settledCopy, reply: IncompleteCopyReply }, { ...settledCopy, reply: UnknownCopyReply, canceledBeforeDispatch: true })
```

### A library notification rechecks the source while a copy is in flight

An ordinary catalog notification refreshes the library. For the
current native video copy, defer that refresh and coalesce checks
of its source and permission. The copy's own pending or published
row can trigger a notification. After each async check, require the
same pending copy and editor epoch. A valid current answer requires
video access, the exact source ID and revision, and an untrashed
item. A failed answer hard-invalidates the view and cancels its
editor. An answer for a retired copy cannot change the current
selection. After Save settles, wait for checks already running.
Once the terminal intent is acknowledged, wait for any check started
during that acknowledgement before publishing the result. Only the
exact active visible source and editor can navigate to the saved
copy. A late acknowledgement can settle its own durable request
while leaving the newer selection in place.

```quint
type CopySourceRead = { exactCopy: bool, epochCurrent: bool, accessReadable: bool,
  videosAllowed: bool, idMatches: bool, revisionMatches: bool, trashed: bool }
type CopySourceResult = IgnoreRetiredCopy | KeepVideoEditor | InvalidateVideoEditor
pure def videoCopySourceResult(readFacts: CopySourceRead): CopySourceResult =
  if (not(readFacts.exactCopy and readFacts.epochCurrent)) IgnoreRetiredCopy
  else if (readFacts.accessReadable and readFacts.videosAllowed and readFacts.idMatches and
    readFacts.revisionMatches and not(readFacts.trashed)) KeepVideoEditor
  else InvalidateVideoEditor
type CopyViewEvidence = { receiptExact: bool, acknowledged: bool, sourceCheckSettled: bool,
  epochCurrent: bool, selectedSourceExact: bool, ownerActive: bool, visible: bool, editorCurrent: bool }
pure def publishCopyResult(viewFacts: CopyViewEvidence): bool =
  viewFacts.receiptExact and viewFacts.acknowledged and viewFacts.sourceCheckSettled and viewFacts.epochCurrent and
    viewFacts.selectedSourceExact and viewFacts.ownerActive and viewFacts.visible and viewFacts.editorCurrent
pure def lawRetiredCopyNeverChangesView(viewFacts: CopyViewEvidence): bool =
  not(viewFacts.epochCurrent and viewFacts.selectedSourceExact) implies not(publishCopyResult(viewFacts))
pure def lawUnacknowledgedCopyNeverChangesView(viewFacts: CopyViewEvidence): bool =
  not(viewFacts.acknowledged and viewFacts.sourceCheckSettled) implies not(publishCopyResult(viewFacts))
pure def lawChangedVideoInvalidatesItsCurrentEditor(readFacts: CopySourceRead): bool =
  readFacts.exactCopy and readFacts.epochCurrent and not(readFacts.revisionMatches) implies
    videoCopySourceResult(readFacts) == InvalidateVideoEditor
pure val currentVideoRead: CopySourceRead = { exactCopy: true, epochCurrent: true, accessReadable: true,
  videosAllowed: true, idMatches: true, revisionMatches: true, trashed: false }
pure val readFactsValues = Set(currentVideoRead, { ...currentVideoRead, epochCurrent: false },
  { ...currentVideoRead, videosAllowed: false }, { ...currentVideoRead, revisionMatches: false },
  { ...currentVideoRead, trashed: true }, { ...currentVideoRead, accessReadable: false })
pure val currentCopyView: CopyViewEvidence = { receiptExact: true, acknowledged: true, sourceCheckSettled: true,
  epochCurrent: true, selectedSourceExact: true, ownerActive: true, visible: true, editorCurrent: true }
pure val viewFactsValues = Set(currentCopyView, { ...currentCopyView, epochCurrent: false },
  { ...currentCopyView, sourceCheckSettled: false }, { ...currentCopyView, acknowledged: false },
  { ...currentCopyView, selectedSourceExact: false }, { ...currentCopyView, visible: false })
```

Alpha's pinned `MediaCopyIntent.qnt` exercises second admission,
restart, and stale acknowledgement on both storage paths. The browser
fixtures cover two tabs, legacy adoption, retained unreadable
archives, native source revocation during receipt acknowledgement
and a late receipt after selection changes.
