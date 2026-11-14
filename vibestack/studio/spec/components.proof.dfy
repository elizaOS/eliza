lemma load_ensures(p: Selection, counts: seq<int>, key: string)
  ensures (inv(p) ==> canLoad(p, counts, key) ==> alwaysSelectionExists(load(p, counts, key)))
{
  if inv(p) && canLoad(p, counts, key) && |counts| > 0 {
    assert counts[0] in counts;
    assert counts[0] >= 0;
  }
}

lemma chooseComponent_ensures(p: Selection, at: int)
  ensures (inv(p) ==> canChooseComponent(p, at) ==> alwaysSelectionExists(chooseComponent(p, at)))
{
  if inv(p) && canChooseComponent(p, at) {
    assert p.counts[at] in p.counts;
    assert p.counts[at] >= 0;
  }
}
