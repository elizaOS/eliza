// Every package row comes from a contributing input: induction over the rows fold.
lemma RowsComeFromContributingInputs(f: (seq<PackageRow>, BundleInput) -> seq<PackageRow>, acc: seq<PackageRow>, xs: seq<BundleInput>, r: PackageRow)
  requires forall rows, i :: f(rows, i) == (if (inputDisposition(i).Contributes? && !((rowOf(i) in rows))) then (rows + [rowOf(i)]) else rows)
  ensures r in Std.Collections.Seq.FoldLeft(f, acc, xs) ==> r in acc || (exists i :: i in xs && inputDisposition(i).Contributes? && rowOf(i) == r)
  decreases |xs|
{
  if |xs| > 0 {
    RowsComeFromContributingInputs(f, f(acc, xs[0]), xs[1..], r);
    if r in Std.Collections.Seq.FoldLeft(f, f(acc, xs[0]), xs[1..]) && !(r in acc) && r in f(acc, xs[0]) {
      assert r == rowOf(xs[0]);
      assert xs[0] in xs;
    }
    if (exists i :: i in xs[1..] && inputDisposition(i).Contributes? && rowOf(i) == r) {
      var i :| i in xs[1..] && inputDisposition(i).Contributes? && rowOf(i) == r;
      assert i in xs;
    }
  }
}

lemma lawExcludedPackageNeverShips_ensures(b: Build, name: string)
  ensures (lawExcludedPackageNeverShips(b, name) == true)
{
  var f := (rows: seq<PackageRow>, i: BundleInput) => (if (inputDisposition(i).Contributes? && !((rowOf(i) in rows))) then (rows + [rowOf(i)]) else rows);
  if buildVerdict(b).Built? && name in b.excluded && (exists r :: r in packageRows(b) && r.name == name) {
    var r :| r in packageRows(b) && r.name == name;
    assert packageRows(b) == Std.Collections.Seq.FoldLeft(f, [], b.inputs);
    RowsComeFromContributingInputs(f, [], b.inputs, r);
    var i :| i in b.inputs && inputDisposition(i).Contributes? && rowOf(i) == r;
    assert contributesExcluded(b);
  }
}
