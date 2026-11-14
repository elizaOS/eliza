lemma ProviderDomainsIdentityFilters(s: ProviderExecutions)
  ensures alwaysDomainIdentity(s) ==
    (s.nextDomain > 0 && forall d :: d in s.domains ==> (d.id > 0 && d.id < s.nextDomain && |ProofLib.Filter((other: ProviderDomain) => (other.id == d.id), s.domains)| == 1))
{}

lemma ProviderDomainsKeyFilters(s: ProviderExecutions)
  ensures alwaysKeyedDomainsUnique(s) ==
    (forall d :: d in s.domains && d.keyed ==>
      |ProofLib.Filter((other: ProviderDomain) => (other.keyed && sameProviderKey(d.key, other.key)), s.domains)| == 1)
{}

lemma ProviderDomainLookupProjection(s: ProviderExecutions, domainId: int)
  ensures providerDomain(s, domainId) ==
    (var matches := ProofLib.Filter((d: ProviderDomain) => (d.id == domainId), s.domains); if |matches| > 0 then matches[0] else absentDomain)
{}

lemma ProviderDomainLookup(s: ProviderExecutions, domainId: int)
  requires alwaysDomainIdentity(s)
  ensures providerDomain(s, domainId).id != 0 ==> providerDomain(s, domainId) in s.domains && providerDomain(s, domainId).id == domainId
  ensures providerDomain(s, domainId).id == 0 ==> providerDomain(s, domainId) == absentDomain
  ensures forall d :: d in s.domains && d.id == domainId ==> d == providerDomain(s, domainId)
{
  ProviderDomainsIdentityFilters(s);
  ProviderDomainLookupProjection(s, domainId);
  var matches := ProofLib.Filter((d: ProviderDomain) => (d.id == domainId), s.domains);
  if |matches| > 0 {
    ProofLib.FilterMember((d: ProviderDomain) => (d.id == domainId), s.domains, matches[0]);
    assert matches[0].id > 0;
  }
  forall d | d in s.domains && d.id == domainId ensures d == providerDomain(s, domainId)
  {
    ProofLib.FilterMember((d: ProviderDomain) => (d.id == domainId), s.domains, d);
    ProofLib.FilterSamePredicate((d: ProviderDomain) => (d.id == domainId), (other: ProviderDomain) => (other.id == d.id), s.domains);
    assert |matches| == 1 && matches[0] == d;
  }
}

lemma ProviderDomainsStableIdentities(s: ProviderExecutions, after: ProviderExecutions)
  requires alwaysDomainIdentity(s) && alwaysKeyedDomainsUnique(s)
  requires s.nextDomain == after.nextDomain && |s.domains| == |after.domains|
  requires forall i :: 0 <= i < |s.domains| ==>
    (s.domains[i].id == after.domains[i].id && s.domains[i].key == after.domains[i].key && s.domains[i].keyed == after.domains[i].keyed)
  ensures alwaysDomainIdentity(after) && alwaysKeyedDomainsUnique(after)
{
  ProviderDomainsIdentityFilters(s);
  ProviderDomainsIdentityFilters(after);
  ProviderDomainsKeyFilters(s);
  ProviderDomainsKeyFilters(after);
  forall d | d in after.domains
    ensures d.id > 0 && d.id < after.nextDomain && |ProofLib.Filter((other: ProviderDomain) => (other.id == d.id), after.domains)| == 1
  {
    var i :| 0 <= i < |after.domains| && after.domains[i] == d;
    assert s.domains[i] in s.domains;
    ProofLib.FilterLengthPointwise((other: ProviderDomain) => (other.id == d.id), (other: ProviderDomain) => (other.id == d.id), s.domains, after.domains);
  }
  forall d | d in after.domains && d.keyed
    ensures |ProofLib.Filter((other: ProviderDomain) => (other.keyed && sameProviderKey(d.key, other.key)), after.domains)| == 1
  {
    var i :| 0 <= i < |after.domains| && after.domains[i] == d;
    var previousDomain := s.domains[i];
    assert previousDomain in s.domains && previousDomain.keyed && previousDomain.key == d.key;
    var byKey := (other: ProviderDomain) => (other.keyed && sameProviderKey(d.key, other.key));
    ProofLib.FilterLengthPointwise(byKey, byKey, s.domains, after.domains);
  }
}

lemma ProviderDomainChildInvariant(s: ProviderExecutions, domain: ProviderDomain)
  requires alwaysEveryDomainValid(s) && domain in s.domains
  ensures core__providers_inv(domain.unit)
{}

lemma ProviderDomainsSameSettlement(s: ProviderExecutions, after: ProviderExecutions)
  requires alwaysDomainIdentity(s) && alwaysDomainIdentity(after)
  requires alwaysSettledWorkOwnsCleanup(s) && s.pendingCleanup == after.pendingCleanup
  requires |s.domains| == |after.domains|
  requires forall i :: 0 <= i < |s.domains| ==>
    (s.domains[i].id == after.domains[i].id && |s.domains[i].unit.works| == |after.domains[i].unit.works| &&
      (forall j :: 0 <= j < |s.domains[i].unit.works| ==>
        (s.domains[i].unit.works[j].id == after.domains[i].unit.works[j].id &&
          s.domains[i].unit.works[j].phase.WorkSettled? == after.domains[i].unit.works[j].phase.WorkSettled?)))
  ensures alwaysSettledWorkOwnsCleanup(after)
{
  forall p | p in after.pendingCleanup ensures canCleanProvider(after, p.domain, p.work)
  {
    ProviderDomainLookup(s, p.domain);
    var original := providerDomain(s, p.domain);
    assert core__providers_canCleanWork(original.unit, p.work);
    if original.id == 0 {
      assert original == absentDomain && absentDomain.unit == core__providers_initial;
      assert !core__providers_canCleanWork(core__providers_initial, p.work);
      assert false;
    }
    assert original.id != 0;
    assert original in s.domains;
    var i :| 0 <= i < |s.domains| && s.domains[i] == original;
    assert after.domains[i] in after.domains;
    ProviderDomainLookup(after, p.domain);
    assert providerDomain(after, p.domain) == after.domains[i];
    ProviderDomainWorkMap(original.unit, after.domains[i].unit, p.work);
  }
  forall d | d in after.domains
    ensures (forall w :: w in d.unit.works && w.phase.WorkSettled? ==> (exists p :: p in after.pendingCleanup && p.domain == d.id && p.work == w.id))
  {
    var i :| 0 <= i < |after.domains| && after.domains[i] == d;
    var original := s.domains[i];
    assert original in s.domains;
    forall w | w in d.unit.works && w.phase.WorkSettled?
      ensures (exists p :: p in after.pendingCleanup && p.domain == d.id && p.work == w.id)
    {
      var j :| 0 <= j < |d.unit.works| && d.unit.works[j] == w;
      assert original.unit.works[j] in original.unit.works && original.unit.works[j].phase.WorkSettled?;
    }
  }
}

lemma ProviderWorkProjection(s: core__providers_ProviderState, workId: int)
  ensures core__providers_providerWork(s, workId) ==
    (var matches := ProofLib.Filter((w: core__providers_ProviderWork) => (w.id == workId), s.works); if |matches| > 0 then matches[0] else core__providers_absentWork)
{}

lemma ProviderDomainWorkMap(s: core__providers_ProviderState, after: core__providers_ProviderState, workId: int)
  requires core__providers_canCleanWork(s, workId)
  requires |s.works| == |after.works|
  requires forall j :: 0 <= j < |s.works| ==>
    (s.works[j].id == after.works[j].id && s.works[j].phase.WorkSettled? == after.works[j].phase.WorkSettled?)
  ensures core__providers_canCleanWork(after, workId)
{
  ProviderWorkProjection(s, workId);
  ProviderWorkProjection(after, workId);
  ProofLib.FilterPointwise(
    (w: core__providers_ProviderWork) => (w.id == workId),
    (w: core__providers_ProviderWork) => (w.id == workId),
    (p: core__providers_ProviderWork, q: core__providers_ProviderWork) => p.phase.WorkSettled? == q.phase.WorkSettled?,
    s.works, after.works);
}

lemma invokeProvider_ensures(s: ProviderExecutions, domainId: int, workId: int)
  ensures (inv(s) ==> canInvokeProvider(s, domainId, workId) ==> alwaysKeyedDomainsUnique(invokeProvider(s, domainId, workId)))
  ensures (inv(s) ==> canInvokeProvider(s, domainId, workId) ==> alwaysDomainIdentity(invokeProvider(s, domainId, workId)))
  ensures (inv(s) ==> canInvokeProvider(s, domainId, workId) ==> alwaysEveryDomainValid(invokeProvider(s, domainId, workId)))
  ensures (inv(s) ==> canInvokeProvider(s, domainId, workId) ==> alwaysDomainCallerAndStopRegistered(invokeProvider(s, domainId, workId)))
  ensures (inv(s) ==> canInvokeProvider(s, domainId, workId) ==> alwaysStoppedDomainsStopped(invokeProvider(s, domainId, workId)))
  ensures (inv(s) ==> canInvokeProvider(s, domainId, workId) ==> alwaysSettledWorkOwnsCleanup(invokeProvider(s, domainId, workId)))
{
  if inv(s) && canInvokeProvider(s, domainId, workId) {
    var after := invokeProvider(s, domainId, workId);
    ProviderDomainsStableIdentities(s, after);
    forall d | d in after.domains
      ensures core__providers_inv(d.unit)
    {
      var i :| 0 <= i < |after.domains| && after.domains[i] == d;
      var original := s.domains[i];
      assert original in s.domains;
      ProviderDomainChildInvariant(s, original);
      if original.id == domainId {
        ProviderDomainLookup(s, domainId);
        assert domainUnit(s, domainId) == original.unit;
        core__providers_invokeWork_ensures(original.unit, workId);
      }
    }
    ProviderDomainsSameSettlement(s, after);
  }
}

lemma ProviderSetExtensionMembership(previous: seq<int>, caller: int, current: seq<int>, id: int)
  requires current == previous + ProofLib.Filter((set_x: int) => !((set_x in previous)), [caller])
  requires id in current
  ensures id in previous || id == caller
{
  if id !in previous {
    var remaining := (x: int) => x !in previous;
    ProofLib.FilterMember(remaining, [caller], id);
  }
}

lemma ProviderSetExtensionRetains(previous: seq<int>, caller: int, current: seq<int>)
  requires current == previous + ProofLib.Filter((set_x: int) => !((set_x in previous)), [caller])
  ensures caller in current && (forall id :: id in previous ==> id in current)
{
  if caller !in previous {
    var remaining := (x: int) => x !in previous;
    ProofLib.FilterMember(remaining, [caller], caller);
  }
}

lemma ProviderAbortCallersProjection(origin: core__providers_ProviderState, caller: int)
  ensures core__providers_abortCaller(origin, caller).abortedCallers == origin.abortedCallers +
    ProofLib.Filter((set_x: int) => !((set_x in origin.abortedCallers)), [caller])
{}

lemma ProviderAttachCallersProjection(s: ProviderExecutions, caller: int, key: ProviderKey, refresh: bool)
  ensures attachProvider(s, caller, key, refresh).usedCallers == s.usedCallers +
    ProofLib.Filter((set_x: int) => !((set_x in s.usedCallers)), [caller])
{}

lemma ProviderAbortAdmission(s: ProviderExecutions, origin: ProviderDomain, after: ProviderDomain, caller: int)
  requires alwaysDomainCallerAndStopRegistered(s) && origin in s.domains
  requires core__providers_canAbortCaller(origin.unit, caller)
  requires after.unit == core__providers_abortCaller(origin.unit, caller)
  ensures forall id :: id in after.unit.abortedCallers ==> id in s.usedCallers
{
  var attached :| attached in origin.unit.callers && attached.id == caller;
  assert caller in s.usedCallers;
  ProviderAbortCallersProjection(origin.unit, caller);
  forall id | id in after.unit.abortedCallers ensures id in s.usedCallers {
    ProviderSetExtensionMembership(origin.unit.abortedCallers, caller, after.unit.abortedCallers, id);
  }
}

lemma abortCaller_ensures(s: ProviderExecutions, domainId: int, caller: int)
  ensures (inv(s) ==> canAbortCaller(s, domainId, caller) ==> alwaysKeyedDomainsUnique(abortCaller(s, domainId, caller)))
  ensures (inv(s) ==> canAbortCaller(s, domainId, caller) ==> alwaysDomainIdentity(abortCaller(s, domainId, caller)))
  ensures (inv(s) ==> canAbortCaller(s, domainId, caller) ==> alwaysEveryDomainValid(abortCaller(s, domainId, caller)))
  ensures (inv(s) ==> canAbortCaller(s, domainId, caller) ==> alwaysDomainCallerAndStopRegistered(abortCaller(s, domainId, caller)))
  ensures (inv(s) ==> canAbortCaller(s, domainId, caller) ==> alwaysStoppedDomainsStopped(abortCaller(s, domainId, caller)))
  ensures (inv(s) ==> canAbortCaller(s, domainId, caller) ==> alwaysSettledWorkOwnsCleanup(abortCaller(s, domainId, caller)))
{
  if inv(s) && canAbortCaller(s, domainId, caller) {
    var after := abortCaller(s, domainId, caller);
    ProviderDomainsStableIdentities(s, after);
    forall d | d in after.domains
      ensures core__providers_inv(d.unit)
      ensures d.unit.stopping == after.stopped
      ensures forall c :: c in d.unit.callers ==> c.id in after.usedCallers
      ensures forall id :: id in d.unit.abortedCallers ==> id in after.usedCallers
    {
      var i :| 0 <= i < |after.domains| && after.domains[i] == d;
      var original := s.domains[i];
      assert original in s.domains;
      ProviderDomainChildInvariant(s, original);
      if original.id == domainId {
        ProviderDomainLookup(s, domainId);
        assert domainUnit(s, domainId) == original.unit;
        core__providers_abortCaller_ensures(original.unit, caller);
        ProviderAbortAdmission(s, original, d, caller);
      }
    }
    ProviderDomainsSameSettlement(s, after);
  }
}

lemma detachCaller_ensures(s: ProviderExecutions, domainId: int, caller: int)
  ensures (inv(s) ==> canDetachCaller(s, domainId, caller) ==> alwaysKeyedDomainsUnique(detachCaller(s, domainId, caller)))
  ensures (inv(s) ==> canDetachCaller(s, domainId, caller) ==> alwaysDomainIdentity(detachCaller(s, domainId, caller)))
  ensures (inv(s) ==> canDetachCaller(s, domainId, caller) ==> alwaysEveryDomainValid(detachCaller(s, domainId, caller)))
  ensures (inv(s) ==> canDetachCaller(s, domainId, caller) ==> alwaysDomainCallerAndStopRegistered(detachCaller(s, domainId, caller)))
  ensures (inv(s) ==> canDetachCaller(s, domainId, caller) ==> alwaysStoppedDomainsStopped(detachCaller(s, domainId, caller)))
  ensures (inv(s) ==> canDetachCaller(s, domainId, caller) ==> alwaysSettledWorkOwnsCleanup(detachCaller(s, domainId, caller)))
{
  if inv(s) && canDetachCaller(s, domainId, caller) {
    var after := detachCaller(s, domainId, caller);
    ProviderDomainsStableIdentities(s, after);
    forall d | d in after.domains
      ensures core__providers_inv(d.unit)
      ensures d.unit.stopping == after.stopped
      ensures forall c :: c in d.unit.callers ==> c.id in after.usedCallers
      ensures forall id :: id in d.unit.abortedCallers ==> id in after.usedCallers
    {
      var i :| 0 <= i < |after.domains| && after.domains[i] == d;
      var original := s.domains[i];
      assert original in s.domains;
      ProviderDomainChildInvariant(s, original);
      if original.id == domainId {
        ProviderDomainLookup(s, domainId);
        assert domainUnit(s, domainId) == original.unit;
        core__providers_detachCancelled_ensures(original.unit, caller);
        var retained := (c: core__providers_ProviderCaller) => c.id != caller;
        assert d.unit.callers == ProofLib.Filter(retained, original.unit.callers);
        forall c | c in d.unit.callers ensures c in original.unit.callers {
          ProofLib.FilterMember(retained, original.unit.callers, c);
        }
      }
    }
    ProviderDomainsSameSettlement(s, after);
  }
}

lemma receiveProvider_ensures(s: ProviderExecutions, domainId: int, caller: int)
  ensures (inv(s) ==> canReceiveProvider(s, domainId, caller) ==> alwaysKeyedDomainsUnique(receiveProvider(s, domainId, caller)))
  ensures (inv(s) ==> canReceiveProvider(s, domainId, caller) ==> alwaysDomainIdentity(receiveProvider(s, domainId, caller)))
  ensures (inv(s) ==> canReceiveProvider(s, domainId, caller) ==> alwaysEveryDomainValid(receiveProvider(s, domainId, caller)))
  ensures (inv(s) ==> canReceiveProvider(s, domainId, caller) ==> alwaysDomainCallerAndStopRegistered(receiveProvider(s, domainId, caller)))
  ensures (inv(s) ==> canReceiveProvider(s, domainId, caller) ==> alwaysStoppedDomainsStopped(receiveProvider(s, domainId, caller)))
  ensures (inv(s) ==> canReceiveProvider(s, domainId, caller) ==> alwaysSettledWorkOwnsCleanup(receiveProvider(s, domainId, caller)))
{
  if inv(s) && canReceiveProvider(s, domainId, caller) {
    var after := receiveProvider(s, domainId, caller);
    ProviderDomainsStableIdentities(s, after);
    forall d | d in after.domains
      ensures core__providers_inv(d.unit)
      ensures d.unit.stopping == after.stopped
      ensures forall c :: c in d.unit.callers ==> c.id in after.usedCallers
      ensures forall id :: id in d.unit.abortedCallers ==> id in after.usedCallers
    {
      var i :| 0 <= i < |after.domains| && after.domains[i] == d;
      var original := s.domains[i];
      assert original in s.domains;
      ProviderDomainChildInvariant(s, original);
      if original.id == domainId {
        ProviderDomainLookup(s, domainId);
        assert domainUnit(s, domainId) == original.unit;
        core__providers_receiveResult_ensures(original.unit, caller);
        var retained := (c: core__providers_ProviderCaller) => c.id != caller;
        assert d.unit.callers == ProofLib.Filter(retained, original.unit.callers);
        forall c | c in d.unit.callers ensures c in original.unit.callers {
          ProofLib.FilterMember(retained, original.unit.callers, c);
        }
      }
    }
    ProviderDomainsSameSettlement(s, after);
  }
}

lemma stopProviders_ensures(s: ProviderExecutions)
  ensures (inv(s) ==> canStopProviders(s) ==> alwaysKeyedDomainsUnique(stopProviders(s)))
  ensures (inv(s) ==> canStopProviders(s) ==> alwaysDomainIdentity(stopProviders(s)))
  ensures (inv(s) ==> canStopProviders(s) ==> alwaysEveryDomainValid(stopProviders(s)))
  ensures (inv(s) ==> canStopProviders(s) ==> alwaysDomainCallerAndStopRegistered(stopProviders(s)))
  ensures (inv(s) ==> canStopProviders(s) ==> alwaysStoppedDomainsStopped(stopProviders(s)))
  ensures (inv(s) ==> canStopProviders(s) ==> alwaysSettledWorkOwnsCleanup(stopProviders(s)))
{
  if inv(s) && canStopProviders(s) {
    var after := stopProviders(s);
    ProviderDomainsStableIdentities(s, after);
    forall d | d in after.domains
      ensures core__providers_inv(d.unit)
    {
      var i :| 0 <= i < |after.domains| && after.domains[i] == d;
      var original := s.domains[i];
      assert original in s.domains;
      ProviderDomainChildInvariant(s, original);
      {

        core__providers_stopProviders_ensures(original.unit);
      }
    }
    ProviderDomainsSameSettlement(s, after);
  }
}

lemma settleProvider_ensures(s: ProviderExecutions, domainId: int, workId: int)
  ensures (inv(s) ==> canSettleProvider(s, domainId, workId) ==> alwaysKeyedDomainsUnique(settleProvider(s, domainId, workId)))
  ensures (inv(s) ==> canSettleProvider(s, domainId, workId) ==> alwaysDomainIdentity(settleProvider(s, domainId, workId)))
  ensures (inv(s) ==> canSettleProvider(s, domainId, workId) ==> alwaysEveryDomainValid(settleProvider(s, domainId, workId)))
  ensures (inv(s) ==> canSettleProvider(s, domainId, workId) ==> alwaysDomainCallerAndStopRegistered(settleProvider(s, domainId, workId)))
  ensures (inv(s) ==> canSettleProvider(s, domainId, workId) ==> alwaysStoppedDomainsStopped(settleProvider(s, domainId, workId)))
  ensures (inv(s) ==> canSettleProvider(s, domainId, workId) ==> alwaysSettledWorkOwnsCleanup(settleProvider(s, domainId, workId)))
{
  if inv(s) && canSettleProvider(s, domainId, workId) {
    var after := settleProvider(s, domainId, workId);
    ProviderDomainsStableIdentities(s, after);
    forall d | d in after.domains
      ensures core__providers_inv(d.unit)
    {
      var i :| 0 <= i < |after.domains| && after.domains[i] == d;
      var original := s.domains[i];
      assert original in s.domains;
      ProviderDomainChildInvariant(s, original);
      if original.id == domainId {
        ProviderDomainLookup(s, domainId);
        assert domainUnit(s, domainId) == original.unit;
        core__providers_settleWork_ensures(original.unit, workId);
      }
    }
    ProviderSettleCleanupOwnership(s, after, domainId, workId);
  }
}

lemma cleanProvider_ensures(s: ProviderExecutions, domainId: int, workId: int)
  ensures (inv(s) ==> canCleanProvider(s, domainId, workId) ==> alwaysKeyedDomainsUnique(cleanProvider(s, domainId, workId)))
  ensures (inv(s) ==> canCleanProvider(s, domainId, workId) ==> alwaysDomainIdentity(cleanProvider(s, domainId, workId)))
  ensures (inv(s) ==> canCleanProvider(s, domainId, workId) ==> alwaysEveryDomainValid(cleanProvider(s, domainId, workId)))
  ensures (inv(s) ==> canCleanProvider(s, domainId, workId) ==> alwaysDomainCallerAndStopRegistered(cleanProvider(s, domainId, workId)))
  ensures (inv(s) ==> canCleanProvider(s, domainId, workId) ==> alwaysStoppedDomainsStopped(cleanProvider(s, domainId, workId)))
  ensures (inv(s) ==> canCleanProvider(s, domainId, workId) ==> alwaysSettledWorkOwnsCleanup(cleanProvider(s, domainId, workId)))
{
  if inv(s) && canCleanProvider(s, domainId, workId) {
    var after := cleanProvider(s, domainId, workId);
    ProviderDomainsStableIdentities(s, after);
    forall d | d in after.domains
      ensures core__providers_inv(d.unit)
    {
      var i :| 0 <= i < |after.domains| && after.domains[i] == d;
      var original := s.domains[i];
      assert original in s.domains;
      ProviderDomainChildInvariant(s, original);
      if original.id == domainId {
        ProviderDomainLookup(s, domainId);
        assert domainUnit(s, domainId) == original.unit;
        core__providers_cleanWork_ensures(original.unit, workId);
      }
    }
    ProviderCleanCleanupOwnership(s, after, domainId, workId);
  }
}

lemma runNextProviderCleanup_ensures(s: ProviderExecutions)
  ensures (inv(s) ==> canRunNextProviderCleanup(s) ==> alwaysKeyedDomainsUnique(runNextProviderCleanup(s)))
  ensures (inv(s) ==> canRunNextProviderCleanup(s) ==> alwaysDomainIdentity(runNextProviderCleanup(s)))
  ensures (inv(s) ==> canRunNextProviderCleanup(s) ==> alwaysEveryDomainValid(runNextProviderCleanup(s)))
  ensures (inv(s) ==> canRunNextProviderCleanup(s) ==> alwaysDomainCallerAndStopRegistered(runNextProviderCleanup(s)))
  ensures (inv(s) ==> canRunNextProviderCleanup(s) ==> alwaysStoppedDomainsStopped(runNextProviderCleanup(s)))
  ensures (inv(s) ==> canRunNextProviderCleanup(s) ==> alwaysSettledWorkOwnsCleanup(runNextProviderCleanup(s)))
{
  if inv(s) && canRunNextProviderCleanup(s) {
    cleanProvider_ensures(s, nextProviderCleanup(s).domain, nextProviderCleanup(s).work);
  }
}

lemma ProviderDomainWorkFromIdentity(s: core__providers_ProviderState, item: core__providers_ProviderWork)
  requires core__providers_alwaysExecutionIdentitiesUnique(s) && item in s.works
  ensures core__providers_providerWork(s,item.id) == item
{
  ProviderWorkProjection(s, item.id);
  var selected := ProofLib.Filter((w: core__providers_ProviderWork) => w.id == item.id, s.works);
  ProofLib.FilterMember((w: core__providers_ProviderWork) => w.id == item.id, s.works, item);
  ProofLib.FilterSamePredicate((w: core__providers_ProviderWork) => w.id == item.id, (x: core__providers_ProviderWork) => x.id == item.id, s.works);
  assert |selected| == 1 && selected[0] == item;
}

lemma ProviderSettlementMembership(s: ProviderExecutions)
  requires inv(s)
  ensures forall d :: d in s.domains ==>
    (forall w :: w in d.unit.works ==> (w.phase.WorkSettled? <==> (exists p :: p in s.pendingCleanup && p.domain == d.id && p.work == w.id)))
  ensures forall p :: p in s.pendingCleanup ==>
    (exists d :: d in s.domains && d.id == p.domain && (exists w :: w in d.unit.works && w.id == p.work && w.phase.WorkSettled?))
{
  forall d | d in s.domains
    ensures (forall w :: w in d.unit.works ==> (w.phase.WorkSettled? <==> (exists p :: p in s.pendingCleanup && p.domain == d.id && p.work == w.id)))
  {
    ProviderDomainLookup(s, d.id);
    forall w | w in d.unit.works
      ensures (w.phase.WorkSettled? <==> (exists p :: p in s.pendingCleanup && p.domain == d.id && p.work == w.id))
    {
      ProviderDomainWorkFromIdentity(d.unit, w);
      if exists p :: p in s.pendingCleanup && p.domain == d.id && p.work == w.id {
        var p :| p in s.pendingCleanup && p.domain == d.id && p.work == w.id;
        assert canCleanProvider(s, p.domain, p.work);
      }
    }
  }
  forall p | p in s.pendingCleanup
    ensures (exists d :: d in s.domains && d.id == p.domain && (exists w :: w in d.unit.works && w.id == p.work && w.phase.WorkSettled?))
  {
    ProviderDomainLookup(s, p.domain);
    var d := providerDomain(s, p.domain);
    if d.id == 0 {
      assert d == absentDomain && absentDomain.unit == core__providers_initial;
      assert !core__providers_canCleanWork(core__providers_initial, p.work);
      assert false;
    }
    ProviderWorkProjection(d.unit, p.work);
    var w := core__providers_providerWork(d.unit, p.work);
    var matches := ProofLib.Filter((w: core__providers_ProviderWork) => w.id == p.work, d.unit.works);
    assert |matches| > 0;
    ProofLib.FilterMember((w: core__providers_ProviderWork) => w.id == p.work, d.unit.works, w);
  }
}

lemma ProviderKeyEquivalence(a: ProviderKey, b: ProviderKey, c: ProviderKey)
  ensures sameProviderKey(a, a)
  ensures sameProviderKey(a, b) == sameProviderKey(b, a)
  ensures sameProviderKey(a, b) && sameProviderKey(b, c) ==> sameProviderKey(a, c)
{
  match a.audience {
    case PublicAudience =>
    case UnattestedAudience =>
    case AttestedAudience(_, _, _) =>
  }
}

lemma ProviderExistingDomainProjection(s: ProviderExecutions, key: ProviderKey)
  ensures existingDomain(s, key) ==
    (var matching := ProofLib.Filter((d: ProviderDomain) => d.keyed && sameProviderKey(d.key, key), s.domains);
     if |matching| > 0 then matching[0].id else 0)
{}

lemma ProviderUnmatchedKey(s: ProviderExecutions, key: ProviderKey)
  requires alwaysDomainIdentity(s) && existingDomain(s, key) == 0
  ensures forall d :: d in s.domains ==> !d.keyed || !sameProviderKey(d.key, key)
{
  ProviderExistingDomainProjection(s, key);
  var byKey := (d: ProviderDomain) => d.keyed && sameProviderKey(d.key, key);
  var matching := ProofLib.Filter(byKey, s.domains);
  if |matching| > 0 {
    ProofLib.FilterMember(byKey, s.domains, matching[0]);
    assert matching[0].id > 0;
    assert false;
  }
  forall d | d in s.domains ensures !byKey(d) {
    ProofLib.FilterMember(byKey, s.domains, d);
  }
}

lemma ProviderDomainAppended(s: ProviderExecutions, after: ProviderExecutions, added: ProviderDomain)
  requires alwaysDomainIdentity(s) && alwaysKeyedDomainsUnique(s)
  requires added.id == s.nextDomain && after.nextDomain == s.nextDomain + 1
  requires after.domains == s.domains + [added]
  requires !added.keyed || existingDomain(s, added.key) == 0
  ensures alwaysDomainIdentity(after) && alwaysKeyedDomainsUnique(after)
{
  ProviderDomainsIdentityFilters(s);
  ProviderDomainsIdentityFilters(after);
  ProviderDomainsKeyFilters(s);
  ProviderDomainsKeyFilters(after);
  if added.keyed {
    ProviderUnmatchedKey(s, added.key);
  }
  forall d | d in after.domains
    ensures d.id > 0 && d.id < after.nextDomain && |ProofLib.Filter((other: ProviderDomain) => other.id == d.id, after.domains)| == 1
  {
    var byId := (other: ProviderDomain) => other.id == d.id;
    ProofLib.FilterAppend(byId, s.domains, added);
    if d == added {
      assert forall j :: 0 <= j < |s.domains| ==> !byId(s.domains[j]);
      ProofLib.FilterNone(byId, s.domains);
    } else {
      assert d in s.domains && d.id < added.id;
    }
  }
  forall d | d in after.domains && d.keyed
    ensures |ProofLib.Filter((other: ProviderDomain) => other.keyed && sameProviderKey(d.key, other.key), after.domains)| == 1
  {
    var byKey := (other: ProviderDomain) => other.keyed && sameProviderKey(d.key, other.key);
    ProofLib.FilterAppend(byKey, s.domains, added);
    if d == added {
      ProviderKeyEquivalence(added.key, added.key, added.key);
      forall j | 0 <= j < |s.domains| ensures !byKey(s.domains[j]) {
        var original := s.domains[j];
        assert original in s.domains;
        ProviderKeyEquivalence(added.key, original.key, added.key);
      }
      ProofLib.FilterNone(byKey, s.domains);
    } else {
      assert d in s.domains;
      assert !byKey(added);
    }
  }
}

lemma ProviderAttachUnit(s: core__providers_ProviderState, caller: int, keyed: bool)
  ensures forall w :: w in core__providers_attach(s, caller, keyed).works && w.phase.WorkSettled? ==> w in s.works
  ensures forall w :: w in s.works ==> w in core__providers_attach(s, caller, keyed).works
  ensures forall c :: c in core__providers_attach(s, caller, keyed).callers ==> c.id == caller || c in s.callers
  ensures core__providers_attach(s, caller, keyed).stopping == s.stopping
  ensures core__providers_attach(s, caller, keyed).abortedCallers == s.abortedCallers
{
  var after := core__providers_attach(s, caller, keyed);
  if after.works != s.works {
    assert |after.works| == |s.works| + 1;
    assert after.works == s.works + [after.works[|s.works|]];
    assert !after.works[|s.works|].phase.WorkSettled?;
  }
}

lemma ProviderAttachmentRegistered(s: ProviderExecutions, origin: core__providers_ProviderState, caller: int, keyed: bool)
  requires canAttachProvider(s, caller, absentDomain.key, false)
  requires origin.stopping == s.stopped
  requires forall c :: c in origin.callers ==> c.id in s.usedCallers
  requires forall id :: id in origin.abortedCallers ==> id in s.usedCallers
  ensures core__providers_canAttach(origin, caller, keyed)
  ensures core__providers_attach(origin, caller, keyed).stopping == s.stopped
  ensures forall c :: c in core__providers_attach(origin, caller, keyed).callers ==> c.id == caller || c.id in s.usedCallers
  ensures forall id :: id in core__providers_attach(origin, caller, keyed).abortedCallers ==> id in s.usedCallers
{
  ProviderAttachUnit(origin, caller, keyed);
}

lemma ProviderNextCallbackUnit(s: core__providers_ProviderState)
  ensures forall c :: c in core__providers_runNextCallback(s).callers ==> c in s.callers
  ensures core__providers_runNextCallback(s).stopping == s.stopping
  ensures core__providers_runNextCallback(s).abortedCallers == s.abortedCallers
  ensures core__providers_runNextCallback(s).keyedId == s.keyedId || core__providers_runNextCallback(s).keyedId == 0
  ensures |core__providers_runNextCallback(s).works| == |s.works|
  ensures forall j :: 0 <= j < |s.works| ==>
    (var w := core__providers_runNextCallback(s).works[j];
     w.id == s.works[j].id && w.phase == s.works[j].phase && w.active == s.works[j].active)
{
  var caller := core__providers_nextCallbackCaller(s).id;
  var after := core__providers_runNextCallback(s);
  var retained := (c: core__providers_ProviderCaller) => c.id != caller;
  assert after.callers == ProofLib.Filter(retained, s.callers);
  forall c | c in after.callers ensures c in s.callers {
    ProofLib.FilterMember(retained, s.callers, c);
  }
}

lemma attachProvider_ensures(s: ProviderExecutions, caller: int, key: ProviderKey, refresh: bool)
  ensures (inv(s) ==> canAttachProvider(s, caller, key, refresh) ==> alwaysKeyedDomainsUnique(attachProvider(s, caller, key, refresh)))
  ensures (inv(s) ==> canAttachProvider(s, caller, key, refresh) ==> alwaysDomainIdentity(attachProvider(s, caller, key, refresh)))
  ensures (inv(s) ==> canAttachProvider(s, caller, key, refresh) ==> alwaysEveryDomainValid(attachProvider(s, caller, key, refresh)))
  ensures (inv(s) ==> canAttachProvider(s, caller, key, refresh) ==> alwaysDomainCallerAndStopRegistered(attachProvider(s, caller, key, refresh)))
  ensures (inv(s) ==> canAttachProvider(s, caller, key, refresh) ==> alwaysStoppedDomainsStopped(attachProvider(s, caller, key, refresh)))
  ensures (inv(s) ==> canAttachProvider(s, caller, key, refresh) ==> alwaysSettledWorkOwnsCleanup(attachProvider(s, caller, key, refresh)))
{
  if inv(s) && canAttachProvider(s, caller, key, refresh) {
    var keyed := eligibleForCoalescing(key, refresh);
    var existing := if keyed then existingDomain(s, key) else 0;
    var after := attachProvider(s, caller, key, refresh);
    assert !after.stopped && s.stopped == after.stopped;
    ProviderAttachCallersProjection(s, caller, key, refresh);
    ProviderSetExtensionRetains(s.usedCallers, caller, after.usedCallers);
    assert caller in after.usedCallers;
    assert after.pendingCleanup == s.pendingCleanup;
    if existing == 0 {
      var added := ProviderDomain(s.nextDomain, key, keyed, core__providers_attach(core__providers_initial, caller, keyed));
      assert after.domains == s.domains + [added];
      ProviderDomainAppended(s, after, added);
      core__providers_initialHolds_ensures();
      ProviderAttachmentRegistered(s, core__providers_initial, caller, keyed);
      core__providers_attach_ensures(core__providers_initial, caller, keyed);
    } else {
      assert |s.domains| == |after.domains|;
      forall i | 0 <= i < |s.domains|
        ensures s.domains[i].id == after.domains[i].id && s.domains[i].key == after.domains[i].key && s.domains[i].keyed == after.domains[i].keyed
      {
        var origin := s.domains[i];
        assert after.domains[i] == (if origin.id == existing then origin.(unit := core__providers_attach(origin.unit, caller, true)) else origin);
      }
      ProviderDomainsStableIdentities(s, after);
    }
    forall d | d in after.domains
      ensures core__providers_inv(d.unit) && d.unit.stopping == after.stopped &&
        (forall c :: c in d.unit.callers ==> c.id in after.usedCallers) &&
        (forall id :: id in d.unit.abortedCallers ==> id in after.usedCallers)
      ensures forall w :: w in d.unit.works && w.phase.WorkSettled? ==>
        (exists p :: p in after.pendingCleanup && p.domain == d.id && p.work == w.id)
    {
      var i :| 0 <= i < |after.domains| && after.domains[i] == d;
      if i == |s.domains| {
        assert existing == 0 && d.id == s.nextDomain;
        assert d.unit == core__providers_attach(core__providers_initial, caller, keyed);
        ProviderAttachUnit(core__providers_initial, caller, keyed);
      } else {
        var origin := s.domains[i];
        assert origin in s.domains;
        ProviderDomainChildInvariant(s, origin);
        assert d.id == origin.id;
        if existing != 0 && origin.id == existing {
          assert d.unit == core__providers_attach(origin.unit, caller, true);
          ProviderAttachmentRegistered(s, origin.unit, caller, true);
          core__providers_attach_ensures(origin.unit, caller, true);
          ProviderAttachUnit(origin.unit, caller, true);
        } else {
          assert d == origin;
        }
      }
    }
    forall p | p in after.pendingCleanup ensures canCleanProvider(after, p.domain, p.work)
    {
      ProviderDomainLookup(s, p.domain);
      var origin := providerDomain(s, p.domain);
      assert core__providers_canCleanWork(origin.unit, p.work);
      if origin.id == 0 {
        assert origin == absentDomain && absentDomain.unit == core__providers_initial;
        assert !core__providers_canCleanWork(core__providers_initial, p.work);
        assert false;
      }
      var i :| 0 <= i < |s.domains| && s.domains[i] == origin;
      assert after.domains[i] in after.domains && after.domains[i].id == p.domain;
      ProviderDomainLookup(after, p.domain);
      var d := after.domains[i];
      assert providerDomain(after, p.domain) == d;
      if existing != 0 && p.domain == existing {
        assert d.unit == core__providers_attach(origin.unit, caller, true);
        ProviderWorkProjection(origin.unit, p.work);
        var w := core__providers_providerWork(origin.unit, p.work);
        var matching := ProofLib.Filter((w: core__providers_ProviderWork) => w.id == p.work, origin.unit.works);
        assert |matching| > 0;
        ProofLib.FilterMember((actual: core__providers_ProviderWork) => actual.id == p.work, origin.unit.works, w);
        ProviderAttachUnit(origin.unit, caller, true);
        assert w in d.unit.works;
        ProviderDomainWorkFromIdentity(d.unit, w);
      } else {
        assert d == origin;
      }
    }
  }
}

lemma ProviderFilterSplitCount<T>(p: T -> bool, q: T -> bool, no: T -> bool, items: seq<T>)
  requires forall item :: item in items ==> no(item) != q(item)
  ensures |ProofLib.Filter(p, items)| ==
    |ProofLib.Filter(p, ProofLib.Filter(q, items))| + |ProofLib.Filter(p, ProofLib.Filter(no, items))|
  decreases |items|
{
  ProofLib.FilterNil(p, []);
  if |items| == 0 {
    ProofLib.FilterNil(q, items);
    ProofLib.FilterNil(no, items);
  } else {
    var x := items[0];
    var tail := items[1..];
    ProofLib.FilterCons(p, items);
    ProofLib.FilterCons(q, items);
    ProofLib.FilterCons(no, items);
    forall item | item in tail ensures no(item) != q(item) {
      assert item in items;
    }
    ProviderFilterSplitCount(p, q, no, tail);
    assert x in items && no(x) != q(x);
    if q(x) {
      assert ProofLib.Filter(q, items) == [x] + ProofLib.Filter(q, tail);
      ProofLib.FilterCons(p, ProofLib.Filter(q, items));
      assert ProofLib.Filter(q, items)[1..] == ProofLib.Filter(q, tail);
      assert ProofLib.Filter(q, items)[0] == x && ProofLib.Filter(no, items) == ProofLib.Filter(no, tail);
      assert |ProofLib.Filter(p, ProofLib.Filter(q, items))| == (if p(x) then 1 else 0) + |ProofLib.Filter(p, ProofLib.Filter(q, tail))|;
    } else {
      assert ProofLib.Filter(no, items) == [x] + ProofLib.Filter(no, tail);
      ProofLib.FilterCons(p, ProofLib.Filter(no, items));
      assert ProofLib.Filter(no, items)[1..] == ProofLib.Filter(no, tail);
      assert ProofLib.Filter(no, items)[0] == x && ProofLib.Filter(q, items) == ProofLib.Filter(q, tail);
      assert |ProofLib.Filter(p, ProofLib.Filter(no, items))| == (if p(x) then 1 else 0) + |ProofLib.Filter(p, ProofLib.Filter(no, tail))|;
    }
    assert |ProofLib.Filter(p, items)| == (if p(x) then 1 else 0) + |ProofLib.Filter(p, tail)|;
  }
}

lemma ProviderFilterSwapSingleton<T>(test: T -> bool, items: seq<T>, selected: T -> bool, keep: T -> bool, prior: T, replacement: T)
  requires ProofLib.Filter(selected, items) == [prior]
  requires forall item :: item in items ==> keep(item) != selected(item)
  requires test(prior) == test(replacement)
  ensures |ProofLib.Filter(test, ProofLib.Filter(keep, items) + [replacement])| == |ProofLib.Filter(test, items)|
{
  var retained := ProofLib.Filter(keep, items);
  ProviderFilterSplitCount(test, selected, keep, items);
  var empty: seq<T> := [];
  var onlyPrior := [prior];
  assert |onlyPrior| == 1 && onlyPrior[0] == prior && onlyPrior[1..] == empty;
  ProofLib.FilterNil(test, empty);
  ProofLib.FilterCons(test, onlyPrior);
  assert ProofLib.Filter(test, onlyPrior) == (if test(prior) then [prior] else empty);
  ProofLib.FilterAppend(test, retained, replacement);
  assert |ProofLib.Filter(test, onlyPrior)| == (if test(replacement) then 1 else 0);
}

lemma ProviderCallbackDomainRetained(s: ProviderExecutions, domainId: int)
  ensures runNextProviderCallback(s).domains ==
    (var filtered := ProofLib.Filter((d: ProviderDomain) => d.id == domainId, s.domains);
     ProofLib.Filter((d: ProviderDomain) => d.id != domainId, s.domains) +
       seq(|filtered|, i requires 0 <= i < |filtered| => filtered[i].(unit := core__providers_runNextCallback(filtered[i].unit))))
  requires domainId == nextCallbackDomain(s)
{}

lemma runNextProviderCallback_ensures(s: ProviderExecutions)
  ensures (inv(s) ==> canRunNextProviderCallback(s) ==> alwaysKeyedDomainsUnique(runNextProviderCallback(s)))
  ensures (inv(s) ==> canRunNextProviderCallback(s) ==> alwaysDomainIdentity(runNextProviderCallback(s)))
  ensures (inv(s) ==> canRunNextProviderCallback(s) ==> alwaysEveryDomainValid(runNextProviderCallback(s)))
  ensures (inv(s) ==> canRunNextProviderCallback(s) ==> alwaysDomainCallerAndStopRegistered(runNextProviderCallback(s)))
  ensures (inv(s) ==> canRunNextProviderCallback(s) ==> alwaysStoppedDomainsStopped(runNextProviderCallback(s)))
  ensures (inv(s) ==> canRunNextProviderCallback(s) ==> alwaysSettledWorkOwnsCleanup(runNextProviderCallback(s)))
{
  if inv(s) && canRunNextProviderCallback(s) {
    var domainId := nextCallbackDomain(s);
    var target := providerDomain(s, domainId);
    ProviderDomainLookup(s, domainId);
    if target.id == 0 {
      assert target == absentDomain && !core__providers_canRunNextCallback(core__providers_initial);
      assert false;
    }
    assert target in s.domains && target.id == domainId;
    assert core__providers_canRunNextCallback(target.unit);
    ProviderDomainChildInvariant(s, target);
    core__providers_runNextCallback_ensures(target.unit);
    ProviderNextCallbackUnit(target.unit);
    var selected := (d: ProviderDomain) => d.id == domainId;
    var others := (d: ProviderDomain) => d.id != domainId;
    var oldSelected := ProofLib.Filter(selected, s.domains);
    var kept := ProofLib.Filter(others, s.domains);
    var replacement := target.(unit := core__providers_runNextCallback(target.unit));
    ProofLib.FilterMember(selected, s.domains, target);
    ProviderDomainsIdentityFilters(s);
    assert |oldSelected| == 1 && oldSelected == [target];
    var after := runNextProviderCallback(s);
    ProviderCallbackDomainRetained(s, domainId);
    assert after.domains == kept + [replacement];
    assert after.pendingCleanup == s.pendingCleanup && after.usedCallers == s.usedCallers;
    ProviderDomainsIdentityFilters(after);
    ProviderDomainsKeyFilters(s);
    ProviderDomainsKeyFilters(after);
    assert forall item :: item in s.domains ==> others(item) != selected(item);
    forall d | d in after.domains
      ensures d.id > 0 && d.id < after.nextDomain
      ensures |ProofLib.Filter((other: ProviderDomain) => other.id == d.id, after.domains)| == 1
      ensures d.keyed ==> |ProofLib.Filter((other: ProviderDomain) => other.keyed && sameProviderKey(d.key, other.key), after.domains)| == 1
      ensures core__providers_inv(d.unit) && d.unit.stopping == after.stopped
      ensures forall c :: c in d.unit.callers ==> c.id in after.usedCallers
      ensures forall id :: id in d.unit.abortedCallers ==> id in after.usedCallers
      ensures after.stopped ==> d.unit.stopping && d.unit.keyedId == 0 && (forall w :: w in d.unit.works ==> !w.active)
      ensures forall w :: w in d.unit.works && w.phase.WorkSettled? ==>
        (exists p :: p in after.pendingCleanup && p.domain == d.id && p.work == w.id)
    {
      var origin := if d == replacement then target else d;
      if d != replacement {
        assert d in kept;
        ProofLib.FilterMember(others, s.domains, d);
      }
      assert origin in s.domains && origin.id == d.id && origin.key == d.key && origin.keyed == d.keyed;
      ProviderDomainChildInvariant(s, origin);
      var byId := (other: ProviderDomain) => other.id == d.id;
      assert |ProofLib.Filter(byId, s.domains)| == 1;
      assert byId(target) == byId(replacement);
      ProviderFilterSwapSingleton(byId, s.domains, selected, others, target, replacement);
      assert |ProofLib.Filter(byId, after.domains)| == 1;
      if d.keyed {
        var byKey := (other: ProviderDomain) => other.keyed && sameProviderKey(d.key, other.key);
        assert |ProofLib.Filter(byKey, s.domains)| == 1;
        assert byKey(target) == byKey(replacement);
        ProviderFilterSwapSingleton(byKey, s.domains, selected, others, target, replacement);
        assert |ProofLib.Filter(byKey, after.domains)| == 1;
      }
      if d == replacement {
        forall w | w in d.unit.works
          ensures (after.stopped ==> !w.active)
          ensures w.phase.WorkSettled? ==> (exists p :: p in after.pendingCleanup && p.domain == d.id && p.work == w.id)
        {
          var i :| 0 <= i < |d.unit.works| && d.unit.works[i] == w;
          var previousWork := target.unit.works[i];
          assert previousWork in target.unit.works;
          assert w.id == previousWork.id && w.phase == previousWork.phase && w.active == previousWork.active;
        }
      }
    }
    forall p | p in after.pendingCleanup ensures canCleanProvider(after, p.domain, p.work)
    {
      ProviderDomainLookup(s, p.domain);
      var origin := providerDomain(s, p.domain);
      assert core__providers_canCleanWork(origin.unit, p.work);
      if origin.id == 0 {
        assert origin == absentDomain && !core__providers_canCleanWork(core__providers_initial, p.work);
        assert false;
      }
      var d := if p.domain == domainId then replacement else origin;
      if p.domain != domainId {
        ProofLib.FilterMember(others, s.domains, origin);
        assert origin in kept;
      } else {
        assert origin == target;
      }
      assert d in after.domains && d.id == p.domain;
      ProviderDomainLookup(after, p.domain);
      assert providerDomain(after, p.domain) == d;
      if p.domain == domainId {
        ProviderDomainWorkMap(origin.unit, d.unit, p.work);
      }
    }
  }
}

lemma ProviderSettleCleanupOwnership(s: ProviderExecutions, after: ProviderExecutions, domainId: int, workId: int)
  requires inv(s) && canSettleProvider(s, domainId, workId)
  requires after == settleProvider(s, domainId, workId)
  requires alwaysDomainIdentity(after) && alwaysEveryDomainValid(after)
  ensures alwaysSettledWorkOwnsCleanup(after)
{
  ProviderSettlementMembership(s);
  ProviderDomainLookup(s, domainId);
  var selected := providerDomain(s, domainId);
  if selected.id == 0 {
    assert selected == absentDomain && selected.unit == core__providers_initial;
    assert !core__providers_canSettleWork(core__providers_initial, workId);
    assert false;
  }
  ProviderWorkProjection(selected.unit, workId);
  var changed := core__providers_providerWork(selected.unit, workId);
  var priorMatches := ProofLib.Filter((w: core__providers_ProviderWork) => w.id == workId, selected.unit.works);
  assert |priorMatches| > 0;
  ProofLib.FilterMember((w: core__providers_ProviderWork) => w.id == workId, selected.unit.works, changed);
  assert changed.id == workId;
  var identified := PendingProviderCleanup(domainId, workId);
  var equalPair := (p: PendingProviderCleanup) => p.domain == domainId && p.work == workId;
  assert after.pendingCleanup == s.pendingCleanup + [identified];
  forall p | p in s.pendingCleanup ensures !equalPair(p) {
    if equalPair(p) {
      assert changed.phase.Working? && changed.phase.WorkSettled?;
    }
  }
  forall p | p in after.pendingCleanup
    ensures |ProofLib.Filter((other: PendingProviderCleanup) => other.domain == p.domain && other.work == p.work, after.pendingCleanup)| == 1
  {
    var byPair := (other: PendingProviderCleanup) => other.domain == p.domain && other.work == p.work;
    ProofLib.FilterAppend(byPair, s.pendingCleanup, identified);
    if p == identified {
      ProofLib.FilterNone(byPair, s.pendingCleanup);
    } else {
      assert p in s.pendingCleanup && !byPair(identified);
    }
  }
  forall p | p in after.pendingCleanup ensures canCleanProvider(after, p.domain, p.work)
  {
    ProviderDomainLookup(s, p.domain);
    var origin := providerDomain(s, p.domain);
    if origin.id == 0 {
      assert p in s.pendingCleanup;
      assert !core__providers_canCleanWork(core__providers_initial, p.work);
      assert false;
    }
    var i :| 0 <= i < |s.domains| && s.domains[i] == origin;
    var d := after.domains[i];
    assert d in after.domains && d.id == origin.id;
    ProviderDomainLookup(after, p.domain);
    assert d == providerDomain(after, p.domain);
    var w := core__providers_providerWork(origin.unit, p.work);
    if p != identified {
      assert p in s.pendingCleanup && w.phase.WorkSettled?;
    } else {
      assert origin == selected && w == changed;
    }
    ProviderWorkProjection(origin.unit, p.work);
    var matches := ProofLib.Filter((w: core__providers_ProviderWork) => w.id == p.work, origin.unit.works);
    assert |matches| > 0;
    ProofLib.FilterMember((w: core__providers_ProviderWork) => w.id == p.work, origin.unit.works, w);
    var j :| 0 <= j < |origin.unit.works| && origin.unit.works[j] == w;
    var afterWork := d.unit.works[j];
    assert afterWork in d.unit.works && afterWork.id == p.work && afterWork.phase.WorkSettled?;
    ProviderDomainWorkFromIdentity(d.unit, afterWork);
  }
  forall d | d in after.domains
    ensures (forall w :: w in d.unit.works && w.phase.WorkSettled? ==>
      (exists p :: p in after.pendingCleanup && p.domain == d.id && p.work == w.id))
  {
    var i :| 0 <= i < |after.domains| && after.domains[i] == d;
    var origin := s.domains[i];
    assert origin in s.domains && origin.id == d.id;
    forall w | w in d.unit.works && w.phase.WorkSettled?
      ensures exists p :: p in after.pendingCleanup && p.domain == d.id && p.work == w.id
    {
      var j :| 0 <= j < |d.unit.works| && d.unit.works[j] == w;
      var prior := origin.unit.works[j];
      assert prior in origin.unit.works && prior.id == w.id;
      if d.id == domainId && w.id == workId {
        assert identified in after.pendingCleanup;
      } else {
        assert prior.phase.WorkSettled?;
        var p :| p in s.pendingCleanup && p.domain == d.id && p.work == w.id;
        assert p in after.pendingCleanup;
      }
    }
  }
}

lemma ProviderCleanCleanupOwnership(s: ProviderExecutions, after: ProviderExecutions, domainId: int, workId: int)
  requires inv(s) && canCleanProvider(s, domainId, workId)
  requires after == cleanProvider(s, domainId, workId)
  requires alwaysDomainIdentity(after) && alwaysEveryDomainValid(after)
  ensures alwaysSettledWorkOwnsCleanup(after)
{
  ProviderSettlementMembership(s);
  ProviderDomainLookup(s, domainId);
  var selected := providerDomain(s, domainId);
  if selected.id == 0 {
    assert selected == absentDomain && selected.unit == core__providers_initial;
    assert !core__providers_canCleanWork(core__providers_initial, workId);
    assert false;
  }
  ProviderWorkProjection(selected.unit, workId);
  var changed := core__providers_providerWork(selected.unit, workId);
  var priorMatches := ProofLib.Filter((w: core__providers_ProviderWork) => w.id == workId, selected.unit.works);
  assert |priorMatches| > 0;
  ProofLib.FilterMember((w: core__providers_ProviderWork) => w.id == workId, selected.unit.works, changed);
  assert changed.id == workId;
  var identified := PendingProviderCleanup(domainId, workId);
  var retained := (p: PendingProviderCleanup) => p.domain != domainId || p.work != workId;
  assert after.pendingCleanup == ProofLib.Filter(retained, s.pendingCleanup);
  forall p | p in after.pendingCleanup
    ensures p in s.pendingCleanup && retained(p)
    ensures |ProofLib.Filter((other: PendingProviderCleanup) => other.domain == p.domain && other.work == p.work, after.pendingCleanup)| == 1
  {
    ProofLib.FilterMember(retained, s.pendingCleanup, p);
    var byPair := (other: PendingProviderCleanup) => other.domain == p.domain && other.work == p.work;
    ProofLib.FilterOfFilterLength(retained, byPair, byPair, s.pendingCleanup);
    ProofLib.FilterMember(byPair, after.pendingCleanup, p);
  }
  forall p | p in after.pendingCleanup ensures canCleanProvider(after, p.domain, p.work)
  {
    ProviderDomainLookup(s, p.domain);
    var origin := providerDomain(s, p.domain);
    if origin.id == 0 {
      assert p in s.pendingCleanup;
      assert !core__providers_canCleanWork(core__providers_initial, p.work);
      assert false;
    }
    var i :| 0 <= i < |s.domains| && s.domains[i] == origin;
    var d := after.domains[i];
    assert d in after.domains && d.id == origin.id;
    ProviderDomainLookup(after, p.domain);
    assert d == providerDomain(after, p.domain);
    var w := core__providers_providerWork(origin.unit, p.work);
    if p != identified {
      assert p in s.pendingCleanup && w.phase.WorkSettled?;
    } else {
      assert origin == selected && w == changed;
    }
    ProviderWorkProjection(origin.unit, p.work);
    var matches := ProofLib.Filter((w: core__providers_ProviderWork) => w.id == p.work, origin.unit.works);
    assert |matches| > 0;
    ProofLib.FilterMember((w: core__providers_ProviderWork) => w.id == p.work, origin.unit.works, w);
    var j :| 0 <= j < |origin.unit.works| && origin.unit.works[j] == w;
    var afterWork := d.unit.works[j];
    assert afterWork in d.unit.works && afterWork.id == p.work && afterWork.phase.WorkSettled?;
    ProviderDomainWorkFromIdentity(d.unit, afterWork);
  }
  forall d | d in after.domains
    ensures (forall w :: w in d.unit.works && w.phase.WorkSettled? ==>
      (exists p :: p in after.pendingCleanup && p.domain == d.id && p.work == w.id))
  {
    var i :| 0 <= i < |after.domains| && after.domains[i] == d;
    var origin := s.domains[i];
    assert origin in s.domains && origin.id == d.id;
    forall w | w in d.unit.works && w.phase.WorkSettled?
      ensures exists p :: p in after.pendingCleanup && p.domain == d.id && p.work == w.id
    {
      var j :| 0 <= j < |d.unit.works| && d.unit.works[j] == w;
      var prior := origin.unit.works[j];
      assert prior in origin.unit.works && prior.id == w.id;
      assert d.id != domainId || w.id != workId;
      assert prior.phase.WorkSettled?;
      var p :| p in s.pendingCleanup && p.domain == d.id && p.work == w.id;
      ProofLib.FilterMember(retained, s.pendingCleanup, p);
    }
  }
}
