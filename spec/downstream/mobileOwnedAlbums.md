# Android custom Photos albums and membership custody

AlphaPhone `8d44dfe5` calls `AlphaPhotosPlugin.java`, which imports Eliza
`c518127a` through `PhotosPlugin`, `OwnedAlbums`, `OwnedMediaLibrary`,
`OwnedMediaSelection` and `PermittedMediaCatalog` in
`plugins/plugin-native-media/android/src/main/java/ai/eliza/plugins/media`.
The installed preferences are `alpha-owned-albums` with JSON key
`albums`. Grace's `DevicePhotosPlugin` at `48b43b9c` uses Eliza
`7743504b` through `PermittedPhotosPlugin` and its image-profile
`PhotoLibraryAccess`. It has no product custom-album bridge at that pin.
[Photo view review](./mobileDevicePhotos.md) owns agent admission to the
editor. [Photo permission epochs](./mobilePhotos.md) own the native
permission fence. This contract begins with exact native album arguments.

## Story: Change the album I reviewed without changing the underlying photo

### A change uses the listed album revision and current member revision

Custom albums need Android 11 or later. Each process has one album
write lock across plugin instances. Inside the lock, a closed bridge
refuses the request. Creation allocates a new opaque album ID and
requires the first member. There are at most 24 albums. The name is
trimmed and has 1–80 Java UTF-16 code units with no ISO controls.
Every other operation supplies the existing album ID and exact
listed album revision. Add and Create also supply the media key and
its current media revision. Owned media uses a positive photo ID or
a `v:` video key and requires an exact untrashed, published item in the
app's namespace. Permitted media uses the `m:` key and requires the
permitted catalog to read the exact revision. The store records the
item's stable identity rather than its changing mutation revision.
The host validates key codecs, owner and platform reads before
supplying the model's admission facts.

Membership holds at most 200 items. Add removes an existing member
of that key before appending the new exact member, so re-adding an
existing member is legal at capacity. Remove checks membership without
requiring the underlying file to still be accessible. Rename and
Delete apply only to this album. The updated document commits before
a saved or deleted reply. Each acknowledged write returns the album's
same ID and a fresh revision, including the deleted album. Album writes
change metadata and carry no MediaStore mutation. A rejected commit
does not confirm the previous disk state.

```quint
type AlbumOperation = CreateAlbum | AddAlbumItem | RemoveAlbumItem | RenameAlbum | DeleteAlbum
type MemberKind = OwnedItem | PermittedItem | InvalidItem
type MediaAdmission = { source: MemberKind, ownerExact: bool, accessible: bool, currentRevision: bool, stableIdentity: str }
type AlbumRequest = { operation: AlbumOperation, android11: bool, bridgeLive: bool, albumsCount: int,
  exactAlbum: bool, exactRevision: bool, validName: bool, memberCount: int, memberPresent: bool, media: MediaAdmission }
pure def addsMember(operation: AlbumOperation): bool = operation == CreateAlbum or operation == AddAlbumItem
pure def validAddedMedia(media: MediaAdmission): bool =
  (media.source == PermittedItem or (media.source == OwnedItem and media.ownerExact)) and
    media.accessible and media.currentRevision and media.stableIdentity != ""
pure def mayWriteAlbum(request: AlbumRequest): bool =
  request.android11 and request.bridgeLive and
    (if (request.operation == CreateAlbum) request.albumsCount >= 0 and request.albumsCount < 24 and request.validName
      else request.exactAlbum and request.exactRevision) and
    (if (addsMember(request.operation)) validAddedMedia(request.media) and request.memberCount >= 0 and
      (request.memberCount < 200 or (request.memberCount == 200 and request.memberPresent))
    else if (request.operation == RemoveAlbumItem) request.memberPresent
    else if (request.operation == RenameAlbum) request.validName else true)
pure val currentMedia: MediaAdmission = { source: OwnedItem, ownerExact: true, accessible: true, currentRevision: true, stableIdentity: "owned-row" }
pure val mediaValues = Set(currentMedia, { ...currentMedia, ownerExact: false },
  { ...currentMedia, source: PermittedItem, ownerExact: false }, { ...currentMedia, currentRevision: false })
pure val createsAlbum: AlbumRequest = { operation: CreateAlbum, android11: true, bridgeLive: true, albumsCount: 2,
  exactAlbum: false, exactRevision: false, validName: true, memberCount: 0, memberPresent: false, media: currentMedia }
pure val requestValues = Set(createsAlbum,
  { ...createsAlbum, operation: AddAlbumItem, exactAlbum: true, exactRevision: true, memberCount: 200, memberPresent: true },
  { ...createsAlbum, operation: AddAlbumItem, exactAlbum: true, exactRevision: true, memberCount: 200, memberPresent: false },
  { ...createsAlbum, operation: RemoveAlbumItem, exactAlbum: true, exactRevision: true, memberCount: 3, memberPresent: true },
  { ...createsAlbum, operation: DeleteAlbum, exactAlbum: true, exactRevision: false },
  { ...createsAlbum, media: { ...currentMedia, accessible: false } })
pure def lawExistingAlbumWriteRequiresExactRevision(request: AlbumRequest): bool =
  request.operation != CreateAlbum and mayWriteAlbum(request) implies request.exactAlbum and request.exactRevision
pure def lawNewMemberCannotGrowFullAlbum(request: AlbumRequest): bool =
  addsMember(request.operation) and request.memberCount >= 200 and not(request.memberPresent) implies not(mayWriteAlbum(request))
pure def lawAddedMediaCarriesAuthority(request: AlbumRequest): bool =
  addsMember(request.operation) and mayWriteAlbum(request) implies validAddedMedia(request.media)
pure def lawForeignOwnedItemCannotBecomeMember(media: MediaAdmission): bool =
  media.source == OwnedItem and not(media.ownerExact) implies not(validAddedMedia(media))
type AlbumAnswer = NoAlbumAnswer | AlbumSaved | AlbumDeleted | AlbumUnconfirmed
type AlbumWrite = { present: bool, revision: int, reviewed: int, pending: bool, operation: AlbumOperation, answer: AlbumAnswer }
pure val initial: AlbumWrite = { present: false, revision: 0, reviewed: 0, pending: false, operation: CreateAlbum, answer: NoAlbumAnswer }
pure def canAskAlbumWrite(s: AlbumWrite, request: AlbumRequest, capturedRevision: int): bool =
  not(s.pending) and mayWriteAlbum(request) and
    (if (request.operation == CreateAlbum) not(s.present) else s.present and capturedRevision == s.revision)
pure def askAlbumWrite(s: AlbumWrite, request: AlbumRequest, capturedRevision: int): AlbumWrite =
  { ...s, reviewed: s.revision, pending: true, operation: request.operation, answer: NoAlbumAnswer }
pure def canObserveCompetingAlbumCommit(s: AlbumWrite): bool = s.present
pure def observeCompetingAlbumCommit(s: AlbumWrite): AlbumWrite = { ...s, revision: s.revision + 1 }
pure def canSettleAlbumWrite(s: AlbumWrite): bool = s.pending
pure def settleAlbumWrite(s: AlbumWrite, commitAcknowledged: bool, bridgeLive: bool): AlbumWrite =
  if (not(commitAcknowledged and bridgeLive) or s.reviewed != s.revision)
    { ...s, pending: false, answer: AlbumUnconfirmed }
  else { ...s, present: s.operation != DeleteAlbum, revision: s.revision + 1, pending: false,
    answer: if (s.operation == DeleteAlbum) AlbumDeleted else AlbumSaved }
pure val capturedRevisionValues = Set(0, 1, 2, 3)
pure def alwaysAlbumCounterIsNonnegative(s: AlbumWrite): bool = s.revision >= 0 and s.reviewed >= 0
pure def stepAlbumSuccessRequiresExactReview(before: AlbumWrite, via: str, after: AlbumWrite): bool =
  via == "settleAlbumWrite" and (after.answer == AlbumSaved or after.answer == AlbumDeleted) implies
    before.pending and before.reviewed == before.revision and after.revision == before.revision + 1
pure def sometimesAlbumWriteAcknowledged(s: AlbumWrite): bool = s.present and s.answer == AlbumSaved
pure def sometimesAlbumWriteUnconfirmed(s: AlbumWrite): bool = s.answer == AlbumUnconfirmed
```

## Story: List only current album members under the current media fence

### Missing or replaced media is withheld without modifying album membership

A row is visible only while it is an active published item and its
current stable identity matches the stored member identity. An owned
row requires the same owner package and uses date added, size and
generation added as its identity. A permitted row must still be
readable. Inaccessible members remain in the album data. Counts
and member IDs reflect the visible rows. Listing takes the catalog's
permission fence before reading. Album summaries and mixed-album
metadata recheck the same fence before returning data or selecting
previews. Each permitted preview independently rechecks identity and
the item revision after obtaining the thumbnail. A failed mixed
preview is omitted from that reply and the page cursor still advances
through the projected metadata page.

The first page accepts an empty cursor. An owned-only album uses a
positive numeric cursor and lists newest MediaStore IDs first, strictly
below that cursor. Its item identity still gates inclusion. An album
with any permitted member uses the mixed cursor even when that
member is inaccessible. The cursor binds the exact album revision and
catalog fence identity, with an offset from zero to 200. Its metadata
sorts lexically by media key before choosing up to 24 rows. A mismatched
cursor is refused. Owned-only reads capture the fence but the pinned
`list` implementation does not recheck it in that branch. The host
keeps the two cursor codecs and permission checks distinct.

```quint
type MemberEvidence = { member: bool, exactIdentity: bool, publishedAndLive: bool, ownerExact: bool, currentlyPermitted: bool }
type CursorForm = FirstPage | OwnedCursor | MixedCursor | InvalidCursor
type AlbumCursor = { form: CursorForm, positiveId: bool, matchingAlbum: bool, matchingFence: bool, offset: int }
pure def visibleMember(source: MemberKind, facts: MemberEvidence): bool =
  facts.member and facts.exactIdentity and facts.publishedAndLive and
    (if (source == OwnedItem) facts.ownerExact else source == PermittedItem and facts.currentlyPermitted)
pure def admitsAlbumCursor(mixed: bool, cursor: AlbumCursor): bool =
  cursor.form == FirstPage or
    (if (mixed) cursor.form == MixedCursor and cursor.matchingAlbum and cursor.matchingFence and cursor.offset >= 0 and cursor.offset <= 200
      else cursor.form == OwnedCursor and cursor.positiveId)
pure def mixedPageEnd(offset: int, visibleRows: int): int =
  if (visibleRows - offset < 24) visibleRows else offset + 24
pure def permitsMixedPreview(catalogMetadataCurrent: bool, exactIdentity: bool, thumbnailReceived: bool, revisionRetained: bool): bool =
  catalogMetadataCurrent and exactIdentity and thumbnailReceived and revisionRetained
pure val factsValues = Set({ member: true, exactIdentity: true, publishedAndLive: true, ownerExact: true, currentlyPermitted: true },
  { member: true, exactIdentity: false, publishedAndLive: true, ownerExact: true, currentlyPermitted: false })
pure val cursorValues = Set({ form: FirstPage, positiveId: false, matchingAlbum: false, matchingFence: false, offset: 0 },
  { form: OwnedCursor, positiveId: true, matchingAlbum: false, matchingFence: false, offset: 0 },
  { form: MixedCursor, positiveId: false, matchingAlbum: true, matchingFence: true, offset: 24 },
  { form: MixedCursor, positiveId: false, matchingAlbum: true, matchingFence: false, offset: 24 })
pure def lawReplacedMediaIsHidden(source: MemberKind, facts: MemberEvidence): bool =
  not(facts.exactIdentity) implies not(visibleMember(source, facts))
pure def lawMixedNoninitialCursorBindsExactFence(cursor: AlbumCursor): bool =
  admitsAlbumCursor(true, cursor) and cursor.form != FirstPage implies cursor.matchingAlbum and cursor.matchingFence
pure def lawMixedPageUsesMetadataRows(offset: int, visibleRows: int): bool =
  offset >= 0 and offset <= visibleRows implies mixedPageEnd(offset, visibleRows) >= offset and mixedPageEnd(offset, visibleRows) - offset <= 24
```
