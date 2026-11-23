// A sent request passed the origin, the gate and every header check, and Authorization passes no header check.
lemma lawASentRequestIsAdmittedOnTheOrigin_ensures(routes: seq<agent__access__routes_Group>, h: Holding, origin: cloud__client_BaseUrl, request: agent__access__routes_Request, headers: seq<string>)
  ensures (lawASentRequestIsAdmittedOnTheOrigin(routes, h, origin, request, headers) == true)
{
  var a := agent__access__routes_admission(routes, request);
  var found := deviceRouteOf((if ((0 <= 0) && (0 < |agent__access__routes_admittedRoute(a)|)) then agent__access__routes_admittedRoute(a)[0] else agent__access__routes_noTemplate));
  var d := (if ((0 <= 0) && (0 < |found|)) then found[0] else noDeviceRoute);
  if cloud__client_originAccepted(origin) && !a.TooLarge? && |agent__access__routes_admittedRoute(a)| == 1 && |found| == 1
    && !(exists x :: x in headers && !(headerAllowed(d, x))) {
    assert !headerAllowed(d, "Authorization");
    assert !("Authorization" in headers);
  } else {
    assert refused(planRequest(routes, h, origin, request, headers));
  }
}

// A cancel changes only its own calls in flight, to cancelled: neither another call nor a settled one.
lemma lawACancelChangesOnlyItsOwnCallInFlight_ensures(calls: seq<PageCall>, name: string)
  ensures (lawACancelChangesOnlyItsOwnCallInFlight(calls, name) == true)
{
  var after := cancelCall(calls, name);
  assert |after| == |calls|;
  assert forall i :: 0 <= i < |after| ==> after[i].name == calls[i].name;
  var other := (c: PageCall) => (c.name != name);
  var settled := (c: PageCall) => c.status.CallSettled?;
  ProofLib.FilterPointwise(other, other, (x: PageCall, y: PageCall) => x.name != name ==> x == y, after, calls);
  ProofLib.FilterPointwise(settled, settled, (x: PageCall, y: PageCall) => x.status.CallSettled? ==> x == y, after, calls);
  var ka := Std.Collections.Seq.Filter(other, after);
  var kc := Std.Collections.Seq.Filter(other, calls);
  assert forall i :: 0 <= i < |ka| ==> other(ka[i]);
  assert forall i :: 0 <= i < |ka| ==> ka[i] == kc[i];
  assert ka == kc;
  var sa := Std.Collections.Seq.Filter(settled, after);
  var sc := Std.Collections.Seq.Filter(settled, calls);
  assert forall i :: 0 <= i < |sa| ==> settled(sa[i]);
  assert forall i :: 0 <= i < |sa| ==> sa[i] == sc[i];
  assert sa == sc;
  forall c | c in after
    ensures !(c.name == name && c.status.CallInFlight?)
  {
    var i :| 0 <= i < |after| && after[i] == c;
  }
}

// What the first redemption keeps names another grant, so the second reads nothing.
lemma lawAGrantReadsOnce_ensures(grants: seq<Grant>, grant: string)
  ensures (lawAGrantReadsOnce(grants, grant) == true)
{
  var r := redeem(grants, grant).grants;
  assert forall i :: 0 <= i < |r| ==> r[i].grant != grant;
  ProofLib.FilterNone((g: Grant) => (g.grant == grant), r);
}
