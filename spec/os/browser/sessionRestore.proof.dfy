lemma KeepTabsWithinCap(rows: seq<os__browser__storage_SavedTab>, tabs: seq<os__browser__storage_SavedTab>)
  requires |rows| <= os__browser__storage_maxSavedTabs
  ensures |Std.Collections.Seq.FoldLeft((rows: seq<os__browser__storage_SavedTab>, row: os__browser__storage_SavedTab) => os__browser__storage_keepTab(os__browser__storage_SessionCodec.RendererCodec, rows, row), rows, tabs)| <= os__browser__storage_maxSavedTabs
  decreases |tabs|
{
  if |tabs| > 0 {
    KeepTabsWithinCap(os__browser__storage_keepTab(os__browser__storage_SessionCodec.RendererCodec, rows, tabs[0]), tabs[1..]);
  }
}

lemma lawSnapshotKeepsAtMostTheTabLimit_ensures(history: seq<os__browser__storage_WebAddress>, candidates: seq<os__browser__storage_SavedTab>, preferred: string)
  ensures (lawSnapshotKeepsAtMostTheTabLimit(history, candidates, preferred) == true)
{
  var picked := Std.Collections.Seq.FoldLeft((rows: seq<os__browser__storage_SavedTab>, row: os__browser__storage_SavedTab) => appendSnapshotCandidate(rows, row), [], candidates);
  KeepTabsWithinCap([], picked);
}
