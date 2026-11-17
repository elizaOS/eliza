# Android permitted Photos catalog paging

A consumer calls Eliza's `PermittedMediaCatalog.java` under
`plugins/plugin-native-media/android` through its photos plugin. The catalog
pages permitted images and videos by one global key and serves the Photos
view and the agent catalog alike. [Permission epochs](./permissionEpochs.md)
govern worker and main-thread publication, and
[permitted mutations](./review.md) use a separate review.

## Story: Page the permitted rows in the order used by my installed app

> As the person, I want to page through the photos and videos I allowed,
> newest first, so that each row appears once and only rows I permitted
> appear at all.

### A query applies the catalog's filters and provider bounds

A query permits 1–24 results, valid media kind and an inclusive
nonnegative date window. They bind an original search string of at
most 128 Java UTF-16 code units with no NUL. A nonblank search is
trimmed and applied as a case-insensitive provider name substring.
The lower date bound rounds up to provider seconds, and a bounded
upper date rounds down. The date filter uses date added even when
the catalog sorts by capture time.

The catalog orders the external volumes by name, refuses more than 16
volumes, and queries the permitted image and video collections that
Android access and catalog visibility allow, with the owned-only predicate
when the scope requires it. Every query excludes pending rows. All, Camera
and Screenshots are supported everywhere, Favorites and Trash on Android 11
and later.

The thumbnail flag does not change page identity. A requested preview is
decoded only within the page's thumbnail budget. Decode failure yields an empty image
field. A row whose decode was skipped retains no image field.
Ordinary single-row reads permit edges from 64 to 2048 pixels and
check the same row revision again after decode. This unit assumes
qualified row, profile, provider-version and access facts from native.

```quint
type MediaKind = AllKinds | ImageKind | VideoKind
type CatalogFilter = AllMedia | FavoriteMedia | TrashMedia | CameraMedia | ScreenshotsMedia
type PageQuery = { kind: MediaKind, filter: CatalogFilter, fromMillis: int, toMillis: int,
  limit: int, search: str, searchUnits: int, noNul: bool }
pure def supportedCatalogFilter(modern: bool, albumFilter: CatalogFilter): bool =
  modern or not(albumFilter == FavoriteMedia or albumFilter == TrashMedia)
pure def validPageQuery(modern: bool, query: PageQuery): bool =
  query.limit >= 1 and query.limit <= 24 and query.fromMillis >= 0 and query.toMillis >= query.fromMillis and
    query.searchUnits >= 0 and query.searchUnits <= 128 and query.noNul and supportedCatalogFilter(modern, query.filter)
pure def dateLowerSeconds(millis: int): int = millis / 1000 + (if (millis % 1000 == 0) 0 else 1)
pure def dateUpperSeconds(millis: int): int = millis / 1000
pure def catalogMayQueryKind(kind: MediaKind, sourceVideo: bool, providerReadable: bool): bool =
  providerReadable and (if (sourceVideo) kind != ImageKind else kind != VideoKind)
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
pure def lawOlderAndroidRefusesFavoritesAndTrash(query: PageQuery): bool =
  query.filter == FavoriteMedia or query.filter == TrashMedia implies not(validPageQuery(false, query))
pure def lawImageQueryReadsNoVideoSource(providerReadable: bool): bool =
  not(catalogMayQueryKind(ImageKind, true, providerReadable))
pure def lawDisabledThumbnailsHaveNoField(withinBudget: bool, decoded: bool): bool =
  catalogThumbnail(false, withinBudget, decoded) == NoThumbnail
```

### The catalog pages by one global key and never repeats the last row

The catalog takes at most the limit plus one candidates from each
permitted volume/type source. The source ordinal follows sorted
volume index, with image before video in each volume. The catalog
sorts the merged list by descending capture time, ascending source
ordinal, and descending MediaStore ID. If capture time is missing
or zero, date added in milliseconds supplies the sort time. The
cursor names the last returned row. A source earlier than the last
row's source needs a strictly smaller time. A later source may
share the last row's time. The same source at equal time needs a
smaller ID. Native selection arguments numerically compare those
time and ID coordinates. The lookahead row is never emitted on the
current page.

```quint
type CatalogRowKey = { shot: int, source: int, rowId: int }
pure def mergedCaptureTime(dateTaken: int, dateAddedSeconds: int): int =
  if (dateTaken == 0) dateAddedSeconds * 1000 else dateTaken
pure def afterMergedCatalogKey(candidate: CatalogRowKey, lastKey: CatalogRowKey): bool =
  candidate.shot < lastKey.shot or (candidate.shot == lastKey.shot and
    (candidate.source > lastKey.source or (candidate.source == lastKey.source and candidate.rowId < lastKey.rowId)))
pure def offersNextCursor(rowCount: int, limit: int, sawLookahead: bool): bool =
  limit >= 1 and limit <= 24 and rowCount == limit and sawLookahead
pure val firstCatalogKey: CatalogRowKey = { shot: 5000, source: 2, rowId: 7 }
pure val candidateValues = Set(firstCatalogKey, { ...firstCatalogKey, source: 1 },
  { ...firstCatalogKey, source: 3 }, { ...firstCatalogKey, rowId: 6 },
  { ...firstCatalogKey, shot: 4999 }, { ...firstCatalogKey, shot: 5001, source: 3 })
pure val lastKeyValues = Set(firstCatalogKey, { ...firstCatalogKey, source: 3 })
pure val rowCountValues = Set(0, 1, 23, 24, 25)
pure val limitValues = Set(1, 24, 25)
pure def lawMergedContinuationNeverRepeatsLastRow(lastKey: CatalogRowKey): bool =
  not(afterMergedCatalogKey(lastKey, lastKey))
pure def lawCatalogCursorNeedsAnUnreturnedCandidate(rowCount: int, limit: int, sawLookahead: bool): bool =
  offersNextCursor(rowCount, limit, sawLookahead) implies rowCount == limit and sawLookahead
```

## Story: Continue only a current, unconsumed catalog page

> As the person, I want the next page of my media to continue the page I
> am on, once, and only while it is current.

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
table. A stale cursor is reported as `LIBRARY_STALE_CURSOR` to every
caller, so it can start over from the first page; an invalid query and a
failed snapshot have their own errors.

The model uses increasing internal IDs for fresh opaque tokens and one
serialized catalog worker; native storage supplies the snapshot
predicates, and provider rows the last key and lookahead evidence.

```quint
type PageStart = PageAdmitted | BadPageQuery | InitialSnapshotFailed | StalePageCursor
type PageFailure = NoPageFailure | InvalidPageQuery | LibraryUnavailable | LibraryStaleCursor
pure def pageStartFailure(start: PageStart): PageFailure =
  if (start == PageAdmitted) NoPageFailure
  else if (start == BadPageQuery) InvalidPageQuery
  else if (start == InitialSnapshotFailed) LibraryUnavailable else LibraryStaleCursor
type CatalogCursor = { token: int, until: int, snapshot: str, query: PageQuery, location: CatalogRowKey }
pure val noCatalogCursor: CatalogCursor = { token: 0, until: 0, snapshot: "", query: galleryQuery, location: firstCatalogKey }
type PageAttempt = { running: bool, query: PageQuery, snapshot: str, inputCursor: CatalogCursor }
type PageReply = PageIdle | PageStarted | PageRefused | PageFailed | PageReturned
type CatalogPaging = { now: int, issued: int, cursors: List[CatalogCursor],
  attempt: PageAttempt, start: PageStart, reply: PageReply, returnedCursor: int }
pure val noPageAttempt: PageAttempt = { running: false, query: galleryQuery, snapshot: "", inputCursor: noCatalogCursor }
pure val initial: CatalogPaging = { now: 0, issued: 0, cursors: List(), attempt: noPageAttempt,
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
  if (not(validPageQuery(modern, query)))
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
pure def canAdvanceCatalogClock(s: CatalogPaging, observedClock: int): bool = observedClock > s.now
pure def advanceCatalogClock(s: CatalogPaging, observedClock: int): CatalogPaging = { ...s, now: observedClock }
pure def invalidateCatalogCursors(s: CatalogPaging): CatalogPaging = { ...s, cursors: List() }
pure val observedClockValues = Set(1, 120000, 120001, 240002)
pure val snapshotValues = Set("", "volume-snapshot-1", "volume-snapshot-2")
pure val tokenValues = Set(0, 1, 2, 3, 4, 5)
pure val cursorValues = Set(noCatalogCursor, { token: 1, until: 120000, snapshot: "volume-snapshot-1",
  query: galleryQuery, location: firstCatalogKey })
pure val cursorsValues = Set(List(), List(noCatalogCursor))
pure val priorValues = queryValues
pure val albumFilterValues = Set(AllMedia, FavoriteMedia, TrashMedia, CameraMedia, ScreenshotsMedia)
pure def lawStaleCursorHasItsOwnError(start: PageStart): bool =
  (pageStartFailure(start) == LibraryStaleCursor) == (start == StalePageCursor)
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
120 seconds. The catalog allocates its next cursor before
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
  location: CatalogRowKey, finalSnapshot: str, publicationAllowed: bool }
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
pure val fullCatalogPage: CatalogPageEvidence = { providerRead: true, rowCount: 24, sawLookahead: true, location: firstCatalogKey,
  finalSnapshot: "volume-snapshot-1", publicationAllowed: true }
pure val evidenceValues = Set(fullCatalogPage, { ...fullCatalogPage, rowCount: 1 },
  { ...fullCatalogPage, sawLookahead: false }, { ...fullCatalogPage, providerRead: false },
  { ...fullCatalogPage, finalSnapshot: "volume-snapshot-2" }, { ...fullCatalogPage, publicationAllowed: false })
pure def alwaysCatalogTokenIsAllocated(s: CatalogPaging): bool =
  s.issued >= 0 and s.returnedCursor >= 0 and s.returnedCursor <= s.issued
pure def stepUnpublishedCatalogPageDoesNotExposeACursor(before: CatalogPaging, via: str, after: CatalogPaging): bool =
  via == "finishCatalogPage" and after.reply == PageFailed implies after.returnedCursor == 0
pure def stepCatalogCursorOnlyReturnedFromFullRead(before: CatalogPaging, via: str, after: CatalogPaging): bool =
  via == "finishCatalogPage" and after.returnedCursor > 0 implies before.attempt.running and
    after.reply == PageReturned and after.issued == before.issued + 1
pure def sometimesCatalogPublishesContinuation(s: CatalogPaging): bool =
  s.reply == PageReturned and s.returnedCursor > 0
pure def sometimesPageRetainsInternalCursorAfterRefusal(s: CatalogPaging): bool =
  s.reply == PageFailed and s.returnedCursor == 0 and s.cursors.length() > 0
pure def sometimesPageRejectsOldCursor(s: CatalogPaging): bool = s.reply == PageRefused and s.start == StalePageCursor
```
