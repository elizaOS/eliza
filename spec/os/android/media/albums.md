# Android custom albums

The media bridge keeps device-local custom albums in one preference file
(`<namespace>-owned-albums`). An album stores each member's media key and
the stable identity the item had when it was added, never bytes or URIs.
A member is an owned item (a positive photo ID or a `v:` video key, an
untrashed, published row of the app's own package) or a permitted library
item (an `m:` key the photo catalog can read). Albums need Android 11 or
later; one process-wide lock serializes every album write, and a closed
bridge refuses a write inside it. Source: `OwnedAlbums.java`,
`OwnedMediaSelection.java` in `plugins/plugin-native-media`.

This machine holds the album document and the media library as the bridge
last read it. The shell reads MediaStore and the permitted catalog, trims
and checks names (1 to 80 UTF-16 code units, no ISO control characters),
allocates opaque IDs and revisions (the model numbers them from one
counter), and commits the document before it replies `saved` or `deleted`
with the album's ID and fresh revision. A commit that fails changes
nothing here.

## Story: Change an album only as listed

> As the person, I want an album edit to apply only to the album I saw
> listed, at the photo I saw, so that organizing never acts on stale
> information or changes a photo.

### A write names the listed album revision and an added item its current revision

Create, Add, Remove, Rename and Delete are the five writes. Create needs a
first member; every other write names an existing album and the exact
revision the person saw listed. Create and Add also name the item's current
mutation revision: the shell inspects the item, and only an item found
readable at that revision may join. The album keeps the item's stable
identity, not its mutation revision, so a later favorite or trash restore
does not withhold it. Remove needs the item to be a member, not readable.
A name must not be empty after trimming.

```quint
import rows.* from "./rows"
type MediaSource = OwnedMedia | PermittedMedia
type MediaRef = { key: int, source: MediaSource }
type Member = { media: MediaRef, identity: int }
type Album = { id: int, name: str, revision: int, members: List[Member] }
type MediaRow = { media: MediaRef, identity: int, revision: int, readable: bool }
type AlbumStore = { albums: List[Album], library: List[MediaRow], lastIssued: int, fence: int }
pure val initial: AlbumStore = { albums: List(), library: List(), lastIssued: 0, fence: 0 }
pure def mediaRowOf(media: MediaRef, s: AlbumStore): MediaRow =
  s.library.select(r => r.media == media).nthOr(0, { media: media, identity: 0, revision: 0, readable: false })
pure def inspectMedia(media: MediaRef, mediaRevision: int, s: AlbumStore): RowInspection = {
  val row = mediaRowOf(media, s)
  if (not(row.readable)) RowInspectFailed
  else if (row.revision != mediaRevision) RowChangedSinceListing
  else RowAtListing({ alreadyDesired: false })
}
pure def albumOf(albumId: int, s: AlbumStore): Album =
  s.albums.select(a => a.id == albumId).nthOr(0, { id: 0, name: "", revision: 0, members: List() })
pure def listedAlbum(albumId: int, listedRevision: int, s: AlbumStore): bool =
  s.albums.some(a => a.id == albumId and a.revision == listedRevision)
pure def withoutMember(members: List[Member], media: MediaRef): List[Member] = members.select(m => m.media != media)
pure def rewriteAlbum(albumId: int, changed: Album, s: AlbumStore): List[Album] =
  s.albums.listMap(a => if (a.id == albumId) changed else a)

pure def canCreateAlbum(s: AlbumStore, name: str, media: MediaRef, mediaRevision: int): bool =
  name != "" and s.albums.length() < albumCapacity and rowAtListing(inspectMedia(media, mediaRevision, s))
pure def createAlbum(s: AlbumStore, name: str, media: MediaRef, mediaRevision: int): AlbumStore =
  { ...s, lastIssued: s.lastIssued + 2, albums: s.albums.append({ id: s.lastIssued + 1, name: name,
    revision: s.lastIssued + 2, members: List({ media: media, identity: mediaRowOf(media, s).identity }) }) }
pure def canAddAlbumMember(s: AlbumStore, albumId: int, listedRevision: int, media: MediaRef, mediaRevision: int): bool =
  listedAlbum(albumId, listedRevision, s) and rowAtListing(inspectMedia(media, mediaRevision, s)) and
    withoutMember(albumOf(albumId, s).members, media).length() < memberCapacity
pure def addAlbumMember(s: AlbumStore, albumId: int, listedRevision: int, media: MediaRef, mediaRevision: int): AlbumStore = {
  val album = albumOf(albumId, s)
  val members = withoutMember(album.members, media).append({ media: media, identity: mediaRowOf(media, s).identity })
  { ...s, lastIssued: s.lastIssued + 1, albums: rewriteAlbum(albumId, { ...album, members: members, revision: s.lastIssued + 1 }, s) }
}
pure def canRemoveAlbumMember(s: AlbumStore, albumId: int, listedRevision: int, media: MediaRef): bool =
  listedAlbum(albumId, listedRevision, s) and albumOf(albumId, s).members.some(m => m.media == media)
pure def removeAlbumMember(s: AlbumStore, albumId: int, listedRevision: int, media: MediaRef): AlbumStore = {
  val album = albumOf(albumId, s)
  { ...s, lastIssued: s.lastIssued + 1,
    albums: rewriteAlbum(albumId, { ...album, members: withoutMember(album.members, media), revision: s.lastIssued + 1 }, s) }
}
pure def canRenameAlbum(s: AlbumStore, albumId: int, listedRevision: int, name: str): bool =
  listedAlbum(albumId, listedRevision, s) and name != ""
pure def renameAlbum(s: AlbumStore, albumId: int, listedRevision: int, name: str): AlbumStore =
  { ...s, lastIssued: s.lastIssued + 1, albums: rewriteAlbum(albumId, { ...albumOf(albumId, s), name: name, revision: s.lastIssued + 1 }, s) }
pure def canDeleteAlbum(s: AlbumStore, albumId: int, listedRevision: int): bool = listedAlbum(albumId, listedRevision, s)
pure def deleteAlbum(s: AlbumStore, albumId: int, listedRevision: int): AlbumStore =
  { ...s, lastIssued: s.lastIssued + 1, albums: s.albums.select(a => a.id != albumId) }
pure val nameValues = Set("", "Trips")
pure val mediaValues = Set({ key: 1, source: OwnedMedia }, { key: 2, source: OwnedMedia }, { key: 1, source: PermittedMedia })
pure val mediaRevisionValues = Set(1, 2)
pure val albumIdValues = Set(1, 3)
pure val listedRevisionValues = Set(2, 3, 4, 5)
pure def sometimesAlbumHoldsOwnedAndPermittedMedia(s: AlbumStore): bool =
  s.albums.some(a => a.members.some(m => m.media.source == OwnedMedia) and a.members.some(m => m.media.source == PermittedMedia))
pure def sometimesAlbumDeletedAfterUse(s: AlbumStore): bool = s.lastIssued >= 3 and s.albums.length() == 0
```

### Every changed album gets a revision newer than any issued before

A write that lists an old revision is refused, and a page cursor bound to
the old revision stops working. Deleting an album issues a revision too;
the reply carries it.

```quint
pure def stepChangedAlbumGetsFreshRevision(before: AlbumStore, after: AlbumStore): bool =
  after.lastIssued >= before.lastIssued and after.albums.every(a => before.albums.includes(a) or a.revision > before.lastIssued)
pure def alwaysIssuedValuesWithinCounter(s: AlbumStore): bool =
  s.lastIssued >= 0 and s.fence >= 0 and
    s.albums.every(a => a.id > 0 and a.id <= s.lastIssued and a.revision > 0 and a.revision <= s.lastIssued)
```

### There are at most 24 albums of at most 200 members, each key once

Add first removes a member with the same key, then appends the item at its
current identity, so adding an existing member again is allowed at
capacity and never duplicates it.

```quint
pure val albumCapacity = 24
pure val memberCapacity = 200
pure def alwaysAlbumsWithinCapacity(s: AlbumStore): bool =
  s.albums.length() <= albumCapacity and s.albums.every(a => a.members.length() <= memberCapacity)
pure def alwaysOneEntryPerKey(s: AlbumStore): bool =
  s.albums.every(a => s.albums.select(b => b.id == a.id).length() == 1 and
    a.members.every(m => a.members.select(n => n.media == m.media).length() == 1)) and
  s.library.every(r => s.library.select(q => q.media == r.media).length() == 1)
```

## Story: Keep album members I can no longer see

> As the person, I want an album to show only the members I may still see,
> without dropping the others, so that a revoked or replaced photo neither
> leaks nor disappears from the album for good.

### Missing, replaced or unreadable media is withheld but stays a member

A member is shown only while its item is readable and has the identity the
album stored. An owned item's identity is its date added, size and
MediaStore generation; replacing the original gives it a new identity.
Counts and member IDs reflect the shown members only, and the album
summary rechecks the catalog's permission fence before replying. The bridge sees the
library change by observing an item, its mutation revision moving, its
identity being replaced, or its readability changing (trash, unpublish, a
photo access change); a permitted readability change moves the catalog's
permission fence.

```quint
pure def visibleMember(member: Member, s: AlbumStore): bool =
  s.library.some(r => r.media == member.media and r.identity == member.identity and r.readable)
pure def visibleMembers(album: Album, s: AlbumStore): List[Member] = album.members.select(m => visibleMember(m, s))
pure def hasMediaRow(media: MediaRef, s: AlbumStore): bool = s.library.some(r => r.media == media)
pure def rewriteMediaRow(media: MediaRef, changed: MediaRow, s: AlbumStore): List[MediaRow] =
  s.library.listMap(r => if (r.media == media) changed else r)
pure def canObserveMedia(s: AlbumStore, media: MediaRef): bool = media.key > 0 and not(hasMediaRow(media, s))
pure def observeMedia(s: AlbumStore, media: MediaRef): AlbumStore =
  { ...s, library: s.library.append({ media: media, identity: 1, revision: 1, readable: true }) }
pure def canEditMedia(s: AlbumStore, media: MediaRef): bool = hasMediaRow(media, s)
pure def editMedia(s: AlbumStore, media: MediaRef): AlbumStore = {
  val row = mediaRowOf(media, s)
  { ...s, library: rewriteMediaRow(media, { ...row, revision: row.revision + 1 }, s) }
}
pure def canReplaceMedia(s: AlbumStore, media: MediaRef): bool = hasMediaRow(media, s)
pure def replaceMedia(s: AlbumStore, media: MediaRef): AlbumStore = {
  val row = mediaRowOf(media, s)
  { ...s, library: rewriteMediaRow(media, { ...row, identity: row.identity + 1, revision: row.revision + 1 }, s) }
}
pure def canSetMediaReadable(s: AlbumStore, media: MediaRef, readable: bool): bool =
  hasMediaRow(media, s) and mediaRowOf(media, s).readable != readable
pure def setMediaReadable(s: AlbumStore, media: MediaRef, readable: bool): AlbumStore =
  { ...s, library: rewriteMediaRow(media, { ...mediaRowOf(media, s), readable: readable }, s),
    fence: if (media.source == PermittedMedia) s.fence + 1 else s.fence }
pure def sometimesMemberWithheldBesideShownOne(s: AlbumStore): bool =
  s.albums.some(a => a.members.some(m => not(visibleMember(m, s))) and a.members.some(m => visibleMember(m, s)))
pure def sometimesMemberShownAfterItsRevisionMoved(s: AlbumStore): bool =
  s.albums.some(a => a.members.some(m => visibleMember(m, s) and mediaRowOf(m.media, s).revision >= 2))
```

### Media changes never change an album, and album writes never change media

```quint
pure def stepAlbumsAndMediaChangeApart(before: AlbumStore, after: AlbumStore): bool =
  after.albums == before.albums or (after.library == before.library and after.fence == before.fence)
```

### A mixed album page continues only from a cursor of its current album revision and fence

An album with any permitted member, readable or not, pages its shown
members sorted by media key, 24 per page, from an offset of 0 to 200; its
cursor binds the album revision and the catalog's permission fence, and
the listing rechecks the fence before returning metadata. Each permitted
preview rechecks its item afterwards, and a failed preview is left out of
that page while the cursor still advances. An owned-only album pages
newest MediaStore IDs first, strictly below a positive ID cursor. The
first page takes an empty cursor; a missing album or any other cursor is
refused.

```quint
type AlbumCursor = FirstAlbumPage | OwnedBefore({ mediaKey: int }) | MixedAt({ revision: int, fence: int, offset: int })
pure def mixedAlbum(album: Album): bool = album.members.some(m => m.media.source == PermittedMedia)
pure def admitsAlbumCursor(albumId: int, cursor: AlbumCursor, s: AlbumStore): bool = {
  val album = albumOf(albumId, s)
  s.albums.some(a => a.id == albumId) and match cursor {
    | FirstAlbumPage => true
    | OwnedBefore(c) => not(mixedAlbum(album)) and c.mediaKey > 0
    | MixedAt(c) => mixedAlbum(album) and c.revision == album.revision and c.fence == s.fence and c.offset >= 0 and c.offset <= memberCapacity
  }
}
pure def stepEarlierMixedCursorRefusedAfterChange(before: AlbumStore, after: AlbumStore): bool =
  before.albums.every(b => (albumOf(b.id, after) == b and after.fence == before.fence) or
    not(admitsAlbumCursor(b.id, MixedAt({ revision: b.revision, fence: before.fence, offset: 0 }), after)))
```
