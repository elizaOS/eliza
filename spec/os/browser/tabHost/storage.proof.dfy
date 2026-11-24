lemma lawAnOlderAddressWriteDoesNotRecoverOldTitles_ensures(found: BookmarkRecord)
  ensures (lawAnOlderAddressWriteDoesNotRecoverOldTitles(found) == true)
{
  if found.titles.OlderTitles? {
    BookmarkFold([], found.urls);
    assert forall entry :: entry in storedBookmarkEntries(found) ==> entry.title.Untitled?;
  }
}

lemma readBookmarks_ensures(s: NativeBrowserStore, ticket: int, found: BookmarkRecord)
  ensures (inv(s) ==> canReadBookmarks(s, ticket) ==> alwaysBookmarksWithinLimit(readBookmarks(s, ticket, found)))
  ensures (inv(s) ==> canReadBookmarks(s, ticket) ==> alwaysClearingHoldsNoSavedSession(readBookmarks(s, ticket, found)))
  ensures (inv(s) ==> canReadBookmarks(s, ticket) ==> stepBoundSessionNeverChanges(s, readBookmarks(s, ticket, found)))
  ensures (inv(s) ==> canReadBookmarks(s, ticket) ==> stepDamagedBookmarksStayDamaged(s, readBookmarks(s, ticket, found)))
  ensures (inv(s) ==> canReadBookmarks(s, ticket) ==> stepClearedOnlyAfterSiteDataDeletion(s, readBookmarks(s, ticket, found)))
  ensures (inv(s) ==> canReadBookmarks(s, ticket) ==> stepClearKeepsBookmarks(s, "readBookmarks", readBookmarks(s, ticket, found)))
{
  if inv(s) && canReadBookmarks(s, ticket) && wholeBookmarks(found) {
    var titles := if found.titles.CurrentTitles? then found.titles.names else [];
    BookmarkFold(titles, found.urls);
    assert |storedBookmarkEntries(found)| == |found.urls|;
  }
}

lemma BookmarkFold(titles: seq<BookmarkName>, urls: seq<os__browser__address_WebAddress>)
  ensures |Std.Collections.Seq.FoldLeft((entries: seq<BookmarkEntry>, address: os__browser__address_WebAddress) => (entries + [BookmarkEntry(address.href, (if ((0 <= |entries|) && (|entries| < |titles|)) then titles[|entries|] else BookmarkName.Untitled))]), [], urls)| == |urls|
  ensures |titles| == 0 ==> (forall entry :: entry in Std.Collections.Seq.FoldLeft((entries: seq<BookmarkEntry>, address: os__browser__address_WebAddress) => (entries + [BookmarkEntry(address.href, (if ((0 <= |entries|) && (|entries| < |titles|)) then titles[|entries|] else BookmarkName.Untitled))]), [], urls) ==> entry.title.Untitled?)
  decreases |urls|
{
  if |urls| > 0 {
    var prefix := urls[..|urls| - 1];
    var address := urls[|urls| - 1];
    var add := (entries: seq<BookmarkEntry>, address: os__browser__address_WebAddress) => (entries + [BookmarkEntry(address.href, (if ((0 <= |entries|) && (|entries| < |titles|)) then titles[|entries|] else BookmarkName.Untitled))]);
    BookmarkFold(titles, prefix);
    ProofLib.FoldLeftAppend(add, [], prefix, address);
    assert urls == prefix + [address];
    var previous := Std.Collections.Seq.FoldLeft(add, [], prefix);
    assert |add(previous, address)| == |previous| + 1;
    if |titles| == 0 {
      var last := BookmarkEntry(address.href, BookmarkName.Untitled);
      assert add(previous, address) == previous + [last];
      forall entry | entry in add(previous, address)
        ensures entry.title.Untitled?
      {
        if entry != last {
          assert entry in previous;
        }
      }
    }
  }
}
