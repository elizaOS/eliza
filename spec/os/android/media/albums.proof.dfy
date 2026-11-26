lemma FilterLenLe<T>(p: T -> bool, xs: seq<T>)
  ensures |ProofLib.Filter(p, xs)| <= |xs|
  decreases |xs|
{
  if |xs| == 0 {
    ProofLib.FilterNil(p, xs);
  } else {
    ProofLib.FilterCons(p, xs);
    FilterLenLe(p, xs[1..]);
  }
}

lemma AlbumsDistinctIff(albums: seq<Album>)
  ensures (forall a :: a in albums ==> |ProofLib.Filter((b: Album) => (b.id == a.id), albums)| == 1) <==> ProofLib.DistinctBy(albums, ((a: Album) => a.id))
{
  if forall a :: a in albums ==> |ProofLib.Filter((b: Album) => (b.id == a.id), albums)| == 1 {
    forall i, j | 0 <= i < |albums| && 0 <= j < |albums| && i != j
      ensures ((a: Album) => a.id)(albums[i]) != ((a: Album) => a.id)(albums[j])
    {
      ProofLib.FilterCountOneIffUnique((b: Album) => (b.id == albums[i].id), albums, ((a: Album) => a.id), i);
    }
  }
  if ProofLib.DistinctBy(albums, ((a: Album) => a.id)) {
    forall a | a in albums
      ensures |ProofLib.Filter((b: Album) => (b.id == a.id), albums)| == 1
    {
      var i :| 0 <= i < |albums| && albums[i] == a;
      ProofLib.FilterOne((b: Album) => (b.id == a.id), albums, i);
    }
  }
}

lemma MembersDistinctIff(members: seq<Member>)
  ensures (forall m :: m in members ==> |ProofLib.Filter((n: Member) => (n.media == m.media), members)| == 1) <==> ProofLib.DistinctBy(members, ((m: Member) => m.media))
{
  if forall m :: m in members ==> |ProofLib.Filter((n: Member) => (n.media == m.media), members)| == 1 {
    forall i, j | 0 <= i < |members| && 0 <= j < |members| && i != j
      ensures ((m: Member) => m.media)(members[i]) != ((m: Member) => m.media)(members[j])
    {
      ProofLib.FilterCountOneIffUnique((n: Member) => (n.media == members[i].media), members, ((m: Member) => m.media), i);
    }
  }
  if ProofLib.DistinctBy(members, ((m: Member) => m.media)) {
    forall m | m in members
      ensures |ProofLib.Filter((n: Member) => (n.media == m.media), members)| == 1
    {
      var i :| 0 <= i < |members| && members[i] == m;
      ProofLib.FilterOne((n: Member) => (n.media == m.media), members, i);
    }
  }
}

lemma LibraryDistinctIff(library: seq<MediaRow>)
  ensures (forall r :: r in library ==> |ProofLib.Filter((q: MediaRow) => (q.media == r.media), library)| == 1) <==> ProofLib.DistinctBy(library, ((r: MediaRow) => r.media))
{
  if forall r :: r in library ==> |ProofLib.Filter((q: MediaRow) => (q.media == r.media), library)| == 1 {
    forall i, j | 0 <= i < |library| && 0 <= j < |library| && i != j
      ensures ((r: MediaRow) => r.media)(library[i]) != ((r: MediaRow) => r.media)(library[j])
    {
      ProofLib.FilterCountOneIffUnique((q: MediaRow) => (q.media == library[i].media), library, ((r: MediaRow) => r.media), i);
    }
  }
  if ProofLib.DistinctBy(library, ((r: MediaRow) => r.media)) {
    forall r | r in library
      ensures |ProofLib.Filter((q: MediaRow) => (q.media == r.media), library)| == 1
    {
      var i :| 0 <= i < |library| && library[i] == r;
      ProofLib.FilterOne((q: MediaRow) => (q.media == r.media), library, i);
    }
  }
}

lemma AlbumOfMatches(s: AlbumStore, albumId: int, a: Album)
  requires ProofLib.DistinctBy(s.albums, ((a: Album) => a.id))
  requires a in s.albums && a.id == albumId
  ensures albumOf(albumId, s) == a
{
  var i :| 0 <= i < |s.albums| && s.albums[i] == a;
  var f := ProofLib.Filter((x: Album) => (x.id == albumId), s.albums);
  ProofLib.FilterOne((x: Album) => (x.id == albumId), s.albums, i);
  ProofLib.FilterMember((x: Album) => (x.id == albumId), s.albums, a);
  assert a in f;
  assert f[0] == a;
}

lemma MediaRowOfMatches(s: AlbumStore, media: MediaRef, r: MediaRow)
  requires ProofLib.DistinctBy(s.library, ((r: MediaRow) => r.media))
  requires r in s.library && r.media == media
  ensures mediaRowOf(media, s) == r
{
  var i :| 0 <= i < |s.library| && s.library[i] == r;
  var f := ProofLib.Filter((x: MediaRow) => (x.media == media), s.library);
  ProofLib.FilterOne((x: MediaRow) => (x.media == media), s.library, i);
  ProofLib.FilterMember((x: MediaRow) => (x.media == media), s.library, r);
  assert r in f;
  assert f[0] == r;
}

lemma RewriteAlbumProperties(s: AlbumStore, albumId: int, changed: Album)
  requires ProofLib.DistinctBy(s.albums, ((a: Album) => a.id))
  requires exists a :: a in s.albums && a.id == albumId
  requires changed.id == albumId
  ensures var res := rewriteAlbum(albumId, changed, s);
    |res| == |s.albums| &&
    ProofLib.DistinctBy(res, ((a: Album) => a.id)) &&
    changed in res &&
    (forall b :: b in s.albums && b.id != albumId ==> b in res) &&
    (forall a :: a in res ==> a == changed || (a in s.albums && a.id != albumId))
{
  var res := rewriteAlbum(albumId, changed, s);
  assert |res| == |s.albums|;
  forall i | 0 <= i < |res|
    ensures res[i].id == s.albums[i].id
  {
  }
  var found :| found in s.albums && found.id == albumId;
  var wi :| 0 <= wi < |s.albums| && s.albums[wi] == found;
  assert res[wi] == changed;
  forall b | b in s.albums && b.id != albumId
    ensures b in res
  {
    var bi :| 0 <= bi < |s.albums| && s.albums[bi] == b;
    assert res[bi] == b;
  }
}

lemma RewriteMediaRowProperties(s: AlbumStore, media: MediaRef, changed: MediaRow)
  requires ProofLib.DistinctBy(s.library, ((r: MediaRow) => r.media))
  requires changed.media == media
  ensures var res := rewriteMediaRow(media, changed, s);
    |res| == |s.library| &&
    ProofLib.DistinctBy(res, ((r: MediaRow) => r.media))
{
  var res := rewriteMediaRow(media, changed, s);
  forall i | 0 <= i < |res|
    ensures res[i].media == s.library[i].media
  {
  }
}

lemma MixedCursorAfterAlbumRewrite(before: AlbumStore, after: AlbumStore, albumId: int, changed: Album)
  requires inv(before)
  requires after.albums == rewriteAlbum(albumId, changed, before)
  requires after.fence == before.fence
  requires changed.id == albumId && changed.revision > before.lastIssued
  requires exists a :: a in before.albums && a.id == albumId
  ensures stepEarlierMixedCursorRefusedAfterChange(before, after)
{
  AlbumsDistinctIff(before.albums);
  RewriteAlbumProperties(before, albumId, changed);
  forall b | b in before.albums
    ensures (albumOf(b.id, after) == b && after.fence == before.fence) || !admitsAlbumCursor(b.id, MixedAt(b.revision, before.fence, 0), after)
  {
    if b.id == albumId {
      AlbumOfMatches(after, b.id, changed);
      assert changed.revision != b.revision;
    } else {
      AlbumOfMatches(after, b.id, b);
    }
  }
}

lemma createAlbum_ensures(s: AlbumStore, name: string, media: MediaRef, mediaRevision: int)
  ensures (inv(s) ==> canCreateAlbum(s, name, media, mediaRevision) ==> alwaysIssuedValuesWithinCounter(createAlbum(s, name, media, mediaRevision)))
  ensures (inv(s) ==> canCreateAlbum(s, name, media, mediaRevision) ==> alwaysAlbumsWithinCapacity(createAlbum(s, name, media, mediaRevision)))
  ensures (inv(s) ==> canCreateAlbum(s, name, media, mediaRevision) ==> alwaysOneEntryPerKey(createAlbum(s, name, media, mediaRevision)))
  ensures (inv(s) ==> canCreateAlbum(s, name, media, mediaRevision) ==> stepChangedAlbumGetsFreshRevision(s, createAlbum(s, name, media, mediaRevision)))
  ensures (inv(s) ==> canCreateAlbum(s, name, media, mediaRevision) ==> stepAlbumsAndMediaChangeApart(s, createAlbum(s, name, media, mediaRevision)))
  ensures (inv(s) ==> canCreateAlbum(s, name, media, mediaRevision) ==> stepEarlierMixedCursorRefusedAfterChange(s, createAlbum(s, name, media, mediaRevision)))
{
  if inv(s) && canCreateAlbum(s, name, media, mediaRevision) {
    var after := createAlbum(s, name, media, mediaRevision);
    var created := Album(s.lastIssued + 1, name, s.lastIssued + 2, [Member(media, mediaRowOf(media, s).identity)]);
    assert after.albums == s.albums + [created];
    AlbumsDistinctIff(s.albums);
    ProofLib.DistinctByConcat(s.albums, [created], ((a: Album) => a.id));
    AlbumsDistinctIff(after.albums);
    MembersDistinctIff(created.members);
    forall b | b in s.albums
      ensures albumOf(b.id, after) == b
    {
      AlbumOfMatches(after, b.id, b);
    }
  }
}

lemma addAlbumMember_ensures(s: AlbumStore, albumId: int, listedRevision: int, media: MediaRef, mediaRevision: int)
  ensures (inv(s) ==> canAddAlbumMember(s, albumId, listedRevision, media, mediaRevision) ==> alwaysIssuedValuesWithinCounter(addAlbumMember(s, albumId, listedRevision, media, mediaRevision)))
  ensures (inv(s) ==> canAddAlbumMember(s, albumId, listedRevision, media, mediaRevision) ==> alwaysAlbumsWithinCapacity(addAlbumMember(s, albumId, listedRevision, media, mediaRevision)))
  ensures (inv(s) ==> canAddAlbumMember(s, albumId, listedRevision, media, mediaRevision) ==> alwaysOneEntryPerKey(addAlbumMember(s, albumId, listedRevision, media, mediaRevision)))
  ensures (inv(s) ==> canAddAlbumMember(s, albumId, listedRevision, media, mediaRevision) ==> stepChangedAlbumGetsFreshRevision(s, addAlbumMember(s, albumId, listedRevision, media, mediaRevision)))
  ensures (inv(s) ==> canAddAlbumMember(s, albumId, listedRevision, media, mediaRevision) ==> stepAlbumsAndMediaChangeApart(s, addAlbumMember(s, albumId, listedRevision, media, mediaRevision)))
  ensures (inv(s) ==> canAddAlbumMember(s, albumId, listedRevision, media, mediaRevision) ==> stepEarlierMixedCursorRefusedAfterChange(s, addAlbumMember(s, albumId, listedRevision, media, mediaRevision)))
{
  if inv(s) && canAddAlbumMember(s, albumId, listedRevision, media, mediaRevision) {
    var after := addAlbumMember(s, albumId, listedRevision, media, mediaRevision);
    AlbumsDistinctIff(s.albums);
    var orig :| orig in s.albums && orig.id == albumId && orig.revision == listedRevision;
    AlbumOfMatches(s, albumId, orig);
    var without := ProofLib.Filter((m: Member) => (m.media != media), orig.members);
    assert without == withoutMember(orig.members, media);
    MembersDistinctIff(orig.members);
    ProofLib.FilterKeepsDistinctBy((m: Member) => (m.media != media), orig.members, ((m: Member) => m.media));
    var added := Member(media, mediaRowOf(media, s).identity);
    forall m | m in without
      ensures m.media != added.media
    {
      ProofLib.FilterMember((x: Member) => (x.media != media), orig.members, m);
    }
    var newMembers := without + [added];
    ProofLib.DistinctByConcat(without, [added], ((m: Member) => m.media));
    MembersDistinctIff(newMembers);
    var changed := orig.(members := newMembers, revision := s.lastIssued + 1);
    RewriteAlbumProperties(s, albumId, changed);
    AlbumsDistinctIff(after.albums);
    MixedCursorAfterAlbumRewrite(s, after, albumId, changed);
  }
}

lemma removeAlbumMember_ensures(s: AlbumStore, albumId: int, listedRevision: int, media: MediaRef)
  ensures (inv(s) ==> canRemoveAlbumMember(s, albumId, listedRevision, media) ==> alwaysIssuedValuesWithinCounter(removeAlbumMember(s, albumId, listedRevision, media)))
  ensures (inv(s) ==> canRemoveAlbumMember(s, albumId, listedRevision, media) ==> alwaysAlbumsWithinCapacity(removeAlbumMember(s, albumId, listedRevision, media)))
  ensures (inv(s) ==> canRemoveAlbumMember(s, albumId, listedRevision, media) ==> alwaysOneEntryPerKey(removeAlbumMember(s, albumId, listedRevision, media)))
  ensures (inv(s) ==> canRemoveAlbumMember(s, albumId, listedRevision, media) ==> stepChangedAlbumGetsFreshRevision(s, removeAlbumMember(s, albumId, listedRevision, media)))
  ensures (inv(s) ==> canRemoveAlbumMember(s, albumId, listedRevision, media) ==> stepAlbumsAndMediaChangeApart(s, removeAlbumMember(s, albumId, listedRevision, media)))
  ensures (inv(s) ==> canRemoveAlbumMember(s, albumId, listedRevision, media) ==> stepEarlierMixedCursorRefusedAfterChange(s, removeAlbumMember(s, albumId, listedRevision, media)))
{
  if inv(s) && canRemoveAlbumMember(s, albumId, listedRevision, media) {
    var after := removeAlbumMember(s, albumId, listedRevision, media);
    AlbumsDistinctIff(s.albums);
    var orig :| orig in s.albums && orig.id == albumId && orig.revision == listedRevision;
    AlbumOfMatches(s, albumId, orig);
    var without := ProofLib.Filter((m: Member) => (m.media != media), orig.members);
    assert without == withoutMember(orig.members, media);
    FilterLenLe((m: Member) => (m.media != media), orig.members);
    MembersDistinctIff(orig.members);
    ProofLib.FilterKeepsDistinctBy((m: Member) => (m.media != media), orig.members, ((m: Member) => m.media));
    MembersDistinctIff(without);
    var changed := orig.(members := without, revision := s.lastIssued + 1);
    RewriteAlbumProperties(s, albumId, changed);
    AlbumsDistinctIff(after.albums);
    MixedCursorAfterAlbumRewrite(s, after, albumId, changed);
  }
}

lemma renameAlbum_ensures(s: AlbumStore, albumId: int, listedRevision: int, name: string)
  ensures (inv(s) ==> canRenameAlbum(s, albumId, listedRevision, name) ==> alwaysIssuedValuesWithinCounter(renameAlbum(s, albumId, listedRevision, name)))
  ensures (inv(s) ==> canRenameAlbum(s, albumId, listedRevision, name) ==> alwaysAlbumsWithinCapacity(renameAlbum(s, albumId, listedRevision, name)))
  ensures (inv(s) ==> canRenameAlbum(s, albumId, listedRevision, name) ==> alwaysOneEntryPerKey(renameAlbum(s, albumId, listedRevision, name)))
  ensures (inv(s) ==> canRenameAlbum(s, albumId, listedRevision, name) ==> stepChangedAlbumGetsFreshRevision(s, renameAlbum(s, albumId, listedRevision, name)))
  ensures (inv(s) ==> canRenameAlbum(s, albumId, listedRevision, name) ==> stepAlbumsAndMediaChangeApart(s, renameAlbum(s, albumId, listedRevision, name)))
  ensures (inv(s) ==> canRenameAlbum(s, albumId, listedRevision, name) ==> stepEarlierMixedCursorRefusedAfterChange(s, renameAlbum(s, albumId, listedRevision, name)))
{
  if inv(s) && canRenameAlbum(s, albumId, listedRevision, name) {
    var after := renameAlbum(s, albumId, listedRevision, name);
    AlbumsDistinctIff(s.albums);
    var orig :| orig in s.albums && orig.id == albumId && orig.revision == listedRevision;
    AlbumOfMatches(s, albumId, orig);
    var changed := orig.(name := name, revision := s.lastIssued + 1);
    RewriteAlbumProperties(s, albumId, changed);
    AlbumsDistinctIff(after.albums);
    MixedCursorAfterAlbumRewrite(s, after, albumId, changed);
  }
}

lemma deleteAlbum_ensures(s: AlbumStore, albumId: int, listedRevision: int)
  ensures (inv(s) ==> canDeleteAlbum(s, albumId, listedRevision) ==> alwaysIssuedValuesWithinCounter(deleteAlbum(s, albumId, listedRevision)))
  ensures (inv(s) ==> canDeleteAlbum(s, albumId, listedRevision) ==> alwaysAlbumsWithinCapacity(deleteAlbum(s, albumId, listedRevision)))
  ensures (inv(s) ==> canDeleteAlbum(s, albumId, listedRevision) ==> alwaysOneEntryPerKey(deleteAlbum(s, albumId, listedRevision)))
  ensures (inv(s) ==> canDeleteAlbum(s, albumId, listedRevision) ==> stepChangedAlbumGetsFreshRevision(s, deleteAlbum(s, albumId, listedRevision)))
  ensures (inv(s) ==> canDeleteAlbum(s, albumId, listedRevision) ==> stepAlbumsAndMediaChangeApart(s, deleteAlbum(s, albumId, listedRevision)))
  ensures (inv(s) ==> canDeleteAlbum(s, albumId, listedRevision) ==> stepEarlierMixedCursorRefusedAfterChange(s, deleteAlbum(s, albumId, listedRevision)))
{
  if inv(s) && canDeleteAlbum(s, albumId, listedRevision) {
    var after := deleteAlbum(s, albumId, listedRevision);
    assert after.albums == ProofLib.Filter((a: Album) => (a.id != albumId), s.albums);
    FilterLenLe((a: Album) => (a.id != albumId), s.albums);
    AlbumsDistinctIff(s.albums);
    ProofLib.FilterKeepsDistinctBy((a: Album) => (a.id != albumId), s.albums, ((a: Album) => a.id));
    AlbumsDistinctIff(after.albums);
    forall a | a in after.albums
      ensures a in s.albums && a.id != albumId
    {
      ProofLib.FilterMember((x: Album) => (x.id != albumId), s.albums, a);
    }
    forall b | b in s.albums
      ensures (albumOf(b.id, after) == b && after.fence == s.fence) || !admitsAlbumCursor(b.id, MixedAt(b.revision, s.fence, 0), after)
    {
      if b.id != albumId {
        ProofLib.FilterMember((x: Album) => (x.id != albumId), s.albums, b);
        AlbumOfMatches(after, b.id, b);
      }
    }
  }
}

lemma observeMedia_ensures(s: AlbumStore, media: MediaRef)
  ensures (inv(s) ==> canObserveMedia(s, media) ==> alwaysIssuedValuesWithinCounter(observeMedia(s, media)))
  ensures (inv(s) ==> canObserveMedia(s, media) ==> alwaysAlbumsWithinCapacity(observeMedia(s, media)))
  ensures (inv(s) ==> canObserveMedia(s, media) ==> alwaysOneEntryPerKey(observeMedia(s, media)))
  ensures (inv(s) ==> canObserveMedia(s, media) ==> stepChangedAlbumGetsFreshRevision(s, observeMedia(s, media)))
  ensures (inv(s) ==> canObserveMedia(s, media) ==> stepAlbumsAndMediaChangeApart(s, observeMedia(s, media)))
  ensures (inv(s) ==> canObserveMedia(s, media) ==> stepEarlierMixedCursorRefusedAfterChange(s, observeMedia(s, media)))
{
  if inv(s) && canObserveMedia(s, media) {
    var after := observeMedia(s, media);
    var row := MediaRow(media, 1, 1, true);
    LibraryDistinctIff(s.library);
    ProofLib.DistinctByConcat(s.library, [row], ((r: MediaRow) => r.media));
    LibraryDistinctIff(after.library);
    AlbumsDistinctIff(s.albums);
    forall b | b in s.albums
      ensures albumOf(b.id, after) == b
    {
      AlbumOfMatches(after, b.id, b);
    }
  }
}

lemma editMedia_ensures(s: AlbumStore, media: MediaRef)
  ensures (inv(s) ==> canEditMedia(s, media) ==> alwaysIssuedValuesWithinCounter(editMedia(s, media)))
  ensures (inv(s) ==> canEditMedia(s, media) ==> alwaysAlbumsWithinCapacity(editMedia(s, media)))
  ensures (inv(s) ==> canEditMedia(s, media) ==> alwaysOneEntryPerKey(editMedia(s, media)))
  ensures (inv(s) ==> canEditMedia(s, media) ==> stepChangedAlbumGetsFreshRevision(s, editMedia(s, media)))
  ensures (inv(s) ==> canEditMedia(s, media) ==> stepAlbumsAndMediaChangeApart(s, editMedia(s, media)))
  ensures (inv(s) ==> canEditMedia(s, media) ==> stepEarlierMixedCursorRefusedAfterChange(s, editMedia(s, media)))
{
  if inv(s) && canEditMedia(s, media) {
    var after := editMedia(s, media);
    LibraryDistinctIff(s.library);
    var orig :| orig in s.library && orig.media == media;
    MediaRowOfMatches(s, media, orig);
    RewriteMediaRowProperties(s, media, orig.(revision := orig.revision + 1));
    LibraryDistinctIff(after.library);
    AlbumsDistinctIff(s.albums);
    forall b | b in s.albums
      ensures albumOf(b.id, after) == b
    {
      AlbumOfMatches(after, b.id, b);
    }
  }
}

lemma replaceMedia_ensures(s: AlbumStore, media: MediaRef)
  ensures (inv(s) ==> canReplaceMedia(s, media) ==> alwaysIssuedValuesWithinCounter(replaceMedia(s, media)))
  ensures (inv(s) ==> canReplaceMedia(s, media) ==> alwaysAlbumsWithinCapacity(replaceMedia(s, media)))
  ensures (inv(s) ==> canReplaceMedia(s, media) ==> alwaysOneEntryPerKey(replaceMedia(s, media)))
  ensures (inv(s) ==> canReplaceMedia(s, media) ==> stepChangedAlbumGetsFreshRevision(s, replaceMedia(s, media)))
  ensures (inv(s) ==> canReplaceMedia(s, media) ==> stepAlbumsAndMediaChangeApart(s, replaceMedia(s, media)))
  ensures (inv(s) ==> canReplaceMedia(s, media) ==> stepEarlierMixedCursorRefusedAfterChange(s, replaceMedia(s, media)))
{
  if inv(s) && canReplaceMedia(s, media) {
    var after := replaceMedia(s, media);
    LibraryDistinctIff(s.library);
    var orig :| orig in s.library && orig.media == media;
    MediaRowOfMatches(s, media, orig);
    RewriteMediaRowProperties(s, media, orig.(identity := orig.identity + 1, revision := orig.revision + 1));
    LibraryDistinctIff(after.library);
    AlbumsDistinctIff(s.albums);
    forall b | b in s.albums
      ensures albumOf(b.id, after) == b
    {
      AlbumOfMatches(after, b.id, b);
    }
  }
}

lemma setMediaReadable_ensures(s: AlbumStore, media: MediaRef, readable: bool)
  ensures (inv(s) ==> canSetMediaReadable(s, media, readable) ==> alwaysIssuedValuesWithinCounter(setMediaReadable(s, media, readable)))
  ensures (inv(s) ==> canSetMediaReadable(s, media, readable) ==> alwaysAlbumsWithinCapacity(setMediaReadable(s, media, readable)))
  ensures (inv(s) ==> canSetMediaReadable(s, media, readable) ==> alwaysOneEntryPerKey(setMediaReadable(s, media, readable)))
  ensures (inv(s) ==> canSetMediaReadable(s, media, readable) ==> stepChangedAlbumGetsFreshRevision(s, setMediaReadable(s, media, readable)))
  ensures (inv(s) ==> canSetMediaReadable(s, media, readable) ==> stepAlbumsAndMediaChangeApart(s, setMediaReadable(s, media, readable)))
  ensures (inv(s) ==> canSetMediaReadable(s, media, readable) ==> stepEarlierMixedCursorRefusedAfterChange(s, setMediaReadable(s, media, readable)))
{
  if inv(s) && canSetMediaReadable(s, media, readable) {
    var after := setMediaReadable(s, media, readable);
    LibraryDistinctIff(s.library);
    var orig :| orig in s.library && orig.media == media;
    MediaRowOfMatches(s, media, orig);
    RewriteMediaRowProperties(s, media, orig.(readable := readable));
    LibraryDistinctIff(after.library);
    AlbumsDistinctIff(s.albums);
    forall b | b in s.albums
      ensures (albumOf(b.id, after) == b && after.fence == s.fence) || !admitsAlbumCursor(b.id, MixedAt(b.revision, s.fence, 0), after)
    {
      if !media.source.PermittedMedia? {
        AlbumOfMatches(after, b.id, b);
      }
    }
  }
}
