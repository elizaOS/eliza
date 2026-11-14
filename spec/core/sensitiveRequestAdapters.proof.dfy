lemma SensitiveAdapterAt(r: AdapterRegistry, group: AdapterGroup)
  requires inv(r) && group in r.groups
  ensures adaptersFor(r,group.target) == group.adapters
{
  var found := ProofLib.Filter((g: AdapterGroup) => g.target == group.target,r.groups);
  ProofLib.FilterMember((g: AdapterGroup) => g.target == group.target,r.groups,group);
  assert |found| == 1;
  assert found[0] == group;
}

lemma SensitiveAdapterAppend(before: seq<Adapter>, after: seq<Adapter>, incoming: Adapter)
  requires after == before + [incoming] && incoming.objectId > 0
  requires forall a :: a in before ==> (a.objectId > 0 && a.objectId != incoming.objectId &&
    |ProofLib.Filter((other: Adapter) => other.objectId == a.objectId,before)| == 1)
  ensures forall a :: a in after ==> a.objectId > 0 && |ProofLib.Filter((other: Adapter) => other.objectId == a.objectId,after)| == 1
{
  forall a | a in after
    ensures a.objectId > 0 && |ProofLib.Filter((other: Adapter) => other.objectId == a.objectId,after)| == 1
  {
    if a == incoming { ProofLib.FilterOne((other: Adapter) => other.objectId == a.objectId,after,|before|); }
    else {
      assert a in before;
      ProofLib.FilterAppend((other: Adapter) => other.objectId == a.objectId,before,incoming);
    }
  }
}

lemma SensitiveAdapterMap(r: AdapterRegistry,t: AdapterRegistry,target: DeliveryTarget,adapter: Adapter)
  requires inv(r) && adapter.objectId > 0
  requires !(exists a :: a in adaptersFor(r,target) && a.objectId == adapter.objectId)
  requires |r.groups| == |t.groups|
  requires forall i :: 0 <= i < |r.groups| ==> (t.groups[i] ==
    (if r.groups[i].target == target then r.groups[i].(adapters := r.groups[i].adapters + [adapter]) else r.groups[i]))
  ensures inv(t)
{
  forall group | group in t.groups
    ensures |group.adapters| > 0 && |ProofLib.Filter((other: AdapterGroup) => other.target == group.target,t.groups)| == 1
    ensures forall a :: a in group.adapters ==> a.objectId > 0 && |ProofLib.Filter((other: Adapter) => other.objectId == a.objectId,group.adapters)| == 1
  {
    var i :| 0 <= i < |t.groups| && t.groups[i] == group;
    var prior := r.groups[i];
    assert prior in r.groups && prior.target == group.target;
    ProofLib.FilterLengthPointwise((other: AdapterGroup) => other.target == prior.target,(other: AdapterGroup) => other.target == group.target,r.groups,t.groups);
    if group.target == target {
      SensitiveAdapterAt(r,prior);
      SensitiveAdapterAppend(prior.adapters,group.adapters,adapter);
    }
  }
}

lemma SensitiveAdapterGroupAppend(r: AdapterRegistry,t: AdapterRegistry,group: AdapterGroup)
  requires inv(r) && t.groups == r.groups + [group] && |group.adapters| == 1 && group.adapters[0].objectId > 0
  requires !(exists oldGroup :: oldGroup in r.groups && oldGroup.target == group.target)
  ensures inv(t)
{
  SensitiveAdapterAppend([],group.adapters,group.adapters[0]);
  forall current | current in t.groups
    ensures |current.adapters| > 0 && |ProofLib.Filter((other: AdapterGroup) => other.target == current.target,t.groups)| == 1
    ensures forall a :: a in current.adapters ==> a.objectId > 0 && |ProofLib.Filter((other: Adapter) => other.objectId == a.objectId,current.adapters)| == 1
  {
    if current == group { ProofLib.FilterOne((other: AdapterGroup) => other.target == current.target,t.groups,|r.groups|); }
    else {
      assert current in r.groups;
      ProofLib.FilterAppend((other: AdapterGroup) => other.target == current.target,r.groups,group);
    }
  }
}

lemma SensitiveChooseResult(adapters: seq<Adapter>, base: AdapterResolution,supports: seq<int>,throws: seq<int>)
  ensures var final := Std.Collections.Seq.FoldLeft((acc: AdapterResolution, a: Adapter) => chooseAdapter(supports,throws,acc,a),base,adapters);
    final.chosen == 0 || final.chosen == base.chosen || (exists a :: a in adapters && a.objectId == final.chosen)
  decreases |adapters|
{
  reveal Std.Collections.Seq.FoldLeft();
  if |adapters| > 0 {
    var head := adapters[0];
    var tail := adapters[1..];
    var moved := chooseAdapter(supports,throws,base,head);
    assert moved.chosen == 0 || moved.chosen == base.chosen || moved.chosen == head.objectId;
    SensitiveChooseResult(tail,moved,supports,throws);
  }
}

lemma SensitiveRejectAll(adapters: seq<Adapter>)
  requires forall a :: a in adapters ==> a.hasSupports
  ensures Std.Collections.Seq.FoldLeft((acc: AdapterResolution, a: Adapter) => chooseAdapter([],[],acc,a),noResolution,adapters) == noResolution
  decreases |adapters|
{
  reveal Std.Collections.Seq.FoldLeft();
  if |adapters| > 0 {
    assert adapters[0] in adapters;
    assert chooseAdapter([],[],noResolution,adapters[0]) == noResolution;
    SensitiveRejectAll(adapters[1..]);
  }
}

lemma register_ensures(r: AdapterRegistry, target: DeliveryTarget, adapter: Adapter)
  ensures (inv(r) ==> canRegister(r, target, adapter) ==> alwaysTargetOrderIsUnique(register(r, target, adapter)))
  ensures (inv(r) ==> canRegister(r, target, adapter) ==> alwaysObjectRegistrationIsIdempotent(register(r, target, adapter)))
{
  if inv(r) && canRegister(r,target,adapter) && !(exists current :: current in adaptersFor(r,target) && current.objectId == adapter.objectId) {
    var t := register(r,target,adapter);
    if exists oldGroup :: oldGroup in r.groups && oldGroup.target == target {
      SensitiveAdapterMap(r,t,target,adapter);
    } else {
      SensitiveAdapterGroupAppend(r,t,AdapterGroup(target,[adapter]));
    }
  }
}

lemma unregister_ensures(r: AdapterRegistry, target: DeliveryTarget)
  ensures (inv(r) ==> alwaysTargetOrderIsUnique(unregister(r, target)))
  ensures (inv(r) ==> alwaysObjectRegistrationIsIdempotent(unregister(r, target)))
{
  if inv(r) {
    var t := unregister(r,target);
    forall g | g in t.groups
      ensures |g.adapters| > 0 && |ProofLib.Filter((other: AdapterGroup) => other.target == g.target,t.groups)| == 1
      ensures forall a :: a in g.adapters ==> a.objectId > 0 && |ProofLib.Filter((other: Adapter) => other.objectId == a.objectId,g.adapters)| == 1
    {
      ProofLib.FilterMember((group: AdapterGroup) => group.target != target,r.groups,g);
      ProofLib.FilterOfFilterLength((group: AdapterGroup) => group.target != target,(other: AdapterGroup) => other.target == g.target,(other: AdapterGroup) => other.target == g.target,r.groups);
      ProofLib.FilterMember((other: AdapterGroup) => other.target == g.target,t.groups,g);
      assert g in ProofLib.Filter((other: AdapterGroup) => other.target == g.target,t.groups);
    }
  }
}

lemma lawResolvedAdapterIsRegistered_ensures(r: AdapterRegistry, target: DeliveryTarget, supports: seq<int>, throws: seq<int>)
  ensures (lawResolvedAdapterIsRegistered(r, target, supports, throws) == true)
{
  var entries := adaptersFor(r,target);
  SensitiveChooseResult(entries,noResolution,supports,throws);
  var found := Std.Collections.Seq.FoldLeft((acc: AdapterResolution, a: Adapter) => chooseAdapter(supports,throws,acc,a),noResolution,entries);
  if found.chosen == 0 && !found.failed && |entries| > 0 {
    assert entries[|entries|-1] in entries;
  }
}

lemma lawAllRejectFallBackToLatest_ensures(r: AdapterRegistry, target: DeliveryTarget)
  ensures (lawAllRejectFallBackToLatest(r, target) == true)
{
  if forall a :: a in adaptersFor(r,target) ==> a.hasSupports {
    SensitiveRejectAll(adaptersFor(r,target));
  }
}
