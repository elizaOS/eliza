lemma ConcurrentHooksBridge(s: ConcurrentHooks)
  ensures alwaysCallIdentity(s) <==> (forall call :: call in s.calls ==> call.id > 0 && |ProofLib.Filter((other: HookCall) => other.id == call.id,s.calls)| == 1)
  ensures alwaysEveryHookCallValid(s) <==> (forall call :: call in s.calls ==> validHookCall(call.unit))
{}

lemma ConcurrentEmptyRegistryCall(unit: core__hooks_HookState)
  requires validHookCall(unit)
  requires unit.memo == [] && unit.epoch == 0 && unit.nextArray == 1
  ensures core__hooks_inv(unit)
{}

lemma ConcurrentRegistryValid(s: ConcurrentHooks)
  requires alwaysRegistryMemoValid(s)
  requires s.registry.snapshot == [] && s.registry.results == [] && !s.registry.completed && !s.registry.rejected
  ensures core__hooks_inv(s.registry)
{}

lemma ConcurrentLookup(s: ConcurrentHooks, callId: int)
  ensures hookCall(s,callId) == core__hooks_initial ||
    (exists call :: call in s.calls && call.id == callId && call.unit == hookCall(s,callId))
{
  var selected := ProofLib.Filter((call: HookCall) => call.id == callId,s.calls);
  if |selected| > 0 {
    ProofLib.FilterMember((call: HookCall) => call.id == callId,s.calls,selected[0]);
  }
}

lemma ConcurrentFind(s: ConcurrentHooks, i: int)
  requires alwaysCallIdentity(s) && 0 <= i < |s.calls|
  ensures hookCall(s,s.calls[i].id) == s.calls[i].unit
{
  ConcurrentHooksBridge(s);
  var id := s.calls[i].id;
  var selected := ProofLib.Filter((call: HookCall) => call.id == id,s.calls);
  assert s.calls[i] in s.calls;
  assert |selected| == 1;
  ProofLib.FilterMember((call: HookCall) => call.id == id,s.calls,s.calls[i]);
  assert selected[0] == s.calls[i];
}

lemma ConcurrentChildValid(phase: string, localAdmission: bool, memo: core__hooks_PhaseMemo)
  requires !localAdmission || phase == "pre_model"
  requires core__hooks_uniqueHookIds(memo.selected)
  ensures validHookCall(core__hooks_childCall(phase,localAdmission,memo))
{
  var unit := core__hooks_childCall(phase,localAdmission,memo);
  forall selected | selected in unit.snapshot ensures exists row :: row in unit.results && row.id == selected.id
  {
    var pos :| 0 <= pos < |unit.snapshot| && unit.snapshot[pos] == selected;
    assert unit.results[pos] in unit.results;
  }
}

lemma ConcurrentMemoAt(s: core__hooks_HookState, phase: string)
  requires core__hooks_alwaysMemoGeneration(s)
  requires phase in core__hooks_pipelinePhases
  ensures core__hooks_memoAt(core__hooks_lookupPhase(s,phase),phase) in core__hooks_lookupPhase(s,phase).memo
{
  var p := (row: core__hooks_PhaseMemo) => row.phase == phase;
  var selected := ProofLib.Filter(p,s.memo);
  var t := core__hooks_lookupPhase(s,phase);
  if |selected| > 0 {
    ProofLib.FilterMember(p,s.memo,selected[0]);
    assert selected[0].arrayRef > 0 && t == s;
  } else {
    forall row | row in s.memo ensures !p(row)
    {
      if p(row) { ProofLib.FilterMember(p,s.memo,row); }
    }
    var addedMemo := t.memo[|s.memo|];
    ProofLib.FilterAppend(p,s.memo,addedMemo);
    assert ProofLib.Filter(p,t.memo) == [addedMemo];
    assert addedMemo in t.memo;
  }
}

lemma ConcurrentCallsPersist(s: ConcurrentHooks, t: ConcurrentHooks)
  requires inv(s) && |s.calls| <= |t.calls| <= |s.calls|+1
  requires forall i :: 0 <= i < |s.calls| ==> s.calls[i].id == t.calls[i].id
  requires forall i :: 0 <= i < |s.calls| ==>
    (s.calls[i].unit.capturedArray == t.calls[i].unit.capturedArray && s.calls[i].unit.snapshot == t.calls[i].unit.snapshot)
  requires forall call :: call in t.calls ==> call.id > 0 && validHookCall(call.unit)
  requires |t.calls| > |s.calls| ==> forall call :: call in s.calls ==> call.id != t.calls[|s.calls|].id
  ensures alwaysCallIdentity(t) && alwaysEveryHookCallValid(t) && stepEverySnapshotStable(s,t)
{
  ConcurrentHooksBridge(s);
  ConcurrentHooksBridge(t);
  forall i,j | 0 <= i < |t.calls| && 0 <= j < |t.calls| && i != j
    ensures t.calls[i].id != t.calls[j].id
  {
    if i < |s.calls| && j < |s.calls| {
      var id := s.calls[i].id;
      assert s.calls[i] in s.calls;
      ProofLib.FilterCountOneIffUnique((other: HookCall) => other.id == id,s.calls,(other: HookCall) => other.id,i);
    }
  }
  forall call | call in t.calls ensures |ProofLib.Filter((other: HookCall) => other.id == call.id,t.calls)| == 1
  {
    var pos :| 0 <= pos < |t.calls| && t.calls[pos] == call;
    ProofLib.FilterOne((other: HookCall) => other.id == call.id,t.calls,pos);
  }
  forall call | call in s.calls
    ensures exists newer :: (newer in t.calls && newer.id == call.id &&
      newer.unit.capturedArray == call.unit.capturedArray && core__hooks_samePipelineOrder(newer.unit.snapshot,call.unit.snapshot))
  {
    var pos :| 0 <= pos < |s.calls| && s.calls[pos] == call;
    assert t.calls[pos] in t.calls;
    core__hooks_lawSelectionReflexive_ensures(call.unit.snapshot);
  }
}

lemma register_ensures(s: ConcurrentHooks, id: int, phase: string, position: int, collation: int, handler: int, kind: core__hooks_HookKind)
  ensures (inv(s) ==> canRegister(s, id, phase, position, collation, handler, kind) ==> alwaysRegistryMemoValid(register(s, id, phase, position, collation, handler, kind)))
  ensures (inv(s) ==> canRegister(s, id, phase, position, collation, handler, kind) ==> alwaysCallIdentity(register(s, id, phase, position, collation, handler, kind)))
  ensures (inv(s) ==> canRegister(s, id, phase, position, collation, handler, kind) ==> alwaysEveryHookCallValid(register(s, id, phase, position, collation, handler, kind)))
  ensures (inv(s) ==> canRegister(s, id, phase, position, collation, handler, kind) ==> stepEverySnapshotStable(s, register(s, id, phase, position, collation, handler, kind)))
  ensures (inv(s) ==> canRegister(s, id, phase, position, collation, handler, kind) ==> stepRegistryMutationKeepsDispatchEpoch(s, "register", register(s, id, phase, position, collation, handler, kind)))
{
  if inv(s) && canRegister(s, id, phase, position, collation, handler, kind) {
    var t := register(s, id, phase, position, collation, handler, kind);
    ConcurrentRegistryValid(s);
    core__hooks_registerHook_ensures(s.registry, id, phase, position, collation, handler, kind);
    ConcurrentHooksBridge(s);
    ConcurrentCallsPersist(s,t);
  }
}

lemma unregister_ensures(s: ConcurrentHooks, id: int)
  ensures (inv(s) ==> alwaysRegistryMemoValid(unregister(s, id)))
  ensures (inv(s) ==> alwaysCallIdentity(unregister(s, id)))
  ensures (inv(s) ==> alwaysEveryHookCallValid(unregister(s, id)))
  ensures (inv(s) ==> stepEverySnapshotStable(s, unregister(s, id)))
  ensures (inv(s) ==> stepRegistryMutationKeepsDispatchEpoch(s, "unregister", unregister(s, id)))
{
  if inv(s) {
    var t := unregister(s, id);
    ConcurrentRegistryValid(s);
    core__hooks_unregisterHook_ensures(s.registry, id);
    ConcurrentHooksBridge(s);
    ConcurrentCallsPersist(s,t);
  }
}

lemma lookupPhase_ensures(s: ConcurrentHooks, phase: string)
  ensures (inv(s) ==> canLookupPhase(s, phase) ==> alwaysRegistryMemoValid(lookupPhase(s, phase)))
  ensures (inv(s) ==> canLookupPhase(s, phase) ==> alwaysCallIdentity(lookupPhase(s, phase)))
  ensures (inv(s) ==> canLookupPhase(s, phase) ==> alwaysEveryHookCallValid(lookupPhase(s, phase)))
  ensures (inv(s) ==> canLookupPhase(s, phase) ==> stepEverySnapshotStable(s, lookupPhase(s, phase)))
  ensures (inv(s) ==> canLookupPhase(s, phase) ==> stepRegistryMutationKeepsDispatchEpoch(s, "lookupPhase", lookupPhase(s, phase)))
{
  if inv(s) && canLookupPhase(s, phase) {
    var t := lookupPhase(s, phase);
    ConcurrentRegistryValid(s);
    core__hooks_lookupPhase_ensures(s.registry, phase);
    ConcurrentHooksBridge(s);
    ConcurrentCallsPersist(s,t);
  }
}

lemma beginCall_ensures(s: ConcurrentHooks, callId: int, phase: string, localAdmission: bool)
  ensures (inv(s) ==> canBeginCall(s, callId, phase, localAdmission) ==> alwaysRegistryMemoValid(beginCall(s, callId, phase, localAdmission)))
  ensures (inv(s) ==> canBeginCall(s, callId, phase, localAdmission) ==> alwaysCallIdentity(beginCall(s, callId, phase, localAdmission)))
  ensures (inv(s) ==> canBeginCall(s, callId, phase, localAdmission) ==> alwaysEveryHookCallValid(beginCall(s, callId, phase, localAdmission)))
  ensures (inv(s) ==> canBeginCall(s, callId, phase, localAdmission) ==> stepEverySnapshotStable(s, beginCall(s, callId, phase, localAdmission)))
  ensures (inv(s) ==> canBeginCall(s, callId, phase, localAdmission) ==> stepRegistryMutationKeepsDispatchEpoch(s, "beginCall", beginCall(s, callId, phase, localAdmission)))
{
  if inv(s) && canBeginCall(s, callId, phase, localAdmission) {
    var t := beginCall(s, callId, phase, localAdmission);
    ConcurrentRegistryValid(s);
    core__hooks_lookupPhase_ensures(s.registry, phase);
    ConcurrentMemoAt(s.registry,phase);
    var memo := core__hooks_memoAt(t.registry,phase);
    ConcurrentChildValid(phase,localAdmission,memo);
    ConcurrentHooksBridge(s);
    forall call | call in t.calls ensures call.id > 0 && validHookCall(call.unit)
    {
      if call !in s.calls { assert call == t.calls[|s.calls|]; }
    }
    ConcurrentCallsPersist(s,t);
  }
}

lemma startCallHook_ensures(s: ConcurrentHooks, callId: int, id: int)
  ensures (inv(s) ==> canStartCallHook(s, callId, id) ==> alwaysRegistryMemoValid(startCallHook(s, callId, id)))
  ensures (inv(s) ==> canStartCallHook(s, callId, id) ==> alwaysCallIdentity(startCallHook(s, callId, id)))
  ensures (inv(s) ==> canStartCallHook(s, callId, id) ==> alwaysEveryHookCallValid(startCallHook(s, callId, id)))
  ensures (inv(s) ==> canStartCallHook(s, callId, id) ==> stepEverySnapshotStable(s, startCallHook(s, callId, id)))
  ensures (inv(s) ==> canStartCallHook(s, callId, id) ==> stepRegistryMutationKeepsDispatchEpoch(s, "startCallHook", startCallHook(s, callId, id)))
{
  if inv(s) && canStartCallHook(s, callId, id) {
    var t := startCallHook(s, callId, id);
    ConcurrentHooksBridge(s);
    forall i | 0 <= i < |s.calls|
      ensures t.calls[i].id == s.calls[i].id && t.calls[i].id > 0 && validHookCall(t.calls[i].unit)
      ensures t.calls[i].unit.capturedArray == s.calls[i].unit.capturedArray && t.calls[i].unit.snapshot == s.calls[i].unit.snapshot
    {
      var original := s.calls[i];
      assert original in s.calls && validHookCall(original.unit);
      if original.id == callId {
        ConcurrentFind(s,i);
        ConcurrentEmptyRegistryCall(original.unit);
        core__hooks_startHook_ensures(original.unit, id);
      }
    }
    forall call | call in t.calls ensures call.id > 0 && validHookCall(call.unit)
    {
      var pos :| 0 <= pos < |t.calls| && t.calls[pos] == call;
    }
    ConcurrentCallsPersist(s,t);
  }
}

lemma finishCallHook_ensures(s: ConcurrentHooks, callId: int, id: int, ok: bool, admissionRefused: bool)
  ensures (inv(s) ==> canFinishCallHook(s, callId, id, ok, admissionRefused) ==> alwaysRegistryMemoValid(finishCallHook(s, callId, id, ok, admissionRefused)))
  ensures (inv(s) ==> canFinishCallHook(s, callId, id, ok, admissionRefused) ==> alwaysCallIdentity(finishCallHook(s, callId, id, ok, admissionRefused)))
  ensures (inv(s) ==> canFinishCallHook(s, callId, id, ok, admissionRefused) ==> alwaysEveryHookCallValid(finishCallHook(s, callId, id, ok, admissionRefused)))
  ensures (inv(s) ==> canFinishCallHook(s, callId, id, ok, admissionRefused) ==> stepEverySnapshotStable(s, finishCallHook(s, callId, id, ok, admissionRefused)))
  ensures (inv(s) ==> canFinishCallHook(s, callId, id, ok, admissionRefused) ==> stepRegistryMutationKeepsDispatchEpoch(s, "finishCallHook", finishCallHook(s, callId, id, ok, admissionRefused)))
{
  if inv(s) && canFinishCallHook(s, callId, id, ok, admissionRefused) {
    var t := finishCallHook(s, callId, id, ok, admissionRefused);
    ConcurrentHooksBridge(s);
    forall i | 0 <= i < |s.calls|
      ensures t.calls[i].id == s.calls[i].id && t.calls[i].id > 0 && validHookCall(t.calls[i].unit)
      ensures t.calls[i].unit.capturedArray == s.calls[i].unit.capturedArray && t.calls[i].unit.snapshot == s.calls[i].unit.snapshot
    {
      var original := s.calls[i];
      assert original in s.calls && validHookCall(original.unit);
      if original.id == callId {
        ConcurrentFind(s,i);
        ConcurrentEmptyRegistryCall(original.unit);
        core__hooks_finishHook_ensures(original.unit, id, ok, admissionRefused);
      }
    }
    forall call | call in t.calls ensures call.id > 0 && validHookCall(call.unit)
    {
      var pos :| 0 <= pos < |t.calls| && t.calls[pos] == call;
    }
    ConcurrentCallsPersist(s,t);
  }
}

lemma finishCall_ensures(s: ConcurrentHooks, callId: int)
  ensures (inv(s) ==> canFinishCall(s, callId) ==> alwaysRegistryMemoValid(finishCall(s, callId)))
  ensures (inv(s) ==> canFinishCall(s, callId) ==> alwaysCallIdentity(finishCall(s, callId)))
  ensures (inv(s) ==> canFinishCall(s, callId) ==> alwaysEveryHookCallValid(finishCall(s, callId)))
  ensures (inv(s) ==> canFinishCall(s, callId) ==> stepEverySnapshotStable(s, finishCall(s, callId)))
  ensures (inv(s) ==> canFinishCall(s, callId) ==> stepRegistryMutationKeepsDispatchEpoch(s, "finishCall", finishCall(s, callId)))
{
  if inv(s) && canFinishCall(s, callId) {
    var t := finishCall(s, callId);
    ConcurrentHooksBridge(s);
    forall i | 0 <= i < |s.calls|
      ensures t.calls[i].id == s.calls[i].id && t.calls[i].id > 0 && validHookCall(t.calls[i].unit)
      ensures t.calls[i].unit.capturedArray == s.calls[i].unit.capturedArray && t.calls[i].unit.snapshot == s.calls[i].unit.snapshot
    {
      var original := s.calls[i];
      assert original in s.calls && validHookCall(original.unit);
      if original.id == callId {
        ConcurrentFind(s,i);
        ConcurrentEmptyRegistryCall(original.unit);
        core__hooks_finishHooks_ensures(original.unit);
      }
    }
    forall call | call in t.calls ensures call.id > 0 && validHookCall(call.unit)
    {
      var pos :| 0 <= pos < |t.calls| && t.calls[pos] == call;
    }
    ConcurrentCallsPersist(s,t);
  }
}

lemma lawRegistrySnapshotEquality_ensures(s: ConcurrentHooks)
  ensures (lawRegistrySnapshotEquality(s) == true)
{
  forall call | call in s.calls ensures core__hooks_lawSelectionReflexive(call.unit.snapshot)
  {
    core__hooks_lawSelectionReflexive_ensures(call.unit.snapshot);
  }
}
