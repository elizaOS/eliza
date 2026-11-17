# Scan draft storage

The device keeps one scan draft, its pages and its edited text, in local
storage. [Scan review](./review.md) owns the
in-memory draft, queued automatic saves and cleanup; this spec governs
the stored row.

## Story: Restore the same scan and edits after reopening the app

> As the owner, I want a scan I was working on, with my edits, to be there
> when I come back to the app.

### A stored draft decodes to complete, ordered pages

A missing row reads as absent. An existing row needs the exact document
ID, a nonempty revision, a finite update time and valid pages, each page
stored as its bytes and image type, in order; any other representation
fails. Each draft holds a page set within the [shared image
bounds](../images.md). A supplied text-layer array has one entry per
page, with null for a page without edited text. Each non-null entry
uses [the scan line rules](./searchablePdf.md). Keep only the line's
text and four position fields in a fresh record. Missing text layers
remain missing.

```quint
import images.* from "../images"
type DraftRow = { exists: bool, envelopeValid: bool, representationMatches: bool,
  pageCount: int, totalBytes: int, pagesAdmitted: bool, layersPresent: bool, layerCount: int, layersAdmitted: bool }
pure def validDraftPageSet(row: DraftRow): bool =
  admitsPageSet(row.pageCount, row.totalBytes) and row.pagesAdmitted
pure def validDraftLayers(row: DraftRow): bool =
  not(row.layersPresent) or (row.layerCount == row.pageCount and row.layersAdmitted)
pure def validDraftRow(row: DraftRow): bool =
  row.exists and row.envelopeValid and row.representationMatches and
    validDraftPageSet(row) and validDraftLayers(row)
type ScanRead = DraftAbsent | DraftRestored | DraftReadFailed
pure def scanReadOutcome(row: DraftRow): ScanRead =
  if (not(row.exists)) DraftAbsent else if (validDraftRow(row)) DraftRestored else DraftReadFailed
pure def lawBrokenStoredScanRemainsAnError(row: DraftRow): bool =
  row.exists and not(validDraftRow(row)) implies scanReadOutcome(row) == DraftReadFailed
pure def lawStoredReviewMatchesPageCount(row: DraftRow): bool =
  validDraftRow(row) and row.layersPresent implies row.layerCount == row.pageCount and row.layersAdmitted
pure val storedDraft: DraftRow = { exists: true, envelopeValid: true, representationMatches: true,
  pageCount: 2, totalBytes: 616, pagesAdmitted: true, layersPresent: true, layerCount: 2, layersAdmitted: true }
pure val rowValues = Set(storedDraft, { ...storedDraft, exists: false }, { ...storedDraft, representationMatches: false },
  { ...storedDraft, layerCount: 1 }, { ...storedDraft, layersPresent: false, layersAdmitted: false },
  { ...storedDraft, totalBytes: 67108865 }, { ...storedDraft, envelopeValid: false })
```

## Story: Save or delete a specific revision and know whether storage committed

> As the owner, I want saving or deleting a scan to act on the version I
> saw, and to know whether it was stored.

### A save snapshots bytes before the transaction and compares the latest stored revision

Check abort, copy the page array, and validate and copy optional layers
before reading bytes. Read each Blob completely in order and recheck
abort after each read. A byte-length mismatch fails the save. After
serialization, compare inside the write transaction. An expected
absence matches only an absent row. An existing row must decode for
save and its revision must match exactly. A peer can finish while
serialization is still open, making the expected revision stale.
A write stores a new revision and update time. A delete compares the
raw row's revision inside the write transaction, so it can remove an
exact revision even if that row's other fields fail decoding.

```quint
type DraftMutation = SaveDraftRow | DeleteDraftRow
type DraftWriteFacts = { snapshotAdmitted: bool, bytesComplete: bool, signalAborted: bool, rowPresent: bool,
  rowDecodable: bool, expectsAbsence: bool, revisionMatches: bool }
pure def admitsDraftWrite(kind: DraftMutation, writeFacts: DraftWriteFacts): bool =
  not(writeFacts.signalAborted) and
    (if (kind == SaveDraftRow)
      writeFacts.snapshotAdmitted and writeFacts.bytesComplete and
      (if (writeFacts.expectsAbsence) not(writeFacts.rowPresent)
       else writeFacts.rowPresent and writeFacts.rowDecodable and writeFacts.revisionMatches)
     else writeFacts.rowPresent and not(writeFacts.expectsAbsence) and writeFacts.revisionMatches)
pure def lawAStaleScanCannotQueue(kind: DraftMutation, writeFacts: DraftWriteFacts): bool =
  writeFacts.rowPresent and not(writeFacts.revisionMatches) implies not(admitsDraftWrite(kind,writeFacts))
pure def lawSaveRequiresAllPageBytes(writeFacts: DraftWriteFacts): bool =
  admitsDraftWrite(SaveDraftRow,writeFacts) implies writeFacts.snapshotAdmitted and writeFacts.bytesComplete
pure def lawUnreadableDraftRequiresRemovalBeforeSaving(writeFacts: DraftWriteFacts): bool =
  writeFacts.rowPresent and not(writeFacts.rowDecodable) implies not(admitsDraftWrite(SaveDraftRow,writeFacts))
pure val exactWrite: DraftWriteFacts = { snapshotAdmitted: true, bytesComplete: true, signalAborted: false,
  rowPresent: true, rowDecodable: true, expectsAbsence: false, revisionMatches: true }
pure val writeFactsValues = Set(exactWrite, { ...exactWrite, bytesComplete: false },
  { ...exactWrite, revisionMatches: false }, { ...exactWrite, rowDecodable: false },
  { ...exactWrite, signalAborted: true }, { ...exactWrite, rowPresent: false, expectsAbsence: true, revisionMatches: false })
```

### Mutations acknowledge only the committed transaction

A queued write is provisional. Only the committed transaction resolves
the operation and returns its receipt. An abort or storage error
before commit rejects and preserves the prior row, and an abort
observed after commit cannot reverse durable storage. A store that
cannot open reports failure.

```quint
type DraftTxPhase = AwaitingDraftMutation | DraftRequestQueued | DraftTxCommitted | DraftTxRejected
type DraftTx = { phase: DraftTxPhase, kind: DraftMutation, acknowledged: bool }
pure val initial: DraftTx = { phase: AwaitingDraftMutation, kind: SaveDraftRow, acknowledged: false }
pure def canQueueMutation(s: DraftTx, kind: DraftMutation, writeFacts: DraftWriteFacts): bool =
  s.phase == AwaitingDraftMutation and admitsDraftWrite(kind,writeFacts)
pure def queueMutation(s: DraftTx, kind: DraftMutation, writeFacts: DraftWriteFacts): DraftTx =
  { ...s, phase: DraftRequestQueued, kind: kind }
pure def canObserveDraftCommit(s: DraftTx, completed: bool): bool = s.phase == DraftRequestQueued and completed
pure def observeDraftCommit(s: DraftTx, completed: bool): DraftTx =
  { ...s, phase: DraftTxCommitted, acknowledged: true }
pure def canRejectDraftTx(s: DraftTx): bool =
  s.phase == AwaitingDraftMutation or s.phase == DraftRequestQueued
pure def rejectDraftTx(s: DraftTx): DraftTx = { ...s, phase: DraftTxRejected, acknowledged: false }
pure def alwaysScanAcknowledgmentHasCommit(s: DraftTx): bool =
  s.acknowledged iff s.phase == DraftTxCommitted
pure def stepOnlyCompletionAcknowledges(before: DraftTx, via: str, after: DraftTx): bool =
  not(before.acknowledged) and after.acknowledged implies via == "observeDraftCommit" and before.phase == DraftRequestQueued
pure def sometimesScanDraftIsWritten(s: DraftTx): bool = s.acknowledged and s.kind == SaveDraftRow
pure def sometimesScanDraftIsDeleted(s: DraftTx): bool = s.acknowledged and s.kind == DeleteDraftRow
```

