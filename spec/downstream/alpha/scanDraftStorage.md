# Alpha scan draft storage

AlphaPhone `8d44dfe52b0a6e2f3462b5da85dd3f8037518f43` binds
`apps/app/src/browser/scan-draft.ts` to
`plugins/plugin-files/src/documents/scan-draft.ts` from Eliza
`c518127a025ab173874af9c7d304f26b25213b0d`. IndexedDB database
`alpha.browser.scan-draft.v1` has schema version 1, object store
`drafts`, key path `id` and one row keyed by `document`.
[Scan review](../mobileDocumentScan.md) owns the in-memory draft,
queued automatic saves and cleanup. This contract governs the storage
port used by those operations.

## Story: Restore the same scan and edits after reopening the app

### Both stored formats decode to complete, ordered pages

A missing row returns undefined. An existing row needs the exact
document ID, a nonempty revision, finite update time and valid pages.
A row with no format discriminator reads Blob pages. A format-2 row
reads an ArrayBuffer and string MIME type for each page and reconstructs
ordered Blobs. Other formats and wrong page representations fail.
Each draft holds 1 through 20 nonempty JPEG, PNG or WebP Blobs, at
most 16 MiB each and 64 MiB together. The decoder checks Blob properties
without decoding pixels. A supplied text-layer array has one entry per
page, with null for a page without edited text. Each non-null entry
uses [the scan line rules](./searchableScanPdf.md). Keep only the line's
text and four position fields in a fresh record. Missing text layers
remain missing.

```quint
type DraftPageCodec = LegacyBlobs | BufferRecords | UnknownDraftCodec
type DraftRow = { exists: bool, envelopeValid: bool, codec: DraftPageCodec, representationMatches: bool,
  pageCount: int, totalBytes: int, pagesAdmitted: bool, layersPresent: bool, layerCount: int, layersAdmitted: bool }
pure def validDraftPageSet(row: DraftRow): bool =
  row.pageCount >= 1 and row.pageCount <= 20 and row.totalBytes > 0 and row.totalBytes <= 67108864 and row.pagesAdmitted
pure def validDraftLayers(row: DraftRow): bool =
  not(row.layersPresent) or (row.layerCount == row.pageCount and row.layersAdmitted)
pure def validDraftRow(row: DraftRow): bool =
  row.exists and row.envelopeValid and row.codec != UnknownDraftCodec and row.representationMatches and
    validDraftPageSet(row) and validDraftLayers(row)
pure def scanReadOutcome(row: DraftRow): str =
  if (not(row.exists)) "absent" else if (validDraftRow(row)) "restored" else "read-failed"
pure def lawBrokenStoredScanRemainsAnError(row: DraftRow): bool =
  row.exists and not(validDraftRow(row)) implies scanReadOutcome(row) == "read-failed"
pure def lawStoredReviewMatchesPageCount(row: DraftRow): bool =
  validDraftRow(row) and row.layersPresent implies row.layerCount == row.pageCount and row.layersAdmitted
pure val legacyDraft: DraftRow = { exists: true, envelopeValid: true, codec: LegacyBlobs, representationMatches: true,
  pageCount: 2, totalBytes: 616, pagesAdmitted: true, layersPresent: true, layerCount: 2, layersAdmitted: true }
pure val rowValues = Set(legacyDraft, { ...legacyDraft, exists: false }, { ...legacyDraft, codec: BufferRecords },
  { ...legacyDraft, codec: UnknownDraftCodec }, { ...legacyDraft, representationMatches: false },
  { ...legacyDraft, layerCount: 1 }, { ...legacyDraft, layersPresent: false, layersAdmitted: false },
  { ...legacyDraft, totalBytes: 67108865 }, { ...legacyDraft, envelopeValid: false })
```

## Story: Save or delete a specific revision and know whether storage committed

### A save snapshots bytes before the transaction and compares the latest stored revision

Check abort, copy the page array, and validate and copy optional layers
before reading bytes. Read each Blob completely in order and recheck
abort after each read. A byte-length mismatch fails the save. After
serialization, compare inside the write transaction. An expected
absence matches only an absent row. An existing row must decode for
save and its revision must match exactly. A peer can finish while
serialization is still open, making the expected revision stale.
New writes store format 2 with a new revision and update time. A delete
compares the raw row's revision inside the write transaction. It can
remove an exact revision even if that row's other fields fail decoding.
The caller supplies whether the stored revision exactly matches the
expected value. UUID generation, timing, binary reads and IndexedDB
are port effects.

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

The IndexedDB get and put or delete requests queue work. A request
success is provisional. Only the transaction's complete event resolves
the operation and returns its receipt. An abort or storage error
before commit rejects and preserves the prior row. An abort observed
after commit cannot reverse durable storage. A blocked database open
reports failure. Close the database handle and retire the listener
after transaction completion or failure. The transaction observer
begins after the database handle opens. It models one write operation,
with IndexedDB supplying the actual serialized settlement.

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

Pinned Chromium fixtures `test/browser/scan-draft.spec.ts` and
`test/browser/scan-text-draft.spec.ts` cover format migration, exact
binary order, edited text restoration, peers saving during
serialization, quota refusal, and cancellation after a put or delete
was queued.
