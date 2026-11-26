lemma lawASentRequestIsAdmittedOnTheOrigin_ensures(routes: seq<agent__access__routes_Group>, h: Holding, origin: cloud__client_BaseUrl, request: agent__access__routes_Request, headers: seq<string>)
  ensures (lawASentRequestIsAdmittedOnTheOrigin(routes, h, origin, request, headers) == true)
{
  var admission := agent__access__routes_admission(routes, request);
  var offered := agent__access__routes_admittedRoute(admission);
  var first := if 0 < |offered| then offered[0] else agent__access__routes_noTemplate;
  var devices := deviceRouteOf(first);
  var plan := planRequest(routes, h, origin, request, headers);
  if !cloud__client_originAccepted(origin) {
    assert plan == Refuse(CallRefusal.NoOrigin);
  } else if admission.TooLarge? {
    assert plan == Refuse(CallRefusal.BodyTooLarge);
  } else if |offered| != 1 || |devices| != 1 {
    assert plan == Refuse(CallRefusal.NotListed);
  } else if "Authorization" in headers {
    assert !headerAllowed(devices[0], "Authorization");
    assert exists x :: x in headers && !headerAllowed(devices[0], x);
    assert plan == Refuse(CallRefusal.HeaderRefused);
  }
}

lemma lawACancelChangesOnlyItsOwnCallInFlight_ensures(calls: seq<PageCall>, name: string)
  ensures (lawACancelChangesOnlyItsOwnCallInFlight(calls, name) == true)
{
  var after := cancelCall(calls, name);
  var other := (c: PageCall) => c.name != name;
  var settled := (c: PageCall) => c.status.CallSettled?;
  if |calls| > 0 {
    var tail := calls[1..];
    assert after[1..] == cancelCall(tail, name) by {
      forall i | 0 <= i < |tail|
        ensures after[1..][i] == cancelCall(tail, name)[i]
      {
        assert tail[i] == calls[i + 1];
      }
    }
    lawACancelChangesOnlyItsOwnCallInFlight_ensures(tail, name);
    ProofLib.FilterCons(other, calls);
    ProofLib.FilterCons(other, after);
    ProofLib.FilterCons(settled, calls);
    ProofLib.FilterCons(settled, after);
    assert after == [after[0]] + after[1..];
  } else {
    assert after == calls;
  }
}

lemma lawAGrantReadsOnce_ensures(grants: seq<Grant>, grant: string)
  ensures (lawAGrantReadsOnce(grants, grant) == true)
{
  var left := redeem(grants, grant).grants;
  forall i | 0 <= i < |left| ensures left[i].grant != grant {
    ProofLib.FilterMember((g: Grant) => g.grant != grant, grants, left[i]);
  }
  ProofLib.FilterNone((g: Grant) => g.grant == grant, left);
}

lemma RouteForMember(method_: cloud__client_HttpMethod, parts: seq<string>, routes: seq<cloud__client_DeviceRoute>)
  ensures var res := Std.Collections.Seq.FoldLeft((best: cloud__client_RouteLookup, r: cloud__client_DeviceRoute) => (if !(cloud__client_routeMatches(r, method_, parts)) then best else (if best.Unlisted? then cloud__client_RouteLookup.Listed(r) else (if (cloud__client_literalCount(r) > cloud__client_literalCount(best.route)) then cloud__client_RouteLookup.Listed(r) else best))), cloud__client_typed1_cloud__client(cloud__client_RouteLookup.Unlisted), routes);
    res.Listed? ==> res.route in routes && cloud__client_routeMatches(res.route, method_, parts)
  decreases |routes|
{
  var f := (best: cloud__client_RouteLookup, r: cloud__client_DeviceRoute) => (if !(cloud__client_routeMatches(r, method_, parts)) then best else (if best.Unlisted? then cloud__client_RouteLookup.Listed(r) else (if (cloud__client_literalCount(r) > cloud__client_literalCount(best.route)) then cloud__client_RouteLookup.Listed(r) else best)));
  var start := cloud__client_typed1_cloud__client(cloud__client_RouteLookup.Unlisted);
  if |routes| == 0 {
    reveal Std.Collections.Seq.FoldLeft();
  } else {
    var prefix := routes[..|routes| - 1];
    var last := routes[|routes| - 1];
    assert routes == prefix + [last];
    RouteForMember(method_, parts, prefix);
    ProofLib.FoldLeftAppend(f, start, prefix, last);
  }
}

lemma RouteMatchesFold(r: cloud__client_DeviceRoute, parts: seq<string>)
  ensures var res := Std.Collections.Seq.FoldLeft((n: int, part: string) => (if ((n >= 0) && cloud__client_segmentMatches((if ((0 <= n) && (n < |r.path|)) then r.path[n] else cloud__client_Segment.Literal("")), part)) then (n + 1) else -1), 0, parts);
    res == |parts| ==> forall k :: 0 <= k < |parts| ==> cloud__client_segmentMatches((if k < |r.path| then r.path[k] else cloud__client_Segment.Literal("")), parts[k])
  ensures var res := Std.Collections.Seq.FoldLeft((n: int, part: string) => (if ((n >= 0) && cloud__client_segmentMatches((if ((0 <= n) && (n < |r.path|)) then r.path[n] else cloud__client_Segment.Literal("")), part)) then (n + 1) else -1), 0, parts);
    res <= |parts|
  decreases |parts|
{
  var f := (n: int, part: string) => (if ((n >= 0) && cloud__client_segmentMatches((if ((0 <= n) && (n < |r.path|)) then r.path[n] else cloud__client_Segment.Literal("")), part)) then (n + 1) else -1);
  if |parts| == 0 {
    reveal Std.Collections.Seq.FoldLeft();
  } else {
    var prefix := parts[..|parts| - 1];
    var last := parts[|parts| - 1];
    assert parts == prefix + [last];
    RouteMatchesFold(r, prefix);
    ProofLib.FoldLeftAppend(f, 0, prefix, last);
  }
}

lemma SignInNotEliza(r: cloud__client_DeviceRoute)
  requires r in cloud__client_signInRoutes
  requires |r.path| >= 3
  ensures !cloud__client_segmentMatches(r.path[2], "eliza")
{
  var i :| 0 <= i < |cloud__client_signInRoutes| && cloud__client_signInRoutes[i] == r;
  if i == 0 {
    assert r.path[2] == cloud__client_Segment.Literal("service");
  } else if i < 20 {
    assert r.path[2] == cloud__client_Segment.Literal("auth");
  } else if i < 27 {
    assert r.path[2] == cloud__client_Segment.Literal("user");
  } else if i < 29 {
    assert r.path[2] == cloud__client_Segment.Literal("referrals");
  } else if i < 37 {
    assert r.path[2] == cloud__client_Segment.Literal("app-auth");
  } else {
    assert i == 37;
    assert r.path[2] == cloud__client_Segment.Literal("api-keys");
  }
}

lemma BillingNotEliza(r: cloud__client_DeviceRoute)
  requires r in cloud__client_billingRoutes
  requires |r.path| >= 3
  ensures !cloud__client_segmentMatches(r.path[2], "eliza")
{
  var i :| 0 <= i < |cloud__client_billingRoutes| && cloud__client_billingRoutes[i] == r;
  if i == 0 || (5 <= i <= 20) {
    assert r.path[2] == cloud__client_Segment.Literal("subscriptions");
  } else if i == 1 || i == 3 || i == 4 {
    assert r.path[2] == cloud__client_Segment.Literal("subscription");
  } else {
    assert r.path[2] == cloud__client_Segment.Literal("billing");
  }
}

lemma ServiceNotEliza(r: cloud__client_DeviceRoute)
  requires r in cloud__client_serviceRoutes
  requires |r.path| >= 3
  ensures !cloud__client_segmentMatches(r.path[2], "eliza")
{
  var i :| 0 <= i < |cloud__client_serviceRoutes| && cloud__client_serviceRoutes[i] == r;
  if i == 0 {
    assert r.path[2] == cloud__client_Segment.Literal("models");
  } else if i == 1 {
    assert r.path[2] == cloud__client_Segment.Literal("decisions");
  } else if i == 2 {
    assert r.path[2] == cloud__client_Segment.Literal("chat");
  } else if i < 9 {
    assert r.path[2] == cloud__client_Segment.Literal("voice");
  } else {
    assert r.path[2] == cloud__client_Segment.Literal("maps");
  }
}

lemma GoogleShortGetIsMail(r: cloud__client_DeviceRoute)
  requires r in cloud__client_googleRoutes
  requires r.method_.Get?
  requires |r.path| <= 6
  ensures r.auth.Mail?
{
  var i :| 0 <= i < |cloud__client_googleRoutes| && cloud__client_googleRoutes[i] == r;
  if i == 8 {
    assert |r.path| == 7;
  } else if i == 17 {
    assert |r.path| == 8;
  }
}

lemma BrokerRouteIsMail(r: cloud__client_DeviceRoute, parts: seq<string>)
  requires r in cloud__client_deviceRoutes
  requires parts == ["api", "v1", "eliza", "google", "accounts"] || parts == ["api", "v1", "eliza", "google", "gmail", "search"]
  requires cloud__client_routeMatches(r, cloud__client_HttpMethod.Get, parts)
  ensures r.auth.Mail?
{
  RouteMatchesFold(r, parts);
  assert cloud__client_segmentMatches(r.path[2], "eliza");
  assert r in cloud__client_signInRoutes || r in cloud__client_billingRoutes || r in cloud__client_serviceRoutes || r in cloud__client_googleRoutes;
  if r in cloud__client_signInRoutes {
    SignInNotEliza(r);
  } else if r in cloud__client_billingRoutes {
    BillingNotEliza(r);
  } else if r in cloud__client_serviceRoutes {
    ServiceNotEliza(r);
  } else {
    GoogleShortGetIsMail(r);
  }
}

lemma lawAHostMailReadIsAMailRouteRead_ensures(readPath: seq<string>, readFields: seq<string>)
  ensures (lawAHostMailReadIsAMailRouteRead(readPath, readFields) == true)
{
  if hostMailReadAdmitted(readPath, readFields) {
    var r :| r in hostMailReads && r.under == readPath;
    if r == hostMailReads[0] {
      assert cloud__client_googleRoutes[0] in cloud__client_deviceRoutes;
    } else if r == hostMailReads[1] {
      assert cloud__client_googleRoutes[1] in cloud__client_deviceRoutes;
    } else if r == hostMailReads[2] {
      assert cloud__client_googleRoutes[5] in cloud__client_deviceRoutes;
    } else if r == hostMailReads[3] {
      assert cloud__client_googleRoutes[7] in cloud__client_deviceRoutes;
    } else if r == hostMailReads[4] {
      assert cloud__client_googleRoutes[10] in cloud__client_deviceRoutes;
    } else {
      assert r == hostMailReads[5];
      assert cloud__client_googleRoutes[19] in cloud__client_deviceRoutes;
    }
  }
}

lemma lawABrokerReadCarriesOnlyTheLease_ensures(h: Holding, call: BrokerCall)
  ensures (lawABrokerReadCarriesOnlyTheLease(h, call) == true)
{
  if brokered(call) && call.ownerHolds {
    var parts := brokerParts(call.read);
    RouteForMember(cloud__client_HttpMethod.Get, parts, cloud__client_deviceRoutes);
    var found := cloud__client_routeFor(cloud__client_HttpMethod.Get, parts);
    if found.Listed? {
      BrokerRouteIsMail(found.route, parts);
    }
  }
}
