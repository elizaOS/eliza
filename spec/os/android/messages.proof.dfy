lemma lawNoClippedContentOrUnnamedReasonIsShown_ensures(listed: seq<ListedRow>, pageNext: PageNext, reasonNamed: bool, carriesContent: bool)
  ensures (lawNoClippedContentOrUnnamedReasonIsShown(listed, pageNext, reasonNamed, carriesContent) == true)
{
  if carriesContent || !reasonNamed {
    var bad := IncompleteRow(reasonNamed, carriesContent);
    assert bad in (listed + [bad]);
    assert !rowShown(bad);
  }
}
