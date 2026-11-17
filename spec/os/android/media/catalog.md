# Permitted photos catalog

The person's permitted photos and videos, a page at a time, newest first,
for the Photos view and the agent's photo catalog alike. It models
`PermittedMediaCatalog.java` (`list`, `readTicket`, `requireReadTicket`,
`publish`, `invalidate`) and the read ticket that `PermittedPhotosPlugin`
captures, in `plugins/plugin-native-media/android`, and the publication
model `NativePhotosOwnership.qnt`. [Media tokens](./rows.md) give the
one-shot page cursors, and [keyset paging](../paging.md), imported as `Pg`,
gives the page order, the page and the lookahead. One serialized catalog
worker runs one page read at a time. The provider queries, the snapshot
digest, thumbnails and the main-thread post stay in the shell.

## Story: Page my photos without repeats

> As the person, I want to page through the photos and videos I allowed,
> newest first, so that each one appears once and only ones I permitted
> appear at all.

### A query applies the catalog's filters and provider bounds

A page holds 1 to 24 rows. The date window is inclusive and nonnegative
and filters on date added: the lower bound rounds up to provider seconds,
the upper bound rounds down. The search is at most 128 UTF-16 units with no
NUL; the shell trims it and matches it as a case-insensitive name
substring. All, Camera and Screenshots work everywhere, Favorites and Trash
only on Android 11 and later (`modern`). An image query reads no video
source, and the reverse; pending rows are never read.

```quint
import rows.* from "./rows"
import paging as Pg from "../paging"
type MediaKind = AllKinds | ImageKind | VideoKind
type CatalogFilter = AllMedia | FavoriteMedia | TrashMedia | CameraMedia | ScreenshotsMedia
type CatalogQuery = { kind: MediaKind, filter: CatalogFilter, fromMillis: int, toMillis: int, limit: int, search: str, searchUnits: int, hasNul: bool }
pure val maxCatalogPage = 24
pure val maxSearchUnits = 128
pure def filterSupported(modern: bool, filter: CatalogFilter): bool = modern or not(filter == FavoriteMedia or filter == TrashMedia)
pure def validCatalogQuery(modern: bool, query: CatalogQuery): bool =
  query.limit >= 1 and query.limit <= maxCatalogPage and query.fromMillis >= 0 and query.toMillis >= query.fromMillis and
    query.searchUnits >= 0 and query.searchUnits <= maxSearchUnits and not(query.hasNul) and filterSupported(modern, query.filter)
pure def readsSource(kind: MediaKind, video: bool, readable: bool): bool = readable and (if (video) kind != ImageKind else kind != VideoKind)
pure def dateLowerSeconds(millis: int): int = millis / 1000 + (if (millis % 1000 == 0) 0 else 1)
pure def dateUpperSeconds(millis: int): int = millis / 1000
pure val galleryQuery: CatalogQuery = { kind: AllKinds, filter: AllMedia, fromMillis: 0, toMillis: 10000, limit: 1, search: "", searchUnits: 0, hasNul: false }
pure val queryValues = Set(galleryQuery, { ...galleryQuery, filter: TrashMedia }, { ...galleryQuery, limit: 25 }, { ...galleryQuery, search: "beach", searchUnits: 5, hasNul: true })
pure val millisValues = Set(0, 1, 999, 1000, 1001, 7000)
pure def lawDateBoundsKeepTheMillisWindow(millis: int): bool =
  millis >= 0 implies (dateLowerSeconds(millis) * 1000 >= millis and (dateLowerSeconds(millis) - 1) * 1000 < millis and
    dateUpperSeconds(millis) * 1000 <= millis and millis < (dateUpperSeconds(millis) + 1) * 1000)
pure def lawOlderAndroidRefusesFavoritesAndTrash(query: CatalogQuery): bool =
  (query.filter == FavoriteMedia or query.filter == TrashMedia) implies not(validCatalogQuery(false, query))
```

### Rows follow one order: newest capture first, then source, then newest row

The capture time is `DATE_TAKEN`, or date added in milliseconds when it is
missing or zero. A source is one volume's images or videos: volumes sort
by name, at most 16, images before videos. The catalog key, in `Pg` page
order, is the negated capture time, the source and the negated MediaStore
ID. Each source is read below the last key with the native selection
`nativeAfter`, which is exactly `Pg::precedes`: an earlier source needs a
strictly older capture, a later source may share it, the same source at the
same time needs a smaller ID.

```quint
pure val maxMediaVolumes = 16
pure def captureTime(dateTaken: int, dateAddedSeconds: int): int = if (dateTaken == 0) dateAddedSeconds * 1000 else dateTaken
pure def sourceOrdinal(volumeIndex: int, video: bool): int = volumeIndex * 2 + (if (video) 1 else 0)
pure def catalogKey(shot: int, source: int, mediaId: int): Pg::RowKey = { major: 0 - shot, minor: source, rowId: 0 - mediaId }
pure def nativeAfter(shot: int, source: int, mediaId: int, lastShot: int, lastSource: int, lastId: int): bool =
  if (source < lastSource) shot < lastShot else if (source > lastSource) shot <= lastShot else (shot < lastShot or (shot == lastShot and mediaId < lastId))
pure val shotValues = Set(4999, 5000, 5001)
pure val lastShotValues = Set(5000)
pure val sourceValues = Set(0, 1, 2)
pure val lastSourceValues = Set(1)
pure val mediaIdValues = Set(6, 7, 8)
pure val lastIdValues = Set(7)
pure def lawNativeSelectionFollowsTheCatalogOrder(shot: int, source: int, mediaId: int, lastShot: int, lastSource: int, lastId: int): bool =
  nativeAfter(shot, source, mediaId, lastShot, lastSource, lastId) iff Pg::precedes(catalogKey(lastShot, lastSource, lastId), catalogKey(shot, source, mediaId))
pure def lawEachVolumeAndTypeIsItsOwnSource(volumeIndex: int, video: bool, otherIndex: int, otherVideo: bool): bool =
  (volumeIndex >= 0 and otherIndex >= 0 and (volumeIndex != otherIndex or video != otherVideo)) implies sourceOrdinal(volumeIndex, video) != sourceOrdinal(otherIndex, otherVideo)
```

### A continuation consumes its cursor before provider work and resumes only its own query and snapshot

A request captures the read ticket (the current epoch) on the calling
thread; a locked, background or closed owner is refused. The worker then
checks the ticket, the query and the volume count, which refuse without
touching the cursor table. A cursor is next taken out of the table, live
or not, and resumes only if it was live, was issued for the same query and
for the current snapshot: access, epoch and library generation. Any other
cursor is `StaleCursor`, which every caller reports so it can start over.

```quint
type CatalogSnapshot = { access: int, epoch: int, generation: int }
type CatalogCursor = { id: int, snapshot: CatalogSnapshot, query: CatalogQuery, last: Pg::RowKey }
type PageRefusal = InvalidQuery | StaleCursor | AccessRetired | LibraryChanged | LibraryUnavailable
type ReadPhase = NoRead | ReadQueued | ReadRunning | ReadPosted | ReadPublished | ReadRefused({ reason: PageRefusal })
type PageRead = { phase: ReadPhase, ticket: int, query: CatalogQuery, tokenId: int, start: Pg::PageStart, snapshot: CatalogSnapshot, next: int }
type CatalogPaging = { now: int, epoch: int, access: int, generation: int, foreground: bool, unlocked: bool, closed: bool,
  tokens: List[OneShotToken], cursors: List[CatalogCursor], lastCursorId: int, read: PageRead }
pure val noSnapshot: CatalogSnapshot = { access: 0, epoch: 0, generation: 0 }
pure val idleRead: PageRead = { phase: NoRead, ticket: 0, query: galleryQuery, tokenId: 0, start: Pg::FromFirst, snapshot: noSnapshot, next: 0 }
pure val initial: CatalogPaging = { now: 0, epoch: 0, access: 0, generation: 0, foreground: true, unlocked: true, closed: false,
  tokens: List(), cursors: List(), lastCursorId: 0, read: idleRead }
pure def ownerUsable(s: CatalogPaging): bool = s.foreground and s.unlocked and not(s.closed)
pure def currentSnapshot(s: CatalogPaging): CatalogSnapshot = { access: s.access, epoch: s.epoch, generation: s.generation }
pure def readBusy(phase: ReadPhase): bool = phase == ReadQueued or phase == ReadRunning or phase == ReadPosted
pure def canRequestPage(s: CatalogPaging): bool = not(readBusy(s.read.phase))
pure def requestPage(s: CatalogPaging, query: CatalogQuery, tokenId: int): CatalogPaging =
  { ...s, read: { ...idleRead, phase: if (ownerUsable(s)) ReadQueued else ReadRefused({ reason: AccessRetired }), ticket: s.epoch, query: query, tokenId: tokenId } }
pure val volumeCountValues = Set(1, 17)
pure def canBeginPage(s: CatalogPaging): bool = s.read.phase == ReadQueued
pure def beginPage(s: CatalogPaging, modern: bool, volumeCount: int): CatalogPaging = {
  val r = s.read
  val taken = takeToken(s.tokens, r.tokenId, s.now)
  val binding = s.cursors.select(c => c.id == r.tokenId)
  val bound = binding.nthOr(0, { id: 0, snapshot: noSnapshot, query: galleryQuery, last: Pg::noRow })
  val resumes = taken.live and binding.length() > 0 and bound.snapshot == currentSnapshot(s) and bound.query == r.query
  val consumed = { ...s, tokens: taken.left, cursors: s.cursors.select(c => c.id != r.tokenId) }
  if (not(ownerUsable(s)) or r.ticket != s.epoch) { ...s, read: { ...r, phase: ReadRefused({ reason: AccessRetired }) } }
  else if (not(validCatalogQuery(modern, r.query))) { ...s, read: { ...r, phase: ReadRefused({ reason: InvalidQuery }) } }
  else if (volumeCount < 0 or volumeCount > maxMediaVolumes) { ...s, read: { ...r, phase: ReadRefused({ reason: LibraryUnavailable }) } }
  else if (r.tokenId == 0) { ...s, read: { ...r, phase: ReadRunning, start: Pg::FromFirst, snapshot: currentSnapshot(s) } }
  else if (resumes) { ...consumed, read: { ...r, phase: ReadRunning, start: Pg::AfterRow({ last: bound.last }), snapshot: currentSnapshot(s) } }
  else { ...consumed, read: { ...r, phase: ReadRefused({ reason: StaleCursor }) } }
}
pure def stepContinuationConsumesItsCursorBeforeProviderWork(before: CatalogPaging, via: str, after: CatalogPaging): bool =
  (via == "beginPage" and before.read.tokenId != 0 and (after.read.phase == ReadRunning or after.read.phase == ReadRefused({ reason: StaleCursor }))) implies
    not(after.tokens.some(t => t.id == before.read.tokenId))
pure def stepContinuationResumesOnlyItsQueryAndSnapshot(before: CatalogPaging, via: str, after: CatalogPaging): bool =
  (via == "beginPage" and before.read.tokenId != 0 and after.read.phase == ReadRunning) implies
    (takeToken(before.tokens, before.read.tokenId, before.now).live and before.cursors.some(c => c.id == before.read.tokenId and
      c.snapshot == currentSnapshot(before) and c.query == before.read.query and after.read.start == Pg::AfterRow({ last: c.last })))
pure def stepEarlyRefusalLeavesTheCursorTable(before: CatalogPaging, via: str, after: CatalogPaging): bool =
  (via == "beginPage" and (after.read.phase == ReadRefused({ reason: AccessRetired }) or after.read.phase == ReadRefused({ reason: InvalidQuery }) or
    after.read.phase == ReadRefused({ reason: LibraryUnavailable }))) implies (after.tokens == before.tokens and after.cursors == before.cursors)
pure def sometimesStaleCursorRefused(s: CatalogPaging): bool = s.read.phase == ReadRefused({ reason: StaleCursor })
```

### A next cursor is issued only for a full page with a lookahead row and reaches the caller only with the published page

The provider rows are the query's rows in `Pg` order; out of order or a
failed query is `LibraryUnavailable` and issues nothing. When rows remain
after the page (`Pg::pageEnd`), the worker issues a fresh cursor for the
page's last row, live for two minutes in a table of at most 32, before the
final snapshot check. If that check finds the snapshot changed, the page
and its cursor are not posted, though the unexposed cursor may stay in
the table until it expires, is evicted or the table is cleared.

```quint
pure val cursorCapacity = 32
pure def canFinishPage(s: CatalogPaging): bool = s.read.phase == ReadRunning
pure def finishPage(s: CatalogPaging, providerRows: List[Pg::RowKey], providerOk: bool): CatalogPaging = {
  val r = s.read
  val ended = Pg::pageEnd("", providerRows, r.start, r.query.limit)
  val more = match ended { | Pg::MoreAfter(_) => true | Pg::EndOfRows => false }
  val last = match ended { | Pg::MoreAfter(m) => m.following.last | Pg::EndOfRows => Pg::noRow }
  val cursorId = s.lastCursorId + 1
  val issuedTokens = issueToken(s.tokens, s.now, cursorCapacity, cursorId, tokenLifetimeMs)
  val issued = { ...s, lastCursorId: cursorId, tokens: issuedTokens,
    cursors: s.cursors.select(c => issuedTokens.some(t => t.id == c.id)).append({ id: cursorId, snapshot: r.snapshot, query: r.query, last: last }) }
  val kept = if (more) issued else s
  if (not(providerOk) or not(Pg::inPageOrder(providerRows))) { ...s, read: { ...r, phase: ReadRefused({ reason: LibraryUnavailable }) } }
  else if (r.snapshot != currentSnapshot(s)) { ...kept, read: { ...r, phase: ReadRefused({ reason: LibraryChanged }) } }
  else { ...kept, read: { ...r, phase: ReadPosted, next: if (more) cursorId else 0 } }
}
pure val providerRowsValues = Set(List(), List({ major: 0, minor: 0, rowId: 1 }),
  List({ major: 0, minor: 0, rowId: 1 }, { major: 0, minor: 0, rowId: 2 }, { major: 0, minor: 1, rowId: 1 }),
  List({ major: 1, minor: 0, rowId: 0 }, { major: 0, minor: 0, rowId: 1 }))
pure def alwaysOnlyAPostedOrPublishedPageCarriesACursor(s: CatalogPaging): bool =
  s.read.next > 0 implies (s.read.phase == ReadPosted or s.read.phase == ReadPublished)
pure def stepNewCursorIsFreshAndHeld(before: CatalogPaging, via: str, after: CatalogPaging): bool =
  (via == "finishPage" and after.read.next > 0) implies
    (after.read.next == before.lastCursorId + 1 and after.lastCursorId == after.read.next and after.tokens.some(t => t.id == after.read.next))
pure def continued(start: Pg::PageStart): bool = match start { | Pg::AfterRow(_) => true | _ => false }
pure def sometimesPublishedPageOffersAContinuation(s: CatalogPaging): bool = s.read.phase == ReadPublished and s.read.next > 0
pure def sometimesNextPageContinuesAfterTheLastRow(s: CatalogPaging): bool = s.read.phase == ReadPublished and continued(s.read.start)
pure def sometimesUnexposedCursorKeptAfterLibraryChange(s: CatalogPaging): bool =
  s.read.phase == ReadRefused({ reason: LibraryChanged }) and s.tokens.length() > 0
pure val weight_requestPage = 4
pure val weight_beginPage = 4
pure val weight_finishPage = 4
pure val weight_publishPage = 4
```

## Story: Stop reads when my photo access changes

> As the person, I want a photo shown only while the access that let the
> app read it still holds, so that revoking access, leaving the app or
> locking the phone hides it at once.

### A scope change or lifecycle retirement advances the permission epoch and clears the cursor table

A changed access answer, an explicit invalidation (a library change seen by
the observer), leaving or reentering the foreground, screen-off and closing
each advance the epoch once and clear every cursor. Unlocking does not
revive anything. An unobserved row change moves the library generation,
which no cursor survives either. The clock is Android's elapsed clock.

```quint
pure val retiringEvents = Set("changeScope", "invalidateCatalog", "pauseCatalog", "resumeCatalog", "lockCatalog", "closeCatalog")
pure def canTick(s: CatalogPaging, observedClock: int): bool = observedClock > s.now
pure def tick(s: CatalogPaging, observedClock: int): CatalogPaging = { ...s, now: observedClock }
pure val observedClockValues = Set(1, 120000, 120001, 240002)
pure def canChangeScope(s: CatalogPaging, access: int): bool = not(s.closed) and access != s.access
pure def changeScope(s: CatalogPaging, access: int): CatalogPaging = { ...s, access: access, epoch: s.epoch + 1, tokens: List(), cursors: List() }
pure val accessValues = Set(0, 1)
pure def changeLibrary(s: CatalogPaging): CatalogPaging = { ...s, generation: s.generation + 1 }
pure def invalidateCatalog(s: CatalogPaging): CatalogPaging = { ...s, epoch: s.epoch + 1, tokens: List(), cursors: List() }
pure def canPauseCatalog(s: CatalogPaging): bool = s.foreground and not(s.closed)
pure def pauseCatalog(s: CatalogPaging): CatalogPaging = { ...s, foreground: false, epoch: s.epoch + 1, tokens: List(), cursors: List() }
pure def canResumeCatalog(s: CatalogPaging): bool = not(s.foreground) and not(s.closed)
pure def resumeCatalog(s: CatalogPaging): CatalogPaging = { ...s, foreground: true, epoch: s.epoch + 1, tokens: List(), cursors: List() }
pure def canLockCatalog(s: CatalogPaging): bool = s.unlocked
pure def lockCatalog(s: CatalogPaging): CatalogPaging = { ...s, unlocked: false, epoch: s.epoch + 1, tokens: List(), cursors: List() }
pure def canUnlockCatalog(s: CatalogPaging): bool = not(s.unlocked)
pure def unlockCatalog(s: CatalogPaging): CatalogPaging = { ...s, unlocked: true }
pure def canCloseCatalog(s: CatalogPaging): bool = not(s.closed)
pure def closeCatalog(s: CatalogPaging): CatalogPaging = { ...s, closed: true, epoch: s.epoch + 1, tokens: List(), cursors: List() }
pure def stepRetirementAdvancesTheEpochAndClearsCursors(before: CatalogPaging, via: str, after: CatalogPaging): bool =
  retiringEvents.contains(via) implies (after.epoch == before.epoch + 1 and after.tokens == List() and after.cursors == List())
pure def stepEpochNeverGoesBack(before: CatalogPaging, after: CatalogPaging): bool = after.epoch >= before.epoch
```

### A page is posted and published only under the epoch that admitted it

The worker refuses a queued read whose ticket is older than the epoch; the
final check refuses a running read whose snapshot moved; the main thread
refuses a posted page, with its cursor, unless the owner is usable and the
ticket is still the epoch, even if the original access has come back.

Discovered by the proof: the ticket is never ahead of the epoch, a held
cursor id was issued, and the table stays within its capacity.

```quint
pure def canPublishPage(s: CatalogPaging): bool = s.read.phase == ReadPosted
pure def publishPage(s: CatalogPaging): CatalogPaging =
  if (ownerUsable(s) and s.read.ticket == s.epoch) { ...s, read: { ...s.read, phase: ReadPublished } }
  else { ...s, read: { ...s.read, phase: ReadRefused({ reason: AccessRetired }), next: 0 } }
pure def alwaysCatalogCountersAreConsistent(s: CatalogPaging): bool =
  s.epoch >= 0 and s.read.ticket >= 0 and s.read.ticket <= s.epoch and s.read.next >= 0 and s.read.next <= s.lastCursorId and
    s.tokens.length() <= cursorCapacity and s.tokens.every(t => t.id >= 1 and t.id <= s.lastCursorId)
pure def stepPageIsPostedOnlyOnItsAdmittingSnapshot(before: CatalogPaging, via: str, after: CatalogPaging): bool =
  (via == "finishPage" and after.read.phase == ReadPosted) implies (before.read.snapshot == currentSnapshot(before) and before.read.ticket == before.epoch)
pure def stepPublishedPageHoldsItsAdmittingEpoch(before: CatalogPaging, via: str, after: CatalogPaging): bool =
  (via == "publishPage" and after.read.phase == ReadPublished) implies (ownerUsable(before) and before.read.ticket == before.epoch)
pure def sometimesOlderEpochReadRevoked(s: CatalogPaging): bool =
  s.read.phase == ReadRefused({ reason: AccessRetired }) and s.read.ticket < s.epoch
```
