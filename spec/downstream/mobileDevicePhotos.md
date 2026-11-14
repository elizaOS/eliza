# Alpha photo library and Photos view receipts

Alpha's `apps/app/src/runtime/photo-library.ts` re-exports Eliza's
pinned `photo-library-contract.ts`. The native adapter
`apps/app/src/prototype/photo-library-adapter.ts` also imports
`photos-view-contract.ts`. These contracts share opaque media IDs
and describe two separate capabilities. The pinned
`DevicePhotosFilter.qnt` checks reviewed proposal authority,
receipt identity, and explicit recovery from an uncertain result.
The [device execution journal](./mobileDeviceExecution.md) owns
claim and retry, while the [photo permission owner](./mobilePhotos.md)
fences access to actual media.

## Story: Filter or open the current Photos view with minimal disclosure

### Both capability grants and the current owner's request gate a direct view action

A Photos operation needs both `photos.library.v1` and
`photos.view.v1`, the nonsensitive Photos view, and a current
owner. Only filter and open can run directly when tied to the
owner's message. Album and share open review. Those receipts report
count and missing count, without promising a completed external
effect. Filter reports its count and whether there is more.
Open reports only whether it opened. The exact wire shapes exclude
file names, pixels, device paths and extra properties.

```quint
type PhotosOperation = FilterPhotos | OpenPhoto | CreateAlbum | SharePhotos
type PhotosContext = { libraryGrant: bool, viewGrant: bool, photosVisible: bool, sensitive: bool, requestCurrent: bool, ownerMessage: bool }
type PhotosActionReceipt = { operation: PhotosOperation, exactShape: bool, reviewOpened: bool, count: int, missing: int }
pure def permitsPhotosOperation(c: PhotosContext): bool =
  c.libraryGrant and c.viewGrant and c.photosVisible and not(c.sensitive) and c.requestCurrent
pure def permitsDirectPhotos(c: PhotosContext, operation: PhotosOperation): bool =
  permitsPhotosOperation(c) and c.ownerMessage and (operation == FilterPhotos or operation == OpenPhoto)
pure def validPhotosReceipt(operation: PhotosOperation, selected: int, r: PhotosActionReceipt): bool =
  r.operation == operation and r.exactShape and
  (if (operation == FilterPhotos) r.count >= 0 and not(r.reviewOpened)
  else if (operation == OpenPhoto) not(r.reviewOpened)
  else r.reviewOpened and r.count >= 1 and r.missing >= 0 and r.count + r.missing == selected)
pure val cValues = Set(
  {libraryGrant: true, viewGrant: true, photosVisible: true, sensitive: false, requestCurrent: true, ownerMessage: true},
  {libraryGrant: true, viewGrant: false, photosVisible: true, sensitive: false, requestCurrent: true, ownerMessage: true},
  {libraryGrant: true, viewGrant: true, photosVisible: true, sensitive: true, requestCurrent: true, ownerMessage: true},
  {libraryGrant: true, viewGrant: true, photosVisible: true, sensitive: false, requestCurrent: false, ownerMessage: true}
)
pure val rValues = Set(
  {operation: FilterPhotos, exactShape: true, reviewOpened: false, count: 0, missing: 0},
  {operation: OpenPhoto, exactShape: true, reviewOpened: false, count: 0, missing: 0},
  {operation: CreateAlbum, exactShape: true, reviewOpened: true, count: 1, missing: 1},
  {operation: SharePhotos, exactShape: true, reviewOpened: false, count: 2, missing: 0}
)
pure val selectedValues = Set(0, 1, 2)
pure def lawPhotosDirectRequiresBothGrants(c: PhotosContext, operation: PhotosOperation): bool =
  permitsDirectPhotos(c, operation) implies c.libraryGrant and c.viewGrant and c.ownerMessage and not(c.sensitive) and
    (operation == FilterPhotos or operation == OpenPhoto)
pure def lawPhotosMutationReceiptIsReviewOnly(operation: PhotosOperation, selected: int, r: PhotosActionReceipt): bool =
  validPhotosReceipt(operation, selected, r) and (operation == CreateAlbum or operation == SharePhotos) implies
    r.reviewOpened and r.count + r.missing == selected
```

## Story: Review the exact current media items before any library change

### Review freezes current revisions and carries a two-minute cutoff

Library search, inspect, and select are local. Search accepts
typed dates, media kind and a favorites flag with no filename
query. Its result may report metadata for at most 50 rows.
Inspect must return the exact opaque media ID. Select partitions
the requested IDs into selected and missing. A review accepts
1–20 unique IDs and corresponding opaque revisions for favorite,
unfavorite, trash or share. The native revision remains local.
When the host resolves the opaque revision, qualification requires
the exact current native row before Android may review the action.
The shared `reviewCurrent` predicate expires a prepared review
at two minutes. The pinned Alpha confirmation handler revalidates
rows and the live review object, but it does not call that expiry
predicate. The model keeps the shared cutoff separate from that
consumer-specific confirmation path.
A `review_opened` receipt shows that the review appeared and
carries the exact requested action and count. It grants no deletion,
share completion or access to the media bytes.

```quint
type LibraryAction = FavoriteItem | UnfavoriteItem | TrashItem | ShareItem
type LibraryReviewEvidence = {
  capability: bool, sameBinding: bool, decoded: bool, idsUnique: bool,
  selectionCount: int, revisionsKnown: bool, exactCurrentRows: bool,
  openedAt: int, checkedAt: int, libraryAction: LibraryAction
}
pure def exactLibraryRows(libraryReceipt: LibraryReviewEvidence): bool =
  libraryReceipt.capability and libraryReceipt.sameBinding and libraryReceipt.decoded and libraryReceipt.idsUnique and
  libraryReceipt.selectionCount >= 1 and libraryReceipt.selectionCount <= 20 and libraryReceipt.revisionsKnown and libraryReceipt.exactCurrentRows
pure def currentLibraryReview(libraryReceipt: LibraryReviewEvidence): bool =
  exactLibraryRows(libraryReceipt) and libraryReceipt.openedAt >= 0 and libraryReceipt.checkedAt >= libraryReceipt.openedAt and libraryReceipt.checkedAt < libraryReceipt.openedAt + 120000
pure def discloseLibraryReviewAllowed(libraryReceipt: LibraryReviewEvidence, libraryAction: LibraryAction, count: int, reviewOpened: bool): bool =
  exactLibraryRows(libraryReceipt) and reviewOpened and libraryAction == libraryReceipt.libraryAction and count == libraryReceipt.selectionCount
pure val libraryQualified: LibraryReviewEvidence = {
  capability: true, sameBinding: true, decoded: true, idsUnique: true,
  selectionCount: 2, revisionsKnown: true, exactCurrentRows: true, openedAt: 1, checkedAt: 1000, libraryAction: TrashItem
}
pure val libraryReceiptValues = Set(libraryQualified, {...libraryQualified, checkedAt: 120001}, {...libraryQualified, exactCurrentRows: false})
pure def lawLibraryReviewCannotUseStaleRows(libraryReceipt: LibraryReviewEvidence, libraryAction: LibraryAction, count: int, reviewOpened: bool): bool =
  discloseLibraryReviewAllowed(libraryReceipt, libraryAction, count, reviewOpened) implies
    libraryReceipt.revisionsKnown and libraryReceipt.exactCurrentRows
pure def lawSharedReviewCutoff(libraryReceipt: LibraryReviewEvidence): bool =
  currentLibraryReview(libraryReceipt) implies libraryReceipt.checkedAt < libraryReceipt.openedAt + 120000
pure val countValues = Set(0, 1, 2, 20, 21)
```

### A new native revision retires its old opaque token

The library adapter keeps a session-local opaque index. Reading
the same native item revision reuses its token. A changed native
revision issues a new token, and eviction removes the mapping.
The native revision stays in the device record and the model
can echo only the opaque token. The projection covers one
item's slot, with creation and eviction supplied by the
bounded map owner.

```quint
type OpaqueRevision = { known: bool, serial: int, nativeRevision: int, opaqueRevision: int }
pure val initial: OpaqueRevision = {known: false, serial: 0, nativeRevision: 0, opaqueRevision: 0}
pure def canObserveNativeRevision(s: OpaqueRevision, nativeRevision: int): bool = nativeRevision > 0
pure def observeNativeRevision(s: OpaqueRevision, nativeRevision: int): OpaqueRevision =
  if (s.known and s.nativeRevision == nativeRevision) s
  else {known: true, serial: s.serial + 1, nativeRevision: nativeRevision, opaqueRevision: s.serial + 1}
pure def canEvictRevision(s: OpaqueRevision): bool = s.known
pure def evictRevision(s: OpaqueRevision): OpaqueRevision = {...s, known: false, nativeRevision: 0, opaqueRevision: 0}
pure def resolveNativeRevision(s: OpaqueRevision, token: int): int =
  if (s.known and token == s.opaqueRevision) s.nativeRevision else 0
pure val tokenValues = Set(0, 1, 2, 3)
pure val nativeRevisionValues = Set(0, 1, 2, 3)
pure def alwaysOpaqueRevisionCoordinate(s: OpaqueRevision): bool =
  s.serial >= 0 and
  (if (s.known) s.nativeRevision > 0 and s.opaqueRevision > 0 and s.opaqueRevision == s.serial
   else s.nativeRevision == 0 and s.opaqueRevision == 0)
pure def stepReplacementRetiresOpaqueToken(before: OpaqueRevision, after: OpaqueRevision): bool =
  before.known and before.nativeRevision != after.nativeRevision implies resolveNativeRevision(after, before.opaqueRevision) == 0
pure def sometimesOpaqueRevisionResolved(s: OpaqueRevision): bool = s.known and s.serial > 1
```
