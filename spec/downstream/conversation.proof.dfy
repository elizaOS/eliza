lemma StoppedSingleton(row: HistoryRow, seek: HistoryMatch)
  ensures rememberStopped([row], seek) ==
    (if stoppedRowMatches(seek.hasClientId && seek.clientId != "" && row.userRow && row.hasClientId, seek, row) then row.rowId else 0)
{
  var rows := [row];
  var byId := stoppedHistoryUsesId(rows, seek);
  assert (exists entry :: entry in [row] && entry.userRow && entry.hasClientId) == (row.userRow && row.hasClientId);
  assert byId == (seek.hasClientId && seek.clientId != "" && row.userRow && row.hasClientId);
  var add := (found: int, entry: HistoryRow) => if stoppedRowMatches(byId, seek, entry) then entry.rowId else found;
  assert rememberStopped(rows, seek) == Std.Collections.Seq.FoldLeft(add, 0, rows);
  calc {
    Std.Collections.Seq.FoldLeft(add, 0, rows);
    == { ProofLib.FoldLeftAppend(add, 0, [], row); }
    add(Std.Collections.Seq.FoldLeft(add, 0, []), row);
    == { reveal Std.Collections.Seq.FoldLeft(); }
    add(0, row);
  }
}

lemma lawDifferentIdentifiedUserDoesNotMatch_ensures(row: HistoryRow, seek: HistoryMatch)
  ensures (lawDifferentIdentifiedUserDoesNotMatch(row, seek) == true)
{
  StoppedSingleton(row, seek);
}

lemma lawLegacyRowNeedsText_ensures(row: HistoryRow, seek: HistoryMatch)
  ensures (lawLegacyRowNeedsText(row, seek) == true)
{
  StoppedSingleton(row, seek);
}
