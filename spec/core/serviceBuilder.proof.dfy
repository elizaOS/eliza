lemma BuilderFilters(s: ServiceBuilder)
  ensures alwaysClassIdsUnique(s) == (forall service :: service in s.built ==> service.id > 0 && service.id < s.nextId && |ProofLib.Filter((other: BuiltService) => (other.id == service.id), s.built)| == 1)
{}

lemma build_ensures(s: ServiceBuilder)
  ensures (inv(s) ==> canBuild(s) ==> alwaysClassIdsUnique(build(s)))
  ensures (inv(s) ==> canBuild(s) ==> alwaysNextClassIdPositive(build(s)))
  ensures (inv(s) ==> canBuild(s) ==> stepBuiltClassesStayFixed(s, build(s)))
{
  if inv(s) && canBuild(s) {
    var after := build(s);
    var added := BuiltService(s.nextId, s.serviceType, s.description, s.startRef, s.stopRef);
    BuilderFilters(s);
    BuilderFilters(after);
    forall service | service in after.built
      ensures service.id > 0 && service.id < after.nextId && |ProofLib.Filter((other: BuiltService) => (other.id == service.id), after.built)| == 1
    {
      var matchId := (other: BuiltService) => (other.id == service.id);
      ProofLib.FilterAppend(matchId, s.built, added);
      if service == added {
        ProofLib.FilterNone(matchId, s.built);
      } else {
        assert service in s.built;
        assert service.id < s.nextId;
      }
    }
  }
}
