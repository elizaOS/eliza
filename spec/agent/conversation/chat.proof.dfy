lemma PageFilters(history: seq<HistoryRow>, cursor: PageCursor, limit: int)
  ensures olderRows(history, cursor) == ProofLib.Filter((r: HistoryRow) => olderThanCursor(r, cursor), history)
  ensures pageRows(history, cursor, limit) == ProofLib.Filter((r: HistoryRow) => (|Std.Collections.Seq.Filter((x: HistoryRow) => precedesRow(r, x), olderRows(history, cursor))| < limit), olderRows(history, cursor))
{
}

lemma lawPageHoldsOnlyOlderMessages_ensures(history: seq<HistoryRow>, cursor: PageCursor, limit: int)
  ensures (lawPageHoldsOnlyOlderMessages(history, cursor, limit) == true)
{
  PageFilters(history, cursor, limit);
  forall r | r in pageRows(history, cursor, limit)
    ensures olderThanCursor(r, cursor)
  {
    ProofLib.FilterMember((r: HistoryRow) => (|Std.Collections.Seq.Filter((x: HistoryRow) => precedesRow(r, x), olderRows(history, cursor))| < limit), olderRows(history, cursor), r);
    ProofLib.FilterMember((r: HistoryRow) => olderThanCursor(r, cursor), history, r);
  }
}
