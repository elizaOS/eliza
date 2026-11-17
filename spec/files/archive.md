# File downloads

The owner downloads selected local media. Source IDs and file bytes stay
on the device; a single file downloads as itself and several as one
archive. Archive encoding is the writer's own contract in the package.

## Story: Download exactly the files I selected

> As the owner, I want a download to hold the files I selected as they
> were when I reviewed them, so that I never save a file I did not choose
> or a changed copy of one.

### Only the current reviewed selection is handed to download

A download takes one to 100 distinct reviewed rows. Each must still exist
at its reviewed revision, be image or video, and be outside Trash. The
selection is checked again after the bytes are prepared, and the download
is handed over only while the request is the current one, its owner is
current and the page is visible. A failed check, a failed archive or a
retired request hands over nothing. Handing a download over is a request:
it does not confirm that the file was saved.

```quint
type DownloadPhase = DownloadIdle | ReadingBatch | BuildingExport | DownloadReady | DownloadRequested | DownloadRefused
type DownloadKind = RawMedia | StoredZip
type ExportFlight = { phase: DownloadPhase, serial: int, ticket: int, capturedBatch: int, count: int, kind: DownloadKind, dispatched: bool }
pure val initial: ExportFlight = { phase: DownloadIdle, serial: 0, ticket: 0, capturedBatch: 0, count: 0, kind: RawMedia, dispatched: false }
pure def allowedSelection(count: int, distinct: bool): bool = count >= 1 and count <= 100 and distinct
pure def downloadKind(count: int): DownloadKind = if (count == 1) RawMedia else StoredZip
pure def canBeginDownload(s: ExportFlight, batchId: int, count: int, distinct: bool, ownerCurrent: bool): bool =
  (s.phase == DownloadIdle or s.phase == DownloadRefused or s.phase == DownloadRequested) and batchId > 0 and allowedSelection(count, distinct) and ownerCurrent
pure def beginDownload(s: ExportFlight, batchId: int, count: int, distinct: bool, ownerCurrent: bool): ExportFlight =
  { ...initial, serial: s.serial + 1, ticket: s.serial + 1, phase: ReadingBatch, capturedBatch: batchId, count: count, kind: downloadKind(count) }
pure def canFinishBatch(s: ExportFlight, exportId: int, payloadValid: bool): bool =
  s.phase == ReadingBatch and exportId == s.ticket
pure def finishBatch(s: ExportFlight, exportId: int, payloadValid: bool): ExportFlight =
  { ...s, phase: if (payloadValid) BuildingExport else DownloadRefused }
pure def canFinishEncoding(s: ExportFlight, exportId: int, encoded: bool): bool =
  s.phase == BuildingExport and exportId == s.ticket
pure def finishEncoding(s: ExportFlight, exportId: int, encoded: bool): ExportFlight =
  { ...s, phase: if (encoded) DownloadReady else DownloadRefused }
pure def canCheckAndRequest(s: ExportFlight, exportId: int, batchId: int, rereadMatches: bool, ownerCurrent: bool, visible: bool): bool =
  s.phase == DownloadReady and exportId == s.ticket
pure def checkAndRequest(s: ExportFlight, exportId: int, batchId: int, rereadMatches: bool, ownerCurrent: bool, visible: bool): ExportFlight = {
  val matching = batchId == s.capturedBatch and rereadMatches and ownerCurrent and visible
  { ...s, phase: if (matching) DownloadRequested else DownloadRefused, dispatched: matching }
}
pure def canRetireDownload(s: ExportFlight): bool =
  s.phase == ReadingBatch or s.phase == BuildingExport or s.phase == DownloadReady
pure def retireDownload(s: ExportFlight): ExportFlight = { ...s, phase: DownloadRefused }
pure def alwaysDownloadSequence(s: ExportFlight): bool =
  s.serial >= 0 and s.ticket == s.serial and (s.phase != DownloadIdle implies s.ticket > 0)
pure def alwaysDownloadUsesBoundedBatch(s: ExportFlight): bool =
  s.phase != DownloadIdle implies s.capturedBatch > 0 and allowedSelection(s.count, true) and s.kind == downloadKind(s.count)
pure def alwaysDispatchMatchesDownloadPhase(s: ExportFlight): bool = s.dispatched == (s.phase == DownloadRequested)
pure def stepOnlyReadyDownloadCanDispatch(before: ExportFlight, via: str, after: ExportFlight): bool =
  after.dispatched and not(before.dispatched) implies via == "checkAndRequest" and before.phase == DownloadReady and after.ticket == before.ticket
pure def lawUnreviewedDownloadCannotDispatch(s: ExportFlight, exportId: int, batchId: int, rereadMatches: bool, ownerCurrent: bool, visible: bool): bool =
  (batchId != s.capturedBatch or not(rereadMatches and ownerCurrent and visible)) implies
    not(checkAndRequest(s, exportId, batchId, rereadMatches, ownerCurrent, visible).dispatched)
pure def sometimesRawRequest(s: ExportFlight): bool = s.dispatched and s.kind == RawMedia
pure def sometimesZipRequest(s: ExportFlight): bool = s.dispatched and s.kind == StoredZip
pure val batchIdValues = Set(1, 2)
pure val exportIdValues = Set(1, 2, 3)
pure val countValues = Set(0, 1, 2, 100, 101)
pure val weight_finishBatch = 5
pure val weight_finishEncoding = 5
pure val weight_checkAndRequest = 8
```

### A multi-file download holds exactly the selected bytes in selection order under distinct names

Each selected file becomes one entry, in selection order, holding that
file's bytes as they were read for review. Entries are named by their
position in the selection, counting from one with no gaps, so no two
entries share a name.

```quint
type SelectedFile = { source: str, bytes: str }
type ArchiveEntry = { position: int, source: str, bytes: str }
type NameWalk = { consecutive: bool, last: int }
pure def archiveEntries(selection: List[SelectedFile]): List[ArchiveEntry] =
  selection.foldl(List(), (entries, file) => entries.append({ position: entries.length() + 1, source: file.source, bytes: file.bytes }))
pure def namesCountFromOne(entries: List[ArchiveEntry]): bool =
  entries.foldl({ consecutive: true, last: 0 }, (walk, entry) => { consecutive: walk.consecutive and entry.position == walk.last + 1, last: entry.position }).consecutive
pure val selectionValues = Set(List(), List({ source: "photo", bytes: "p" }), List({ source: "photo", bytes: "p" }, { source: "video", bytes: "v" }),
  List({ source: "video", bytes: "v" }, { source: "photo", bytes: "p" }, { source: "clip", bytes: "p" }))
pure def lawArchiveHoldsSelectedBytesInOrder(selection: List[SelectedFile]): bool =
  archiveEntries(selection).listMap(entry => { source: entry.source, bytes: entry.bytes }) == selection
pure def lawArchiveNamesCountFromOne(selection: List[SelectedFile]): bool = namesCountFromOne(archiveEntries(selection))
```
