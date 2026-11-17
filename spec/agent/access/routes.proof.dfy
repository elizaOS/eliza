// The admitted template is the first match in the first claimant's routes,
// and that claimant's claim is the fold maximum of every group's claim.

lemma lawLongestClaimWins_ensures(routes: seq<Group>, request: Request)
  ensures (lawLongestClaimWins(routes, request) == true)
{
  AdmissionIsFilter(routes, request);
  var a := admission(routes, request);
  if a.Admitted? {
    var top := longest(routes, request.segments);
    var cs := claimant(routes, request.segments);
    ClaimantIsFilter(routes, request.segments);
    var p := (g: Group) => ((longest(routes, request.segments) >= 0) && (claim(g, request.segments) == longest(routes, request.segments)));
    var g := if 0 < |cs| then cs[0] else noGroup;
    var q := (t: Template) => templateAdmits(t, g.id, request);
    var ms := ProofLib.Filter(q, g.routes);
    assert |ms| > 0;
    assert a.route == ms[0];
    ProofLib.FilterSubset(q, g.routes);
    assert a.route in g.routes;
    assert |cs| > 0;
    ProofLib.FilterSubset(p, routes);
    assert g in routes;
    ProofLib.FilterMember(p, routes, g);
    assert top >= 0 && claim(g, request.segments) == top;
    ProofLib.FoldLeftAboveEach((top: int, g: Group) => (if (claim(g, request.segments) > top) then claim(g, request.segments) else top), (h: Group) => claim(h, request.segments), -1, routes);
    assert forall h :: h in routes ==> claim(h, request.segments) <= top;
  }
}

lemma AdmissionIsFilter(routes: seq<Group>, request: Request)
  ensures admission(routes, request) == (var g := (if 0 < |claimant(routes, request.segments)| then claimant(routes, request.segments)[0] else noGroup); var ms := ProofLib.Filter((t: Template) => templateAdmits(t, g.id, request), g.routes); var t := (if 0 < |ms| then ms[0] else noTemplate); if (!(wellFormed(request)) || (|ms| == 0)) then Admission.RouteRefused else if !(withinLimit(t.limit, request.body)) then Admission.TooLarge else Admitted(t))
{
}

lemma ClaimantIsFilter(routes: seq<Group>, segments: seq<Segment>)
  ensures claimant(routes, segments) == ProofLib.Filter((g: Group) => ((longest(routes, segments) >= 0) && (claim(g, segments) == longest(routes, segments))), routes)
{
}
