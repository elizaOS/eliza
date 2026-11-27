lemma FindStoppedFold(acc: int, rows: seq<HistoryRow>, turn: int)
  requires forall r :: r in rows ==> !(r.fromOwner && r.clientMessageId == turn)
  ensures Std.Collections.Seq.FoldLeft((found: int, r: HistoryRow) => (if (r.fromOwner && (r.clientMessageId == turn)) then r.message else found), acc, rows) == acc
  decreases |rows|
{
  if |rows| > 0 {
    assert rows[0] in rows;
    assert forall r :: r in rows[1..] ==> r in rows;
    FindStoppedFold(acc, rows[1..], turn);
  }
}

lemma lawNoRowMatchesWithoutTheSameId_ensures(rows: seq<HistoryRow>, turn: int)
  ensures (lawNoRowMatchesWithoutTheSameId(rows, turn) == true)
{
  if !(exists r :: r in rows && !((!(r.fromOwner) || (r.clientMessageId != turn)))) {
    FindStoppedFold(0, rows, turn);
  }
}
