# Document scan review, drafts and export

Alpha imports `createScanDocument`, image admission and scan limits from
Eliza's `plugins/plugin-native-camera/src/scan-document.ts` in
`apps/app/src/prototype/scan-document.ts`. Its Camera adapter also imports
`createScanCapture` from that file. Alpha's `apps/app/src/browser/scan-draft.ts`
binds `plugins/plugin-files/src/documents/scan-draft.ts` to the device
database `alpha.browser.scan-draft.v1`. The editor runs on the native and
browser surfaces. Native Alpha enables autosave and native save pickers.

## Story: Assemble a document and retain a reviewable draft

### Page batches meet every image, count and size limit

The accepted formats are JPEG, PNG and WebP. Each page is nonempty and
at most 16 MiB, with a positive decoded width and height and a maximum
of 32 million pixels when decoded. A document holds at most 20 pages
and 64 MiB total. The stored draft requires at least one page. Editing
replaces or inserts whole pages, checks the requested slot and assigns a
new page identity on replacement. Moving pages preserves page identities
and moves their text layers with them. A whole batch of text layers must
have one entry per page. The model abstracts the validated ordered page
and text-layer snapshot as an increasing revision with count and size.

```quint
type ScanFormat = ScanJpeg | ScanPng | ScanWebp | ScanUnsupported
type ScanPageFacts = { format: ScanFormat, bytes: int, width: int, height: int }
type ScanBatch = { count: int, bytes: int, pagesValidated: bool }
pure val noPages: ScanBatch = { count: 0, bytes: 0, pagesValidated: true }
pure def allowsScanPage(page: ScanPageFacts): bool =
  page.format != ScanUnsupported and page.bytes > 0 and page.bytes <= 16777216 and
  page.width > 0 and page.height > 0 and page.width * page.height <= 32000000
pure def allowsScanBatch(batch: ScanBatch): bool =
  batch.pagesValidated and batch.count >= 0 and batch.count <= 20 and
  ((batch.count == 0 and batch.bytes == 0) or (batch.count > 0 and batch.bytes > 0 and batch.bytes <= 67108864))
pure def lawOversizedPageRefused(page: ScanPageFacts): bool =
  (page.bytes > 16777216 or page.width * page.height > 32000000) implies not(allowsScanPage(page))
pure def lawOversizedDocumentRefused(batch: ScanBatch): bool =
  (batch.count > 20 or batch.bytes > 67108864) implies not(allowsScanBatch(batch))
pure val pageValues = Set(
  { format: ScanJpeg, bytes: 1024, width: 1024, height: 768 },
  { format: ScanWebp, bytes: 16777216, width: 8000, height: 4000 },
  { format: ScanPng, bytes: 16777217, width: 8000, height: 4001 },
  { format: ScanUnsupported, bytes: 1024, width: 0, height: 0 }
)
```

### The document serializes edits, export and explicit draft operations

The renderer uses the controls and `run` to admit one in-flight page
operation, draft action or export. The current review owns one abort
signal. Closing drops its pages, revokes their URLs, aborts ordinary work
and suppresses stale UI publication. A hidden native picker can retain
the review while control is at the system picker. Explicit draft actions
wait for queued autosaves. A draft load validates the bytes and requires
confirmation if it would replace visible pages. It reopens an exported
document for editing only after that admission succeeds. Saving or
loading adopts the durable draft as explicit ownership.

```quint
type ScanFlight = ScanFree | EditingPages | ExportingPages | DraftAction
type ScanExport = ExportUnobserved | ExportRetryable | ExportReviewed | ExportConfirmed | ExportUnknown
type DraftOwnership = NoDraft | AutomaticDraft | ExplicitDraft
type ScanSource = SourceCaptured | SourceSelected | SourceUnsaved
type ScanKeep = KeepIdle | KeepRunning | KeepSaved | KeepFailed | KeepUnknown
type ScanKeepReview = { source: ScanSource, status: ScanKeep, closed: bool, hasPort: bool, native: bool, operation: int }
type ScanDocument = { closed: bool, pages: ScanBatch, pageRevision: int, flight: ScanFlight, exportResult: ScanExport,
  exportRevision: int, autoQueued: bool, lastPageRemoved: bool, draftKind: DraftOwnership, draftRevision: int, cleanupRevision: int, keep: ScanKeepReview }
pure val initial: ScanDocument = { closed: false, pages: noPages, pageRevision: 0, flight: ScanFree, exportResult: ExportUnobserved,
  exportRevision: 0, autoQueued: false, lastPageRemoved: false, draftKind: NoDraft, draftRevision: 0, cleanupRevision: 0,
  keep: { source: SourceSelected, status: KeepIdle, closed: true, hasPort: false, native: false, operation: 0 } }
pure def editable(s: ScanDocument): bool = not(s.closed) and s.exportResult != ExportConfirmed and s.exportResult != ExportUnknown
pure def canBeginEdit(s: ScanDocument): bool = editable(s) and s.flight == ScanFree
pure def beginEdit(s: ScanDocument): ScanDocument = { ...s, flight: EditingPages }
pure def canFinishEdit(s: ScanDocument, batch: ScanBatch): bool = editable(s) and s.flight == EditingPages and allowsScanBatch(batch)
pure def finishEdit(s: ScanDocument, batch: ScanBatch, autosave: bool): ScanDocument =
  { ...s, pages: batch, pageRevision: s.pageRevision + 1, flight: ScanFree,
    autoQueued: autosave or s.autoQueued, lastPageRemoved: autosave and batch.count == 0 }
pure def canCancelEdit(s: ScanDocument): bool = editable(s) and s.flight == EditingPages
pure def cancelEdit(s: ScanDocument): ScanDocument = { ...s, flight: ScanFree }
pure def canBeginDraftAction(s: ScanDocument): bool = not(s.closed or s.autoQueued) and s.flight == ScanFree
pure def beginDraftAction(s: ScanDocument): ScanDocument = { ...s, flight: DraftAction }
pure def canAdoptStoredPages(s: ScanDocument, batch: ScanBatch, revision: int, approved: bool): bool =
  not(s.closed) and s.flight == DraftAction and allowsScanBatch(batch) and batch.count > 0 and revision > 0 and (s.pages.count == 0 or approved)
pure def adoptStoredPages(s: ScanDocument, batch: ScanBatch, revision: int, approved: bool): ScanDocument =
  { ...s, pages: batch, pageRevision: s.pageRevision + 1, exportResult: ExportUnobserved, flight: ScanFree, draftKind: ExplicitDraft, draftRevision: revision }
pure def canSaveExplicitDraft(s: ScanDocument, stored: int, revision: int, committed: bool): bool =
  not(s.closed) and s.flight == DraftAction and s.pages.count > 0 and committed and revision > 0 and matchesDraftRevision(s.draftRevision, stored)
pure def saveExplicitDraft(s: ScanDocument, stored: int, revision: int, committed: bool): ScanDocument =
  { ...s, flight: ScanFree, draftKind: ExplicitDraft, draftRevision: revision }
pure def canDeleteDraft(s: ScanDocument, stored: int, approved: bool, committed: bool): bool =
  not(s.closed) and s.flight == DraftAction and approved and committed and stored > 0 and matchesDraftRevision(s.draftRevision, stored)
pure def deleteDraft(s: ScanDocument, stored: int, approved: bool, committed: bool): ScanDocument =
  { ...s, flight: ScanFree, draftKind: NoDraft, draftRevision: 0 }
pure def canEndDraftAction(s: ScanDocument): bool = not(s.closed) and s.flight == DraftAction
pure def endDraftAction(s: ScanDocument): ScanDocument = { ...s, flight: ScanFree }
pure def canCloseScan(s: ScanDocument): bool = not(s.closed)
pure def closeScan(s: ScanDocument): ScanDocument = { ...s, closed: true, pages: noPages, flight: ScanFree }
pure val batchValues = Set(noPages, { count: 1, bytes: 1024, pagesValidated: true }, { count: 20, bytes: 67108864, pagesValidated: true },
  { count: 21, bytes: 67108864, pagesValidated: true }, { count: 2, bytes: 67108865, pagesValidated: true },
  { count: 1, bytes: 1024, pagesValidated: false })
pure val revisionValues = Set(0, 1, 2, 3, 4)
pure def alwaysPagesWithinLimits(s: ScanDocument): bool = allowsScanBatch(s.pages)
pure def alwaysDraftOwnershipHasRevision(s: ScanDocument): bool = (s.draftKind == NoDraft) == (s.draftRevision == 0)
pure def alwaysClosedScanHasNoReview(s: ScanDocument): bool = s.closed implies s.pages.count == 0 and s.flight == ScanFree
pure def sometimesExplicitDraft(s: ScanDocument): bool = s.draftKind == ExplicitDraft
```

### An automatic cleanup removes only this review's captured draft revision

Each queued native save captures ordered images and layers. The queue
serializes writes. The store compares the expected revision inside its
write transaction, where an absent expectation matches an absent row.
Conflict leaves the stored draft in place. A write receipt supplies the
new revision and preserves explicit ownership. Removing the last page
and confirming export can clear an automatically saved draft using its
revision, after earlier autosaves settle. The cleanup receives its own
ten-second signal and can finish after review close. It can never delete
a replacement draft. A user closing an edited native review can keep
its automatic draft or explicitly discard it. Page hide retains the
draft. The model represents a drained batch of queued snapshots and
uses the transaction's matching revision and commit as port evidence.

```quint
pure def matchesDraftRevision(expected: int, stored: int): bool = expected >= 0 and expected == stored
pure def queueAutoCleanup(required: bool, s: ScanDocument): ScanDocument =
  if (required and s.draftKind == AutomaticDraft and not(s.autoQueued) and s.cleanupRevision == 0 and
    (s.lastPageRemoved or s.exportResult == ExportConfirmed)) { ...s, cleanupRevision: s.draftRevision }
  else s
pure def canSettleAutoSave(s: ScanDocument): bool = s.autoQueued and s.flight != DraftAction
pure def settleAutoSave(s: ScanDocument, stored: int, revision: int, committed: bool): ScanDocument = {
  val updated = if (not(s.closed) and s.pages.count > 0 and committed and revision > 0 and matchesDraftRevision(s.draftRevision, stored))
    { ...s, autoQueued: false, draftRevision: revision,
      draftKind: if (s.draftKind == ExplicitDraft) ExplicitDraft else AutomaticDraft }
  else { ...s, autoQueued: false }
  queueAutoCleanup(true, updated)
}
pure def canSettleAutoCleanup(s: ScanDocument): bool = s.cleanupRevision > 0
pure def settleAutoCleanup(s: ScanDocument, stored: int, committed: bool): ScanDocument =
  if (committed and s.draftKind == AutomaticDraft and matchesDraftRevision(s.cleanupRevision, stored) and s.cleanupRevision == s.draftRevision)
    { ...s, draftKind: NoDraft, draftRevision: 0, cleanupRevision: 0 }
  else { ...s, cleanupRevision: 0 }
pure val weight_beginEdit = 4
pure val weight_finishEdit = 8
pure val weight_settleAutoSave = 8
pure val weight_settleAutoCleanup = 8
pure val storedValues = Set(0, 1, 2, 3, 4)
pure def lawDraftCASRejectsDifferentRevision(expected: int, stored: int): bool = expected != stored implies not(matchesDraftRevision(expected, stored))
pure def stepCleanupPreservesExplicitDraft(before: ScanDocument, via: str, after: ScanDocument): bool =
  (via == "settleAutoCleanup" and before.draftKind == ExplicitDraft) implies after.draftKind == ExplicitDraft and before.draftRevision == after.draftRevision
pure def sometimesAutomaticDraftCleanupPending(s: ScanDocument): bool = s.cleanupRevision > 0
```

## Story: Save only the reviewed scan and see whether the save completed

### A PDF export holds a page snapshot until its result is known

The export receives the ordered image and text-layer snapshot. A
definite cancellation, unavailable destination, size rejection or
definite failure leaves that document editable. Searchable review that
only completed a review can also return to editing. Confirmed export
ends editing and permits automatic draft cleanup. An unknown outcome
ends editing without automatically clearing the draft because the file
may already exist. The user can explicitly resume their saved draft.

```quint
pure def canBeginExport(s: ScanDocument): bool = editable(s) and s.flight == ScanFree and s.pages.count > 0
pure def beginExport(s: ScanDocument): ScanDocument = { ...s, flight: ExportingPages, exportRevision: s.pageRevision }
pure def canFinishExport(s: ScanDocument, result: ScanExport): bool = not(s.closed) and s.flight == ExportingPages and result != ExportUnobserved
pure def finishExport(s: ScanDocument, result: ScanExport): ScanDocument =
  queueAutoCleanup(result == ExportConfirmed, { ...s, flight: ScanFree, exportResult: result })
pure val resultValues = Set(ExportRetryable, ExportReviewed, ExportConfirmed, ExportUnknown)
pure def alwaysExportOwnsCurrentSnapshot(s: ScanDocument): bool =
  s.flight == ExportingPages implies s.exportRevision == s.pageRevision and s.pages.count > 0
pure def sometimesExportConfirmed(s: ScanDocument): bool = s.exportResult == ExportConfirmed
pure def sometimesExportUnconfirmed(s: ScanDocument): bool = s.exportResult == ExportUnknown
```

### A captured page reaches Photos only by explicit Keep

An unsaved scan remains in memory until the owner chooses Keep. An
already captured or selected page has no Keep action. Keep admits one
flight and a native retry after uncertainty retains the same operation
identity. After a definite failure it uses a fresh identity because the
store kept nothing for the old one. Alpha's browser port offers no retry
after an unknown result because that store lacks an operation identity.
Closing aborts the flight and removes the authority to request another
Keep. A late result can still describe what happened in the store; it
cannot reopen the review. These guards apply separately to each reviewed
image. A selected image need not be copied to Photos.

```quint
pure def allowsKeep(review: ScanKeepReview): bool =
  review.source == SourceUnsaved and review.hasPort and not(review.closed) and review.operation > 0 and
  (review.status == KeepIdle or review.status == KeepFailed or (review.status == KeepUnknown and review.native))
pure def keepIdentityAfter(review: ScanKeepReview, keepResult: ScanKeep, fresh: int): int =
  if (keepResult == KeepFailed) fresh else review.operation
pure def canOpenKeepReview(s: ScanDocument): bool = s.keep.closed and s.keep.status != KeepRunning
pure def openKeepReview(s: ScanDocument, source: ScanSource, hasPort: bool, native: bool): ScanDocument =
  { ...s, keep: { source: source, status: KeepIdle, closed: false, hasPort: hasPort, native: native, operation: s.keep.operation + 1 } }
pure def canRequestKeep(s: ScanDocument): bool = allowsKeep(s.keep)
pure def requestKeep(s: ScanDocument): ScanDocument = { ...s, keep: { ...s.keep, status: KeepRunning } }
pure def canResolveKeep(s: ScanDocument, keepResult: ScanKeep): bool =
  s.keep.status == KeepRunning and (keepResult == KeepSaved or keepResult == KeepFailed or keepResult == KeepUnknown)
pure def resolveKeep(s: ScanDocument, keepResult: ScanKeep): ScanDocument =
  { ...s, keep: { ...s.keep, status: keepResult, operation: keepIdentityAfter(s.keep, keepResult, s.keep.operation + 1) } }
pure def canCloseKeepReview(s: ScanDocument): bool = not(s.keep.closed)
pure def closeKeepReview(s: ScanDocument): ScanDocument = { ...s, keep: { ...s.keep, closed: true } }
pure val sourceValues = Set(SourceUnsaved, SourceSelected, SourceCaptured)
pure val keepResultValues = Set(KeepSaved, KeepFailed, KeepUnknown)
pure def stepLateKeepCannotReopenReview(before: ScanDocument, via: str, after: ScanDocument): bool =
  (via == "resolveKeep" and before.keep.closed) implies after.keep.closed
pure def sometimesLostKeepAnswer(s: ScanDocument): bool = s.keep.status == KeepUnknown
pure def sometimesKeptScan(s: ScanDocument): bool = s.keep.status == KeepSaved
pure val reviewValues = Set(
  { source: SourceUnsaved, status: KeepUnknown, closed: false, hasPort: true, native: true, operation: 1 },
  { source: SourceUnsaved, status: KeepUnknown, closed: false, hasPort: true, native: false, operation: 2 },
  { source: SourceSelected, status: KeepIdle, closed: false, hasPort: true, native: true, operation: 3 },
  { source: SourceUnsaved, status: KeepFailed, closed: true, hasPort: true, native: true, operation: 4 }
)
pure def lawClosedScanCannotKeep(review: ScanKeepReview): bool = review.closed implies not(allowsKeep(review))
pure def lawSourceMustBeUnsaved(review: ScanKeepReview): bool = allowsKeep(review) implies review.source == SourceUnsaved
pure def lawUnknownNativeKeepReusesIdentity(review: ScanKeepReview, fresh: int): bool = keepIdentityAfter(review, KeepUnknown, fresh) == review.operation
pure def lawNoBrowserRepeatAfterUnknown(review: ScanKeepReview): bool = (not(review.native) and review.status == KeepUnknown) implies not(allowsKeep(review))
```
