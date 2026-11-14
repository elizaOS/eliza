# Native Photos catalog window

Alpha `8d44dfe52` installs the Photos renderer in
`apps/app/src/prototype/camera-adapter.ts`. Its live catalog refresh
imports `readWindow`, `mergeWindow`, `newestFirst`, `keepThumbnails`
and `thumbnailPlan` from Eliza `c518127a`'s
`packages/ui/src/mobile-shell/photos-view.ts`.
[Native photo permission epochs](../mobilePhotos.md) owns native
admission and delivery. This window additionally gates renderer
publication and preserves the resident catalog across refresh.

## Story: Scroll through my current photo library and refresh without losing the loaded window

### One current access and page reader owns every catalog publication

A visible, installed renderer starts one read. It reads native access
before requesting rows. A read captures the generation at start, and
checks the generation and page visibility after each await. Leaving
the Photos view while the document remains visible can leave the
catalog read active. Hiding the document invalidates any active read,
including its first access request, and clears catalog rows and cursor.
Disposal also clears rows. Only the current read can publish a failure.
A request during either read phase coalesces into one full refresh.
The next refresh starts in a microtask after the previous read releases
its loading slot. It rechecks document visibility before starting.
Availability failure can report Open Gallery without a native read.

The model tracks one serialized request, a pending rerun, and the row
count and cursor of the committed catalog. A later rule supplies the data
projection and limits. Native access scope and all row payloads are
ports. Current summary results use a separate generation, so an old
summary failure leaves the newer count intact.

```quint
type CatalogFlight = Ready | AccessRead | PageRead
type Catalog = { hidden: bool, disposed: bool, epoch: int, ticket: int, flight: CatalogFlight,
  loaded: bool, count: int, nextCursor: str, more: bool, rerun: bool, errorVisible: bool }
pure val initial: Catalog = { hidden: false, disposed: false, epoch: 0, ticket: 0, flight: Ready,
  loaded: false, count: 0, nextCursor: "", more: false, rerun: false, errorVisible: false }
pure val countValues = Set(0, 1, 100, 2000, 2001)
pure def liveCatalog(s: Catalog): bool = not(s.hidden or s.disposed)
pure def ownsCatalog(s: Catalog): bool = liveCatalog(s) and s.ticket == s.epoch
pure def openRead(more: bool, s: Catalog): Catalog =
  { ...s, epoch: s.epoch + 1, ticket: s.epoch + 1, flight: AccessRead, more: more, rerun: false }
pure def canRequestCatalog(s: Catalog): bool = liveCatalog(s)
pure def requestCatalog(s: Catalog, more: bool, available: bool): Catalog =
  if (s.flight != Ready) { ...s, rerun: true }
  else if (not(available)) { ...s, loaded: true, errorVisible: true, rerun: false }
  else openRead(if (s.rerun) false else more, s)
pure def canRunQueuedRefresh(s: Catalog): bool = s.flight == Ready and s.rerun
pure def runQueuedRefresh(s: Catalog, available: bool): Catalog =
  if (not(liveCatalog(s))) { ...s, rerun: false }
  else requestCatalog(s, false, available)
pure def finishRead(failed: bool, s: Catalog): Catalog =
  if (failed and ownsCatalog(s)) { ...s, flight: Ready, loaded: true, errorVisible: true }
  else { ...s, flight: Ready }
pure def canSettleAccess(s: Catalog): bool = s.flight == AccessRead
pure def settleAccess(s: Catalog, success: bool): Catalog =
  if (success and ownsCatalog(s)) { ...s, flight: PageRead } else finishRead(not(success), s)
pure def canSettlePage(s: Catalog): bool = s.flight == PageRead
pure def clampCatalogCount(count: int): int = if (count > 2000) 2000 else if (count < 0) 0 else count
pure def settlePage(s: Catalog, success: bool, finished: bool, count: int, nextCursor: str): Catalog =
  if (not(ownsCatalog(s))) finishRead(false, s)
  else if (not(success) or count < 0) finishRead(true, s)
  else if (finished) { ...s, flight: Ready, loaded: true, count: clampCatalogCount(count), nextCursor: nextCursor, errorVisible: false }
  else s
pure def canHideCatalog(s: Catalog): bool = liveCatalog(s)
pure def hideCatalog(s: Catalog): Catalog =
  { ...s, hidden: true, epoch: s.epoch + 1, count: 0, nextCursor: "", loaded: false }
pure def canShowCatalog(s: Catalog): bool = s.hidden and not(s.disposed)
pure def showCatalog(s: Catalog): Catalog = { ...s, hidden: false, loaded: false }
pure def canDisposeCatalog(s: Catalog): bool = not(s.disposed)
pure def disposeCatalog(s: Catalog): Catalog = { ...s, disposed: true, count: 0, nextCursor: "", rerun: false }
pure def summaryMayPublish(disposed: bool, currentEpoch: int, replyEpoch: int): bool =
  not(disposed) and currentEpoch == replyEpoch
pure def lawOldSummaryPreservesCurrent(disposed: bool, currentEpoch: int, replyEpoch: int): bool =
  currentEpoch != replyEpoch implies not(summaryMayPublish(disposed, currentEpoch, replyEpoch))
pure def alwaysRetiredCatalogHasNoRows(s: Catalog): bool = not(liveCatalog(s)) implies s.count == 0 and s.nextCursor == ""
pure def alwaysCatalogBounded(s: Catalog): bool = s.count >= 0 and s.count <= 2000
pure def alwaysCatalogEpoch(s: Catalog): bool = s.epoch >= 0 and s.ticket >= 0 and s.ticket <= s.epoch
pure def stepStaleReplyCannotPublish(before: Catalog, via: str, after: Catalog): bool =
  (via == "settleAccess" or via == "settlePage") and not(ownsCatalog(before)) implies
  after.count == before.count and after.nextCursor == before.nextCursor and after.loaded == before.loaded and after.errorVisible == before.errorVisible
pure def stepOneCatalogFlight(before: Catalog, via: str, after: Catalog): bool =
  via == "requestCatalog" and before.flight != Ready implies
  after.flight == before.flight and after.ticket == before.ticket and after.rerun
pure def sometimesCatalogHasRows(s: Catalog): bool = s.count > 0
pure def sometimesRefreshIsQueued(s: Catalog): bool = s.rerun and s.flight != Ready
pure val weight_requestCatalog = 3
pure val weight_settleAccess = 3
pure val weight_settlePage = 4
```

### Reload retains the loaded depth and appending replaces duplicate identities

Loading more makes one request from the supplied cursor. A full reload
starts without a cursor and reads until the previous row count is
reached, with a target of at least one and a cap of 2,000, or until
the provider cursor is exhausted. An empty first page with a cursor
can continue. A repeated cursor is refused when another request for
it would be issued. Only requests after accumulated rows suppress
thumbnail transport. The merged append uses the last page row for
a duplicate identity, sorts by descending capture time, then by
descending string identity, and keeps the newest 2,000. Positive
`taken` wins over `date`. Reload sorts and caps the new list and then
retains compatible existing thumbnails. Order compares the actual
string IDs in the host, including their common `native-camera-` prefix.
The model represents that string tie order by an ordered rank.

```quint
pure def reloadTarget(loadedCount: int): int =
  if (loadedCount < 1) 1 else if (loadedCount > 2000) 2000 else loadedCount
pure def continueReload(more: bool, nextCursor: str, accumulated: int, loadedCount: int): bool =
  not(more) and nextCursor != "" and accumulated < reloadTarget(loadedCount)
pure def allowsNextCursor(visited: Set[str], nextCursor: str): bool = not(visited.contains(nextCursor))
pure def asksForThumbnails(more: bool, accumulated: int): bool = more or accumulated == 0
pure def captureTime(taken: int, dated: int): int = if (taken > 0) taken else dated
pure def sortsAhead(takenA: int, dateA: int, identityA: int, takenB: int, dateB: int, identityB: int): bool =
  captureTime(takenA, dateA) > captureTime(takenB, dateB) or
  (captureTime(takenA, dateA) == captureTime(takenB, dateB) and identityA > identityB)
pure def lawRepeatedCursorRefused(visited: Set[str], nextCursor: str): bool =
  visited.contains(nextCursor) implies not(allowsNextCursor(visited, nextCursor))
pure def lawNoSecondAppendPage(nextCursor: str, accumulated: int, loadedCount: int): bool =
  not(continueReload(true, nextCursor, accumulated, loadedCount))
pure def lawReloadTargetBounded(loadedCount: int): bool = reloadTarget(loadedCount) >= 1 and reloadTarget(loadedCount) <= 2000
pure def lawOversizedWindowIsCapped(count: int): bool = count >= 2000 implies clampCatalogCount(count) == 2000
```

### Thumbnail reuse requires the same media identity and revisions

A reload reuses saved pixels only when the new row has no pixels and
the previous row with that ID has pixels and exactly the same row,
mutation and content revisions. Missing revisions compare equal when
missing on both sides. An existing fresh image wins. The viewport plan
keeps the rendered span and a symmetric margin from a target of 240,
clamped by visible row bounds; it can keep a larger rendered span.
It requests missing images only within the rendered range. Native
requests coalesce after 120 ms and issue up to 24 selected IDs per
bridge call. Album cover images get their own retention path.
Unrequested IDs are ignored and a failed request leaves a retryable
placeholder. Publication requires the same catalog and photo-read
generations and active Photos owner, the document visible, and the
correct grid or cover surface. The viewport and active-owner checks
belong to the renderer and are stricter than its resident catalog
publication checks.

```quint
type ThumbMatch = { missing: bool, oldHasImage: bool, sameIdentity: bool, sameRevision: bool, sameMutation: bool, sameContent: bool }
type ThumbRead = { live: bool, sameCatalogEpoch: bool, samePhotoEpoch: bool, sameOwner: bool, correctSurface: bool, requested: bool, missing: bool }
pure val thumbMatchValues = Set(
  { missing: true, oldHasImage: true, sameIdentity: true, sameRevision: true, sameMutation: true, sameContent: true },
  { missing: true, oldHasImage: true, sameIdentity: true, sameRevision: true, sameMutation: true, sameContent: false },
  { missing: false, oldHasImage: true, sameIdentity: true, sameRevision: true, sameMutation: true, sameContent: true }
)
pure val thumbReadValues = Set(
  { live: true, sameCatalogEpoch: true, samePhotoEpoch: true, sameOwner: true, correctSurface: true, requested: true, missing: true },
  { live: true, sameCatalogEpoch: false, samePhotoEpoch: true, sameOwner: true, correctSurface: true, requested: true, missing: true },
  { live: true, sameCatalogEpoch: true, samePhotoEpoch: true, sameOwner: true, correctSurface: true, requested: false, missing: true }
)
pure def reusesThumbnail(thumbMatch: ThumbMatch): bool =
  thumbMatch.missing and thumbMatch.oldHasImage and thumbMatch.sameIdentity and thumbMatch.sameRevision and thumbMatch.sameMutation and thumbMatch.sameContent
pure def publishesThumbnail(thumbRead: ThumbRead): bool =
  thumbRead.live and thumbRead.sameCatalogEpoch and thumbRead.samePhotoEpoch and thumbRead.sameOwner and
  thumbRead.correctSurface and thumbRead.requested and thumbRead.missing
pure def lawChangedPixelRevisionNeverReuses(thumbMatch: ThumbMatch): bool =
  not(thumbMatch.sameRevision and thumbMatch.sameMutation and thumbMatch.sameContent) implies not(reusesThumbnail(thumbMatch))
pure def lawUnrequestedThumbnailNeverAppears(thumbRead: ThumbRead): bool =
  not(thumbRead.requested) implies not(publishesThumbnail(thumbRead))
```

The pinned `PhotosWindow.qnt` and
`test/quint-photos-window.test.mjs` drive the real renderer and
shared helpers with controlled native access, list and summary ports.
They cover stale access and page results, coalescing, order, duplicate
replacement, disposal and late summary failure. The original
`test/photos-view.test.mjs` and `test/photos-thumbnail-refresh.test.mjs`
exercise window and thumbnail rules without real Android media.
