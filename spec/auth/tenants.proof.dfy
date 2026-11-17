lemma addRedirect_ensures(s: TenantConfig, actor: TenantActor, entry: RedirectEntry)
  ensures (inv(s) ==> alwaysEntriesListedOnce(addRedirect(s, actor, entry).state))
  ensures (inv(s) ==> alwaysJoinClosedUntilChanged(addRedirect(s, actor, entry).state))
  ensures (inv(s) ==> stepChangesNeedRecentOwnerOrAdmin(s, addRedirect(s, actor, entry).state))
  ensures (inv(s) ==> stepAddingNativeIdKeepsOthers(s, "addRedirect", addRedirect(s, actor, entry).state))
  ensures (inv(s) ==> stepNativeIdsStayWithTheirClient(s, "addRedirect", addRedirect(s, actor, entry).state))
  ensures (inv(s) ==> stepDiscoveryReportsOnlyEnabled(s, "addRedirect", addRedirect(s, actor, entry).state))
  ensures (inv(s) ==> stepRemovalTakesOnlyTheNamedEntry(s, "addRedirect", addRedirect(s, actor, entry).state))
  ensures (inv(s) ==> stepChangeIsAudited(s, addRedirect(s, actor, entry).state, addRedirect(s, actor, entry).out))
{
  if inv(s) {
    var after := addRedirect(s, actor, entry);
    Once(s);
    Once(after.state);
    AddOne(s.redirects, entry.url);
    if !mayChange(actor) || !listable(entry) {
      Unchanged(s, after.state);
    }
  }
}

lemma enableMethod_ensures(s: TenantConfig, actor: TenantActor, method_: string)
  ensures (inv(s) ==> canEnableMethod(s, method_) ==> alwaysEntriesListedOnce(enableMethod(s, actor, method_).state))
  ensures (inv(s) ==> canEnableMethod(s, method_) ==> alwaysJoinClosedUntilChanged(enableMethod(s, actor, method_).state))
  ensures (inv(s) ==> canEnableMethod(s, method_) ==> stepChangesNeedRecentOwnerOrAdmin(s, enableMethod(s, actor, method_).state))
  ensures (inv(s) ==> canEnableMethod(s, method_) ==> stepAddingNativeIdKeepsOthers(s, "enableMethod", enableMethod(s, actor, method_).state))
  ensures (inv(s) ==> canEnableMethod(s, method_) ==> stepNativeIdsStayWithTheirClient(s, "enableMethod", enableMethod(s, actor, method_).state))
  ensures (inv(s) ==> canEnableMethod(s, method_) ==> stepDiscoveryReportsOnlyEnabled(s, "enableMethod", enableMethod(s, actor, method_).state))
  ensures (inv(s) ==> canEnableMethod(s, method_) ==> stepRemovalTakesOnlyTheNamedEntry(s, "enableMethod", enableMethod(s, actor, method_).state))
  ensures (inv(s) ==> canEnableMethod(s, method_) ==> stepChangeIsAudited(s, enableMethod(s, actor, method_).state, enableMethod(s, actor, method_).out))
{
  if inv(s) && canEnableMethod(s, method_) {
    var after := enableMethod(s, actor, method_);
    Once(s);
    Once(after.state);
    AddOne(s.enabledMethods, method_);
    if !mayChange(actor) {
      Unchanged(s, after.state);
    }
  }
}

lemma discover_ensures(s: TenantConfig, request: DiscoveryRequest)
  ensures (inv(s) ==> alwaysEntriesListedOnce(discover(s, request)))
  ensures (inv(s) ==> alwaysJoinClosedUntilChanged(discover(s, request)))
  ensures (inv(s) ==> stepChangesNeedRecentOwnerOrAdmin(s, discover(s, request)))
  ensures (inv(s) ==> stepAddingNativeIdKeepsOthers(s, "discover", discover(s, request)))
  ensures (inv(s) ==> stepNativeIdsStayWithTheirClient(s, "discover", discover(s, request)))
  ensures (inv(s) ==> stepDiscoveryReportsOnlyEnabled(s, "discover", discover(s, request)))
  ensures (inv(s) ==> stepRemovalTakesOnlyTheNamedEntry(s, "discover", discover(s, request)))
  ensures (inv(s) ==> stepChangeIsAudited(s, discover(s, request), []))
{
  if inv(s) {
    var after := discover(s, request);
    Once(s);
    Once(after);
    Unchanged(s, after);
    StepDiscoveryReportsOnlyEnabledFilter(s, "discover", after);
    if discoveryAccepted(request) {
      assert after.reported == ProofLib.Filter((set_x: string) => (set_x in s.enabledMethods), request.asked);
      forall x | x in after.reported ensures x in ProofLib.Filter((set_x: string) => (set_x in after.discovery.asked), s.enabledMethods) {
        ProofLib.FilterMember((set_x: string) => (set_x in s.enabledMethods), request.asked, x);
        ProofLib.FilterMember((set_x: string) => (set_x in after.discovery.asked), s.enabledMethods, x);
      }
    }
  }
}

lemma disableMethod_ensures(s: TenantConfig, actor: TenantActor, method_: string)
  ensures (inv(s) ==> alwaysEntriesListedOnce(disableMethod(s, actor, method_).state))
  ensures (inv(s) ==> alwaysJoinClosedUntilChanged(disableMethod(s, actor, method_).state))
  ensures (inv(s) ==> stepChangesNeedRecentOwnerOrAdmin(s, disableMethod(s, actor, method_).state))
  ensures (inv(s) ==> stepAddingNativeIdKeepsOthers(s, "disableMethod", disableMethod(s, actor, method_).state))
  ensures (inv(s) ==> stepNativeIdsStayWithTheirClient(s, "disableMethod", disableMethod(s, actor, method_).state))
  ensures (inv(s) ==> stepDiscoveryReportsOnlyEnabled(s, "disableMethod", disableMethod(s, actor, method_).state))
  ensures (inv(s) ==> stepRemovalTakesOnlyTheNamedEntry(s, "disableMethod", disableMethod(s, actor, method_).state))
  ensures (inv(s) ==> stepChangeIsAudited(s, disableMethod(s, actor, method_).state, disableMethod(s, actor, method_).out))
{
  if inv(s) {
    var after := disableMethod(s, actor, method_);
    Once(s);
    Once(after.state);
    RemoveOne(s.enabledMethods, method_);
    if !mayChange(actor) || !(method_ in s.enabledMethods) {
      Unchanged(s, after.state);
    }
    StepRemovalTakesOnlyTheNamedEntryFilter(s, "disableMethod", after.state);
  }
}

lemma removeRedirect_ensures(s: TenantConfig, actor: TenantActor, url: string)
  ensures (inv(s) ==> alwaysEntriesListedOnce(removeRedirect(s, actor, url).state))
  ensures (inv(s) ==> alwaysJoinClosedUntilChanged(removeRedirect(s, actor, url).state))
  ensures (inv(s) ==> stepChangesNeedRecentOwnerOrAdmin(s, removeRedirect(s, actor, url).state))
  ensures (inv(s) ==> stepAddingNativeIdKeepsOthers(s, "removeRedirect", removeRedirect(s, actor, url).state))
  ensures (inv(s) ==> stepNativeIdsStayWithTheirClient(s, "removeRedirect", removeRedirect(s, actor, url).state))
  ensures (inv(s) ==> stepDiscoveryReportsOnlyEnabled(s, "removeRedirect", removeRedirect(s, actor, url).state))
  ensures (inv(s) ==> stepRemovalTakesOnlyTheNamedEntry(s, "removeRedirect", removeRedirect(s, actor, url).state))
  ensures (inv(s) ==> stepChangeIsAudited(s, removeRedirect(s, actor, url).state, removeRedirect(s, actor, url).out))
{
  if inv(s) {
    var after := removeRedirect(s, actor, url);
    Once(s);
    Once(after.state);
    RemoveOne(s.redirects, url);
    if !mayChange(actor) || !(url in s.redirects) {
      Unchanged(s, after.state);
    }
    StepRemovalTakesOnlyTheNamedEntryFilter(s, "removeRedirect", after.state);
  }
}

lemma addNativeClientId_ensures(s: TenantConfig, actor: TenantActor, client: string, nativeId: string)
  ensures (inv(s) ==> canAddNativeClientId(s, client, nativeId) ==> alwaysEntriesListedOnce(addNativeClientId(s, actor, client, nativeId).state))
  ensures (inv(s) ==> canAddNativeClientId(s, client, nativeId) ==> alwaysJoinClosedUntilChanged(addNativeClientId(s, actor, client, nativeId).state))
  ensures (inv(s) ==> canAddNativeClientId(s, client, nativeId) ==> stepChangesNeedRecentOwnerOrAdmin(s, addNativeClientId(s, actor, client, nativeId).state))
  ensures (inv(s) ==> canAddNativeClientId(s, client, nativeId) ==> stepAddingNativeIdKeepsOthers(s, "addNativeClientId", addNativeClientId(s, actor, client, nativeId).state))
  ensures (inv(s) ==> canAddNativeClientId(s, client, nativeId) ==> stepNativeIdsStayWithTheirClient(s, "addNativeClientId", addNativeClientId(s, actor, client, nativeId).state))
  ensures (inv(s) ==> canAddNativeClientId(s, client, nativeId) ==> stepDiscoveryReportsOnlyEnabled(s, "addNativeClientId", addNativeClientId(s, actor, client, nativeId).state))
  ensures (inv(s) ==> canAddNativeClientId(s, client, nativeId) ==> stepRemovalTakesOnlyTheNamedEntry(s, "addNativeClientId", addNativeClientId(s, actor, client, nativeId).state))
  ensures (inv(s) ==> canAddNativeClientId(s, client, nativeId) ==> stepChangeIsAudited(s, addNativeClientId(s, actor, client, nativeId).state, addNativeClientId(s, actor, client, nativeId).out))
{
  if inv(s) && canAddNativeClientId(s, client, nativeId) {
    var change := addNativeClientId(s, actor, client, nativeId);
    var after := change.state;
    var c :| c in s.clients && c.id == client;
    var k :| 0 <= k < |s.clients| && s.clients[k] == c;
    AddMapped(s, actor, client, nativeId);
    ClientChange(s, after, client, k);
    AddKeepsOthers(s, after);
    AddStays(s, after, client, k);
    if !mayChange(actor) {
      Unchanged(s, after);
    }
    Audited(s, change);
  }

}

lemma removeNativeClientId_ensures(s: TenantConfig, actor: TenantActor, client: string, nativeId: string)
  ensures (inv(s) ==> canRemoveNativeClientId(s, actor, client, nativeId) ==> alwaysEntriesListedOnce(removeNativeClientId(s, actor, client, nativeId).state))
  ensures (inv(s) ==> canRemoveNativeClientId(s, actor, client, nativeId) ==> alwaysJoinClosedUntilChanged(removeNativeClientId(s, actor, client, nativeId).state))
  ensures (inv(s) ==> canRemoveNativeClientId(s, actor, client, nativeId) ==> stepChangesNeedRecentOwnerOrAdmin(s, removeNativeClientId(s, actor, client, nativeId).state))
  ensures (inv(s) ==> canRemoveNativeClientId(s, actor, client, nativeId) ==> stepAddingNativeIdKeepsOthers(s, "removeNativeClientId", removeNativeClientId(s, actor, client, nativeId).state))
  ensures (inv(s) ==> canRemoveNativeClientId(s, actor, client, nativeId) ==> stepNativeIdsStayWithTheirClient(s, "removeNativeClientId", removeNativeClientId(s, actor, client, nativeId).state))
  ensures (inv(s) ==> canRemoveNativeClientId(s, actor, client, nativeId) ==> stepDiscoveryReportsOnlyEnabled(s, "removeNativeClientId", removeNativeClientId(s, actor, client, nativeId).state))
  ensures (inv(s) ==> canRemoveNativeClientId(s, actor, client, nativeId) ==> stepRemovalTakesOnlyTheNamedEntry(s, "removeNativeClientId", removeNativeClientId(s, actor, client, nativeId).state))
  ensures (inv(s) ==> canRemoveNativeClientId(s, actor, client, nativeId) ==> stepChangeIsAudited(s, removeNativeClientId(s, actor, client, nativeId).state, removeNativeClientId(s, actor, client, nativeId).out))
{
  if inv(s) && canRemoveNativeClientId(s, actor, client, nativeId) {
    var change := removeNativeClientId(s, actor, client, nativeId);
    var after := change.state;
    var c :| c in s.clients && c.id == client;
    var k :| 0 <= k < |s.clients| && s.clients[k] == c;
    RemoveMapped(s, actor, client, nativeId);
    ClientChange(s, after, client, k);
    RemoveNamed(s, after, client, k);
    if !mayChange(actor) || after.result.NoChange? {
      Unchanged(s, after);
    }
    assert change.out == auditEntries(after.result);
    Audited(s, change);
  }

}

lemma initialHolds_ensures()
  ensures inv(initialHolds())
{
  Once(initial);
}

lemma Unchanged(s: TenantConfig, t: TenantConfig)
  requires t.redirects == s.redirects && t.enabledMethods == s.enabledMethods && t.joinMode == s.joinMode && t.clients == s.clients
  ensures !configChanged(s, t)
  ensures sameSet(s.redirects, t.redirects) && sameSet(s.enabledMethods, t.enabledMethods)
{
}

lemma AddOne(xs: seq<string>, x: string)
  requires ProofLib.Distinct(xs)
  ensures ProofLib.Distinct(xs + ProofLib.Filter((set_x: string) => !((set_x in xs)), [x]))
  ensures forall y :: y in xs + ProofLib.Filter((set_x: string) => !((set_x in xs)), [x]) <==> y in xs || y == x
{
  ProofLib.FilterCons((set_x: string) => !((set_x in xs)), [x]);
  ProofLib.FilterNil((set_x: string) => !((set_x in xs)), [x][1..]);
}

lemma RemoveOne(xs: seq<string>, x: string)
  requires ProofLib.Distinct(xs)
  ensures ProofLib.Distinct(ProofLib.Filter((set_x: string) => !((set_x in [x])), xs))
  ensures forall y :: y in ProofLib.Filter((set_x: string) => !((set_x in [x])), xs) <==> y in xs && y != x
  ensures |xs| - |ProofLib.Filter((set_x: string) => !((set_x in [x])), xs)| <= 1
  ensures !(x in xs) ==> ProofLib.Filter((set_x: string) => !((set_x in [x])), xs) == xs
  decreases |xs|
{
  if |xs| == 0 {
    ProofLib.FilterNil((set_x: string) => !((set_x in [x])), xs);
  } else {
    ProofLib.FilterCons((set_x: string) => !((set_x in [x])), xs);
    assert ProofLib.Distinct(xs[1..]);
    RemoveOne(xs[1..], x);
    assert xs == [xs[0]] + xs[1..];
    assert !(xs[0] in xs[1..]);
    if xs[0] != x {
      DistinctCons(xs[0], ProofLib.Filter((set_x: string) => !((set_x in [x])), xs[1..]));
    }
  }
}

lemma Once(s: TenantConfig)
  ensures alwaysEntriesListedOnce(s) <==> ProofLib.Distinct(s.redirects) && ProofLib.Distinct(s.enabledMethods) && ProofLib.DistinctBy(s.clients, (c: AppClient) => c.id) && forall c :: c in s.clients ==> ProofLib.Distinct(c.nativeClientIds)
{
  AlwaysEntriesListedOnceFilter(s);
  StringsOnce(s.redirects);
  StringsOnce(s.enabledMethods);
  forall c | c in s.clients ensures (!((exists i :: i in c.nativeClientIds && !((|ProofLib.Filter((j: string) => (j == i), c.nativeClientIds)| == 1))))) <==> ProofLib.Distinct(c.nativeClientIds) {
    StringsOnce(c.nativeClientIds);
  }
  forall i | 0 <= i < |s.clients|
    ensures |ProofLib.Filter((d: AppClient) => (d.id == s.clients[i].id), s.clients)| == 1 <==> forall j :: 0 <= j < |s.clients| && j != i ==> s.clients[j].id != s.clients[i].id
  {
    ProofLib.FilterCountOneIffUnique((d: AppClient) => (d.id == s.clients[i].id), s.clients, (c: AppClient) => c.id, i);
  }
  if !ProofLib.DistinctBy(s.clients, (c: AppClient) => c.id) {
    var i, j :| 0 <= i < |s.clients| && 0 <= j < |s.clients| && i != j && s.clients[i].id == s.clients[j].id;
    assert s.clients[i] in s.clients;
  } else {
    forall c | c in s.clients ensures |ProofLib.Filter((d: AppClient) => (d.id == c.id), s.clients)| == 1 {
      var i :| 0 <= i < |s.clients| && s.clients[i] == c;
    }
  }
}

lemma StringsOnce(xs: seq<string>)
  ensures (!((exists u :: u in xs && !((|ProofLib.Filter((v: string) => (v == u), xs)| == 1))))) <==> ProofLib.Distinct(xs)
  ensures (!((exists m :: m in xs && !((|ProofLib.Filter((n: string) => (n == m), xs)| == 1))))) <==> ProofLib.Distinct(xs)
  ensures (!((exists i :: i in xs && !((|ProofLib.Filter((j: string) => (j == i), xs)| == 1))))) <==> ProofLib.Distinct(xs)
{
  forall k | 0 <= k < |xs|
    ensures |ProofLib.Filter((v: string) => (v == xs[k]), xs)| == 1 <==> forall j :: 0 <= j < |xs| && j != k ==> xs[j] != xs[k]
  {
    ProofLib.FilterCountOneIffUnique((v: string) => (v == xs[k]), xs, (x: string) => x, k);
  }
  forall u | u in xs
    ensures ProofLib.Filter((n: string) => (n == u), xs) == ProofLib.Filter((v: string) => (v == u), xs)
    ensures ProofLib.Filter((j: string) => (j == u), xs) == ProofLib.Filter((v: string) => (v == u), xs)
  {
    ProofLib.FilterSamePredicate((n: string) => (n == u), (v: string) => (v == u), xs);
    ProofLib.FilterSamePredicate((j: string) => (j == u), (v: string) => (v == u), xs);
  }
  if ProofLib.Distinct(xs) {
    forall u | u in xs ensures |ProofLib.Filter((v: string) => (v == u), xs)| == 1 {
      var k :| 0 <= k < |xs| && xs[k] == u;
    }
  } else {
    var i, j :| 0 <= i < j < |xs| && xs[i] == xs[j];
    assert xs[i] in xs;
  }
}

lemma DistinctCons(a: string, r: seq<string>)
  requires ProofLib.Distinct(r) && !(a in r)
  ensures ProofLib.Distinct([a] + r)
{
  forall i, j | 0 <= i < j < |[a] + r| ensures ([a] + r)[i] != ([a] + r)[j] {
    assert ([a] + r)[j] == r[j - 1];
    if i > 0 {
      assert ([a] + r)[i] == r[i - 1];
    }
  }
}

lemma AddMapped(s: TenantConfig, actor: TenantActor, client: string, nativeId: string)
  requires alwaysEntriesListedOnce(s)
  ensures var after := addNativeClientId(s, actor, client, nativeId).state;
    after.redirects == s.redirects && after.enabledMethods == s.enabledMethods && after.joinMode == s.joinMode && |after.clients| == |s.clients| &&
    forall i :: 0 <= i < |s.clients| ==> (after.clients[i].id == s.clients[i].id && (s.clients[i].id != client ==> after.clients[i] == s.clients[i]) &&
      ProofLib.Distinct(after.clients[i].nativeClientIds) && forall x :: x in s.clients[i].nativeClientIds ==> x in after.clients[i].nativeClientIds)
{
  var after := addNativeClientId(s, actor, client, nativeId).state;
  Once(s);
  forall i | 0 <= i < |s.clients|
    ensures after.clients[i].id == s.clients[i].id && (s.clients[i].id != client ==> after.clients[i] == s.clients[i])
    ensures ProofLib.Distinct(after.clients[i].nativeClientIds) && forall x :: x in s.clients[i].nativeClientIds ==> x in after.clients[i].nativeClientIds
  {
    assert s.clients[i] in s.clients;
    AddOne(s.clients[i].nativeClientIds, nativeId);
  }
}

lemma RemoveMapped(s: TenantConfig, actor: TenantActor, client: string, nativeId: string)
  requires alwaysEntriesListedOnce(s)
  ensures var after := removeNativeClientId(s, actor, client, nativeId).state;
    after.redirects == s.redirects && after.enabledMethods == s.enabledMethods && after.joinMode == s.joinMode && after.joinChanged == s.joinChanged && |after.clients| == |s.clients| &&
    (after.result.NoChange? ==> after.clients == s.clients) &&
    (after.result.NativeIdRemoved? || after.result.NoChange? || after.result.ChangeRefused?) &&
    forall i :: 0 <= i < |s.clients| ==> (after.clients[i].id == s.clients[i].id && (s.clients[i].id != client ==> after.clients[i] == s.clients[i]) &&
      ProofLib.Distinct(after.clients[i].nativeClientIds) && removedAtMostOne(s.clients[i].nativeClientIds, after.clients[i].nativeClientIds))
{
  var after := removeNativeClientId(s, actor, client, nativeId).state;
  var present := exists c :: c in s.clients && ((c.id == client) && (nativeId in c.nativeClientIds));
  Once(s);
  forall i | 0 <= i < |s.clients|
    ensures after.clients[i].id == s.clients[i].id && (s.clients[i].id != client ==> after.clients[i] == s.clients[i])
    ensures ProofLib.Distinct(after.clients[i].nativeClientIds) && removedAtMostOne(s.clients[i].nativeClientIds, after.clients[i].nativeClientIds)
    ensures !present ==> after.clients[i] == s.clients[i]
  {
    assert s.clients[i] in s.clients;
    RemoveOne(s.clients[i].nativeClientIds, nativeId);
  }
  if after.result.NoChange? {
    assert after.clients == s.clients;
  }
}

lemma ClientChange(s: TenantConfig, after: TenantConfig, client: string, k: int)
  requires alwaysEntriesListedOnce(s)
  requires after.redirects == s.redirects && after.enabledMethods == s.enabledMethods && |after.clients| == |s.clients|
  requires 0 <= k < |s.clients| && s.clients[k].id == client
  requires forall i :: 0 <= i < |s.clients| ==> after.clients[i].id == s.clients[i].id && (s.clients[i].id != client ==> after.clients[i] == s.clients[i]) && ProofLib.Distinct(after.clients[i].nativeClientIds)
  ensures alwaysEntriesListedOnce(after)
  ensures |ProofLib.Filter((d: AppClient) => d.id == client, after.clients)| == 1
  ensures forall c, i :: c in s.clients && 0 <= i < |s.clients| && c.id == s.clients[i].id ==> c == s.clients[i]
{
  Once(s);
  Once(after);
  forall c, i | c in s.clients && 0 <= i < |s.clients| && c.id == s.clients[i].id ensures c == s.clients[i] {
    var j :| 0 <= j < |s.clients| && s.clients[j] == c;
  }
  forall c | c in after.clients ensures ProofLib.Distinct(c.nativeClientIds) {
    var j :| 0 <= j < |after.clients| && after.clients[j] == c;
  }
  ProofLib.FilterOne((d: AppClient) => d.id == client, after.clients, k);
}

lemma AddKeepsOthers(s: TenantConfig, after: TenantConfig)
  requires |after.clients| == |s.clients|
  requires forall i :: 0 <= i < |s.clients| ==> after.clients[i].id == s.clients[i].id && forall x :: x in s.clients[i].nativeClientIds ==> x in after.clients[i].nativeClientIds
  ensures stepAddingNativeIdKeepsOthers(s, "addNativeClientId", after)
{
  forall c | c in s.clients ensures exists d :: d in after.clients && d.id == c.id && forall x :: x in c.nativeClientIds ==> x in d.nativeClientIds {
    var i :| 0 <= i < |s.clients| && s.clients[i] == c;
    assert after.clients[i] in after.clients;
  }
}

lemma AddStays(s: TenantConfig, after: TenantConfig, client: string, k: int)
  requires |after.clients| == |s.clients|
  requires forall i :: 0 <= i < |s.clients| ==> after.clients[i].id == s.clients[i].id && (s.clients[i].id != client ==> after.clients[i] == s.clients[i])
  requires |ProofLib.Filter((d: AppClient) => d.id == client, after.clients)| == 1
  requires forall c, i :: c in s.clients && 0 <= i < |s.clients| && c.id == s.clients[i].id ==> c == s.clients[i]
  ensures stepNativeIdsStayWithTheirClient(s, "addNativeClientId", after)
{
  StepNativeIdsStayWithTheirClientFilter(s, "addNativeClientId", after);
  ProofLib.FilterImpLength((d: AppClient) => (exists c :: c in s.clients && ((c.id == d.id) && !(!((exists set_x :: set_x in d.nativeClientIds && !((set_x in c.nativeClientIds))))))), (d: AppClient) => d.id == client, after.clients);
}

lemma RemoveNamed(s: TenantConfig, after: TenantConfig, client: string, k: int)
  requires after.redirects == s.redirects && after.enabledMethods == s.enabledMethods && after.joinMode == s.joinMode && |after.clients| == |s.clients|
  requires after.result.NoChange? ==> after.clients == s.clients
  requires forall i :: 0 <= i < |s.clients| ==> after.clients[i].id == s.clients[i].id && (s.clients[i].id != client ==> after.clients[i] == s.clients[i]) && removedAtMostOne(s.clients[i].nativeClientIds, after.clients[i].nativeClientIds)
  requires |ProofLib.Filter((d: AppClient) => d.id == client, after.clients)| == 1
  requires forall c, i :: c in s.clients && 0 <= i < |s.clients| && c.id == s.clients[i].id ==> c == s.clients[i]
  ensures stepRemovalTakesOnlyTheNamedEntry(s, "removeNativeClientId", after)
{
  StepRemovalTakesOnlyTheNamedEntryFilter(s, "removeNativeClientId", after);
  ProofLib.FilterImpLength((d: AppClient) => (exists c :: c in s.clients && ((c.id == d.id) && !(sameSet(c.nativeClientIds, d.nativeClientIds)))), (d: AppClient) => d.id == client, after.clients);
  forall c | c in s.clients ensures exists d :: d in after.clients && d.id == c.id && removedAtMostOne(c.nativeClientIds, d.nativeClientIds) {
    var i :| 0 <= i < |s.clients| && s.clients[i] == c;
    assert after.clients[i] in after.clients;
  }
  if after.result.NoChange? {
    Unchanged(s, after);
  }
}
lemma AlwaysEntriesListedOnceFilter(s: TenantConfig)
  ensures alwaysEntriesListedOnce(s) == ((!((exists u :: u in s.redirects && !((|ProofLib.Filter((v: string) => (v == u), s.redirects)| == 1)))) && !((exists m :: m in s.enabledMethods && !((|ProofLib.Filter((n: string) => (n == m), s.enabledMethods)| == 1))))) && !((exists c :: c in s.clients && !(((|ProofLib.Filter((d: AppClient) => (d.id == c.id), s.clients)| == 1) && !((exists i :: i in c.nativeClientIds && !((|ProofLib.Filter((j: string) => (j == i), c.nativeClientIds)| == 1)))))))))
{
}

lemma StepNativeIdsStayWithTheirClientFilter(before: TenantConfig, via: string, after: TenantConfig)
  ensures stepNativeIdsStayWithTheirClient(before, via, after) == (!((via == "addNativeClientId")) || (|ProofLib.Filter((d: AppClient) => (exists c :: c in before.clients && ((c.id == d.id) && !(!((exists set_x :: set_x in d.nativeClientIds && !((set_x in c.nativeClientIds))))))), after.clients)| <= 1))
{
}

lemma StepRemovalTakesOnlyTheNamedEntryFilter(before: TenantConfig, via: string, after: TenantConfig)
  ensures stepRemovalTakesOnlyTheNamedEntry(before, via, after) == ((((!((via == "removeRedirect")) || removedAtMostOne(before.redirects, after.redirects)) && (!((via == "disableMethod")) || removedAtMostOne(before.enabledMethods, after.enabledMethods))) && (!((via == "removeNativeClientId")) || (((|after.clients| == |before.clients|) && (|ProofLib.Filter((d: AppClient) => (exists c :: c in before.clients && ((c.id == d.id) && !(sameSet(c.nativeClientIds, d.nativeClientIds)))), after.clients)| <= 1)) && !((exists c :: c in before.clients && !((exists d :: d in after.clients && ((d.id == c.id) && removedAtMostOne(c.nativeClientIds, d.nativeClientIds))))))))) && (!(after.result.NoChange?) || !(configChanged(before, after))))
{
}

lemma StepDiscoveryReportsOnlyEnabledFilter(before: TenantConfig, via: string, after: TenantConfig)
  ensures stepDiscoveryReportsOnlyEnabled(before, via, after) == (!((via == "discover")) || (!((exists set_x :: set_x in after.reported && !((set_x in ProofLib.Filter((set_x: string) => (set_x in after.discovery.asked), before.enabledMethods))))) && (!(!(discoveryAccepted(after.discovery))) || (|after.reported| == 0))))
{
}


lemma Audited(s: TenantConfig, change: TenantChange)
  requires change.out == auditEntries(change.state.result)
  requires change.state.result.ChangeApplied? || change.state.result.NativeIdRemoved? || (!configChanged(s, change.state) && (change.state.result.ChangeRefused? || change.state.result.NoChange?))
  ensures stepChangeIsAudited(s, change.state, change.out)
{
}
