lemma lawPairUsesFourBytes_ensures(high: int, low: int)
  ensures (lawPairUsesFourBytes(high, low) == true)
{
  if highSurrogate(high) && lowSurrogate(low) {
    Utf8TwoUnits(high, low);
  }
}

lemma lawLoneHighUsesReplacement_ensures(high: int)
  ensures (lawLoneHighUsesReplacement(high) == true)
{
  if highSurrogate(high) {
    Utf8OneUnit(high);
  }
}

lemma lawLoneLowUsesReplacement_ensures(low: int)
  ensures (lawLoneLowUsesReplacement(low) == true)
{
  if lowSurrogate(low) {
    Utf8OneUnit(low);
  }
}

lemma Utf8OneUnit(code: int)
  ensures utf8Length([code]) == countCodeUnit(Utf8Counter(false, 0), code).bytes + (if countCodeUnit(Utf8Counter(false, 0), code).pendingHigh then 3 else 0)
{
  var start := Utf8Counter(false, 0);
  var f := (c: Utf8Counter, code: int) => countCodeUnit(c, code);
  ProofLib.FoldLeftAppend(f, start, [], code);
  assert Std.Collections.Seq.FoldLeft(f, start, []) == start;
  assert [] + [code] == [code];
  var counted := Std.Collections.Seq.FoldLeft(f, start, [code]);
  assert counted == countCodeUnit(start, code);
  assert utf8Length([code]) == counted.bytes + (if counted.pendingHigh then 3 else 0);
}

lemma Utf8TwoUnits(first: int, second: int)
  requires highSurrogate(first) && lowSurrogate(second)
  ensures utf8Length([first, second]) == 4
{
  var start := Utf8Counter(false, 0);
  var f := (c: Utf8Counter, code: int) => countCodeUnit(c, code);
  ProofLib.FoldLeftAppend(f, start, [], first);
  ProofLib.FoldLeftAppend(f, start, [first], second);
  assert Std.Collections.Seq.FoldLeft(f, start, []) == start;
  assert [first] + [second] == [first, second];
  assert f(start, first) == Utf8Counter(true, 0);
  assert f(f(start, first), second) == Utf8Counter(false, 4);
}
