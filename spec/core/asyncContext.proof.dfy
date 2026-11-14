lemma ContextFilters(s: ContextScopes)
  ensures alwaysContinuationIdsAreUnique(s) == (forall continuation :: continuation in s.continuations ==> |ProofLib.Filter((other: Continuation) => (other.id == continuation.id), s.continuations)| == 1)
{}

lemma ContextIdentityMap(before: ContextScopes, after: ContextScopes)
  requires inv(before)
  requires |before.continuations| == |after.continuations|
  requires forall i :: 0 <= i < |before.continuations| ==> before.continuations[i].id == after.continuations[i].id
  ensures inv(after)
  ensures stepExistingContinuationsRemainRegistered(before, after)
{
  ContextFilters(before); ContextFilters(after);
  forall continuation | continuation in after.continuations
    ensures |ProofLib.Filter((other: Continuation) => (other.id == continuation.id), after.continuations)| == 1
  {
    var i :| 0 <= i < |after.continuations| && after.continuations[i] == continuation;
    assert before.continuations[i] in before.continuations;
    assert before.continuations[i].id == continuation.id;
    ProofLib.FilterLengthPointwise((other: Continuation) => (other.id == continuation.id), (other: Continuation) => (other.id == continuation.id), before.continuations, after.continuations);
  }
  forall continuation | continuation in before.continuations
    ensures exists other :: other in after.continuations && other.id == continuation.id
  {
    var i :| 0 <= i < |before.continuations| && before.continuations[i] == continuation;
    assert after.continuations[i] in after.continuations;
  }
}

lemma ContextAppend(s: ContextScopes, newContinuation: Continuation)
  requires inv(s)
  requires !hasContinuation(s, newContinuation.id)
  ensures inv(ContextScopes(s.continuations + [newContinuation]))
  ensures stepExistingContinuationsRemainRegistered(s, ContextScopes(s.continuations + [newContinuation]))
{
  var after := ContextScopes(s.continuations + [newContinuation]);
  ContextFilters(s); ContextFilters(after);
  forall continuation | continuation in after.continuations
    ensures |ProofLib.Filter((other: Continuation) => (other.id == continuation.id), after.continuations)| == 1
  {
    ProofLib.FilterAppend((other: Continuation) => (other.id == continuation.id), s.continuations, newContinuation);
    if continuation.id == newContinuation.id {
      ProofLib.FilterNone((other: Continuation) => (other.id == continuation.id), s.continuations);
    } else {
      assert continuation in s.continuations;
    }
  }
}

lemma ContextObservation(s: ContextScopes, id: string)
  ensures observedContext(s, id) == (if |ProofLib.Filter((continuation: Continuation) => (continuation.id == id), s.continuations)| > 0 then ProofLib.Filter((continuation: Continuation) => (continuation.id == id), s.continuations)[0].activeContext else emptyContext)
{}

lemma createRoot_ensures(s: ContextScopes, id: string)
  ensures (inv(s) ==> canCreateRoot(s, id) ==> alwaysContinuationIdsAreUnique(createRoot(s, id)))
  ensures (inv(s) ==> canCreateRoot(s, id) ==> stepExistingContinuationsRemainRegistered(s, createRoot(s, id)))
{
  if inv(s) && canCreateRoot(s, id) { ContextAppend(s, Continuation(id, emptyContext, [])); }
}

lemma forkContinuation_ensures(s: ContextScopes, parentId: string, childId: string)
  ensures (inv(s) ==> canForkContinuation(s, parentId, childId) ==> alwaysContinuationIdsAreUnique(forkContinuation(s, parentId, childId)))
  ensures (inv(s) ==> canForkContinuation(s, parentId, childId) ==> stepExistingContinuationsRemainRegistered(s, forkContinuation(s, parentId, childId)))
{
  if inv(s) && canForkContinuation(s, parentId, childId) { ContextAppend(s, Continuation(childId, observedContext(s, parentId), [])); }
}

lemma enterScope_ensures(s: ContextScopes, id: string, identity: string)
  ensures (inv(s) ==> canEnterScope(s, id, identity) ==> alwaysContinuationIdsAreUnique(enterScope(s, id, identity)))
  ensures (inv(s) ==> canEnterScope(s, id, identity) ==> stepExistingContinuationsRemainRegistered(s, enterScope(s, id, identity)))
{
  if inv(s) && canEnterScope(s, id, identity) {
    var after := enterScope(s, id, identity);
    assert |s.continuations| == |after.continuations|;
    forall i | 0 <= i < |s.continuations| ensures s.continuations[i].id == after.continuations[i].id {}
    ContextIdentityMap(s, after);
  }
}

lemma leaveScope_ensures(s: ContextScopes, id: string)
  ensures (inv(s) ==> canLeaveScope(s, id) ==> alwaysContinuationIdsAreUnique(leaveScope(s, id)))
  ensures (inv(s) ==> canLeaveScope(s, id) ==> stepExistingContinuationsRemainRegistered(s, leaveScope(s, id)))
{
  if inv(s) && canLeaveScope(s, id) {
    var after := leaveScope(s, id);
    assert |s.continuations| == |after.continuations|;
    forall i | 0 <= i < |s.continuations| ensures s.continuations[i].id == after.continuations[i].id {}
    ContextIdentityMap(s, after);
  }
}

lemma lawEnterThenLeaveRestores_ensures(s: ContextScopes, id: string, identity: string)
  ensures (lawEnterThenLeaveRestores(s, id, identity) == true)
{
  var entered := enterScope(s, id, identity);
  var after := leaveScope(entered, id);
  assert |s.continuations| == |entered.continuations| == |after.continuations|;
  forall i | 0 <= i < |s.continuations|
    ensures after.continuations[i] == s.continuations[i]
  {
    if s.continuations[i].id == id {
      var continuation := s.continuations[i];
      assert entered.continuations[i].stack == continuation.stack + [continuation.activeContext];
      assert (continuation.stack + [continuation.activeContext])[|continuation.stack|] == continuation.activeContext;
    }
  }
  assert after.continuations == s.continuations;
}

lemma lawPeerContextUnchanged_ensures(s: ContextScopes, id: string, peerId: string, identity: string)
  ensures (lawPeerContextUnchanged(s, id, peerId, identity) == true)
{
  if id != peerId {
    var after := enterScope(s, id, identity);
    ContextObservation(s, peerId); ContextObservation(after, peerId);
    assert |s.continuations| == |after.continuations|;
    forall i | 0 <= i < |s.continuations|
      ensures (s.continuations[i].id == peerId) == (after.continuations[i].id == peerId)
      ensures s.continuations[i].id == peerId ==> s.continuations[i] == after.continuations[i]
    {}
    ProofLib.FilterPointwise((continuation: Continuation) => (continuation.id == peerId), (continuation: Continuation) => (continuation.id == peerId), (left: Continuation, right: Continuation) => (left.id == peerId ==> left == right), s.continuations, after.continuations);
    var priorMatches := ProofLib.Filter((continuation: Continuation) => (continuation.id == peerId), s.continuations);
    var laterMatches := ProofLib.Filter((continuation: Continuation) => (continuation.id == peerId), after.continuations);
    if |priorMatches| > 0 {
      ProofLib.FilterMember((continuation: Continuation) => (continuation.id == peerId), s.continuations, priorMatches[0]);
      assert priorMatches[0] == laterMatches[0];
    }
  }
}
