# Android permitted Photos catalog paging

AlphaPhone `8d44dfe5` calls Eliza `c518127a` through installed
`AlphaPhotosPlugin` and `AlphaPhotoLibraryPlugin`. Grace `48b43b9c`
calls Eliza `7743504b` through `DevicePhotosPlugin`. Both use
`plugins/plugin-native-media/android/src/main/java/ai/eliza/plugins/media/PermittedMediaCatalog.java`.
Alpha's `camera-adapter.ts` uses `PhotosPlugin.list` for its Photos
window, and `photo-library-adapter.ts` uses `DeviceLibraryPlugin` for
agent listing. Grace's `apps/app/src/device-services.ts` uses
`PermittedPhotosPlugin.listPermitted` with image-only, thumbnail-free
pages, adapting the cursor to its renderer offset interface.
[Permission epochs](./mobilePhotos.md) govern worker and main-thread
publication. [Alpha Photos window](./alpha/photosWindow.md) owns
renderer buffering, window depth and thumbnail cache. [Permitted
mutations](./mobilePermittedMediaReview.md) use a separate review.

Alpha's pinned `test/photos-library-patch.test.mjs` checks the exact
Java merged order, continuation SQL, and thumbnail handling. Both
vendors' `test/native-host/permitted-catalog.node.mjs` check catalog
read admission and publication. Grace's `PhotosInstrumentedTest` and
Alpha's `PhotosForeignLibraryInstrumentedTest` exercise Android
permission and provider behavior. Grace's `test-photos-browser.mjs`
supplies controlled results for the renderer's offset adapter.

## Story: Page the permitted rows in the order used by my installed app

### A query applies the pinned profile, filters and provider bounds

Both catalogs permit 1–24 results, valid media kind and an inclusive
nonnegative date window. They bind an original search string of at
most 128 Java UTF-16 code units with no NUL. A nonblank search is
trimmed and applied as a case-insensitive provider name substring.
The lower date bound rounds up to provider seconds, and a bounded
upper date rounds down. The date filter uses date added even when
Alpha sorts by capture time.

The producer orders the external volumes by name, refuses more
than 16 volumes, and queries permitted image and video collections.
Grace configures the image permission profile. Android access and
catalog visibility determine whether a type can be queried. The host
applies its owned-only provider predicate when the scope requires
it. All queries exclude pending rows and apply the configured
trash, favorite and folder filters. Alpha supports All, Camera and
Screenshots before Android 11, with Favorites and Trash on 11 and
later. Grace supports All before Android 11, with Favorites and
Trash on 11 and later. Grace's active renderer uses All.

The thumbnail flag does not change page identity. If previews are
requested, a page can start a decode for a row only before its
three-second thumbnail cutoff. Decode failure yields an empty image
field. A row whose decode was skipped retains no image field.
Ordinary single-row reads permit edges from 64 to 2048 pixels and
check the same row revision again after decode. This unit assumes
qualified row, profile, provider-version and access facts from native.

```quint
type CatalogPin = AlphaCatalog | GraceCatalog
type CatalogBridge = AlphaPhotosView | AlphaPermittedView | AlphaAgentCatalog | GracePhotosView
type MediaKind = AllKinds | ImageKind | VideoKind
type CatalogFilter = AllMedia | FavoriteMedia | TrashMedia | CameraMedia | ScreenshotsMedia
type PageQuery = { kind: MediaKind, filter: CatalogFilter, fromMillis: int, toMillis: int,
  limit: int, search: str, searchUnits: int, noNul: bool }
pure def supportedCatalogFilter(pin: CatalogPin, modern: bool, albumFilter: CatalogFilter): bool =
  albumFilter == AllMedia or (modern and (albumFilter == FavoriteMedia or albumFilter == TrashMedia)) or
    (pin == AlphaCatalog and (albumFilter == CameraMedia or albumFilter == ScreenshotsMedia))
pure def validPageQuery(pin: CatalogPin, modern: bool, query: PageQuery): bool =
  query.limit >= 1 and query.limit <= 24 and query.fromMillis >= 0 and query.toMillis >= query.fromMillis and
    query.searchUnits >= 0 and query.searchUnits <= 128 and query.noNul and supportedCatalogFilter(pin, modern, query.filter)
pure def dateLowerSeconds(millis: int): int = millis / 1000 + (if (millis % 1000 == 0) 0 else 1)
pure def dateUpperSeconds(millis: int): int = millis / 1000
pure def catalogMayQueryKind(pin: CatalogPin, kind: MediaKind, sourceVideo: bool, providerReadable: bool): bool =
  providerReadable and (if (sourceVideo) pin == AlphaCatalog and kind != ImageKind else kind != VideoKind)
pure def validNativeVolumeCount(volumeCount: int): bool = volumeCount >= 0 and volumeCount <= 16
type ThumbnailField = NoThumbnail | EmptyThumbnail | DecodedThumbnail
pure def catalogThumbnail(thumbnails: bool, withinBudget: bool, decoded: bool): ThumbnailField =
  if (not(thumbnails and withinBudget)) NoThumbnail else if (decoded) DecodedThumbnail else EmptyThumbnail
pure def validSinglePreviewEdge(edge: int): bool = edge >= 64 and edge <= 2048
pure val galleryQuery: PageQuery = { kind: ImageKind, filter: AllMedia, fromMillis: 0, toMillis: 10000,
  limit: 24, search: "", searchUnits: 0, noNul: true }
pure val cameraQuery: PageQuery = { ...galleryQuery, filter: CameraMedia }
pure val queryValues = Set(galleryQuery, cameraQuery, { ...galleryQuery, filter: FavoriteMedia },
  { ...galleryQuery, limit: 1 }, { ...galleryQuery, limit: 25 }, { ...galleryQuery, noNul: false },
  { ...galleryQuery, search: " holiday ", searchUnits: 9 })
pure val millisValues = Set(0, 999, 1000, 1001, 7000)
pure val edgeValues = Set(63, 64, 1024, 2048, 2049)
pure val volumeCountValues = Set(0, 1, 16, 17)
pure def lawGraceCatalogExcludesFolderFilters(modern: bool, query: PageQuery): bool =
  validPageQuery(GraceCatalog, modern, query) implies query.filter != CameraMedia and query.filter != ScreenshotsMedia
pure def lawGraceImageProfileExcludesVideos(kind: MediaKind, providerReadable: bool): bool =
  not(catalogMayQueryKind(GraceCatalog, kind, true, providerReadable))
pure def lawDisabledThumbnailsHaveNoField(withinBudget: bool, decoded: bool): bool =
  catalogThumbnail(false, withinBudget, decoded) == NoThumbnail
```

### Alpha merges by the global key while Grace advances one bucket at a time

Alpha takes at most the limit plus one candidates from each
permitted volume/type source. The source ordinal follows sorted
volume index, with image before video in each volume. The catalog
sorts the merged list by descending capture time, ascending source
ordinal, and descending MediaStore ID. If capture time is missing
or zero, date added in milliseconds supplies the sort time. The
cursor names the last returned row. A source earlier than the last
row's source needs a strictly smaller time. A later source may
share the last row's time. The same source at equal time needs a
smaller ID. Native selection arguments numerically compare those
time and ID coordinates.

Grace exhausts each permitted bucket in sorted volume order, and
IDs descend within the bucket. It asks each bucket for the remaining
page budget plus one. Its cursor names the bucket where it saw the
first unreturned candidate and the exclusive ID bound for that
bucket. When the lookahead is in a new bucket, the bound is the
initial upper bound. Its first unreturned row remains eligible.
A provider row from an earlier bucket cannot appear again. The
lookahead row is not emitted on the current page in either pin.

```quint
type CatalogRowKey = { shot: int, source: int, rowId: int }
type BucketPosition = { bucket: int, hasUpper: bool, beforeId: int }
type PagePosition = { alphaKey: CatalogRowKey, graceKey: BucketPosition }
pure def alphaCaptureTime(dateTaken: int, dateAddedSeconds: int): int =
  if (dateTaken == 0) dateAddedSeconds * 1000 else dateTaken
pure def afterAlphaCatalogKey(candidate: CatalogRowKey, lastKey: CatalogRowKey): bool =
  candidate.shot < lastKey.shot or (candidate.shot == lastKey.shot and
    (candidate.source > lastKey.source or (candidate.source == lastKey.source and candidate.rowId < lastKey.rowId)))
pure def afterGraceCatalogBucket(candidate: CatalogRowKey, position: BucketPosition): bool =
  candidate.source > position.bucket or
    (candidate.source == position.bucket and (not(position.hasUpper) or candidate.rowId < position.beforeId))
pure def catalogAfter(pin: CatalogPin, candidate: CatalogRowKey, location: PagePosition): bool =
  if (pin == AlphaCatalog) afterAlphaCatalogKey(candidate, location.alphaKey)
  else afterGraceCatalogBucket(candidate, location.graceKey)
pure def offersNextCursor(rowCount: int, limit: int, sawLookahead: bool): bool =
  limit >= 1 and limit <= 24 and rowCount == limit and sawLookahead
pure val firstCatalogKey: CatalogRowKey = { shot: 5000, source: 2, rowId: 7 }
pure val firstPosition: PagePosition = { alphaKey: firstCatalogKey, graceKey: { bucket: 2, hasUpper: true, beforeId: 7 } }
pure val nextGraceBucket: BucketPosition = { bucket: 3, hasUpper: false, beforeId: 0 }
pure val candidateValues = Set(firstCatalogKey, { ...firstCatalogKey, source: 1 },
  { ...firstCatalogKey, source: 3 }, { ...firstCatalogKey, rowId: 6 },
  { ...firstCatalogKey, shot: 4999 }, { ...firstCatalogKey, shot: 5001, source: 3 })
pure val lastKeyValues = Set(firstCatalogKey, { ...firstCatalogKey, source: 3 })
pure val positionValues = Set(firstPosition.graceKey, nextGraceBucket)
pure val locationValues = Set(firstPosition, { ...firstPosition, graceKey: nextGraceBucket })
pure val rowCountValues = Set(0, 1, 23, 24, 25)
pure val limitValues = Set(1, 24, 25)
pure def lawAlphaContinuationNeverRepeatsLastRow(lastKey: CatalogRowKey): bool =
  not(afterAlphaCatalogKey(lastKey, lastKey))
pure def lawGraceContinuationNeverReturnsEarlierBucket(candidate: CatalogRowKey, position: BucketPosition): bool =
  afterGraceCatalogBucket(candidate, position) implies candidate.source >= position.bucket
pure def lawCatalogCursorNeedsAnUnreturnedCandidate(rowCount: int, limit: int, sawLookahead: bool): bool =
  offersNextCursor(rowCount, limit, sawLookahead) implies rowCount == limit and sawLookahead
```

## Story: Continue only a current, unconsumed catalog page

### A syntactically valid page request consumes its matching cursor before provider work

A cursor belongs to one catalog instance. It binds the original
search, kind, filter, date bounds and limit, plus the permission and
provider snapshot. The snapshot includes ordered volume identities,
their current MediaStore versions, and each generation on Android
11 and later, together with the catalog access and epoch. The shell
captures the exact snapshot and checks that the final query still
has that snapshot and volume list. A malformed query or initial
snapshot failure prevents a cursor lookup and leaves it intact.

Once lookup starts, the opaque token is removed before its deadline,
query and snapshot checks. A token expiring at the exact elapsed
deadline is still valid. A stale, mismatched, consumed or absent
token cannot start provider reads. A failure after lookup cannot
give the old token back. A catalog invalidation clears the cursor
table. Alpha's agent facade maps that stale cursor to
`LIBRARY_STALE_CURSOR`. Alpha's ordinary `list` instead reports
saved media could not be loaded. Alpha's inherited `listPermitted`
entry point instead uses the same generic library rejection as Grace.
Grace reports the generic
library changed or unavailable rejection and its renderer clears
the offset adapter so a later read can start over.

The model uses increasing internal IDs for fresh opaque UUIDs.
It models serialized reads by one catalog worker. Native storage
and publication supply the snapshot predicates, and provider rows
supply the last key and lookahead evidence.

```quint
type PageStart = PageAdmitted | BadPageQuery | InitialSnapshotFailed | StalePageCursor
type PageFailure = NoPageFailure | SavedMediaUnavailable | LibraryChanged | LibraryStaleCursor
pure def pageStartFailure(bridge: CatalogBridge, start: PageStart): PageFailure =
  if (start == PageAdmitted) NoPageFailure
  else if (bridge == AlphaPhotosView) SavedMediaUnavailable
  else if (bridge == AlphaAgentCatalog and start == StalePageCursor) LibraryStaleCursor
  else LibraryChanged
type CatalogCursor = { token: int, until: int, snapshot: str, query: PageQuery, location: PagePosition }
pure val noCatalogCursor: CatalogCursor = { token: 0, until: 0, snapshot: "", query: galleryQuery, location: firstPosition }
type PageAttempt = { running: bool, query: PageQuery, snapshot: str, inputCursor: CatalogCursor }
type PageReply = PageIdle | PageStarted | PageRefused | PageFailed | PageReturned
type CatalogPaging = { pin: CatalogPin, now: int, issued: int, cursors: List[CatalogCursor],
  attempt: PageAttempt, start: PageStart, reply: PageReply, returnedCursor: int }
pure val noPageAttempt: PageAttempt = { running: false, query: galleryQuery, snapshot: "", inputCursor: noCatalogCursor }
pure val initial: CatalogPaging = { pin: AlphaCatalog, now: 0, issued: 0, cursors: List(), attempt: noPageAttempt,
  start: PageAdmitted, reply: PageIdle, returnedCursor: 0 }
pure def findCatalogCursor(cursors: List[CatalogCursor], token: int): CatalogCursor =
  cursors.select(cursor => cursor.token == token).nthOr(0, noCatalogCursor)
pure def removeCatalogCursor(cursors: List[CatalogCursor], token: int): List[CatalogCursor] =
  cursors.select(cursor => cursor.token != token)
pure def samePageQuery(prior: PageQuery, query: PageQuery): bool =
  prior.kind == query.kind and prior.filter == query.filter and prior.fromMillis == query.fromMillis and
    prior.toMillis == query.toMillis and prior.limit == query.limit and prior.search == query.search
pure def matchesCatalogCursor(cursor: CatalogCursor, now: int, query: PageQuery, snapshot: str): bool =
  cursor.token > 0 and cursor.until >= now and samePageQuery(cursor.query, query) and cursor.snapshot == snapshot
pure def canReadCatalogPage(s: CatalogPaging): bool = not(s.attempt.running)
pure def readCatalogPage(s: CatalogPaging, query: PageQuery, modern: bool, snapshot: str, token: int): CatalogPaging = {
  val cursor = findCatalogCursor(s.cursors, token)
  val remaining = if (token == 0) s.cursors else removeCatalogCursor(s.cursors, token)
  if (not(validPageQuery(s.pin, modern, query)))
    { ...s, start: BadPageQuery, reply: PageRefused, returnedCursor: 0 }
  else if (snapshot == "")
    { ...s, start: InitialSnapshotFailed, reply: PageRefused, returnedCursor: 0 }
  else {
    if (token != 0 and not(cursor.token == token and matchesCatalogCursor(cursor, s.now, query, snapshot)))
      { ...s, cursors: remaining, start: StalePageCursor, reply: PageRefused, returnedCursor: 0 }
    else { ...s, cursors: remaining, attempt: { running: true, query: query, snapshot: snapshot, inputCursor: cursor },
      start: PageAdmitted, reply: PageStarted, returnedCursor: 0 }
  }
}
pure def canUseCatalogPin(s: CatalogPaging, pin: CatalogPin): bool =
  s.reply == PageIdle and s.issued == 0 and not(s.attempt.running) and s.pin != pin
pure def useCatalogPin(s: CatalogPaging, pin: CatalogPin): CatalogPaging = { ...s, pin: pin }
pure def canAdvanceCatalogClock(s: CatalogPaging, observedClock: int): bool = observedClock > s.now
pure def advanceCatalogClock(s: CatalogPaging, observedClock: int): CatalogPaging = { ...s, now: observedClock }
pure def invalidateCatalogCursors(s: CatalogPaging): CatalogPaging = { ...s, cursors: List() }
pure val observedClockValues = Set(1, 120000, 120001, 240002)
pure val snapshotValues = Set("", "volume-snapshot-1", "volume-snapshot-2")
pure val tokenValues = Set(0, 1, 2, 3, 4, 5)
pure val cursorValues = Set(noCatalogCursor, { token: 1, until: 120000, snapshot: "volume-snapshot-1",
  query: galleryQuery, location: firstPosition })
pure val cursorsValues = Set(List(), List(noCatalogCursor))
pure val priorValues = queryValues
pure val albumFilterValues = Set(AllMedia, FavoriteMedia, TrashMedia, CameraMedia, ScreenshotsMedia)
pure val weight_readCatalogPage = 16
pure def lawNativeStaleErrorIsSpecificToAgentFacade(bridge: CatalogBridge, start: PageStart): bool =
  pageStartFailure(bridge, start) == LibraryStaleCursor implies bridge == AlphaAgentCatalog and start == StalePageCursor
pure def stepEarlyRefusalLeavesCursorTable(before: CatalogPaging, via: str, after: CatalogPaging): bool =
  via == "readCatalogPage" and (after.start == BadPageQuery or after.start == InitialSnapshotFailed) implies
    after.cursors == before.cursors and not(after.attempt.running)
pure def stepAdmittedContinuationConsumesItsToken(before: CatalogPaging, via: str, after: CatalogPaging): bool =
  via == "readCatalogPage" and after.attempt.running and after.attempt.inputCursor.token > 0 implies
    after.cursors == removeCatalogCursor(before.cursors, after.attempt.inputCursor.token)
```

### A continuation can be issued internally before final publication without exposing stale rows

The catalog allocates a new cursor only with a full page and a
lookahead row. It drops entries that have expired, evicts the oldest
insertion if 32 live entries remain, and appends a token valid for
120 seconds. Both producers allocate their next cursor before
the last snapshot verification. A failed final fence or refused
main-thread publication cannot expose either the rows or the next
token. The unexposed entry may still occupy the cursor cache until
retired or evicted. A provider failure before constructing a page
cannot allocate a token. The observation supplied by the port must fit
the page's row bound. End-of-catalog returns an empty cursor.

The shared permission epoch owner finishes the main-thread check.
This model observes that qualification along with the catalog's
last snapshot comparison.

```quint
type CatalogPageEvidence = { providerRead: bool, rowCount: int, sawLookahead: bool,
  location: PagePosition, finalSnapshot: str, publicationAllowed: bool }
pure def keepCatalogCursor(cursors: List[CatalogCursor], now: int, cursor: CatalogCursor): List[CatalogCursor] = {
  val live = cursors.select(prior => prior.until >= now)
  val room = if (live.length() >= 32) live.removeAt(0) else live
  room.append(cursor)
}
pure def canFinishCatalogPage(s: CatalogPaging): bool = s.attempt.running
pure def finishCatalogPage(s: CatalogPaging, evidence: CatalogPageEvidence): CatalogPaging = {
  val full = evidence.providerRead and offersNextCursor(evidence.rowCount, s.attempt.query.limit, evidence.sawLookahead)
  val visible = evidence.providerRead and evidence.rowCount >= 0 and evidence.rowCount <= s.attempt.query.limit and evidence.finalSnapshot == s.attempt.snapshot and evidence.publicationAllowed
  val cursor = { token: s.issued + 1, until: s.now + 120000, snapshot: s.attempt.snapshot, query: s.attempt.query,
    location: evidence.location }
  { ...s, issued: if (full) cursor.token else s.issued, attempt: noPageAttempt,
    cursors: if (full) keepCatalogCursor(s.cursors, s.now, cursor) else s.cursors,
    reply: if (visible) PageReturned else PageFailed, returnedCursor: if (visible and full) cursor.token else 0 }
}
pure val fullCatalogPage: CatalogPageEvidence = { providerRead: true, rowCount: 24, sawLookahead: true, location: firstPosition,
  finalSnapshot: "volume-snapshot-1", publicationAllowed: true }
pure val evidenceValues = Set(fullCatalogPage, { ...fullCatalogPage, rowCount: 1 },
  { ...fullCatalogPage, sawLookahead: false }, { ...fullCatalogPage, providerRead: false },
  { ...fullCatalogPage, finalSnapshot: "volume-snapshot-2" }, { ...fullCatalogPage, publicationAllowed: false })
pure val weight_finishCatalogPage = 16
pure def alwaysCatalogTokenIsAllocated(s: CatalogPaging): bool =
  s.issued >= 0 and s.returnedCursor >= 0 and s.returnedCursor <= s.issued
pure def stepUnpublishedCatalogPageDoesNotExposeACursor(before: CatalogPaging, via: str, after: CatalogPaging): bool =
  via == "finishCatalogPage" and after.reply == PageFailed implies after.returnedCursor == 0
pure def stepCatalogCursorOnlyReturnedFromFullRead(before: CatalogPaging, via: str, after: CatalogPaging): bool =
  via == "finishCatalogPage" and after.returnedCursor > 0 implies before.attempt.running and
    after.reply == PageReturned and after.issued == before.issued + 1
pure def sometimesAlphaCatalogPublishesContinuation(s: CatalogPaging): bool =
  s.pin == AlphaCatalog and s.reply == PageReturned and s.returnedCursor > 0
pure def sometimesGraceCatalogPublishesContinuation(s: CatalogPaging): bool =
  s.pin == GraceCatalog and s.reply == PageReturned and s.returnedCursor > 0
pure def sometimesPageRetainsInternalCursorAfterRefusal(s: CatalogPaging): bool =
  s.reply == PageFailed and s.returnedCursor == 0 and s.cursors.length() > 0
pure def sometimesPageRejectsOldCursor(s: CatalogPaging): bool = s.reply == PageRefused and s.start == StalePageCursor
```
