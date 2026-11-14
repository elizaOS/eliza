lemma SlotFilters(s: AmbientManagers)
  ensures alwaysOneSlotPerSymbol(s) == (s.nextGeneration > 0 && (forall slot :: slot in s.slots ==> slot.reference > 0 && slot.generation > 0 && slot.generation < s.nextGeneration && |ProofLib.Filter((other: AmbientSlot) => (other.key == slot.key), s.slots)| == 1))
{}

lemma SlotMapPreserves(before: AmbientManagers, after: AmbientManagers)
  requires alwaysOneSlotPerSymbol(before)
  requires |before.slots| == |after.slots|
  requires after.nextGeneration > 0
  requires forall i :: 0 <= i < |before.slots| ==> before.slots[i].key == after.slots[i].key && after.slots[i].reference > 0 && after.slots[i].generation > 0 && after.slots[i].generation < after.nextGeneration
  ensures alwaysOneSlotPerSymbol(after)
{
  SlotFilters(before); SlotFilters(after);
  forall slot | slot in after.slots
    ensures slot.reference > 0 && slot.generation > 0 && slot.generation < after.nextGeneration && |ProofLib.Filter((other: AmbientSlot) => (other.key == slot.key), after.slots)| == 1
  {
    var i :| 0 <= i < |after.slots| && after.slots[i] == slot;
    ProofLib.FilterLengthPointwise((other: AmbientSlot) => (other.key == slot.key), (other: AmbientSlot) => (other.key == slot.key), before.slots, after.slots);
  }
}

lemma AppendSlotPreserves(before: AmbientManagers, after: AmbientManagers, key: AmbientKey, reference: int)
  requires alwaysOneSlotPerSymbol(before)
  requires !(exists slot :: slot in before.slots && slot.key == key)
  requires reference > 0
  requires after.slots == before.slots + [AmbientSlot(key, reference, before.nextGeneration)]
  requires after.nextGeneration == before.nextGeneration + 1
  ensures alwaysOneSlotPerSymbol(after)
{
  SlotFilters(before); SlotFilters(after);
  forall slot | slot in after.slots
    ensures slot.reference > 0 && slot.generation > 0 && slot.generation < after.nextGeneration && |ProofLib.Filter((other: AmbientSlot) => (other.key == slot.key), after.slots)| == 1
  {
    ProofLib.FilterAppend((other: AmbientSlot) => (other.key == slot.key), before.slots, AmbientSlot(key, reference, before.nextGeneration));
    if slot.key == key {
      ProofLib.FilterNone((other: AmbientSlot) => (other.key == slot.key), before.slots);
    } else { assert slot in before.slots; }
  }
}

lemma StoredSlot(s: AmbientManagers, key: AmbientKey)
  ensures managerSlot(s, key) == (var matching := ProofLib.Filter((slot: AmbientSlot) => (slot.key == key), s.slots); if |matching| > 0 then matching[0] else absentSlot)
{}

lemma StoredSlotExists(s: AmbientManagers, key: AmbientKey)
  requires alwaysOneSlotPerSymbol(s)
  ensures (exists slot :: slot in s.slots && slot.key == key) ==> managerSlot(s, key) in s.slots && managerSlot(s, key).key == key
  ensures !(exists slot :: slot in s.slots && slot.key == key) ==> managerSlot(s, key) == absentSlot
{
  StoredSlot(s, key);
  if exists slot :: slot in s.slots && slot.key == key {
    var selected :| selected in s.slots && selected.key == key;
    ProofLib.FilterMember((slot: AmbientSlot) => (slot.key == key), s.slots, selected);
    var matching := ProofLib.Filter((slot: AmbientSlot) => (slot.key == key), s.slots);
    assert |matching| > 0;
    ProofLib.FilterMember((slot: AmbientSlot) => (slot.key == key), s.slots, matching[0]);
  } else {
    ProofLib.FilterNone((slot: AmbientSlot) => (slot.key == key), s.slots);
  }
}

lemma OperationParts(s: AmbientManagers, operationId: int, lookupId: int)
  ensures beginManagerOperation(s, operationId, lookupId).operations == (var matches := ProofLib.Filter((l: ManagerLookup) => (l.id == lookupId), s.lookups); var selected := if |matches| > 0 then matches[0] else ManagerLookup(0, 0, AmbientKey.TrajectoryManager, 0, 0); s.operations + [ManagerOperation(operationId, lookupId, selected.key, selected.reference, true)])
{}

lemma replaceManager_ensures(s: AmbientManagers, key: AmbientKey, reference: int)
  ensures (inv(s) ==> canReplaceManager(s, key, reference) ==> alwaysOneSlotPerSymbol(replaceManager(s, key, reference)))
  ensures (inv(s) ==> canReplaceManager(s, key, reference) ==> alwaysLookupGenerationExists(replaceManager(s, key, reference)))
  ensures (inv(s) ==> canReplaceManager(s, key, reference) ==> alwaysOperationUsesCapturedLookup(replaceManager(s, key, reference)))
  ensures (inv(s) ==> canReplaceManager(s, key, reference) ==> stepCapturedOperationManagerStable(s, replaceManager(s, key, reference)))
{
  if inv(s) && canReplaceManager(s, key, reference) {
    var after := replaceManager(s, key, reference);
    if exists slot :: slot in s.slots && slot.key == key {
      SlotMapPreserves(s, after);
    } else { AppendSlotPreserves(s, after, key, reference); }
  }
}

lemma lookupManager_ensures(s: AmbientManagers, lookupId: int, bundle: int, key: AmbientKey, reference: int)
  ensures (inv(s) ==> canLookupManager(s, lookupId, bundle, key, reference) ==> alwaysOneSlotPerSymbol(lookupManager(s, lookupId, bundle, key, reference)))
  ensures (inv(s) ==> canLookupManager(s, lookupId, bundle, key, reference) ==> alwaysLookupGenerationExists(lookupManager(s, lookupId, bundle, key, reference)))
  ensures (inv(s) ==> canLookupManager(s, lookupId, bundle, key, reference) ==> alwaysOperationUsesCapturedLookup(lookupManager(s, lookupId, bundle, key, reference)))
  ensures (inv(s) ==> canLookupManager(s, lookupId, bundle, key, reference) ==> stepCapturedOperationManagerStable(s, lookupManager(s, lookupId, bundle, key, reference)))
{
  if inv(s) && canLookupManager(s, lookupId, bundle, key, reference) {
    StoredSlotExists(s, key);
    var existing := managerSlot(s, key);
    var after := lookupManager(s, lookupId, bundle, key, reference);
    if existing.generation == 0 {
      assert !(exists slot :: slot in s.slots && slot.key == key);
      AppendSlotPreserves(s, after, key, reference);
    } else {
      assert existing in s.slots;
    }
  }
}

lemma beginManagerOperation_ensures(s: AmbientManagers, operationId: int, lookupId: int)
  ensures (inv(s) ==> canBeginManagerOperation(s, operationId, lookupId) ==> alwaysOneSlotPerSymbol(beginManagerOperation(s, operationId, lookupId)))
  ensures (inv(s) ==> canBeginManagerOperation(s, operationId, lookupId) ==> alwaysLookupGenerationExists(beginManagerOperation(s, operationId, lookupId)))
  ensures (inv(s) ==> canBeginManagerOperation(s, operationId, lookupId) ==> alwaysOperationUsesCapturedLookup(beginManagerOperation(s, operationId, lookupId)))
  ensures (inv(s) ==> canBeginManagerOperation(s, operationId, lookupId) ==> stepCapturedOperationManagerStable(s, beginManagerOperation(s, operationId, lookupId)))
{
  if inv(s) && canBeginManagerOperation(s, operationId, lookupId) {
    OperationParts(s, operationId, lookupId);
    var matches := ProofLib.Filter((l: ManagerLookup) => (l.id == lookupId), s.lookups);
    var selected :| selected in s.lookups && selected.id == lookupId;
    ProofLib.FilterMember((l: ManagerLookup) => (l.id == lookupId), s.lookups, selected);
    assert |matches| > 0;
    ProofLib.FilterMember((l: ManagerLookup) => (l.id == lookupId), s.lookups, matches[0]);
    assert matches[0] in s.lookups && matches[0].id == lookupId;
  }
}

lemma finishManagerOperation_ensures(s: AmbientManagers, operationId: int)
  ensures (inv(s) ==> canFinishManagerOperation(s, operationId) ==> alwaysOneSlotPerSymbol(finishManagerOperation(s, operationId)))
  ensures (inv(s) ==> canFinishManagerOperation(s, operationId) ==> alwaysLookupGenerationExists(finishManagerOperation(s, operationId)))
  ensures (inv(s) ==> canFinishManagerOperation(s, operationId) ==> alwaysOperationUsesCapturedLookup(finishManagerOperation(s, operationId)))
  ensures (inv(s) ==> canFinishManagerOperation(s, operationId) ==> stepCapturedOperationManagerStable(s, finishManagerOperation(s, operationId)))
{
  if inv(s) && canFinishManagerOperation(s, operationId) {
    var after := finishManagerOperation(s, operationId);
    forall op | op in s.operations
      ensures exists other :: other in after.operations && other.id == op.id && other.reference == op.reference && other.key == op.key
    {
      var i :| 0 <= i < |s.operations| && s.operations[i] == op;
      assert after.operations[i].id == op.id && after.operations[i].reference == op.reference && after.operations[i].key == op.key;
    }
  }
}
