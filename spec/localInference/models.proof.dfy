lemma LocalClearedAssignments(xs: seq<ModelSlot>, m: map<ModelSlot, string>, modelId: string, slot: ModelSlot)
  ensures lookup1_localInference__models(Std.Collections.Seq.FoldLeft((m: map<ModelSlot, string>, slot: ModelSlot) => (if (lookup1_localInference__models(m, slot, "") == modelId) then m[slot := ""] else m), m, xs), slot, "") == (if slot in xs && lookup1_localInference__models(m, slot, "") == modelId then "" else lookup1_localInference__models(m, slot, ""))
  decreases |xs|
{
  if |xs| > 0 {
    LocalClearedAssignments(xs[1..], if (lookup1_localInference__models(m, xs[0], "") == modelId) then m[xs[0] := ""] else m, modelId, slot);
  }
}

lemma LocalAssignedFold(s: LocalModels, ok: bool, xs: seq<ModelSlot>)
  ensures Std.Collections.Seq.FoldLeft((ok: bool, slot: ModelSlot) => (ok && ((assignedTo(s, slot) == "") || installed(s, assignedTo(s, slot)))), ok, xs) == (ok && forall slot :: slot in xs ==> (assignedTo(s, slot) == "") || installed(s, assignedTo(s, slot)))
  decreases |xs|
{
  if |xs| > 0 {
    LocalAssignedFold(s, ok && ((assignedTo(s, xs[0]) == "") || installed(s, assignedTo(s, xs[0]))), xs[1..]);
    assert xs == [xs[0]] + xs[1..];
  }
}

lemma LocalOtherModelKept(s: LocalModels, modelId: string, other: string)
  requires other != modelId
  ensures modelOf(uninstallModel(s, modelId), other) == modelOf(s, other)
{
  assert ("$" + other)[1..] == other && ("$" + modelId)[1..] == modelId;
  assert ("$" + other) != ("$" + modelId);
}

lemma LocalSlotsMatchFold(s: LocalModels, ok: bool, xs: seq<ModelSlot>)
  ensures Std.Collections.Seq.FoldLeft((ok: bool, slot: ModelSlot) => (ok && ((assignedTo(s, slot) == "") || servesSlot(modelOf(s, assignedTo(s, slot)).role, slot))), ok, xs) == (ok && forall slot :: slot in xs ==> (assignedTo(s, slot) == "") || servesSlot(modelOf(s, assignedTo(s, slot)).role, slot))
  decreases |xs|
{
  if |xs| > 0 {
    LocalSlotsMatchFold(s, ok && ((assignedTo(s, xs[0]) == "") || servesSlot(modelOf(s, assignedTo(s, xs[0])).role, xs[0])), xs[1..]);
    assert xs == [xs[0]] + xs[1..];
  }
}

lemma LocalUninstallSlot(s: LocalModels, modelId: string, slot: ModelSlot)
  requires slot in allSlots
  ensures assignedTo(uninstallModel(s, modelId), slot) == (if assignedTo(s, slot) == modelId then "" else assignedTo(s, slot))
  ensures assignedTo(uninstallModel(s, modelId), slot) != "" ==> modelOf(uninstallModel(s, modelId), assignedTo(uninstallModel(s, modelId), slot)) == modelOf(s, assignedTo(s, slot))
{
  LocalClearedAssignments(allSlots, s.assignments, modelId, slot);
  if assignedTo(uninstallModel(s, modelId), slot) != "" {
    LocalOtherModelKept(s, modelId, assignedTo(s, slot));
  }
}

lemma LocalUninstallKeeps(s: LocalModels, modelId: string)
  requires inv(s)
  ensures alwaysSlotsMatchTheirModelsRole(uninstallModel(s, modelId))
  ensures alwaysActiveModelPassedItsChecks(uninstallModel(s, modelId))
  ensures alwaysAssignedModelsAreInstalled(uninstallModel(s, modelId))
{
  var after := uninstallModel(s, modelId);
  if s.active != modelId {
    LocalOtherModelKept(s, modelId, s.active);
  }
  LocalAssignedFold(s, true, allSlots);
  LocalAssignedFold(after, true, allSlots);
  LocalSlotsMatchFold(s, true, allSlots);
  LocalSlotsMatchFold(after, true, allSlots);
  forall slot | slot in allSlots
    ensures (assignedTo(after, slot) == "") || (installed(after, assignedTo(after, slot)) && servesSlot(modelOf(after, assignedTo(after, slot)).role, slot))
  {
    LocalUninstallSlot(s, modelId, slot);
  }
}

lemma uninstallModel_ensures(s: LocalModels, modelId: string)
  ensures (inv(s) ==> canUninstallModel(s, modelId) ==> alwaysSlotsMatchTheirModelsRole(uninstallModel(s, modelId)))
  ensures (inv(s) ==> canUninstallModel(s, modelId) ==> alwaysActiveModelPassedItsChecks(uninstallModel(s, modelId)))
  ensures (inv(s) ==> canUninstallModel(s, modelId) ==> alwaysAssignedModelsAreInstalled(uninstallModel(s, modelId)))
  ensures (inv(s) ==> canUninstallModel(s, modelId) ==> stepOneAssignmentPerChange(s, "uninstallModel", uninstallModel(s, modelId)))
  ensures (inv(s) ==> canUninstallModel(s, modelId) ==> stepUnreadableAssignmentsAreKept(s, uninstallModel(s, modelId)))
{
  if inv(s) && canUninstallModel(s, modelId) {
    LocalUninstallKeeps(s, modelId);
  }
}
