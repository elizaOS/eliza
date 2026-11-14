lemma lawBoxesAndLooseMakeTheWhole_ensures(units: int)
  ensures (lawBoxesAndLooseMakeTheWhole(units) == true)
{
  assert loose(units) == units - 4 * boxes(units);
}
