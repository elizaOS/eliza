lemma lawLongestClaimWins_ensures(routes: seq<Group>, request: Request)
  ensures (lawLongestClaimWins(routes, request) == true)
{
  AdmissionIsFilter(routes, request);
  var a := admission(routes, request);
  if a.Admitted? {
    var cs := claimant(routes, request.segments);
    ClaimantIsFilter(routes, request.segments);
    var p := (g: Group) => ((claim(g, request.segments) >= 0) && !((exists h :: h in routes && !((claim(h, request.segments) <= claim(g, request.segments))))));
    var g := if 0 < |cs| then cs[0] else noGroup;
    var q := (t: Route) => templateAdmits(t, g.id, request);
    var ms := ProofLib.Filter(q, g.routes);
    assert |ms| > 0;
    assert a.route == ms[0];
    ProofLib.FilterSubset(q, g.routes);
    assert a.route in g.routes;
    if |cs| == 0 {
      ProofLib.FilterNil(q, g.routes);
    }
    assert |cs| > 0;
    ProofLib.FilterMember(p, routes, g);
    assert g in routes && p(g);
  }
}

lemma AdmissionIsFilter(routes: seq<Group>, request: Request)
  ensures admission(routes, request) == (var g := (if 0 < |claimant(routes, request.segments)| then claimant(routes, request.segments)[0] else noGroup); var ms := ProofLib.Filter((t: Route) => templateAdmits(t, g.id, request), g.routes); var t := (if 0 < |ms| then ms[0] else noTemplate); if (!(wellFormed(request)) || (|ms| == 0)) then Admission.RouteRefused else if !(withinLimit(t.limit, request.body)) then Admission.TooLarge else Admitted(t))
{
}

lemma ClaimantIsFilter(routes: seq<Group>, segments: seq<Segment>)
  ensures claimant(routes, segments) == ProofLib.Filter((g: Group) => ((claim(g, segments) >= 0) && !((exists h :: h in routes && !((claim(h, segments) <= claim(g, segments)))))), routes)
{
}
