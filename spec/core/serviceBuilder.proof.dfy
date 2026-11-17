// A build appends a class whose identity is above every earlier one, so each
// identity still occurs exactly once.
lemma BuildKeepsClassIds(s: ServiceBuilder)
  requires alwaysClassIdsUnique(s)
  requires s.nextId > 0
  ensures alwaysClassIdsUnique(build(s))
{
  var after := build(s);
  var newest := BuiltService(s.nextId, s.serviceType, s.description, s.startRef, s.stopRef);
  forall service | service in after.built
    ensures (service.id > 0) && (service.id < after.nextId) && (|ProofLib.Filter((other: BuiltService) => (other.id == service.id), after.built)| == 1)
  {
    ProofLib.FilterAppend((other: BuiltService) => (other.id == service.id), s.built, newest);
    if service !in s.built {
      ProofLib.FilterNone((other: BuiltService) => (other.id == service.id), s.built);
    }
  }
}

lemma build_ensures(s: ServiceBuilder)
  ensures (inv(s) ==> canBuild(s) ==> alwaysClassIdsUnique(build(s)))
  ensures (inv(s) ==> canBuild(s) ==> alwaysNextIdIsPositive(build(s)))
  ensures (inv(s) ==> canBuild(s) ==> stepBuiltClassesStayFixed(s, build(s)))
{
  if inv(s) && canBuild(s) {
    BuildKeepsClassIds(s);
  }
}
