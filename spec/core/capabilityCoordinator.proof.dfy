lemma CoordinatorFilters(c: Coordinator)
  ensures alwaysRegisteredIdentitiesAreUnique(c) == (forall authority :: authority in c.registered ==> authority.policy.decisionId != "" && |ProofLib.Filter((other: core__capabilityAuthority_Authority) => (other.policy.decisionId == authority.policy.decisionId), c.registered)| == 1)
  ensures alwaysDispatchIdentitiesAreUnique(c) == (forall authority :: authority in c.dispatches ==> authority.decisionConsumed && authority.policy.decisionId in c.reservedDecisionIds && |ProofLib.Filter((other: core__capabilityAuthority_Authority) => (other.policy.decisionId == authority.policy.decisionId), c.dispatches)| == 1 && core__capabilityAuthority_alwaysReceiptUsesAuthenticIdentity(authority) && core__capabilityAuthority_alwaysAcceptedReceiptHasExactBindings(authority))
{}

lemma CoordinatorAuthorityDistinct(xs: seq<core__capabilityAuthority_Authority>)
  ensures (forall authority :: authority in xs ==> |ProofLib.Filter((other: core__capabilityAuthority_Authority) => (other.policy.decisionId == authority.policy.decisionId), xs)| == 1) <==> ProofLib.DistinctBy(xs, (authority: core__capabilityAuthority_Authority) => authority.policy.decisionId)
{
  if forall authority :: authority in xs ==> |ProofLib.Filter((other: core__capabilityAuthority_Authority) => (other.policy.decisionId == authority.policy.decisionId), xs)| == 1 {
    forall i, j | 0 <= i < |xs| && 0 <= j < |xs| && i != j
      ensures xs[i].policy.decisionId != xs[j].policy.decisionId
    {
      ProofLib.FilterCountOneIffUnique((other: core__capabilityAuthority_Authority) => (other.policy.decisionId == xs[i].policy.decisionId), xs, (authority: core__capabilityAuthority_Authority) => authority.policy.decisionId, i);
    }
  } else if ProofLib.DistinctBy(xs, (authority: core__capabilityAuthority_Authority) => authority.policy.decisionId) {
    forall authority | authority in xs
      ensures |ProofLib.Filter((other: core__capabilityAuthority_Authority) => (other.policy.decisionId == authority.policy.decisionId), xs)| == 1
    {
      var i :| 0 <= i < |xs| && xs[i] == authority;
      ProofLib.FilterOne((other: core__capabilityAuthority_Authority) => (other.policy.decisionId == authority.policy.decisionId), xs, i);
    }
  }
}

lemma CoordinatorRegisteredLookup(c: Coordinator, authority: core__capabilityAuthority_Authority)
  requires alwaysRegisteredIdentitiesAreUnique(c)
  requires authority in c.registered
  ensures lookup(c, authority.policy.decisionId) == authority
{
  CoordinatorFilters(c);
  var matches := ProofLib.Filter((other: core__capabilityAuthority_Authority) => (other.policy.decisionId == authority.policy.decisionId), c.registered);
  ProofLib.FilterMember((other: core__capabilityAuthority_Authority) => (other.policy.decisionId == authority.policy.decisionId), c.registered, authority);
  assert |matches| == 1;
  assert matches[0] == authority;
}

lemma CoordinatorDispatchLookup(c: Coordinator, authority: core__capabilityAuthority_Authority)
  requires alwaysDispatchIdentitiesAreUnique(c)
  requires authority in c.dispatches
  ensures dispatchAt(c, authority.policy.decisionId) == authority
{
  CoordinatorFilters(c);
  var matches := ProofLib.Filter((other: core__capabilityAuthority_Authority) => (other.policy.decisionId == authority.policy.decisionId), c.dispatches);
  ProofLib.FilterMember((other: core__capabilityAuthority_Authority) => (other.policy.decisionId == authority.policy.decisionId), c.dispatches, authority);
  assert |matches| == 1;
  assert matches[0] == authority;
}

lemma CoordinatorAbsentLookup(c: Coordinator, decisionId: string)
  requires !(exists authority :: authority in c.registered && authority.policy.decisionId == decisionId)
  ensures lookup(c, decisionId) == core__capabilityAuthority_initial
{
  ProofLib.FilterNone((authority: core__capabilityAuthority_Authority) => (authority.policy.decisionId == decisionId), c.registered);
}

lemma CoordinatorMappedDistinct(before: seq<core__capabilityAuthority_Authority>, after: seq<core__capabilityAuthority_Authority>)
  requires ProofLib.DistinctBy(before, (authority: core__capabilityAuthority_Authority) => authority.policy.decisionId)
  requires |before| == |after|
  requires forall i :: 0 <= i < |before| ==> before[i].policy.decisionId == after[i].policy.decisionId
  ensures ProofLib.DistinctBy(after, (authority: core__capabilityAuthority_Authority) => authority.policy.decisionId)
{
  forall i, j | 0 <= i < |after| && 0 <= j < |after| && i != j
    ensures after[i].policy.decisionId != after[j].policy.decisionId
  {}
}

lemma CoordinatorDispatchSummary(c: Coordinator, decisionId: string)
  ensures dispatchAt(c, decisionId) == core__capabilityAuthority_initial || (dispatchAt(c, decisionId) in c.dispatches && dispatchAt(c, decisionId).policy.decisionId == decisionId)
{
  var matches := ProofLib.Filter((authority: core__capabilityAuthority_Authority) => (authority.policy.decisionId == decisionId), c.dispatches);
  if |matches| > 0 {
    ProofLib.FilterMember((authority: core__capabilityAuthority_Authority) => (authority.policy.decisionId == decisionId), c.dispatches, matches[0]);
  }
}

lemma CoordinatorMemberProtocol(c: Coordinator, authority: core__capabilityAuthority_Authority)
  requires inv(c)
  requires authority in c.registered || authority in c.dispatches
  ensures core__capabilityAuthority_inv(authority)
{}

lemma CoordinatorMappedState(c: Coordinator, after: Coordinator)
  requires inv(c)
  requires after.reservedDecisionIds == c.reservedDecisionIds && after.reservedConfirmationIds == c.reservedConfirmationIds
  requires after.nextObject == c.nextObject
  requires (after.lastResult == c.lastResult && after.lastDecisionId == c.lastDecisionId) || (!after.lastResult.DispatchConsumed? && !after.lastResult.SnapshotRejected?)
  requires |after.registered| == |c.registered| && |after.dispatches| == |c.dispatches|
  requires forall i :: 0 <= i < |c.registered| ==> after.registered[i].policy == c.registered[i].policy && !after.registered[i].decisionConsumed && (after.registered[i].phase.Registered? || after.registered[i].phase.Confirmed?) && after.registered[i].now == after.now && after.registered[i].originalObject == 0 && after.registered[i].candidateObject == 0 && after.registered[i].nextObject == 1 && |after.registered[i].authenticObjects| == 0 && !after.registered[i].receiptAccepted
  requires forall i :: 0 <= i < |c.dispatches| ==> after.dispatches[i].policy == c.dispatches[i].policy && after.dispatches[i].authenticObjects == c.dispatches[i].authenticObjects && core__capabilityAuthority_inv(after.dispatches[i]) && after.dispatches[i].decisionConsumed && after.dispatches[i].originalObject < after.nextObject && after.dispatches[i].candidateObject < after.nextObject && after.dispatches[i].nextObject <= after.nextObject
  ensures inv(after)
{
  CoordinatorFilters(c);
  CoordinatorFilters(after);
  CoordinatorAuthorityDistinct(c.registered);
  CoordinatorAuthorityDistinct(c.dispatches);
  CoordinatorMappedDistinct(c.registered, after.registered);
  CoordinatorMappedDistinct(c.dispatches, after.dispatches);
  CoordinatorAuthorityDistinct(after.registered);
  CoordinatorAuthorityDistinct(after.dispatches);
  forall authority | authority in after.registered
    ensures authority.policy.decisionId != "" && authority.policy.decisionId in after.reservedDecisionIds && (!authority.policy.confirmationRequired || authority.policy.confirmationId in after.reservedConfirmationIds)
  {
    var i :| 0 <= i < |after.registered| && after.registered[i] == authority;
  }
  forall authority | authority in after.dispatches
    ensures authority.decisionConsumed && authority.policy.decisionId in after.reservedDecisionIds && core__capabilityAuthority_alwaysReceiptUsesAuthenticIdentity(authority) && core__capabilityAuthority_alwaysAcceptedReceiptHasExactBindings(authority)
  {
    var i :| 0 <= i < |after.dispatches| && after.dispatches[i] == authority;
  }
  assert alwaysRegisteredIdentitiesAreUnique(after);
  assert alwaysDispatchIdentitiesAreUnique(after);
  forall registered | registered in after.registered
    ensures !(exists dispatched :: dispatched in after.dispatches && dispatched.policy.decisionId == registered.policy.decisionId)
  {
    var i :| 0 <= i < |after.registered| && after.registered[i] == registered;
    forall dispatched | dispatched in after.dispatches
      ensures dispatched.policy.decisionId != registered.policy.decisionId
    {
      var j :| 0 <= j < |after.dispatches| && after.dispatches[j] == dispatched;
    }
  }
  forall authority | authority in after.dispatches
    ensures forall reference :: reference in authority.authenticObjects ==> reference < after.nextObject && forall other :: other in after.dispatches ==> other.policy.decisionId == authority.policy.decisionId || !(reference in other.authenticObjects)
  {
    var i :| 0 <= i < |after.dispatches| && after.dispatches[i] == authority;
    forall reference | reference in authority.authenticObjects
      ensures reference < after.nextObject && forall other :: other in after.dispatches ==> other.policy.decisionId == authority.policy.decisionId || !(reference in other.authenticObjects)
    {
      forall other | other in after.dispatches
        ensures other.policy.decisionId == authority.policy.decisionId || !(reference in other.authenticObjects)
      {
        var j :| 0 <= j < |after.dispatches| && after.dispatches[j] == other;
      }
    }
  }
  if after.lastResult.DispatchConsumed? || after.lastResult.SnapshotRejected? {
    var prior := dispatchAt(c, c.lastDecisionId);
    CoordinatorDispatchSummary(c, c.lastDecisionId);
    assert prior in c.dispatches;
    var i :| 0 <= i < |c.dispatches| && c.dispatches[i] == prior;
    CoordinatorDispatchLookup(after, after.dispatches[i]);
  }
}

lemma CoordinatorTransfer(c: Coordinator, after: Coordinator, registeredAuthority: core__capabilityAuthority_Authority, transferred: core__capabilityAuthority_Authority)
  requires inv(c) && registeredAuthority in c.registered
  requires core__capabilityAuthority_inv(transferred) && transferred.decisionConsumed
  requires transferred.policy == registeredAuthority.policy && transferred.originalObject == 0 && transferred.candidateObject == 0 && transferred.nextObject == 1 && |transferred.authenticObjects| == 0
  requires after.registered == ProofLib.Filter((authority: core__capabilityAuthority_Authority) => (authority.policy.decisionId != registeredAuthority.policy.decisionId), c.registered)
  requires after.dispatches == c.dispatches + [transferred]
  requires after.reservedDecisionIds == c.reservedDecisionIds && after.reservedConfirmationIds == c.reservedConfirmationIds && after.now == c.now && after.nextObject == c.nextObject
  requires after.lastDecisionId == registeredAuthority.policy.decisionId && (after.lastResult.DispatchConsumed? || after.lastResult.SnapshotRejected?)
  ensures inv(after)
{
  CoordinatorFilters(c);
  CoordinatorFilters(after);
  CoordinatorAuthorityDistinct(c.registered);
  CoordinatorAuthorityDistinct(c.dispatches);
  ProofLib.FilterKeepsDistinctBy((authority: core__capabilityAuthority_Authority) => (authority.policy.decisionId != registeredAuthority.policy.decisionId), c.registered, (authority: core__capabilityAuthority_Authority) => authority.policy.decisionId);
  CoordinatorAuthorityDistinct(after.registered);
  forall authority | authority in c.dispatches ensures authority.policy.decisionId != transferred.policy.decisionId {}
  ProofLib.DistinctByConcat(c.dispatches, [transferred], (authority: core__capabilityAuthority_Authority) => authority.policy.decisionId);
  CoordinatorAuthorityDistinct(after.dispatches);
  forall authority | authority in after.registered
    ensures authority in c.registered && authority.policy.decisionId != registeredAuthority.policy.decisionId
  {
    ProofLib.FilterMember((authority: core__capabilityAuthority_Authority) => (authority.policy.decisionId != registeredAuthority.policy.decisionId), c.registered, authority);
  }
  forall authority | authority in after.dispatches
    ensures core__capabilityAuthority_inv(authority) && authority.decisionConsumed && authority.policy.decisionId in after.reservedDecisionIds
  {
    if authority != transferred {
      assert authority in c.dispatches;
      CoordinatorMemberProtocol(c, authority);
    }
  }
  assert alwaysRegisteredIdentitiesAreUnique(after);
  assert alwaysDispatchIdentitiesAreUnique(after);
  forall registered | registered in after.registered
    ensures !(exists dispatched :: dispatched in after.dispatches && dispatched.policy.decisionId == registered.policy.decisionId)
  {
    forall dispatched | dispatched in after.dispatches
      ensures dispatched.policy.decisionId != registered.policy.decisionId
    {}
  }
  forall authority | authority in after.dispatches
    ensures forall reference :: reference in authority.authenticObjects ==> reference < after.nextObject && forall other :: other in after.dispatches ==> other.policy.decisionId == authority.policy.decisionId || !(reference in other.authenticObjects)
  {
    forall reference | reference in authority.authenticObjects
      ensures reference < after.nextObject && forall other :: other in after.dispatches ==> other.policy.decisionId == authority.policy.decisionId || !(reference in other.authenticObjects)
    {
      assert authority in c.dispatches;
      forall other | other in after.dispatches
        ensures other.policy.decisionId == authority.policy.decisionId || !(reference in other.authenticObjects)
      {}
    }
  }
  CoordinatorDispatchLookup(after, transferred);
}

lemma CoordinatorRegister(c: Coordinator, after: Coordinator, added: core__capabilityAuthority_Authority)
  requires inv(c)
  requires !(added.policy.decisionId in c.reservedDecisionIds)
  requires added.policy.decisionId != "" && (added.phase.Registered? || added.phase.Confirmed?) && !added.decisionConsumed && added.now == c.now
  requires added.originalObject == 0 && added.candidateObject == 0 && added.nextObject == 1 && |added.authenticObjects| == 0 && !added.receiptAccepted
  requires after.registered == c.registered + [added] && after.dispatches == c.dispatches
  requires after.now == c.now && after.nextObject == c.nextObject && after.lastResult.DecisionRegistered?
  requires forall reference :: reference in c.reservedDecisionIds ==> reference in after.reservedDecisionIds
  requires forall reference :: reference in c.reservedConfirmationIds ==> reference in after.reservedConfirmationIds
  requires added.policy.decisionId in after.reservedDecisionIds && (!added.policy.confirmationRequired || added.policy.confirmationId in after.reservedConfirmationIds)
  ensures inv(after)
{
  CoordinatorFilters(c);
  CoordinatorFilters(after);
  CoordinatorAuthorityDistinct(c.registered);
  forall authority | authority in c.registered ensures authority.policy.decisionId != added.policy.decisionId {}
  ProofLib.DistinctByConcat(c.registered, [added], (authority: core__capabilityAuthority_Authority) => authority.policy.decisionId);
  CoordinatorAuthorityDistinct(after.registered);
  forall authority | authority in after.registered
    ensures authority.policy.decisionId != "" && authority.policy.decisionId in after.reservedDecisionIds && (!authority.policy.confirmationRequired || authority.policy.confirmationId in after.reservedConfirmationIds)
  {
    if authority != added { assert authority in c.registered; }
  }
  forall authority | authority in after.dispatches
    ensures authority.policy.decisionId in after.reservedDecisionIds
  {}
  forall registered | registered in after.registered
    ensures !(exists dispatched :: dispatched in after.dispatches && dispatched.policy.decisionId == registered.policy.decisionId)
  {
    forall dispatched | dispatched in after.dispatches
      ensures dispatched.policy.decisionId != registered.policy.decisionId
    {
      if registered == added { assert dispatched.policy.decisionId in c.reservedDecisionIds; }
    }
  }
}

lemma CoordinatorReplace(c: Coordinator, after: Coordinator, replacement: core__capabilityAuthority_Authority, nextNumber: int)
  requires inv(c)
  requires exists authority :: authority in c.dispatches && authority.policy == replacement.policy
  requires core__capabilityAuthority_inv(replacement) && replacement.decisionConsumed
  requires nextNumber >= c.nextObject && replacement.originalObject < nextNumber && replacement.candidateObject < nextNumber && replacement.nextObject <= nextNumber
  requires forall other :: other in c.dispatches && other.policy.decisionId != replacement.policy.decisionId ==> forall reference :: reference in replacement.authenticObjects ==> !(reference in other.authenticObjects)
  requires after == replaceDispatch(replacement, c).(nextObject := nextNumber)
  ensures inv(after)
{
  CoordinatorFilters(c);
  CoordinatorFilters(after);
  CoordinatorAuthorityDistinct(c.dispatches);
  CoordinatorMappedDistinct(c.dispatches, after.dispatches);
  CoordinatorAuthorityDistinct(after.dispatches);
  forall authority | authority in after.dispatches
    ensures core__capabilityAuthority_inv(authority) && authority.decisionConsumed && authority.policy.decisionId in after.reservedDecisionIds && authority.originalObject < nextNumber && authority.candidateObject < nextNumber && authority.nextObject <= nextNumber
  {
    var i :| 0 <= i < |after.dispatches| && after.dispatches[i] == authority;
    if c.dispatches[i].policy.decisionId != replacement.policy.decisionId {
      CoordinatorMemberProtocol(c, c.dispatches[i]);
    }
  }
  assert alwaysDispatchIdentitiesAreUnique(after);
  forall authority | authority in after.dispatches
    ensures forall reference :: reference in authority.authenticObjects ==> reference < after.nextObject && forall other :: other in after.dispatches ==> other.policy.decisionId == authority.policy.decisionId || !(reference in other.authenticObjects)
  {
    var i :| 0 <= i < |after.dispatches| && after.dispatches[i] == authority;
    forall reference | reference in authority.authenticObjects
      ensures reference < after.nextObject && forall other :: other in after.dispatches ==> other.policy.decisionId == authority.policy.decisionId || !(reference in other.authenticObjects)
    {
      forall other | other in after.dispatches
        ensures other.policy.decisionId == authority.policy.decisionId || !(reference in other.authenticObjects)
      {
        var j :| 0 <= j < |after.dispatches| && after.dispatches[j] == other;
      }
    }
  }
  forall registered | registered in after.registered
    ensures !(exists dispatched :: dispatched in after.dispatches && dispatched.policy.decisionId == registered.policy.decisionId)
  {
    forall dispatched | dispatched in after.dispatches
      ensures dispatched.policy.decisionId != registered.policy.decisionId
    {
      var j :| 0 <= j < |after.dispatches| && after.dispatches[j] == dispatched;
    }
  }
  if c.lastResult.DispatchConsumed? || c.lastResult.SnapshotRejected? {
    var prior := dispatchAt(c, c.lastDecisionId);
    CoordinatorDispatchSummary(c, c.lastDecisionId);
    assert prior in c.dispatches;
    var i :| 0 <= i < |c.dispatches| && c.dispatches[i] == prior;
    CoordinatorDispatchLookup(after, after.dispatches[i]);
  }
}

lemma CoordinatorExpandedFrontier(c: Coordinator, authority: core__capabilityAuthority_Authority)
  requires inv(c) && authority in c.dispatches
  ensures core__capabilityAuthority_inv(authority.(nextObject := c.nextObject))
{
  CoordinatorMemberProtocol(c, authority);
}

lemma CoordinatorRegisteredSummary(c: Coordinator, decisionId: string)
  ensures lookup(c, decisionId) == core__capabilityAuthority_initial || (lookup(c, decisionId) in c.registered && lookup(c, decisionId).policy.decisionId == decisionId)
{
  var matches := ProofLib.Filter((authority: core__capabilityAuthority_Authority) => (authority.policy.decisionId == decisionId), c.registered);
  if |matches| > 0 {
    ProofLib.FilterMember((authority: core__capabilityAuthority_Authority) => (authority.policy.decisionId == decisionId), c.registered, matches[0]);
  }
}

lemma lawAbsentDecisionCannotConsume_ensures(c: Coordinator, by_: core__capabilityAuthority_AuthorityCaller, request: core__capabilityAuthority_CapabilityRequest, policy: core__capabilityAuthority_CapabilityPolicy, grant: core__capabilityAuthority_CapabilityGrant)
  ensures (lawAbsentDecisionCannotConsume(c, by_, request, policy, grant) == true)
{
  if !(exists authority :: authority in c.registered && authority.policy.decisionId == policy.decisionId) {
    CoordinatorAbsentLookup(c, policy.decisionId);
  }
}

lemma register_ensures(c: Coordinator, by_: core__capabilityAuthority_AuthorityCaller, request: core__capabilityAuthority_CapabilityRequest, policy: core__capabilityAuthority_CapabilityPolicy)
  ensures (inv(c) ==> canRegister(c, by_, request, policy) ==> alwaysDispatchObjectsAreGloballyDistinct(register(c, by_, request, policy)))
  ensures (inv(c) ==> canRegister(c, by_, request, policy) ==> alwaysDispatchIdentitiesAreUnique(register(c, by_, request, policy)))
  ensures (inv(c) ==> canRegister(c, by_, request, policy) ==> alwaysRegisteredIdentitiesAreUnique(register(c, by_, request, policy)))
  ensures (inv(c) ==> canRegister(c, by_, request, policy) ==> alwaysRegisteredIdsRemainReserved(register(c, by_, request, policy)))
  ensures (inv(c) ==> canRegister(c, by_, request, policy) ==> alwaysMapContainsOnlyUnconsumedAuthority(register(c, by_, request, policy)))
  ensures (inv(c) ==> canRegister(c, by_, request, policy) ==> alwaysRegisteredAwaitObjectMint(register(c, by_, request, policy)))
  ensures (inv(c) ==> canRegister(c, by_, request, policy) ==> alwaysDispatchAllocationsUseGlobalCounter(register(c, by_, request, policy)))
  ensures (inv(c) ==> canRegister(c, by_, request, policy) ==> alwaysRegisteredAndConsumedAreDisjoint(register(c, by_, request, policy)))
  ensures (inv(c) ==> canRegister(c, by_, request, policy) ==> alwaysDispatchesKeepAuthorityProtocol(register(c, by_, request, policy)))
  ensures (inv(c) ==> canRegister(c, by_, request, policy) ==> alwaysTransferredAuthorityIsConsumed(register(c, by_, request, policy)))
  ensures (inv(c) ==> canRegister(c, by_, request, policy) ==> stepReservationsArePermanent(c, "register", register(c, by_, request, policy)))
{
  if inv(c) && canRegister(c, by_, request, policy) {
    var after := register(c, by_, request, policy);
    var added := core__capabilityAuthority_register(core__capabilityAuthority_initial.(now := c.now), by_, request, policy);
    assert policy.decisionId in after.reservedDecisionIds by {
      ProofLib.FilterMember((set_x: string) => !((set_x in c.reservedDecisionIds)), [policy.decisionId], policy.decisionId);
    }
    if policy.confirmationRequired {
      ProofLib.FilterMember((set_x: string) => !((set_x in c.reservedConfirmationIds)), [policy.confirmationId], policy.confirmationId);
    }
    CoordinatorRegister(c, after, added);
  }
}

lemma setClock_ensures(c: Coordinator, by_: core__capabilityAuthority_AuthorityCaller, now: int)
  ensures (inv(c) ==> canSetClock(c, by_, now) ==> alwaysDispatchObjectsAreGloballyDistinct(setClock(c, by_, now)))
  ensures (inv(c) ==> canSetClock(c, by_, now) ==> alwaysDispatchIdentitiesAreUnique(setClock(c, by_, now)))
  ensures (inv(c) ==> canSetClock(c, by_, now) ==> alwaysRegisteredIdentitiesAreUnique(setClock(c, by_, now)))
  ensures (inv(c) ==> canSetClock(c, by_, now) ==> alwaysRegisteredIdsRemainReserved(setClock(c, by_, now)))
  ensures (inv(c) ==> canSetClock(c, by_, now) ==> alwaysMapContainsOnlyUnconsumedAuthority(setClock(c, by_, now)))
  ensures (inv(c) ==> canSetClock(c, by_, now) ==> alwaysRegisteredAwaitObjectMint(setClock(c, by_, now)))
  ensures (inv(c) ==> canSetClock(c, by_, now) ==> alwaysDispatchAllocationsUseGlobalCounter(setClock(c, by_, now)))
  ensures (inv(c) ==> canSetClock(c, by_, now) ==> alwaysRegisteredAndConsumedAreDisjoint(setClock(c, by_, now)))
  ensures (inv(c) ==> canSetClock(c, by_, now) ==> alwaysDispatchesKeepAuthorityProtocol(setClock(c, by_, now)))
  ensures (inv(c) ==> canSetClock(c, by_, now) ==> alwaysTransferredAuthorityIsConsumed(setClock(c, by_, now)))
  ensures (inv(c) ==> canSetClock(c, by_, now) ==> stepReservationsArePermanent(c, "setClock", setClock(c, by_, now)))
{
  if inv(c) && canSetClock(c, by_, now) {
    var after := setClock(c, by_, now);
    forall i | 0 <= i < |c.dispatches|
      ensures core__capabilityAuthority_inv(after.dispatches[i])
    {
      CoordinatorMemberProtocol(c, c.dispatches[i]);
      core__capabilityAuthority_setClock_ensures(c.dispatches[i], by_, now);
    }
    CoordinatorMappedState(c, after);
  }
}

lemma invalidateAccount_ensures(c: Coordinator, by_: core__capabilityAuthority_AuthorityCaller, accountId: string)
  ensures (inv(c) ==> canInvalidateAccount(c, by_, accountId) ==> alwaysDispatchObjectsAreGloballyDistinct(invalidateAccount(c, by_, accountId)))
  ensures (inv(c) ==> canInvalidateAccount(c, by_, accountId) ==> alwaysDispatchIdentitiesAreUnique(invalidateAccount(c, by_, accountId)))
  ensures (inv(c) ==> canInvalidateAccount(c, by_, accountId) ==> alwaysRegisteredIdentitiesAreUnique(invalidateAccount(c, by_, accountId)))
  ensures (inv(c) ==> canInvalidateAccount(c, by_, accountId) ==> alwaysRegisteredIdsRemainReserved(invalidateAccount(c, by_, accountId)))
  ensures (inv(c) ==> canInvalidateAccount(c, by_, accountId) ==> alwaysMapContainsOnlyUnconsumedAuthority(invalidateAccount(c, by_, accountId)))
  ensures (inv(c) ==> canInvalidateAccount(c, by_, accountId) ==> alwaysRegisteredAwaitObjectMint(invalidateAccount(c, by_, accountId)))
  ensures (inv(c) ==> canInvalidateAccount(c, by_, accountId) ==> alwaysDispatchAllocationsUseGlobalCounter(invalidateAccount(c, by_, accountId)))
  ensures (inv(c) ==> canInvalidateAccount(c, by_, accountId) ==> alwaysRegisteredAndConsumedAreDisjoint(invalidateAccount(c, by_, accountId)))
  ensures (inv(c) ==> canInvalidateAccount(c, by_, accountId) ==> alwaysDispatchesKeepAuthorityProtocol(invalidateAccount(c, by_, accountId)))
  ensures (inv(c) ==> canInvalidateAccount(c, by_, accountId) ==> alwaysTransferredAuthorityIsConsumed(invalidateAccount(c, by_, accountId)))
  ensures (inv(c) ==> canInvalidateAccount(c, by_, accountId) ==> stepReservationsArePermanent(c, "invalidateAccount", invalidateAccount(c, by_, accountId)))
{
  if inv(c) && canInvalidateAccount(c, by_, accountId) {
    var after := invalidateAccount(c, by_, accountId);
    forall authority | authority in c.dispatches
      ensures core__capabilityAuthority_inv(authority)
    { CoordinatorMemberProtocol(c, authority); }
    CoordinatorMappedState(c, after);
  }
}

lemma issueGrant_ensures(c: Coordinator, by_: core__capabilityAuthority_AuthorityCaller, decisionId: string, grant: core__capabilityAuthority_CapabilityGrant)
  ensures (inv(c) ==> canIssueGrant(c, by_, decisionId, grant) ==> alwaysDispatchObjectsAreGloballyDistinct(issueGrant(c, by_, decisionId, grant)))
  ensures (inv(c) ==> canIssueGrant(c, by_, decisionId, grant) ==> alwaysDispatchIdentitiesAreUnique(issueGrant(c, by_, decisionId, grant)))
  ensures (inv(c) ==> canIssueGrant(c, by_, decisionId, grant) ==> alwaysRegisteredIdentitiesAreUnique(issueGrant(c, by_, decisionId, grant)))
  ensures (inv(c) ==> canIssueGrant(c, by_, decisionId, grant) ==> alwaysRegisteredIdsRemainReserved(issueGrant(c, by_, decisionId, grant)))
  ensures (inv(c) ==> canIssueGrant(c, by_, decisionId, grant) ==> alwaysMapContainsOnlyUnconsumedAuthority(issueGrant(c, by_, decisionId, grant)))
  ensures (inv(c) ==> canIssueGrant(c, by_, decisionId, grant) ==> alwaysRegisteredAwaitObjectMint(issueGrant(c, by_, decisionId, grant)))
  ensures (inv(c) ==> canIssueGrant(c, by_, decisionId, grant) ==> alwaysDispatchAllocationsUseGlobalCounter(issueGrant(c, by_, decisionId, grant)))
  ensures (inv(c) ==> canIssueGrant(c, by_, decisionId, grant) ==> alwaysRegisteredAndConsumedAreDisjoint(issueGrant(c, by_, decisionId, grant)))
  ensures (inv(c) ==> canIssueGrant(c, by_, decisionId, grant) ==> alwaysDispatchesKeepAuthorityProtocol(issueGrant(c, by_, decisionId, grant)))
  ensures (inv(c) ==> canIssueGrant(c, by_, decisionId, grant) ==> alwaysTransferredAuthorityIsConsumed(issueGrant(c, by_, decisionId, grant)))
  ensures (inv(c) ==> canIssueGrant(c, by_, decisionId, grant) ==> stepReservationsArePermanent(c, "issueGrant", issueGrant(c, by_, decisionId, grant)))
{
  if inv(c) && canIssueGrant(c, by_, decisionId, grant) {
    var after := issueGrant(c, by_, decisionId, grant);
    forall authority | authority in c.dispatches
      ensures core__capabilityAuthority_inv(authority)
    { CoordinatorMemberProtocol(c, authority); }
    CoordinatorMappedState(c, after);
  }
}

lemma consumeDecision_ensures(c: Coordinator, by_: core__capabilityAuthority_AuthorityCaller, request: core__capabilityAuthority_CapabilityRequest, policy: core__capabilityAuthority_CapabilityPolicy, grant: core__capabilityAuthority_CapabilityGrant)
  ensures (inv(c) ==> canConsumeDecision(c, by_, request, policy, grant) ==> alwaysDispatchObjectsAreGloballyDistinct(consumeDecision(c, by_, request, policy, grant)))
  ensures (inv(c) ==> canConsumeDecision(c, by_, request, policy, grant) ==> alwaysDispatchIdentitiesAreUnique(consumeDecision(c, by_, request, policy, grant)))
  ensures (inv(c) ==> canConsumeDecision(c, by_, request, policy, grant) ==> alwaysRegisteredIdentitiesAreUnique(consumeDecision(c, by_, request, policy, grant)))
  ensures (inv(c) ==> canConsumeDecision(c, by_, request, policy, grant) ==> alwaysRegisteredIdsRemainReserved(consumeDecision(c, by_, request, policy, grant)))
  ensures (inv(c) ==> canConsumeDecision(c, by_, request, policy, grant) ==> alwaysMapContainsOnlyUnconsumedAuthority(consumeDecision(c, by_, request, policy, grant)))
  ensures (inv(c) ==> canConsumeDecision(c, by_, request, policy, grant) ==> alwaysRegisteredAwaitObjectMint(consumeDecision(c, by_, request, policy, grant)))
  ensures (inv(c) ==> canConsumeDecision(c, by_, request, policy, grant) ==> alwaysDispatchAllocationsUseGlobalCounter(consumeDecision(c, by_, request, policy, grant)))
  ensures (inv(c) ==> canConsumeDecision(c, by_, request, policy, grant) ==> alwaysRegisteredAndConsumedAreDisjoint(consumeDecision(c, by_, request, policy, grant)))
  ensures (inv(c) ==> canConsumeDecision(c, by_, request, policy, grant) ==> alwaysDispatchesKeepAuthorityProtocol(consumeDecision(c, by_, request, policy, grant)))
  ensures (inv(c) ==> canConsumeDecision(c, by_, request, policy, grant) ==> alwaysTransferredAuthorityIsConsumed(consumeDecision(c, by_, request, policy, grant)))
  ensures (inv(c) ==> canConsumeDecision(c, by_, request, policy, grant) ==> stepReservationsArePermanent(c, "consumeDecision", consumeDecision(c, by_, request, policy, grant)))
{
  if inv(c) && canConsumeDecision(c, by_, request, policy, grant) {
    var originalAuthority := lookup(c, policy.decisionId);
    CoordinatorRegisteredSummary(c, policy.decisionId);
    assert originalAuthority in c.registered;
    CoordinatorMemberProtocol(c, originalAuthority);
    core__capabilityAuthority_consume_ensures(originalAuthority, by_, request, policy, grant);
    var transferred := core__capabilityAuthority_consume(originalAuthority, by_, request, policy, grant);
    CoordinatorTransfer(c, consumeDecision(c, by_, request, policy, grant), originalAuthority, transferred);
  }
}

lemma rejectSnapshot_ensures(c: Coordinator, by_: core__capabilityAuthority_AuthorityCaller, request: core__capabilityAuthority_CapabilityRequest, policy: core__capabilityAuthority_CapabilityPolicy, grant: core__capabilityAuthority_CapabilityGrant)
  ensures (inv(c) ==> canRejectSnapshot(c, by_, request, policy, grant) ==> alwaysDispatchObjectsAreGloballyDistinct(rejectSnapshot(c, by_, request, policy, grant)))
  ensures (inv(c) ==> canRejectSnapshot(c, by_, request, policy, grant) ==> alwaysDispatchIdentitiesAreUnique(rejectSnapshot(c, by_, request, policy, grant)))
  ensures (inv(c) ==> canRejectSnapshot(c, by_, request, policy, grant) ==> alwaysRegisteredIdentitiesAreUnique(rejectSnapshot(c, by_, request, policy, grant)))
  ensures (inv(c) ==> canRejectSnapshot(c, by_, request, policy, grant) ==> alwaysRegisteredIdsRemainReserved(rejectSnapshot(c, by_, request, policy, grant)))
  ensures (inv(c) ==> canRejectSnapshot(c, by_, request, policy, grant) ==> alwaysMapContainsOnlyUnconsumedAuthority(rejectSnapshot(c, by_, request, policy, grant)))
  ensures (inv(c) ==> canRejectSnapshot(c, by_, request, policy, grant) ==> alwaysRegisteredAwaitObjectMint(rejectSnapshot(c, by_, request, policy, grant)))
  ensures (inv(c) ==> canRejectSnapshot(c, by_, request, policy, grant) ==> alwaysDispatchAllocationsUseGlobalCounter(rejectSnapshot(c, by_, request, policy, grant)))
  ensures (inv(c) ==> canRejectSnapshot(c, by_, request, policy, grant) ==> alwaysRegisteredAndConsumedAreDisjoint(rejectSnapshot(c, by_, request, policy, grant)))
  ensures (inv(c) ==> canRejectSnapshot(c, by_, request, policy, grant) ==> alwaysDispatchesKeepAuthorityProtocol(rejectSnapshot(c, by_, request, policy, grant)))
  ensures (inv(c) ==> canRejectSnapshot(c, by_, request, policy, grant) ==> alwaysTransferredAuthorityIsConsumed(rejectSnapshot(c, by_, request, policy, grant)))
  ensures (inv(c) ==> canRejectSnapshot(c, by_, request, policy, grant) ==> stepReservationsArePermanent(c, "rejectSnapshot", rejectSnapshot(c, by_, request, policy, grant)))
{
  if inv(c) && canRejectSnapshot(c, by_, request, policy, grant) {
    var originalAuthority := lookup(c, policy.decisionId);
    CoordinatorRegisteredSummary(c, policy.decisionId);
    assert originalAuthority in c.registered;
    CoordinatorMemberProtocol(c, originalAuthority);
    core__capabilityAuthority_rejectStaleSnapshot_ensures(originalAuthority, by_);
    var transferred := core__capabilityAuthority_rejectStaleSnapshot(originalAuthority, by_);
    CoordinatorTransfer(c, rejectSnapshot(c, by_, request, policy, grant), originalAuthority, transferred);
  }
}

lemma useAuthorizedOriginal_ensures(c: Coordinator, by_: core__capabilityAuthority_AuthorityCaller, decisionId: string)
  ensures (inv(c) ==> canUseAuthorizedOriginal(c, by_, decisionId) ==> alwaysDispatchObjectsAreGloballyDistinct(useAuthorizedOriginal(c, by_, decisionId)))
  ensures (inv(c) ==> canUseAuthorizedOriginal(c, by_, decisionId) ==> alwaysDispatchIdentitiesAreUnique(useAuthorizedOriginal(c, by_, decisionId)))
  ensures (inv(c) ==> canUseAuthorizedOriginal(c, by_, decisionId) ==> alwaysRegisteredIdentitiesAreUnique(useAuthorizedOriginal(c, by_, decisionId)))
  ensures (inv(c) ==> canUseAuthorizedOriginal(c, by_, decisionId) ==> alwaysRegisteredIdsRemainReserved(useAuthorizedOriginal(c, by_, decisionId)))
  ensures (inv(c) ==> canUseAuthorizedOriginal(c, by_, decisionId) ==> alwaysMapContainsOnlyUnconsumedAuthority(useAuthorizedOriginal(c, by_, decisionId)))
  ensures (inv(c) ==> canUseAuthorizedOriginal(c, by_, decisionId) ==> alwaysRegisteredAwaitObjectMint(useAuthorizedOriginal(c, by_, decisionId)))
  ensures (inv(c) ==> canUseAuthorizedOriginal(c, by_, decisionId) ==> alwaysDispatchAllocationsUseGlobalCounter(useAuthorizedOriginal(c, by_, decisionId)))
  ensures (inv(c) ==> canUseAuthorizedOriginal(c, by_, decisionId) ==> alwaysRegisteredAndConsumedAreDisjoint(useAuthorizedOriginal(c, by_, decisionId)))
  ensures (inv(c) ==> canUseAuthorizedOriginal(c, by_, decisionId) ==> alwaysDispatchesKeepAuthorityProtocol(useAuthorizedOriginal(c, by_, decisionId)))
  ensures (inv(c) ==> canUseAuthorizedOriginal(c, by_, decisionId) ==> alwaysTransferredAuthorityIsConsumed(useAuthorizedOriginal(c, by_, decisionId)))
  ensures (inv(c) ==> canUseAuthorizedOriginal(c, by_, decisionId) ==> stepReservationsArePermanent(c, "useAuthorizedOriginal", useAuthorizedOriginal(c, by_, decisionId)))
{
  if inv(c) && canUseAuthorizedOriginal(c, by_, decisionId) {
    var originalAuthority := dispatchAt(c, decisionId);
    CoordinatorDispatchSummary(c, decisionId);
    assert originalAuthority in c.dispatches;
    CoordinatorMemberProtocol(c, originalAuthority);
    core__capabilityAuthority_useOriginal_ensures(originalAuthority, by_);
    var replacement := core__capabilityAuthority_useOriginal(originalAuthority, by_);
    CoordinatorReplace(c, useAuthorizedOriginal(c, by_, decisionId), replacement, c.nextObject);
  }
}

lemma validateDispatchReceipt_ensures(c: Coordinator, decisionId: string, receipt: core__capabilityAuthority_CapabilityReceipt)
  ensures (inv(c) ==> canValidateDispatchReceipt(c, decisionId, receipt) ==> alwaysDispatchObjectsAreGloballyDistinct(validateDispatchReceipt(c, decisionId, receipt)))
  ensures (inv(c) ==> canValidateDispatchReceipt(c, decisionId, receipt) ==> alwaysDispatchIdentitiesAreUnique(validateDispatchReceipt(c, decisionId, receipt)))
  ensures (inv(c) ==> canValidateDispatchReceipt(c, decisionId, receipt) ==> alwaysRegisteredIdentitiesAreUnique(validateDispatchReceipt(c, decisionId, receipt)))
  ensures (inv(c) ==> canValidateDispatchReceipt(c, decisionId, receipt) ==> alwaysRegisteredIdsRemainReserved(validateDispatchReceipt(c, decisionId, receipt)))
  ensures (inv(c) ==> canValidateDispatchReceipt(c, decisionId, receipt) ==> alwaysMapContainsOnlyUnconsumedAuthority(validateDispatchReceipt(c, decisionId, receipt)))
  ensures (inv(c) ==> canValidateDispatchReceipt(c, decisionId, receipt) ==> alwaysRegisteredAwaitObjectMint(validateDispatchReceipt(c, decisionId, receipt)))
  ensures (inv(c) ==> canValidateDispatchReceipt(c, decisionId, receipt) ==> alwaysDispatchAllocationsUseGlobalCounter(validateDispatchReceipt(c, decisionId, receipt)))
  ensures (inv(c) ==> canValidateDispatchReceipt(c, decisionId, receipt) ==> alwaysRegisteredAndConsumedAreDisjoint(validateDispatchReceipt(c, decisionId, receipt)))
  ensures (inv(c) ==> canValidateDispatchReceipt(c, decisionId, receipt) ==> alwaysDispatchesKeepAuthorityProtocol(validateDispatchReceipt(c, decisionId, receipt)))
  ensures (inv(c) ==> canValidateDispatchReceipt(c, decisionId, receipt) ==> alwaysTransferredAuthorityIsConsumed(validateDispatchReceipt(c, decisionId, receipt)))
  ensures (inv(c) ==> canValidateDispatchReceipt(c, decisionId, receipt) ==> stepReservationsArePermanent(c, "validateDispatchReceipt", validateDispatchReceipt(c, decisionId, receipt)))
{
  if inv(c) && canValidateDispatchReceipt(c, decisionId, receipt) {
    var originalAuthority := dispatchAt(c, decisionId);
    CoordinatorDispatchSummary(c, decisionId);
    assert originalAuthority in c.dispatches;
    CoordinatorMemberProtocol(c, originalAuthority);
    core__capabilityAuthority_validateReceipt_ensures(originalAuthority, receipt);
    var replacement := core__capabilityAuthority_validateReceipt(originalAuthority, receipt);
    CoordinatorReplace(c, validateDispatchReceipt(c, decisionId, receipt), replacement, c.nextObject);
  }
}

lemma cloneAuthorizedFields_ensures(c: Coordinator, decisionId: string)
  ensures (inv(c) ==> canCloneAuthorizedFields(c, decisionId) ==> alwaysDispatchObjectsAreGloballyDistinct(cloneAuthorizedFields(c, decisionId)))
  ensures (inv(c) ==> canCloneAuthorizedFields(c, decisionId) ==> alwaysDispatchIdentitiesAreUnique(cloneAuthorizedFields(c, decisionId)))
  ensures (inv(c) ==> canCloneAuthorizedFields(c, decisionId) ==> alwaysRegisteredIdentitiesAreUnique(cloneAuthorizedFields(c, decisionId)))
  ensures (inv(c) ==> canCloneAuthorizedFields(c, decisionId) ==> alwaysRegisteredIdsRemainReserved(cloneAuthorizedFields(c, decisionId)))
  ensures (inv(c) ==> canCloneAuthorizedFields(c, decisionId) ==> alwaysMapContainsOnlyUnconsumedAuthority(cloneAuthorizedFields(c, decisionId)))
  ensures (inv(c) ==> canCloneAuthorizedFields(c, decisionId) ==> alwaysRegisteredAwaitObjectMint(cloneAuthorizedFields(c, decisionId)))
  ensures (inv(c) ==> canCloneAuthorizedFields(c, decisionId) ==> alwaysDispatchAllocationsUseGlobalCounter(cloneAuthorizedFields(c, decisionId)))
  ensures (inv(c) ==> canCloneAuthorizedFields(c, decisionId) ==> alwaysRegisteredAndConsumedAreDisjoint(cloneAuthorizedFields(c, decisionId)))
  ensures (inv(c) ==> canCloneAuthorizedFields(c, decisionId) ==> alwaysDispatchesKeepAuthorityProtocol(cloneAuthorizedFields(c, decisionId)))
  ensures (inv(c) ==> canCloneAuthorizedFields(c, decisionId) ==> alwaysTransferredAuthorityIsConsumed(cloneAuthorizedFields(c, decisionId)))
  ensures (inv(c) ==> canCloneAuthorizedFields(c, decisionId) ==> stepReservationsArePermanent(c, "cloneAuthorizedFields", cloneAuthorizedFields(c, decisionId)))
{
  if inv(c) && canCloneAuthorizedFields(c, decisionId) {
    var originalAuthority := dispatchAt(c, decisionId);
    CoordinatorDispatchSummary(c, decisionId);
    assert originalAuthority in c.dispatches;
    CoordinatorExpandedFrontier(c, originalAuthority);
    var expanded := originalAuthority.(nextObject := c.nextObject);
    core__capabilityAuthority_cloneFields_ensures(expanded);
    var replacement := core__capabilityAuthority_cloneFields(expanded);
    CoordinatorReplace(c, cloneAuthorizedFields(c, decisionId), replacement, c.nextObject + 1);
  }
}

lemma finishDispatch_ensures(c: Coordinator, by_: core__capabilityAuthority_AuthorityCaller, decisionId: string, authorizationId: string)
  ensures (inv(c) ==> canFinishDispatch(c, by_, decisionId, authorizationId) ==> alwaysDispatchObjectsAreGloballyDistinct(finishDispatch(c, by_, decisionId, authorizationId)))
  ensures (inv(c) ==> canFinishDispatch(c, by_, decisionId, authorizationId) ==> alwaysDispatchIdentitiesAreUnique(finishDispatch(c, by_, decisionId, authorizationId)))
  ensures (inv(c) ==> canFinishDispatch(c, by_, decisionId, authorizationId) ==> alwaysRegisteredIdentitiesAreUnique(finishDispatch(c, by_, decisionId, authorizationId)))
  ensures (inv(c) ==> canFinishDispatch(c, by_, decisionId, authorizationId) ==> alwaysRegisteredIdsRemainReserved(finishDispatch(c, by_, decisionId, authorizationId)))
  ensures (inv(c) ==> canFinishDispatch(c, by_, decisionId, authorizationId) ==> alwaysMapContainsOnlyUnconsumedAuthority(finishDispatch(c, by_, decisionId, authorizationId)))
  ensures (inv(c) ==> canFinishDispatch(c, by_, decisionId, authorizationId) ==> alwaysRegisteredAwaitObjectMint(finishDispatch(c, by_, decisionId, authorizationId)))
  ensures (inv(c) ==> canFinishDispatch(c, by_, decisionId, authorizationId) ==> alwaysDispatchAllocationsUseGlobalCounter(finishDispatch(c, by_, decisionId, authorizationId)))
  ensures (inv(c) ==> canFinishDispatch(c, by_, decisionId, authorizationId) ==> alwaysRegisteredAndConsumedAreDisjoint(finishDispatch(c, by_, decisionId, authorizationId)))
  ensures (inv(c) ==> canFinishDispatch(c, by_, decisionId, authorizationId) ==> alwaysDispatchesKeepAuthorityProtocol(finishDispatch(c, by_, decisionId, authorizationId)))
  ensures (inv(c) ==> canFinishDispatch(c, by_, decisionId, authorizationId) ==> alwaysTransferredAuthorityIsConsumed(finishDispatch(c, by_, decisionId, authorizationId)))
  ensures (inv(c) ==> canFinishDispatch(c, by_, decisionId, authorizationId) ==> stepReservationsArePermanent(c, "finishDispatch", finishDispatch(c, by_, decisionId, authorizationId)))
{
  if inv(c) && canFinishDispatch(c, by_, decisionId, authorizationId) {
    var originalAuthority := dispatchAt(c, decisionId);
    CoordinatorDispatchSummary(c, decisionId);
    assert originalAuthority in c.dispatches;
    CoordinatorExpandedFrontier(c, originalAuthority);
    var expanded := originalAuthority.(nextObject := c.nextObject);
    core__capabilityAuthority_finishAuthorization_ensures(expanded, by_, authorizationId);
    var replacement := core__capabilityAuthority_finishAuthorization(expanded, by_, authorizationId);
    var nextNumber := if replacement.phase.Authorized? then c.nextObject + 1 else c.nextObject;
    forall other | other in c.dispatches && other.policy.decisionId != replacement.policy.decisionId
      ensures forall reference :: reference in replacement.authenticObjects ==> !(reference in other.authenticObjects)
    {
      forall reference | reference in replacement.authenticObjects
        ensures !(reference in other.authenticObjects)
      {
        assert reference == c.nextObject;
      }
    }
    CoordinatorReplace(c, finishDispatch(c, by_, decisionId, authorizationId), replacement, nextNumber);
  }
}
