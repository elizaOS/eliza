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

lemma SignInRoutes35To38(d: DeviceRoute)
  requires d in signInRoutes[35..38]
  ensures (|d.path| > 0 && d.path[0] == Literal("api") && ((d.method_.Get? || d.method_.Post?) ==> ifMatch !in d.headers))
{}

lemma SignInRoutesLength()
  ensures |signInRoutes| == 38
{}

lemma SignInRouteShape(d: DeviceRoute)
  requires d in signInRoutes
  ensures |d.path| > 0 && d.path[0] == Literal("api")
  ensures d.method_.Get? || d.method_.Post? ==> ifMatch !in d.headers
{
  hide *;
  SignInRoutesLength();
  var i :| 0 <= i < |signInRoutes| && signInRoutes[i] == d;
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
  } else if i < 35 {
    assert d == signInRoutes[28..35][i - 28];
    SignInRoutes28To35(d);
  } else {
    assert d == signInRoutes[35..38][i - 35];
    SignInRoutes35To38(d);
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

lemma SignInGroupPathComponents(i: int, j: int)
  requires 0 <= i < j < |signInRoutes|
  ensures (signInRoutes[i].method_, signInRoutes[i].path) != (signInRoutes[j].method_, signInRoutes[j].path)
{
  var a := signInRoutes[i];
  var b := signInRoutes[j];
  if a.method_ == b.method_ && a.path == b.path {
    assert |a.path| == |b.path|;
    assert |a.path| > 2 && a.path[2] == b.path[2];
    if |a.path| > 3 { assert a.path[3] == b.path[3]; }
    if |a.path| > 4 { assert a.path[4] == b.path[4]; }
    if |a.path| > 5 { assert a.path[5] == b.path[5]; }
    if |a.path| > 6 { assert a.path[6] == b.path[6]; }
    assert false;
  }
}

lemma SignInRouteKeyFacts()
  ensures ProofLib.DistinctBy(signInRoutes, (d: DeviceRoute) => (d.method_, d.path))
  ensures forall d :: d in signInRoutes ==> |d.path| > 2 && d.path[2] in {Literal("service"), Literal("auth"), Literal("user"), Literal("referrals"), Literal("app-auth"), Literal("api-keys")}
{
  var key := (d: DeviceRoute) => (d.method_, d.path);
  forall i, j | 0 <= i < |signInRoutes| && 0 <= j < |signInRoutes| && i != j
    ensures key(signInRoutes[i]) != key(signInRoutes[j])
  {
    if i < j { SignInGroupPathComponents(i, j); }
    else { SignInGroupPathComponents(j, i); }
  }
  forall d | d in signInRoutes
    ensures |d.path| > 2 && d.path[2] in {Literal("service"), Literal("auth"), Literal("user"), Literal("referrals"), Literal("app-auth"), Literal("api-keys")}
  {
    var i :| 0 <= i < |signInRoutes| && signInRoutes[i] == d;
    SignInRouteAtNamespace(i);
  }
}

lemma SignInRouteAtNamespace(i: int)
  requires 0 <= i < |signInRoutes|
  ensures var path := signInRoutes[i].path;
    |path| > 2 && path[2] in {Literal("service"), Literal("auth"), Literal("user"), Literal("referrals"), Literal("app-auth"), Literal("api-keys")}
{}

lemma BillingGroupPathComponents(i: int, j: int)
  requires 0 <= i < j < |billingRoutes|
  ensures (billingRoutes[i].method_, billingRoutes[i].path) != (billingRoutes[j].method_, billingRoutes[j].path)
{
  var a := billingRoutes[i];
  var b := billingRoutes[j];
  if a.method_ == b.method_ && a.path == b.path {
    assert |a.path| == |b.path|;
    assert |a.path| > 2 && a.path[2] == b.path[2];
    if |a.path| > 3 { assert a.path[3] == b.path[3]; }
    if |a.path| > 4 { assert a.path[4] == b.path[4]; }
    if |a.path| > 5 { assert a.path[5] == b.path[5]; }
    assert false;
  }
}

lemma BillingRouteKeyFacts()
  ensures ProofLib.DistinctBy(billingRoutes, (d: DeviceRoute) => (d.method_, d.path))
  ensures forall d :: d in billingRoutes ==> |d.path| > 2 && d.path[2] in {Literal("subscriptions"), Literal("subscription"), Literal("billing")}
{
  var key := (d: DeviceRoute) => (d.method_, d.path);
  forall i, j | 0 <= i < |billingRoutes| && 0 <= j < |billingRoutes| && i != j
    ensures key(billingRoutes[i]) != key(billingRoutes[j])
  {
    if i < j { BillingGroupPathComponents(i, j); }
    else { BillingGroupPathComponents(j, i); }
  }
  forall d | d in billingRoutes
    ensures |d.path| > 2 && d.path[2] in {Literal("subscriptions"), Literal("subscription"), Literal("billing")}
  {
    var i :| 0 <= i < |billingRoutes| && billingRoutes[i] == d;
    BillingRouteAtNamespace(i);
  }
}

lemma BillingRouteAtNamespace(i: int)
  requires 0 <= i < |billingRoutes|
  ensures var path := billingRoutes[i].path;
    |path| > 2 && path[2] in {Literal("subscriptions"), Literal("subscription"), Literal("billing")}
{}

lemma ServiceGroupPathComponents(i: int, j: int)
  requires 0 <= i < j < |serviceRoutes|
  ensures (serviceRoutes[i].method_, serviceRoutes[i].path) != (serviceRoutes[j].method_, serviceRoutes[j].path)
{
  var a := serviceRoutes[i];
  var b := serviceRoutes[j];
  if a.method_ == b.method_ && a.path == b.path {
    assert |a.path| == |b.path|;
    assert |a.path| > 2 && a.path[2] == b.path[2];
    if |a.path| > 3 { assert a.path[3] == b.path[3]; }
    if |a.path| > 4 { assert a.path[4] == b.path[4]; }
    if |a.path| > 5 { assert a.path[5] == b.path[5]; }
    if |a.path| > 6 { assert a.path[6] == b.path[6]; }
    assert false;
  }
}

lemma ServiceRouteKeyFacts()
  ensures ProofLib.DistinctBy(serviceRoutes, (d: DeviceRoute) => (d.method_, d.path))
  ensures forall d :: d in serviceRoutes ==> |d.path| > 2 && d.path[2] in {Literal("models"), Literal("decisions"), Literal("chat"), Literal("voice"), Literal("maps")}
{
  var key := (d: DeviceRoute) => (d.method_, d.path);
  forall i, j | 0 <= i < |serviceRoutes| && 0 <= j < |serviceRoutes| && i != j
    ensures key(serviceRoutes[i]) != key(serviceRoutes[j])
  {
    if i < j { ServiceGroupPathComponents(i, j); }
    else { ServiceGroupPathComponents(j, i); }
  }
  forall d | d in serviceRoutes
    ensures |d.path| > 2 && d.path[2] in {Literal("models"), Literal("decisions"), Literal("chat"), Literal("voice"), Literal("maps")}
  {
    var i :| 0 <= i < |serviceRoutes| && serviceRoutes[i] == d;
    ServiceRouteAtNamespace(i);
  }
}

lemma ServiceRouteAtNamespace(i: int)
  requires 0 <= i < |serviceRoutes|
  ensures var path := serviceRoutes[i].path;
    |path| > 2 && path[2] in {Literal("models"), Literal("decisions"), Literal("chat"), Literal("voice"), Literal("maps")}
{}

lemma GoogleGroupPathComponents(i: int, j: int)
  requires 0 <= i < j < |googleRoutes|
  ensures (googleRoutes[i].method_, googleRoutes[i].path) != (googleRoutes[j].method_, googleRoutes[j].path)
{
  var a := googleRoutes[i];
  var b := googleRoutes[j];
  if a.method_ == b.method_ && a.path == b.path {
    assert |a.path| == |b.path|;
    assert |a.path| > 2 && a.path[2] == b.path[2];
    if |a.path| > 3 { assert a.path[3] == b.path[3]; }
    if |a.path| > 4 { assert a.path[4] == b.path[4]; }
    if |a.path| > 5 { assert a.path[5] == b.path[5]; }
    if |a.path| > 6 { assert a.path[6] == b.path[6]; }
    if |a.path| > 7 { assert a.path[7] == b.path[7]; }
    if |a.path| > 8 { assert a.path[8] == b.path[8]; }
    assert false;
  }
}

lemma GoogleRouteKeyFacts()
  ensures ProofLib.DistinctBy(googleRoutes, (d: DeviceRoute) => (d.method_, d.path))
  ensures forall d :: d in googleRoutes ==> |d.path| > 2 && d.path[2] in {Literal("eliza")}
{
  var key := (d: DeviceRoute) => (d.method_, d.path);
  forall i, j | 0 <= i < |googleRoutes| && 0 <= j < |googleRoutes| && i != j
    ensures key(googleRoutes[i]) != key(googleRoutes[j])
  {
    if i < j { GoogleGroupPathComponents(i, j); }
    else { GoogleGroupPathComponents(j, i); }
  }
  forall d | d in googleRoutes
    ensures |d.path| > 2 && d.path[2] in {Literal("eliza")}
  {
    var i :| 0 <= i < |googleRoutes| && googleRoutes[i] == d;
    GoogleRouteAtNamespace(i);
  }
}

lemma GoogleRouteAtNamespace(i: int)
  requires 0 <= i < |googleRoutes|
  ensures var path := googleRoutes[i].path;
    |path| > 2 && path[2] in {Literal("eliza")}
{}

lemma AppendDisjointRouteGroups(earlier: seq<DeviceRoute>, later: seq<DeviceRoute>, earlierNames: set<Segment>, laterNames: set<Segment>)
  requires ProofLib.DistinctBy(earlier, (d: DeviceRoute) => (d.method_, d.path))
  requires ProofLib.DistinctBy(later, (d: DeviceRoute) => (d.method_, d.path))
  requires forall d :: d in earlier ==> |d.path| > 2 && d.path[2] in earlierNames
  requires forall d :: d in later ==> |d.path| > 2 && d.path[2] in laterNames
  requires earlierNames * laterNames == {}
  ensures ProofLib.DistinctBy(earlier + later, (d: DeviceRoute) => (d.method_, d.path))
  ensures forall d :: d in earlier + later ==> |d.path| > 2 && d.path[2] in earlierNames + laterNames
{
  var key := (d: DeviceRoute) => (d.method_, d.path);
  forall a, b | a in earlier && b in later
    ensures key(a) != key(b)
  {
    assert a.path[2] in earlierNames;
    assert b.path[2] in laterNames;
    if a.path[2] == b.path[2] {
      assert a.path[2] in earlierNames * laterNames;
      assert false;
    }
  }
  ProofLib.DistinctByConcat(earlier, later, key);
  forall d | d in earlier + later
    ensures |d.path| > 2 && d.path[2] in earlierNames + laterNames
  {
    assert d in earlier || d in later;
  }
}


lemma AccountNamespacesAreDisjoint()
  ensures {Literal("service"), Literal("auth"), Literal("user"), Literal("referrals"), Literal("app-auth"), Literal("api-keys")} * {Literal("subscriptions"), Literal("subscription"), Literal("billing")} == {}
{
  var earlier := {Literal("service"), Literal("auth"), Literal("user"), Literal("referrals"), Literal("app-auth"), Literal("api-keys")};
  var later := {Literal("subscriptions"), Literal("subscription"), Literal("billing")};
  if earlier * later != {} {
    var prefix :| prefix in earlier * later;
    assert prefix in earlier && prefix in later;
    assert prefix == Literal("service") || prefix == Literal("auth") || prefix == Literal("user") || prefix == Literal("referrals") || prefix == Literal("app-auth") || prefix == Literal("api-keys");
    assert prefix == Literal("subscriptions") || prefix == Literal("subscription") || prefix == Literal("billing");
    assert false;
  }
}

lemma GroupedNamespacesAreDisjoint()
  ensures ({Literal("service"), Literal("auth"), Literal("user"), Literal("referrals"), Literal("app-auth"), Literal("api-keys")} + {Literal("subscriptions"), Literal("subscription"), Literal("billing")}) * ({Literal("models"), Literal("decisions"), Literal("chat"), Literal("voice"), Literal("maps")} + {Literal("eliza")}) == {}
{
  var earlier := ({Literal("service"), Literal("auth"), Literal("user"), Literal("referrals"), Literal("app-auth"), Literal("api-keys")} + {Literal("subscriptions"), Literal("subscription"), Literal("billing")});
  var later := ({Literal("models"), Literal("decisions"), Literal("chat"), Literal("voice"), Literal("maps")} + {Literal("eliza")});
  if earlier * later != {} {
    var prefix :| prefix in earlier * later;
    assert prefix in earlier && prefix in later;
    assert prefix == Literal("service") || prefix == Literal("auth") || prefix == Literal("user") || prefix == Literal("referrals") || prefix == Literal("app-auth") || prefix == Literal("api-keys") || prefix == Literal("subscriptions") || prefix == Literal("subscription") || prefix == Literal("billing");
    assert prefix == Literal("models") || prefix == Literal("decisions") || prefix == Literal("chat") || prefix == Literal("voice") || prefix == Literal("maps") || prefix == Literal("eliza");
    assert false;
  }
}

lemma CapabilityNamespacesAreDisjoint()
  ensures {Literal("models"), Literal("decisions"), Literal("chat"), Literal("voice"), Literal("maps")} * {Literal("eliza")} == {}
{
  var earlier := {Literal("models"), Literal("decisions"), Literal("chat"), Literal("voice"), Literal("maps")};
  var later := {Literal("eliza")};
  if earlier * later != {} {
    var prefix :| prefix in earlier * later;
    assert prefix in earlier && prefix in later;
    assert prefix == Literal("models") || prefix == Literal("decisions") || prefix == Literal("chat") || prefix == Literal("voice") || prefix == Literal("maps");
    assert prefix == Literal("eliza");
    assert false;
  }
}

lemma AccountRouteKeyFacts()
  ensures ProofLib.DistinctBy(joinRouteGroups(signInRoutes, billingRoutes), (d: DeviceRoute) => (d.method_, d.path))
  ensures forall d :: d in joinRouteGroups(signInRoutes, billingRoutes) ==> |d.path| > 2 && d.path[2] in {Literal("service"), Literal("auth"), Literal("user"), Literal("referrals"), Literal("app-auth"), Literal("api-keys")} + {Literal("subscriptions"), Literal("subscription"), Literal("billing")}
{
  hide *;
  reveal joinRouteGroups();
  SignInRouteKeyFacts();
  BillingRouteKeyFacts();
  AccountNamespacesAreDisjoint();
  AppendDisjointRouteGroups(signInRoutes, billingRoutes, {Literal("service"), Literal("auth"), Literal("user"), Literal("referrals"), Literal("app-auth"), Literal("api-keys")}, {Literal("subscriptions"), Literal("subscription"), Literal("billing")});
}

lemma CapabilityRouteKeyFacts()
  ensures ProofLib.DistinctBy(joinRouteGroups(serviceRoutes, googleRoutes), (d: DeviceRoute) => (d.method_, d.path))
  ensures forall d :: d in joinRouteGroups(serviceRoutes, googleRoutes) ==> |d.path| > 2 && d.path[2] in {Literal("models"), Literal("decisions"), Literal("chat"), Literal("voice"), Literal("maps")} + {Literal("eliza")}
{
  hide *;
  reveal joinRouteGroups();
  ServiceRouteKeyFacts();
  GoogleRouteKeyFacts();
  CapabilityNamespacesAreDisjoint();
  AppendDisjointRouteGroups(serviceRoutes, googleRoutes, {Literal("models"), Literal("decisions"), Literal("chat"), Literal("voice"), Literal("maps")}, {Literal("eliza")});
}

lemma DeviceRouteKeysAreDistinct()
  ensures ProofLib.DistinctBy(deviceRoutes, (d: DeviceRoute) => (d.method_, d.path))
{
  var accounts := joinRouteGroups(signInRoutes, billingRoutes);
  var capabilities := joinRouteGroups(serviceRoutes, googleRoutes);
  var accountNames := {Literal("service"), Literal("auth"), Literal("user"), Literal("referrals"), Literal("app-auth"), Literal("api-keys")} + {Literal("subscriptions"), Literal("subscription"), Literal("billing")};
  var capabilityNames := {Literal("models"), Literal("decisions"), Literal("chat"), Literal("voice"), Literal("maps")} + {Literal("eliza")};
  AccountRouteKeyFacts();
  CapabilityRouteKeyFacts();
  GroupedNamespacesAreDisjoint();
  AppendDisjointRouteGroups(accounts, capabilities, accountNames, capabilityNames);
  assert deviceRoutes == accounts + capabilities;
}

lemma RouteUniquenessFilter(method_: HttpMethod)
  ensures lawNoRouteIsListedTwice(method_) ==
    !((exists d :: d in routesOf(method_) && !((|ProofLib.Filter((other: DeviceRoute) => (other.path == d.path), routesOf(method_))| == 1))))
{}

lemma DistinctMethodRoutesHaveOnePathMatch(method_: HttpMethod)
  requires ProofLib.DistinctBy(routesOf(method_), (d: DeviceRoute) => (d.method_, d.path))
  ensures lawNoRouteIsListedTwice(method_)
{
  var forMethod := (d: DeviceRoute) => (d.method_ == method_);
  var routeKey := (d: DeviceRoute) => (d.method_, d.path);
  var rows := routesOf(method_);
  RoutesForMethod(method_);
  forall d | d in rows
    ensures |ProofLib.Filter((other: DeviceRoute) => (other.path == d.path), rows)| == 1
  {
    var i :| 0 <= i < |rows| && rows[i] == d;
    var samePath := (other: DeviceRoute) => (other.path == d.path);
    ProofLib.FilterMember(forMethod, deviceRoutes, d);
    forall j | 0 <= j < |rows| && j != i ensures !samePath(rows[j]) {
      var other := rows[j];
      assert other in rows;
      ProofLib.FilterMember(forMethod, deviceRoutes, other);
      assert routeKey(other) != routeKey(d);
    }
    ProofLib.FilterOne(samePath, rows, i);
  }
  RouteUniquenessFilter(method_);
}

lemma lawNoRouteIsListedTwice_ensures(method_: HttpMethod)
  ensures (lawNoRouteIsListedTwice(method_) == true)
{
  var forMethod := (d: DeviceRoute) => (d.method_ == method_);
  var routeKey := (d: DeviceRoute) => (d.method_, d.path);
  DeviceRouteKeysAreDistinct();
  RoutesForMethod(method_);
  ProofLib.FilterKeepsDistinctBy(forMethod, deviceRoutes, routeKey);
  DistinctMethodRoutesHaveOnePathMatch(method_);
}
