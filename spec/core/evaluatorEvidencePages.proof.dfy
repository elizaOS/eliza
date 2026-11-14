lemma PageScanWithoutCursor(ordered: seq<EvidenceRow>, cursor: string, initialScan: PageScan)
  requires !initialScan.reached
  requires !(exists row :: row in ordered && row.identity == cursor)
  ensures !Std.Collections.Seq.FoldLeft((scan: PageScan, row: EvidenceRow) => (if scan.reached then scan else (if (row.identity == cursor) then scan.(reached := true) else scan.(before := ([row] + scan.before)))), initialScan, ordered).reached
  decreases |ordered|
{
  reveal Std.Collections.Seq.FoldLeft();
  if |ordered| > 0 {
    assert ordered[0] in ordered;
    assert forall row :: row in ordered[1..] ==> row in ordered;
    var advanced := initialScan.(before := [ordered[0]] + initialScan.before);
    PageScanWithoutCursor(ordered[1..], cursor, advanced);
  }
}

lemma lawMissingCursorHasNoPage_ensures(ordered: seq<EvidenceRow>, cursor: string, maxBytes: int)
  ensures (lawMissingCursorHasNoPage(ordered, cursor, maxBytes) == true)
{
  if maxBytes > 0 && !(exists row :: row in ordered && row.identity == cursor) {
    PageScanWithoutCursor(ordered, cursor, emptyScan);
  }
}
