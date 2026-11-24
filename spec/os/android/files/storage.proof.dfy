// spec/os/android/files/storage.md, "A category count totals the sizes its files record, and a file without one adds nothing"

// Appending a row adds exactly the bytes that row counts.
lemma StorageCategoryBytesAppend(rows: seq<CategoryRow>, last: CategoryRow)
  ensures categoryBytes(rows + [last]) == categoryBytes(rows) + categoryRowBytes(last)
{
  forall f: (int, CategoryRow) -> int, init: int
    ensures Std.Collections.Seq.FoldLeft(f, init, rows + [last]) == f(Std.Collections.Seq.FoldLeft(f, init, rows), last)
  {
    ProofLib.FoldLeftAppend(f, init, rows, last);
  }
  ProofLib.FoldLeftAppend((total: int, counted: CategoryRow) => (total + categoryRowBytes(counted)), 0, rows, last);
}

// A row never counts below zero, so neither does the total of any rows.
lemma StorageCategoryBytesNatural(rows: seq<CategoryRow>)
  ensures categoryBytes(rows) >= 0
  decreases |rows|
{
  if |rows| > 0 {
    var front := rows[..|rows| - 1];
    assert rows == front + [rows[|rows| - 1]];
    StorageCategoryBytesAppend(front, rows[|rows| - 1]);
    StorageCategoryBytesNatural(front);
  }
}

lemma lawAnUnsizedRowAddsNothing_ensures(rows: seq<CategoryRow>)
  ensures (lawAnUnsizedRowAddsNothing(rows) == true)
{
  StorageCategoryBytesAppend(rows, unsizedRow);
}

lemma lawACategoryTotalIsNeverNegative_ensures(rows: seq<CategoryRow>)
  ensures (lawACategoryTotalIsNeverNegative(rows) == true)
{
  StorageCategoryBytesNatural(rows);
}

lemma lawASizedRowAddsItsSize_ensures(rows: seq<CategoryRow>)
  ensures (lawASizedRowAddsItsSize(rows) == true)
{
  StorageCategoryBytesAppend(rows, CategoryRow(true, 5));
}
