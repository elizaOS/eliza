// spec/embeddings/index.md, "Vectors cover every index exactly once and share one width"
lemma EmbeddingRowFoldRequiresValidRows(acc: int, rows: seq<VectorObservation>, width: int)
  ensures acc < 0 ==> Std.Collections.Seq.FoldLeft((rowNumber: int, row: VectorObservation) => (if ((((rowNumber >= 0) && (row.inputIndex == rowNumber)) && (row.vectorWidth == width)) && row.finiteCoordinates) then (rowNumber + 1) else -1), acc, rows) < 0
  ensures Std.Collections.Seq.FoldLeft((rowNumber: int, row: VectorObservation) => (if ((((rowNumber >= 0) && (row.inputIndex == rowNumber)) && (row.vectorWidth == width)) && row.finiteCoordinates) then (rowNumber + 1) else -1), acc, rows) >= 0 ==> (acc >= 0 && forall row :: row in rows ==> row.vectorWidth == width && row.finiteCoordinates)
  decreases |rows|
{
  reveal Std.Collections.Seq.FoldLeft();
  var fn := (rowNumber: int, row: VectorObservation) => (if ((((rowNumber >= 0) && (row.inputIndex == rowNumber)) && (row.vectorWidth == width)) && row.finiteCoordinates) then (rowNumber + 1) else -1);
  if |rows| > 0 {
    var next := fn(acc, rows[0]);
    EmbeddingRowFoldRequiresValidRows(next, rows[1..], width);
    assert rows == [rows[0]] + rows[1..];
  }
}

lemma lawNonFiniteRowRefuses_ensures(rows: seq<VectorObservation>, inputCount: int, width: int)
  ensures (lawNonFiniteRowRefuses(rows, inputCount, width) == true)
{
  EmbeddingRowFoldRequiresValidRows(0, rows, width);
}

lemma lawWrongRowWidthRefuses_ensures(rows: seq<VectorObservation>, inputCount: int, width: int)
  ensures (lawWrongRowWidthRefuses(rows, inputCount, width) == true)
{
  EmbeddingRowFoldRequiresValidRows(0, rows, width);
}
