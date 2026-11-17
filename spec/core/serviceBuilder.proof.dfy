lemma ClassIdsBridge(s: ServiceBuilder)
  ensures alwaysClassIdsUnique(s) <==> (s.nextId > 0 && (forall service :: service in s.built ==> (0 < service.id < s.nextId && |ProofLib.Filter((other: BuiltService) => (other.id == service.id), s.built)| == 1)))
{}

lemma build_ensures(s: ServiceBuilder)
  ensures (inv(s) ==> canBuild(s) ==> alwaysClassIdsUnique(build(s)))
  ensures (inv(s) ==> canBuild(s) ==> stepBuiltClassesStayFixed(s, build(s)))
{
  if inv(s) && canBuild(s) {
    var t := build(s);
    ClassIdsBridge(s);
    ClassIdsBridge(t);
    var row := t.built[|t.built| - 1];
    assert t.built == s.built + [row];
    forall entry | entry in t.built
      ensures 0 < entry.id < t.nextId && |ProofLib.Filter((other: BuiltService) => (other.id == entry.id), t.built)| == 1
    {
      var p := (other: BuiltService) => (other.id == entry.id);
      ProofLib.FilterAppend(p, s.built, row);
      if entry == row {
        ProofLib.FilterNone(p, s.built);
      } else {
        assert entry in s.built;
      }
    }
  }
}
