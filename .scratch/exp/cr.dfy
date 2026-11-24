// Two lists of the same length that differ only where a call fails p keep the same calls that pass p.
lemma CrFilterSame(p: PageCall -> bool, xs: seq<PageCall>, ys: seq<PageCall>)
  requires |xs| == |ys|
  requires forall i :: 0 <= i < |xs| ==> p(xs[i]) == p(ys[i]) && (p(xs[i]) ==> xs[i] == ys[i])
  ensures Std.Collections.Seq.Filter(p, xs) == Std.Collections.Seq.Filter(p, ys)
  decreases |xs|
{
  reveal Std.Collections.Seq.Filter();
  if |xs| > 0 {
    assert forall i :: 0 <= i < |xs[1..]| ==> xs[1..][i] == xs[i + 1] && ys[1..][i] == ys[i + 1];
    CrFilterSame(p, xs[1..], ys[1..]);
  }
}

// A cancel changes only its own calls in flight, to cancelled: neither another call nor a settled one.
lemma lawACancelChangesOnlyItsOwnCallInFlight_ensures(calls: seq<PageCall>, name: string)
  ensures (lawACancelChangesOnlyItsOwnCallInFlight(calls, name) == true)
{
  var after := cancelCall(calls, name);
  assert |after| == |calls|;
  assert forall i :: 0 <= i < |after| ==> after[i].name == calls[i].name && (after[i].name != name || !calls[i].status.CallInFlight? ==> after[i] == calls[i]);
  CrFilterSame((c: PageCall) => (c.name != name), after, calls);
  CrFilterSame((c: PageCall) => c.status.CallSettled?, after, calls);
  forall c | c in after
    ensures !(c.name == name && c.status.CallInFlight?)
  {
    var i :| 0 <= i < |after| && after[i] == c;
  }
}
