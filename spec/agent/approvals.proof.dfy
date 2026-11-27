lemma ListedTakeBound(acc: seq<string>, xs: seq<string>, cap: int)
  requires cap >= 0 && |acc| <= cap
  ensures var res := Std.Collections.Seq.FoldLeft((a: seq<string>, id: string) => (if (|a| < cap) then (a + [id]) else a), acc, xs);
    |res| <= cap && (forall id :: id in res ==> id in acc || id in xs)
  decreases |xs|
{
  if |xs| > 0 {
    var next := if |acc| < cap then acc + [xs[0]] else acc;
    ListedTakeBound(next, xs[1..], cap);
  }
}

lemma list_ensures(s: Queue, query: PageQuery)
  ensures (inv(s) ==> canList(s, query) ==> alwaysListedIdsAreKnown(list(s, query).state))
  ensures (inv(s) ==> canList(s, query) ==> stepOnlyResolveLeavesAnOpenPhase(s, "list", list(s, query).state))
  ensures (inv(s) ==> canList(s, query) ==> stepRefusalChangesNothing(s, "list", list(s, query).state, list(s, query).out))
  ensures (inv(s) ==> canList(s, query) ==> stepDecisionAdvancesRevision(s, "list", list(s, query).state, list(s, query).out))
  ensures (inv(s) ==> canList(s, query) ==> stepLapseKeepsPhaseAndRevision(s, "list", list(s, query).state))
  ensures (inv(s) ==> canList(s, query) ==> stepListingIsBoundedAndChangesNothing(s, "list", list(s, query).state, list(s, query).out))
{
  if inv(s) && canList(s, query) {
    var p := (id: string) => matchesFilter(query.phases, rowAt(s, id).phase);
    var filtered := ProofLib.Filter(p, s.newestFirst);
    var cap := pageSize(query.limit);
    assert 1 <= cap <= 500;
    ListedTakeBound([], filtered, cap);
    var ids := listedIds(s, query);
    assert |ids| <= cap;
    forall id | id in ids ensures known(s, id) && matchesFilter(query.phases, rowAt(s, id).phase) {
      assert id in filtered;
      ProofLib.FilterMember(p, s.newestFirst, id);
    }
  }
}
