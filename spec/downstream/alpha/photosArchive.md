# Alpha browser Photos downloads and stored ZIP

AlphaPhone `8d44dfe52b0a6e2f3462b5da85dd3f8037518f43` consumes
`plugins/plugin-files/src/browser/file-archive.ts` from Eliza
`c518127a025ab173874af9c7d304f26b25213b0d`. The imported writer is used
by `apps/app/src/prototype/browser-camera.ts` for downloads from browser
Photos and the media categories in browser Files. It constructs an
archive in memory from explicitly selected local media. Source IDs and
file bytes stay local. The pinned writer exposes no archive extraction.

## Story: Download the selected Photos and keep their exact saved bytes

### Only the current reviewed selection reaches browser download

The producer takes between one and 100 distinct, nonempty ID/revision
pairs and copies them in order. In one readonly IndexedDB transaction,
each row must exist, be image or video, have the reviewed mutation
revision, and be outside Trash. Video bytes are joined by the same
ID from the separate video store in that transaction. Metadata-only
rechecks do not read those bytes. The producer accepts only a local
image or video data URL for each accepted row. It reads each full blob
and preserves the entire batch order even if blob completions arrive
out of order. A single selected file is downloaded directly. Multiple
files have generated names using the selection index and a known
extension. They are delivered as `Alpha photos.zip`.

The producer checks the exact selected revisions again after preparing
the bytes. It requires the current callback and a visible document
immediately before creating and clicking the download link.
Photos supplies the current adapter/selection generation and exact
selected rows or open detail. Files resolves its media paths through
the current inventory and supplies its foreground callback. This
is the browser Files contract as pinned. It does not add the Photos
view's selection identity to that callback. A failed recheck, failed
archive, hidden page or retired Photos view produces no click.
The anchor is removed after the click attempt and the object URL
is revoked after 60 seconds. A click is a download request. It cannot
confirm browser storage, filesystem publication or viewer use.

The machine models one flight per invocation, independently of other
concurrent explicit requests. The chosen ordered IDs, revisions and
associated payload stand for a normalized batch identity. It tracks the
checked filesystem snapshot and caller authority separately. Browser
fixture checks refine actual IndexedDB, blob and download calls.

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
pure def alwaysDispatchHasTerminalPhase(s: ExportFlight): bool = s.dispatched == (s.phase == DownloadRequested)
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

### ZIP entries and the central directory agree with the selected bytes

The writer emits a classic single-disk ZIP with stored entries in input
order, marked UTF-8. Each entry has a 30-byte local header, UTF-8 filename,
and exact input bytes, plus a 46-byte central record and the same filename.
Both headers give identical CRC-32 and compressed/uncompressed lengths.
The local header signature is 0x04034b50, central is 0x02014b50, and the
22-byte end record signature is 0x06054b50. Fields are little-endian.
The local/central versions are 20, the flag is 0x0800, method is zero and
the date is 1980-01-01 with zero time. Extra field, comment, disk and
attributes are zero. The central entry points to the exact local header.
The end record carries the number of entries, total central length and
the byte offset of its start. Nothing is published if any limit or entry
fails.

The count must be below 65,535 because that count would require ZIP64.
The encoded filename can use at most 65,535 bytes, and the entry payload
and local-plus-central total are each checked against the inclusive
32-bit unsigned bound. The pinned writer leaves 22 bytes for the end record
outside that total's test. It never emits ZIP64 records. The boundary
value all ones in 32-bit fields therefore remains a generic
interoperability case. Alpha's 100-file selection bound is tighter than
the generic entry limit. Its writer does not promise a separate browser
memory budget or an operating-system save result.

The pinned writer uses the reflected CRC-32 polynomial 0xEDB88320,
with both initial and final XOR 0xFFFFFFFF. Every byte is applied before
the checksum is placed into both headers. The model expresses the
header and offset relationships and accepts the observed unsigned CRC
of exact stored bytes at the writer boundary. The fixture checks the
numeric CRC and file round trip using an independent ZIP reader and CRC
implementation. Photos uses a separate path for raw single-file output.

```quint
type ZipSizes = { localBytes: int, centralBytes: int, count: int }
type ZipEntry = { utf8Bytes: int, storedBytes: int, crc32: int }
type ZipHeader = { signature: int, flags: int, method: int, filenameBytes: int, storedBytes: int, originalBytes: int, crc32: int }
type ZipEnd = { signature: int, diskEntries: int, totalEntries: int, centralBytes: int, centralOffset: int }
pure val entryValues = Set(
  { utf8Bytes: 1, storedBytes: 0, crc32: 0 },
  { utf8Bytes: 65535, storedBytes: 1200, crc32: 3130697061 },
  { utf8Bytes: 65536, storedBytes: 0, crc32: 0 }
)
pure val sizesValues = Set(
  { localBytes: 0, centralBytes: 0, count: 0 },
  { localBytes: 100, centralBytes: 47, count: 1 },
  { localBytes: 4294967100, centralBytes: 95, count: 2 },
  { localBytes: 0, centralBytes: 0, count: 65534 }
)
pure def validZipEntry(entry: ZipEntry): bool =
  entry.utf8Bytes >= 1 and entry.utf8Bytes <= 65535 and entry.storedBytes >= 0 and entry.storedBytes <= 4294967295 and
  entry.crc32 >= 0 and entry.crc32 <= 4294967295
pure def validZipSizes(sizes: ZipSizes): bool =
  sizes.count >= 0 and sizes.count < 65535 and sizes.localBytes >= 0 and sizes.centralBytes >= 0 and
    sizes.localBytes + sizes.centralBytes <= 4294967295
pure def appendZipSize(sizes: ZipSizes, entry: ZipEntry): ZipSizes =
  { localBytes: sizes.localBytes + 30 + entry.utf8Bytes + entry.storedBytes,
    centralBytes: sizes.centralBytes + 46 + entry.utf8Bytes, count: sizes.count + 1 }
pure def zipEntryFits(sizes: ZipSizes, entry: ZipEntry): bool =
  validZipSizes(sizes) and validZipEntry(entry) and validZipSizes(appendZipSize(sizes, entry))
pure def localZipHeader(entry: ZipEntry): ZipHeader =
  { signature: 67324752, flags: 2048, method: 0, filenameBytes: entry.utf8Bytes,
    storedBytes: entry.storedBytes, originalBytes: entry.storedBytes, crc32: entry.crc32 }
pure def centralZipHeader(entry: ZipEntry): ZipHeader =
  { ...localZipHeader(entry), signature: 33639248 }
pure def zipEnding(sizes: ZipSizes): ZipEnd =
  { signature: 101010256, diskEntries: sizes.count, totalEntries: sizes.count,
    centralBytes: sizes.centralBytes, centralOffset: sizes.localBytes }
pure def lawMatchingZipChecksums(entry: ZipEntry): bool =
  localZipHeader(entry).crc32 == centralZipHeader(entry).crc32 and centralZipHeader(entry).crc32 == entry.crc32
pure def lawStoredZipLengthIsExact(entry: ZipEntry): bool =
  localZipHeader(entry).storedBytes == entry.storedBytes and centralZipHeader(entry).originalBytes == entry.storedBytes
pure def lawZipLocalOffsetInsideEnd(sizes: ZipSizes, entry: ZipEntry): bool =
  zipEntryFits(sizes, entry) implies sizes.localBytes < zipEnding(appendZipSize(sizes, entry)).centralOffset
pure def lawZip64CountMayNotPublish(sizes: ZipSizes, entry: ZipEntry): bool =
  sizes.count >= 65534 implies not(zipEntryFits(sizes, entry))
pure def lawOverflowMayNotPublish(sizes: ZipSizes, entry: ZipEntry): bool =
  sizes.localBytes + sizes.centralBytes + 76 + entry.utf8Bytes * 2 + entry.storedBytes > 4294967295 implies not(zipEntryFits(sizes, entry))
```

### Relative paths are distinct under the pinned key and Photos generates flat ASCII names

The generic writer rejects empty paths, backslash, NUL, leading ASCII
drive letters followed by a colon, and empty, blank, dot or dot-dot
components after trimming each component for inspection. A final
slash is ignored for validation and the collision key. The original name,
including that slash, is written to both ZIP headers. Leading slash and
repeated separators yield empty components. Exact equality of the
trimmed trailing-slash key prevents duplicate paths. Case conversion,
Unicode normalization and filesystem-specific rules are outside this
equality. The pinned generic writer does not reject file/folder prefix
collisions or two distinct UTF-16 inputs that encode as the same
UTF-8 filename. A consumer requiring arbitrary path extraction must
own a separate policy and cannot use this producer's check as that
authority. Alpha's multi-file exporter generates flat ASCII filenames
with distinct selection positions, so its production inputs avoid both
classes.

The model treats the original path and the parser's trailing-slash
key as inputs to layout. The codec supplies lexical validation and
checks actual encoded byte length. A unique selected position maps to
one filename. No extraction or writing to an existing file tree is
modeled by this writer.

```quint
type ZipPath = { original: str, collisionKey: str, hasDrive: bool, hasBackslash: bool, hasNul: bool, safeComponents: bool }
pure val pValues = Set(
  { original: "folder", collisionKey: "folder", hasDrive: false, hasBackslash: false, hasNul: false, safeComponents: true },
  { original: "folder/", collisionKey: "folder", hasDrive: false, hasBackslash: false, hasNul: false, safeComponents: true },
  { original: "../note", collisionKey: "../note", hasDrive: false, hasBackslash: false, hasNul: false, safeComponents: false }
)
pure val reservedValues = Set(Set(), Set("folder"), Set("unrelated"))
pure def validArchivePath(p: ZipPath, reserved: Set[str]): bool =
  p.original != "" and p.collisionKey != "" and not(p.hasDrive or p.hasBackslash or p.hasNul) and p.safeComponents and
    not(reserved.contains(p.collisionKey))
pure def lawArchiveKeyCannotRepeat(p: ZipPath, reserved: Set[str]): bool =
  reserved.contains(p.collisionKey) implies not(validArchivePath(p, reserved))
pure def lawUnsafeComponentsCannotPublish(p: ZipPath, reserved: Set[str]): bool =
  not(p.safeComponents) implies not(validArchivePath(p, reserved))
```
