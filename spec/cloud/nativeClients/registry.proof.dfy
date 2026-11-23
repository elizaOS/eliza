lemma lawRegisteringNeverChangesAnotherClient_ensures(registry: seq<Registration>, served: cloud__deployment_Environment, request: ClientRequest, r: Registration)
  ensures (lawRegisteringNeverChangesAnotherClient(registry, served, request, r) == true)
{
  if request.clientId != r.clientId {
    var keep := (x: Registration) => (x.clientId != r.clientId);
    var mine := (x: Registration) => ((x.clientId == request.clientId) && (x.environment == served));
    assert withRegistration(registry, r) == ProofLib.Filter(keep, registry) + [r];
    ProofLib.FilterAppend(mine, ProofLib.Filter(keep, registry), r);
    FilterWithinFilter(mine, keep, registry);
    assert registrationsFor(withRegistration(registry, r), served, request.clientId) == ProofLib.Filter(mine, withRegistration(registry, r));
    assert registrationsFor(registry, served, request.clientId) == ProofLib.Filter(mine, registry);
    assert registrationsFor(withRegistration(registry, r), served, request.clientId) == registrationsFor(registry, served, request.clientId);
  }
}

lemma lawDisablingKeepsTheRegistryValid_ensures(registry: seq<Registration>, served: cloud__deployment_Environment, clientId: string)
  ensures (lawDisablingKeepsTheRegistryValid(registry, served, clientId) == true)
{
  if registryValid(registry, served) {
    var after := disableClient(registry, clientId);
    ValidRegistryPairwise(registry, served);
    forall i | 0 <= i < |after| ensures after[i].environment == served && registrationValid(after[i]) {
      assert registry[i] in registry;
      assert returnsOf(after[i]) == returnsOf(registry[i]);
    }
    forall i, j | 0 <= i < |after| && 0 <= j < |after| && i != j ensures sharesNothing(after[i], after[j]) {
      assert returnsOf(after[i]) == returnsOf(registry[i]);
      assert returnsOf(after[j]) == returnsOf(registry[j]);
    }
    PairwiseRegistryValid(after, served);
  }
}

lemma lawADisabledClientIsNeverAdmitted_ensures(registry: seq<Registration>, served: cloud__deployment_Environment, request: ClientRequest)
  ensures (lawADisabledClientIsNeverAdmitted(registry, served, request) == true)
{
  var after := disableClient(registry, request.clientId);
  var mine := (x: Registration) => ((x.clientId == request.clientId) && (x.environment == served));
  var found := registrationsFor(after, served, request.clientId);
  assert found == ProofLib.Filter(mine, after);
  if request.environment == served && |found| > 0 {
    ProofLib.FilterMember(mine, after, found[0]);
    var i :| 0 <= i < |after| && after[i] == found[0];
    assert !found[0].enabled;
  }
}

lemma lawAReturnBelongsToOneRegistration_ensures(registry: seq<Registration>, served: cloud__deployment_Environment, url: ReturnUrl)
  ensures (lawAReturnBelongsToOneRegistration(registry, served, url) == true)
{
  if registryValid(registry, served) {
    var live := (x: Registration) => (x.enabled && (x.environment == served));
    var shown := ProofLib.Filter(live, registry);
    ValidRegistryPairwise(registry, served);
    ProofLib.FilterSubset(live, registry);
    FilterKeepsPairwise(live, registry, (a: Registration, b: Registration) => sharesNothing(a, b));
    var h := (x: Registration) => entriesAt(x, url);
    var step := (acc: seq<ReturnEntry>, x: Registration) => (acc + entriesAt(x, url));
    forall i | 0 <= i < |shown| ensures |h(shown[i])| <= 1 {
      assert shown[i] in registry;
      EntriesAtMostOne(shown[i], url);
    }
    forall i, j | 0 <= i < j < |shown| ensures |h(shown[i])| == 0 || |h(shown[j])| == 0 {
      if |h(shown[i])| > 0 && |h(shown[j])| > 0 {
        EntriesNameAReturn(shown[i], url);
        EntriesNameAReturn(shown[j], url);
        assert sharesNothing(shown[i], shown[j]);
      }
    }
    FoldConcatAtMostOne(step, h, [], shown);
    assert returnsAt(registry, served, url) == Std.Collections.Seq.FoldLeft(step, [], shown);
  }
}

lemma lawOneStatementPerPackage_ensures(registry: seq<Registration>, served: cloud__deployment_Environment)
  ensures (lawOneStatementPerPackage(registry, served) == true)
{
  if registryValid(registry, served) {
    var live := (x: Registration) => (x.enabled && (x.environment == served));
    var shown := ProofLib.Filter(live, registry);
    var statements := assetStatements(registry, served);
    ValidRegistryPairwise(registry, served);
    assert ProofLib.DistinctBy(registry, (x: Registration) => x.androidPackage);
    ProofLib.FilterKeepsDistinctBy(live, registry, (x: Registration) => x.androidPackage);
    assert |statements| == |shown|;
    assert forall k :: 0 <= k < |statements| ==> statements[k].packageName == shown[k].androidPackage;
    assert ProofLib.DistinctBy(statements, (s: AssetStatement) => s.packageName);
    if exists s :: s in statements && !((|ProofLib.Filter((t: AssetStatement) => (t.packageName == s.packageName), statements)| == 1)) {
      var s :| s in statements && !((|ProofLib.Filter((t: AssetStatement) => (t.packageName == s.packageName), statements)| == 1));
      var i :| 0 <= i < |statements| && statements[i] == s;
      var samePackage := (t: AssetStatement) => (t.packageName == s.packageName);
      var key := (t: AssetStatement) => t.packageName;
      assert forall j :: 0 <= j < |statements| && j != i ==> key(statements[j]) != key(statements[i]);
      ProofLib.FilterCountOneIffUnique(samePackage, statements, key, i);
      assert |ProofLib.Filter(samePackage, statements)| == 1;
      assert false;
    }
  }
}

lemma lawAnUnchangedRegistrationKeepsTheRegistry_ensures(registry: seq<Registration>, r: Registration)
  ensures (lawAnUnchangedRegistrationKeepsTheRegistry(registry, r) == true)
{
  var same := (x: Registration) => (x.clientId == r.clientId);
  var keep := (x: Registration) => (x.clientId != r.clientId);
  if applyAction(registry, r).AppliedSame? && |ProofLib.Filter(same, registry)| == 1 {
    assert r in registry;
    var at :| 0 <= at < |registry| && registry[at] == r;
    FilterSplitLength(same, keep, registry);
    assert withRegistration(registry, r) == ProofLib.Filter(keep, registry) + [r];
    forall x | x in registry ensures x in withRegistration(registry, r) {
      if x.clientId != r.clientId {
        ProofLib.FilterMember(keep, registry, x);
      } else if x != r {
        var j :| 0 <= j < |registry| && registry[j] == x;
        ProofLib.FilterTwo(same, registry, at, j);
      }
    }
  }
}

lemma FilterWithinFilter<T>(p: T -> bool, q: T -> bool, xs: seq<T>)
  requires forall x :: p(x) ==> q(x)
  ensures ProofLib.Filter(p, ProofLib.Filter(q, xs)) == ProofLib.Filter(p, xs)
  decreases |xs|
{
  if |xs| == 0 {
    ProofLib.FilterNil(q, xs);
    ProofLib.FilterNil(p, ProofLib.Filter(q, xs));
    ProofLib.FilterNil(p, xs);
  } else {
    ProofLib.FilterCons(q, xs);
    ProofLib.FilterCons(p, xs);
    FilterWithinFilter(p, q, xs[1..]);
    var rest := ProofLib.Filter(q, xs[1..]);
    if q(xs[0]) {
      ProofLib.FilterCons(p, [xs[0]] + rest);
      assert ([xs[0]] + rest)[1..] == rest;
    } else {
      assert ProofLib.Filter(q, xs) == rest;
    }
  }
}

lemma FilterSplitLength<T>(p: T -> bool, q: T -> bool, xs: seq<T>)
  requires forall x :: q(x) == !p(x)
  ensures |ProofLib.Filter(p, xs)| + |ProofLib.Filter(q, xs)| == |xs|
  decreases |xs|
{
  if |xs| == 0 {
    ProofLib.FilterNil(p, xs);
    ProofLib.FilterNil(q, xs);
  } else {
    ProofLib.FilterCons(p, xs);
    ProofLib.FilterCons(q, xs);
    FilterSplitLength(p, q, xs[1..]);
  }
}

lemma FilterKeepsPairwise<T>(p: T -> bool, xs: seq<T>, rel: (T, T) -> bool)
  requires forall i, j :: 0 <= i < j < |xs| ==> rel(xs[i], xs[j])
  ensures forall i, j :: 0 <= i < j < |ProofLib.Filter(p, xs)| ==> rel(ProofLib.Filter(p, xs)[i], ProofLib.Filter(p, xs)[j])
  decreases |xs|
{
  if |xs| == 0 {
    ProofLib.FilterNil(p, xs);
  } else {
    ProofLib.FilterCons(p, xs);
    var rest := ProofLib.Filter(p, xs[1..]);
    assert forall i, j :: 0 <= i < j < |xs[1..]| ==> xs[1..][i] == xs[i + 1] && xs[1..][j] == xs[j + 1];
    FilterKeepsPairwise(p, xs[1..], rel);
    forall m | 0 <= m < |rest| ensures rel(xs[0], rest[m]) {
      ProofLib.FilterMember(p, xs[1..], rest[m]);
      var n :| 0 <= n < |xs[1..]| && xs[1..][n] == rest[m];
      assert xs[n + 1] == rest[m];
    }
    if p(xs[0]) {
      var all := [xs[0]] + rest;
      forall i, j | 0 <= i < j < |all| ensures rel(all[i], all[j]) {
        if i == 0 {
          assert all[j] == rest[j - 1];
        } else {
          assert all[i] == rest[i - 1] && all[j] == rest[j - 1];
        }
      }
    }
  }
}

lemma PairwiseRegistryValid(registry: seq<Registration>, served: cloud__deployment_Environment)
  requires forall i :: 0 <= i < |registry| ==> registry[i].environment == served && registrationValid(registry[i])
  requires forall i, j :: 0 <= i < |registry| && 0 <= j < |registry| && i != j ==> sharesNothing(registry[i], registry[j])
  ensures registryValid(registry, served)
{
  if !registryValid(registry, served) {
    var a :| a in registry && !((((a.environment == served) && registrationValid(a)) && (|ProofLib.Filter((b: Registration) => !(sharesNothing(a, b)), registry)| == 1)));
    var i :| 0 <= i < |registry| && registry[i] == a;
    var near := (b: Registration) => !(sharesNothing(a, b));
    assert !sharesNothing(a, a);
    ProofLib.FilterOne(near, registry, i);
    assert |ProofLib.Filter((b: Registration) => !(sharesNothing(a, b)), registry)| == 1;
  }
}

lemma ValidRegistryPairwise(registry: seq<Registration>, served: cloud__deployment_Environment)
  requires registryValid(registry, served)
  ensures forall i, j :: 0 <= i < |registry| && 0 <= j < |registry| && i != j ==> sharesNothing(registry[i], registry[j])
{
  forall i, j | 0 <= i < |registry| && 0 <= j < |registry| && i != j
    ensures sharesNothing(registry[i], registry[j])
  {
    var a := registry[i];
    assert a in registry;
    var near := (b: Registration) => !(sharesNothing(a, b));
    assert |ProofLib.Filter(near, registry)| == 1;
    assert !sharesNothing(a, a);
    if !sharesNothing(a, registry[j]) {
      ProofLib.FilterTwo(near, registry, i, j);
    }
  }
}

lemma EntriesNameAReturn(r: Registration, url: ReturnUrl)
  requires |entriesAt(r, url)| > 0
  ensures url in returnsOf(r)
{
  var asks := (p: ReturnPurpose) => hasReturn(r, p, url);
  var purposes := [typed0_cloud__nativeClients__registry(ReturnPurpose.SignInPurpose), typed0_cloud__nativeClients__registry(ReturnPurpose.BillingPurpose), typed0_cloud__nativeClients__registry(ReturnPurpose.ConnectPurpose)];
  assert |ProofLib.Filter(asks, purposes)| > 0;
  ProofLib.FilterNone(asks, purposes);
  var k :| 0 <= k < |purposes| && asks(purposes[k]);
}

lemma EntriesAtMostOne(r: Registration, url: ReturnUrl)
  requires registrationValid(r)
  ensures |entriesAt(r, url)| <= 1
{
  var asks := (p: ReturnPurpose) => hasReturn(r, p, url);
  var purposes := [typed0_cloud__nativeClients__registry(ReturnPurpose.SignInPurpose), typed0_cloud__nativeClients__registry(ReturnPurpose.BillingPurpose), typed0_cloud__nativeClients__registry(ReturnPurpose.ConnectPurpose)];
  var urls := returnsOf(r);
  var isUrl := (v: ReturnUrl) => (v == url);
  forall i, j | 0 <= i < j < 3 && asks(purposes[i]) && asks(purposes[j]) ensures false {
    assert urls[i] == url && urls[j] == url;
    assert url in urls;
    assert |ProofLib.Filter(isUrl, urls)| == 1;
    ProofLib.FilterTwo(isUrl, urls, i, j);
  }
  if forall k :: 0 <= k < 3 ==> !asks(purposes[k]) {
    ProofLib.FilterNone(asks, purposes);
  } else {
    var k :| 0 <= k < 3 && asks(purposes[k]);
    ProofLib.FilterOne(asks, purposes, k);
  }
  assert |entriesAt(r, url)| == |ProofLib.Filter(asks, purposes)|;
}

lemma FoldConcatAtMostOne<A, T>(f: (seq<A>, T) -> seq<A>, h: T -> seq<A>, init: seq<A>, xs: seq<T>)
  requires forall a, x :: f(a, x) == a + h(x)
  requires |init| <= 1
  requires forall i :: 0 <= i < |xs| ==> |h(xs[i])| <= 1
  requires forall i, j :: 0 <= i < j < |xs| ==> |h(xs[i])| == 0 || |h(xs[j])| == 0
  requires |init| == 1 ==> forall i :: 0 <= i < |xs| ==> |h(xs[i])| == 0
  ensures |Std.Collections.Seq.FoldLeft(f, init, xs)| <= 1
  decreases |xs|
{
  if |xs| > 0 {
    assert forall i :: 1 <= i < |xs| ==> xs[i] == xs[1..][i - 1];
    FoldConcatAtMostOne(f, h, f(init, xs[0]), xs[1..]);
  }
}
