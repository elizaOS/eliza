lemma UniqueMailboxMessageFilter(s: MailboxFeed)
  ensures alwaysUniqueMessages(s) == (forall id :: id in s.messages ==> |ProofLib.Filter((other: string) => (other == id), s.messages)| == 1)
{}

lemma UniqueMailboxCursorFilter(s: MailboxFeed)
  ensures alwaysUniqueCursors(s) == (forall cursor :: cursor in s.seen ==> |ProofLib.Filter((other: string) => (other == cursor), s.seen)| == 1)
{}

lemma MailboxDistinctFromFilter(xs: seq<string>)
  requires forall id :: id in xs ==> |ProofLib.Filter((other: string) => (other == id), xs)| == 1
  ensures ProofLib.Distinct(xs)
{
  forall i, j | 0 <= i < j < |xs|
    ensures xs[i] != xs[j]
  {
    var id := xs[i];
    assert id in xs;
    if xs[i] == xs[j] {
      ProofLib.FilterTwo((other: string) => (other == id), xs, i, j);
    }
  }
}

lemma MailboxFilterFromDistinct(xs: seq<string>)
  requires ProofLib.Distinct(xs)
  ensures forall id :: id in xs ==> |ProofLib.Filter((other: string) => (other == id), xs)| == 1
{
  forall id | id in xs
    ensures |ProofLib.Filter((other: string) => (other == id), xs)| == 1
  {
    ProofLib.FilterDistinctCountOne((other: string) => (other == id), xs, id);
  }
}

lemma acceptPage_ensures(s: MailboxFeed, query: MailboxQuery, receiptLoad: int, pageToken: string, page: MailboxPage)
  ensures (inv(s) ==> canAcceptPage(s, query, receiptLoad, pageToken) ==> alwaysCursorWasObserved(acceptPage(s, query, receiptLoad, pageToken, page)))
  ensures (inv(s) ==> canAcceptPage(s, query, receiptLoad, pageToken) ==> alwaysUniqueMessages(acceptPage(s, query, receiptLoad, pageToken, page)))
  ensures (inv(s) ==> canAcceptPage(s, query, receiptLoad, pageToken) ==> alwaysUniqueCursors(acceptPage(s, query, receiptLoad, pageToken, page)))
  ensures (inv(s) ==> canAcceptPage(s, query, receiptLoad, pageToken) ==> alwaysDetachedMailboxEmpty(acceptPage(s, query, receiptLoad, pageToken, page)))
{
  if inv(s) && canAcceptPage(s, query, receiptLoad, pageToken) {
    var after := acceptPage(s, query, receiptLoad, pageToken, page);
    var prior := if pageToken != "" then s.messages else [];
    var oldCursors := if pageToken != "" then s.seen else [];
    UniqueMailboxMessageFilter(s);
    UniqueMailboxMessageFilter(after);
    UniqueMailboxCursorFilter(s);
    UniqueMailboxCursorFilter(after);
    MailboxDistinctFromFilter(s.messages);
    assert ProofLib.Distinct(prior);
    ProofLib.FoldLeftDedupDistinct((acc: seq<string>, id: string) => (if (id in acc) then acc else (acc + [id])), prior, page.messages);
    assert after.messages == uniqueAppend(prior, page.messages);
    MailboxFilterFromDistinct(after.messages);
    assert after.seen == oldCursors || after.seen == oldCursors + [page.nextCursor];
    if after.seen != oldCursors {
      assert !(page.nextCursor in oldCursors);
      forall item | item in after.seen
        ensures |ProofLib.Filter((other: string) => (other == item), after.seen)| == 1
      {
        ProofLib.FilterAppend((other: string) => (other == item), oldCursors, page.nextCursor);
        if item == page.nextCursor {
          ProofLib.FilterNone((other: string) => (other == item), oldCursors);
        } else {
          assert item in oldCursors;
        }
      }
    }
  }
}
