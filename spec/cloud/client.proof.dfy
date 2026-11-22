lemma RoutesForMethod(method_: HttpMethod)
  ensures routesOf(method_) == ProofLib.Filter((d: DeviceRoute) => (d.method_ == method_), deviceRoutes)
{}

lemma RouteGroupMembership(d: DeviceRoute)
  requires d in deviceRoutes
  ensures d in signInRoutes || d in billingRoutes || d in serviceRoutes || d in googleRoutes
{
  assert deviceRoutes == (signInRoutes + billingRoutes) + (serviceRoutes + googleRoutes);
}

lemma SignInRoutes0To7(d: DeviceRoute)
  requires d in signInRoutes[0..7]
  ensures (|d.path| > 0 && d.path[0] == Literal("api") && ((d.method_.Get? || d.method_.Post?) ==> ifMatch !in d.headers))
{}

lemma SignInRoutes7To10(d: DeviceRoute)
  requires d in signInRoutes[7..10]
  ensures (|d.path| > 0 && d.path[0] == Literal("api") && ((d.method_.Get? || d.method_.Post?) ==> ifMatch !in d.headers))
{}

lemma SignInRoutes10To14(d: DeviceRoute)
  requires d in signInRoutes[10..14]
  ensures (|d.path| > 0 && d.path[0] == Literal("api") && ((d.method_.Get? || d.method_.Post?) ==> ifMatch !in d.headers))
{}

lemma SignInRoutes14To21(d: DeviceRoute)
  requires d in signInRoutes[14..21]
  ensures (|d.path| > 0 && d.path[0] == Literal("api") && ((d.method_.Get? || d.method_.Post?) ==> ifMatch !in d.headers))
{}

lemma SignInRoutes21To28(d: DeviceRoute)
  requires d in signInRoutes[21..28]
  ensures (|d.path| > 0 && d.path[0] == Literal("api") && ((d.method_.Get? || d.method_.Post?) ==> ifMatch !in d.headers))
{}

lemma SignInRoutes28To35(d: DeviceRoute)
  requires d in signInRoutes[28..35]
  ensures (|d.path| > 0 && d.path[0] == Literal("api") && ((d.method_.Get? || d.method_.Post?) ==> ifMatch !in d.headers))
{}

lemma SignInRouteShape(d: DeviceRoute)
  requires d in signInRoutes
  ensures |d.path| > 0 && d.path[0] == Literal("api")
  ensures d.method_.Get? || d.method_.Post? ==> ifMatch !in d.headers
{
  var i :| 0 <= i < |signInRoutes| && signInRoutes[i] == d;
  assert |signInRoutes| == 35;
  if i < 7 {
    assert d == signInRoutes[0..7][i - 0];
    SignInRoutes0To7(d);
  } else if i < 10 {
    assert d == signInRoutes[7..10][i - 7];
    SignInRoutes7To10(d);
  } else if i < 14 {
    assert d == signInRoutes[10..14][i - 10];
    SignInRoutes10To14(d);
  } else if i < 21 {
    assert d == signInRoutes[14..21][i - 14];
    SignInRoutes14To21(d);
  } else if i < 28 {
    assert d == signInRoutes[21..28][i - 21];
    SignInRoutes21To28(d);
  } else {
    assert d == signInRoutes[28..35][i - 28];
    SignInRoutes28To35(d);
  }
}

lemma BillingRouteShape()
  ensures forall d :: d in billingRoutes ==> |d.path| > 0 && d.path[0] == Literal("api")
  ensures forall d :: d in billingRoutes && (d.method_.Get? || d.method_.Post?) ==> ifMatch !in d.headers
{}

lemma ServiceRouteShape()
  ensures forall d :: d in serviceRoutes ==> |d.path| > 0 && d.path[0] == Literal("api")
  ensures forall d :: d in serviceRoutes && (d.method_.Get? || d.method_.Post?) ==> ifMatch !in d.headers
{}

lemma GoogleRouteShape()
  ensures forall d :: d in googleRoutes ==> |d.path| > 0 && d.path[0] == Literal("api")
  ensures forall d :: d in googleRoutes && (d.method_.Get? || d.method_.Post?) ==> ifMatch !in d.headers
{}

lemma ListedRouteShape(d: DeviceRoute)
  requires d in deviceRoutes
  ensures |d.path| > 0 && d.path[0] == Literal("api")
  ensures d.method_.Get? || d.method_.Post? ==> ifMatch !in d.headers
{
  RouteGroupMembership(d);
  if d in signInRoutes {
    SignInRouteShape(d);
  } else if d in billingRoutes {
    BillingRouteShape();
  } else if d in serviceRoutes {
    ServiceRouteShape();
  } else {
    GoogleRouteShape();
  }
}

lemma lawEveryRouteIsUnderApi_ensures(method_: HttpMethod)
  ensures (lawEveryRouteIsUnderApi(method_) == true)
{
  RoutesForMethod(method_);
  forall d | d in routesOf(method_)
    ensures |d.path| > 0 && d.path[0] == Literal("api")
  {
    ProofLib.FilterMember((d: DeviceRoute) => (d.method_ == method_), deviceRoutes, d);
    ListedRouteShape(d);
  }
}

lemma lawIfMatchOnlyOnChangeAndDelete_ensures(method_: HttpMethod)
  ensures (lawIfMatchOnlyOnChangeAndDelete(method_) == true)
{
  if method_.Get? || method_.Post? {
    RoutesForMethod(method_);
    forall d | d in routesOf(method_)
      ensures ifMatch !in d.headers
    {
      ProofLib.FilterMember((d: DeviceRoute) => (d.method_ == method_), deviceRoutes, d);
      ListedRouteShape(d);
    }
  }
}

lemma LookupRuleFilter(method_: HttpMethod, parts: seq<string>)
  ensures lawAMatchedRouteMatches(method_, parts) ==
    (var selected := routeFor(method_, parts);
      if selected.Listed? then routeMatches(selected.route, method_, parts)
      else (|ProofLib.Filter((r: DeviceRoute) => routeMatches(r, method_, parts), deviceRoutes)| == 0))
{}

lemma MatchingRoutePrefix(method_: HttpMethod, parts: seq<string>, rows: seq<DeviceRoute>)
  ensures var selected := Std.Collections.Seq.FoldLeft((best: RouteLookup, r: DeviceRoute) =>
    (if !(routeMatches(r, method_, parts)) then best
     else (if best.Unlisted? then Listed(r) else (if (literalCount(r) > literalCount(best.route)) then Listed(r) else best))), RouteLookup.Unlisted, rows);
    if selected.Listed? then routeMatches(selected.route, method_, parts)
    else |ProofLib.Filter((r: DeviceRoute) => routeMatches(r, method_, parts), rows)| == 0
  decreases |rows|
{
  if |rows| == 0 {
    ProofLib.FilterNil((r: DeviceRoute) => routeMatches(r, method_, parts), rows);
  } else {
    var prefix := rows[..|rows|-1];
    var last := rows[|rows|-1];
    assert rows == prefix + [last];
    MatchingRoutePrefix(method_, parts, prefix);
    ProofLib.FoldLeftAppend((best: RouteLookup, r: DeviceRoute) =>
      (if !(routeMatches(r, method_, parts)) then best
       else (if best.Unlisted? then Listed(r) else (if (literalCount(r) > literalCount(best.route)) then Listed(r) else best))), RouteLookup.Unlisted, prefix, last);
    ProofLib.FilterAppend((r: DeviceRoute) => routeMatches(r, method_, parts), prefix, last);
  }
}

lemma lawAMatchedRouteMatches_ensures(method_: HttpMethod, parts: seq<string>)
  ensures (lawAMatchedRouteMatches(method_, parts) == true)
{
  MatchingRoutePrefix(method_, parts, deviceRoutes);
  LookupRuleFilter(method_, parts);
}
