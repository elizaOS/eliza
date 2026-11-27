lemma ScanHit(lookups: seq<FeedLookup>)
  ensures Std.Collections.Seq.FoldLeft(scanLookup, noHitYet, lookups).scanned == |lookups|
  ensures var h := Std.Collections.Seq.FoldLeft(scanLookup, noHitYet, lookups).hit; h >= 0 ==> 0 <= h < |lookups| && lookups[h].ListHit?
  ensures FeedLookup.ListHit in lookups ==> Std.Collections.Seq.FoldLeft(scanLookup, noHitYet, lookups).hit >= 0
  decreases |lookups|
{
  if |lookups| == 0 {
    reveal Std.Collections.Seq.FoldLeft();
  } else {
    var prefix := lookups[..|lookups| - 1];
    var last := lookups[|lookups| - 1];
    assert lookups == prefix + [last];
    ScanHit(prefix);
    ProofLib.FoldLeftAppend(scanLookup, noHitYet, prefix, last);
  }
}

lemma LookalikeFold(host: string, references: seq<string>)
  ensures var r := Std.Collections.Seq.FoldLeft((found: Lookalike, reference: string) => (if (found.NotLookalike? && resemblesSite(host, reference)) then LooksLike(reference) else found), typed1_os__browser__protection(Lookalike.NotLookalike), references); r.LooksLike? ==> r.suggested in references
  decreases |references|
{
  var f := (found: Lookalike, reference: string) => (if (found.NotLookalike? && resemblesSite(host, reference)) then LooksLike(reference) else found);
  var start := typed1_os__browser__protection(Lookalike.NotLookalike);
  if |references| == 0 {
    reveal Std.Collections.Seq.FoldLeft();
  } else {
    var prefix := references[..|references| - 1];
    var last := references[|references| - 1];
    assert references == prefix + [last];
    LookalikeFold(host, prefix);
    ProofLib.FoldLeftAppend(f, start, prefix, last);
  }
}

lemma DedupTwo(v: string)
  ensures Std.Collections.Seq.FoldLeft((seen: seq<string>, id: string) => (seen + Std.Collections.Seq.Filter((set_x: string) => !((set_x in seen)), [id])), [], [v, v]) == [v]
{
  reveal Std.Collections.Seq.FoldLeft();
  reveal Std.Collections.Seq.Filter();
  var f := (seen: seq<string>, id: string) => (seen + Std.Collections.Seq.Filter((set_x: string) => !((set_x in seen)), [id]));
  assert [v] == [] + [v];
  assert [v, v] == [v] + [v];
  assert [v][1..] == [];
  ProofLib.FoldLeftAppend(f, [], [], v);
  ProofLib.FoldLeftAppend(f, [], [v], v);
  assert f([], v) == [v];
  assert f([v], v) == [v];
}

lemma lawRepeatedListIsRefused_ensures(id: string)
  ensures (lawRepeatedListIsRefused(id) == true)
{
  DedupTwo(id);
}

lemma lawAnyLoadedHitBlocks_ensures(query: ReputationQuery, lookups: seq<FeedLookup>)
  ensures (lawAnyLoadedHitBlocks(query, lookups) == true)
{
  ScanHit(lookups);
}

lemma lawSuggestionIsAnotherReferenceSite_ensures(host: string, domain: string, references: seq<string>)
  ensures (lawSuggestionIsAnotherReferenceSite(host, domain, references) == true)
{
  LookalikeFold(host, references);
}
