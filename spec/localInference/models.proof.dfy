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
  ensures (inv(s) ==> canUninstallModel(s, modelId) ==> stepUnreadableModelsStayUnreadable(s, uninstallModel(s, modelId)))
{
  if inv(s) && canUninstallModel(s, modelId) {
    LocalUninstallKeeps(s, modelId);
  }
}

// What the two assignment invariants say, slot by slot.
lemma LocalFoldsHold(s: LocalModels)
  requires alwaysSlotsMatchTheirModelsRole(s) && alwaysAssignedModelsAreInstalled(s)
  ensures forall slot :: slot in allSlots && assignedTo(s, slot) != "" ==> servesSlot(modelOf(s, assignedTo(s, slot)).role, slot) && installed(s, assignedTo(s, slot))
{
  LocalAssignedFold(s, true, allSlots);
  LocalSlotsMatchFold(s, true, allSlots);
}

// The two assignment invariants, from what they say slot by slot.
lemma LocalFoldsKept(after: LocalModels)
  requires forall slot :: slot in allSlots && assignedTo(after, slot) != "" ==> servesSlot(modelOf(after, assignedTo(after, slot)).role, slot) && installed(after, assignedTo(after, slot))
  ensures alwaysSlotsMatchTheirModelsRole(after) && alwaysAssignedModelsAreInstalled(after)
{
  LocalAssignedFold(after, true, allSlots);
  LocalSlotsMatchFold(after, true, allSlots);
}

// Changing one model's install leaves every other model as it was.
lemma LocalWithInstallOther(s: LocalModels, modelId: string, install: InstallPhase, evalsPassed: bool, other: string)
  requires other != modelId
  ensures modelOf(withInstall(modelId, s, install, evalsPassed), other) == modelOf(s, other)
{
  assert ("$" + other)[1..] == other && ("$" + modelId)[1..] == modelId;
  assert ("$" + other) != ("$" + modelId);
}

// A model that is not installed is assigned to no slot, so changing its install keeps both assignment invariants.
lemma LocalUnassignedInstallKeeps(s: LocalModels, modelId: string, install: InstallPhase, evalsPassed: bool)
  requires inv(s) && !modelOf(s, modelId).install.Installed?
  ensures alwaysSlotsMatchTheirModelsRole(withInstall(modelId, s, install, evalsPassed))
  ensures alwaysAssignedModelsAreInstalled(withInstall(modelId, s, install, evalsPassed))
{
  var after := withInstall(modelId, s, install, evalsPassed);
  LocalFoldsHold(s);
  forall slot | slot in allSlots && assignedTo(after, slot) != ""
    ensures servesSlot(modelOf(after, assignedTo(after, slot)).role, slot) && installed(after, assignedTo(after, slot))
  {
    assert assignedTo(after, slot) == assignedTo(s, slot);
    LocalWithInstallOther(s, modelId, install, evalsPassed, assignedTo(s, slot));
  }
  LocalFoldsKept(after);
}

// A change that keeps the models and the assignments keeps both assignment invariants.
lemma LocalSameAssignmentsKeep(s: LocalModels, after: LocalModels)
  requires inv(s) && after.models == s.models && after.assignments == s.assignments
  ensures alwaysSlotsMatchTheirModelsRole(after) && alwaysAssignedModelsAreInstalled(after)
{
  LocalFoldsHold(s);
  LocalFoldsKept(after);
}

// What activation assigns: each slot the model's role serves.
lemma LocalActivatedAssignments(xs: seq<ModelSlot>, m: map<ModelSlot, string>, role: ModelRole, modelId: string, slot: ModelSlot)
  ensures lookup1_localInference__models(Std.Collections.Seq.FoldLeft((m: map<ModelSlot, string>, slot: ModelSlot) => (if servesSlot(role, slot) then m[slot := modelId] else m), m, xs), slot, "") == (if slot in xs && servesSlot(role, slot) then modelId else lookup1_localInference__models(m, slot, ""))
  decreases |xs|
{
  if |xs| > 0 {
    LocalActivatedAssignments(xs[1..], if servesSlot(role, xs[0]) then m[xs[0] := modelId] else m, role, modelId, slot);
  }
}

lemma startDownload_ensures(s: LocalModels, modelId: string)
  ensures (inv(s) ==> canStartDownload(s, modelId) ==> alwaysSlotsMatchTheirModelsRole(startDownload(s, modelId)))
  ensures (inv(s) ==> canStartDownload(s, modelId) ==> alwaysActiveModelPassedItsChecks(startDownload(s, modelId)))
  ensures (inv(s) ==> canStartDownload(s, modelId) ==> alwaysAssignedModelsAreInstalled(startDownload(s, modelId)))
  ensures (inv(s) ==> canStartDownload(s, modelId) ==> stepOneAssignmentPerChange(s, "startDownload", startDownload(s, modelId)))
  ensures (inv(s) ==> canStartDownload(s, modelId) ==> stepUnreadableAssignmentsAreKept(s, startDownload(s, modelId)))
  ensures (inv(s) ==> canStartDownload(s, modelId) ==> stepUnreadableModelsStayUnreadable(s, startDownload(s, modelId)))
{
  if inv(s) && canStartDownload(s, modelId) {
    LocalUnassignedInstallKeeps(s, modelId, InstallPhase.Downloading, false);
  }
}

lemma cancelDownload_ensures(s: LocalModels, modelId: string)
  ensures (inv(s) ==> canCancelDownload(s, modelId) ==> alwaysSlotsMatchTheirModelsRole(cancelDownload(s, modelId)))
  ensures (inv(s) ==> canCancelDownload(s, modelId) ==> alwaysActiveModelPassedItsChecks(cancelDownload(s, modelId)))
  ensures (inv(s) ==> canCancelDownload(s, modelId) ==> alwaysAssignedModelsAreInstalled(cancelDownload(s, modelId)))
  ensures (inv(s) ==> canCancelDownload(s, modelId) ==> stepOneAssignmentPerChange(s, "cancelDownload", cancelDownload(s, modelId)))
  ensures (inv(s) ==> canCancelDownload(s, modelId) ==> stepUnreadableAssignmentsAreKept(s, cancelDownload(s, modelId)))
  ensures (inv(s) ==> canCancelDownload(s, modelId) ==> stepUnreadableModelsStayUnreadable(s, cancelDownload(s, modelId)))
{
  if inv(s) && canCancelDownload(s, modelId) {
    LocalUnassignedInstallKeeps(s, modelId, InstallPhase.NotInstalled, false);
  }
}

lemma finishDownload_ensures(s: LocalModels, modelId: string, digestMatches: bool, evalsPassed: bool)
  ensures (inv(s) ==> canFinishDownload(s, modelId) ==> alwaysSlotsMatchTheirModelsRole(finishDownload(s, modelId, digestMatches, evalsPassed)))
  ensures (inv(s) ==> canFinishDownload(s, modelId) ==> alwaysActiveModelPassedItsChecks(finishDownload(s, modelId, digestMatches, evalsPassed)))
  ensures (inv(s) ==> canFinishDownload(s, modelId) ==> alwaysAssignedModelsAreInstalled(finishDownload(s, modelId, digestMatches, evalsPassed)))
  ensures (inv(s) ==> canFinishDownload(s, modelId) ==> stepOneAssignmentPerChange(s, "finishDownload", finishDownload(s, modelId, digestMatches, evalsPassed)))
  ensures (inv(s) ==> canFinishDownload(s, modelId) ==> stepUnreadableAssignmentsAreKept(s, finishDownload(s, modelId, digestMatches, evalsPassed)))
  ensures (inv(s) ==> canFinishDownload(s, modelId) ==> stepUnreadableModelsStayUnreadable(s, finishDownload(s, modelId, digestMatches, evalsPassed)))
{
  if inv(s) && canFinishDownload(s, modelId) {
    if digestMatches {
      LocalUnassignedInstallKeeps(s, modelId, InstallPhase.Installed, evalsPassed);
    } else {
      LocalUnassignedInstallKeeps(s, modelId, InstallPhase.NotInstalled, false);
    }
  }
}

lemma modelUnreadable_ensures(s: LocalModels, modelId: string)
  ensures (inv(s) ==> canModelUnreadable(s, modelId) ==> alwaysSlotsMatchTheirModelsRole(modelUnreadable(s, modelId)))
  ensures (inv(s) ==> canModelUnreadable(s, modelId) ==> alwaysActiveModelPassedItsChecks(modelUnreadable(s, modelId)))
  ensures (inv(s) ==> canModelUnreadable(s, modelId) ==> alwaysAssignedModelsAreInstalled(modelUnreadable(s, modelId)))
  ensures (inv(s) ==> canModelUnreadable(s, modelId) ==> stepOneAssignmentPerChange(s, "modelUnreadable", modelUnreadable(s, modelId)))
  ensures (inv(s) ==> canModelUnreadable(s, modelId) ==> stepUnreadableAssignmentsAreKept(s, modelUnreadable(s, modelId)))
  ensures (inv(s) ==> canModelUnreadable(s, modelId) ==> stepUnreadableModelsStayUnreadable(s, modelUnreadable(s, modelId)))
{
  if inv(s) && canModelUnreadable(s, modelId) {
    LocalUnassignedInstallKeeps(s, modelId, InstallPhase.Unreadable, false);
  }
}

lemma assignModel_ensures(s: LocalModels, slot: ModelSlot, modelId: string)
  ensures (inv(s) ==> canAssignModel(s, slot, modelId) ==> alwaysSlotsMatchTheirModelsRole(assignModel(s, slot, modelId)))
  ensures (inv(s) ==> canAssignModel(s, slot, modelId) ==> alwaysActiveModelPassedItsChecks(assignModel(s, slot, modelId)))
  ensures (inv(s) ==> canAssignModel(s, slot, modelId) ==> alwaysAssignedModelsAreInstalled(assignModel(s, slot, modelId)))
  ensures (inv(s) ==> canAssignModel(s, slot, modelId) ==> stepOneAssignmentPerChange(s, "assignModel", assignModel(s, slot, modelId)))
  ensures (inv(s) ==> canAssignModel(s, slot, modelId) ==> stepUnreadableAssignmentsAreKept(s, assignModel(s, slot, modelId)))
  ensures (inv(s) ==> canAssignModel(s, slot, modelId) ==> stepUnreadableModelsStayUnreadable(s, assignModel(s, slot, modelId)))
{
  if inv(s) && canAssignModel(s, slot, modelId) {
    var after := assignModel(s, slot, modelId);
    LocalFoldsHold(s);
    LocalFoldsKept(after);
  }
}

lemma clearAssignment_ensures(s: LocalModels, slot: ModelSlot)
  ensures (inv(s) ==> canClearAssignment(s, slot) ==> alwaysSlotsMatchTheirModelsRole(clearAssignment(s, slot)))
  ensures (inv(s) ==> canClearAssignment(s, slot) ==> alwaysActiveModelPassedItsChecks(clearAssignment(s, slot)))
  ensures (inv(s) ==> canClearAssignment(s, slot) ==> alwaysAssignedModelsAreInstalled(clearAssignment(s, slot)))
  ensures (inv(s) ==> canClearAssignment(s, slot) ==> stepOneAssignmentPerChange(s, "clearAssignment", clearAssignment(s, slot)))
  ensures (inv(s) ==> canClearAssignment(s, slot) ==> stepUnreadableAssignmentsAreKept(s, clearAssignment(s, slot)))
  ensures (inv(s) ==> canClearAssignment(s, slot) ==> stepUnreadableModelsStayUnreadable(s, clearAssignment(s, slot)))
{
  if inv(s) && canClearAssignment(s, slot) {
    var after := clearAssignment(s, slot);
    LocalFoldsHold(s);
    LocalFoldsKept(after);
  }
}

lemma assignmentsUnreadable_ensures(s: LocalModels)
  ensures (inv(s) ==> canAssignmentsUnreadable(s) ==> alwaysSlotsMatchTheirModelsRole(assignmentsUnreadable(s)))
  ensures (inv(s) ==> canAssignmentsUnreadable(s) ==> alwaysActiveModelPassedItsChecks(assignmentsUnreadable(s)))
  ensures (inv(s) ==> canAssignmentsUnreadable(s) ==> alwaysAssignedModelsAreInstalled(assignmentsUnreadable(s)))
  ensures (inv(s) ==> canAssignmentsUnreadable(s) ==> stepOneAssignmentPerChange(s, "assignmentsUnreadable", assignmentsUnreadable(s)))
  ensures (inv(s) ==> canAssignmentsUnreadable(s) ==> stepUnreadableAssignmentsAreKept(s, assignmentsUnreadable(s)))
  ensures (inv(s) ==> canAssignmentsUnreadable(s) ==> stepUnreadableModelsStayUnreadable(s, assignmentsUnreadable(s)))
{
  if inv(s) && canAssignmentsUnreadable(s) {
    LocalSameAssignmentsKeep(s, assignmentsUnreadable(s));
  }
}

lemma assignmentsRepaired_ensures(s: LocalModels)
  ensures (inv(s) ==> canAssignmentsRepaired(s) ==> alwaysSlotsMatchTheirModelsRole(assignmentsRepaired(s)))
  ensures (inv(s) ==> canAssignmentsRepaired(s) ==> alwaysActiveModelPassedItsChecks(assignmentsRepaired(s)))
  ensures (inv(s) ==> canAssignmentsRepaired(s) ==> alwaysAssignedModelsAreInstalled(assignmentsRepaired(s)))
  ensures (inv(s) ==> canAssignmentsRepaired(s) ==> stepOneAssignmentPerChange(s, "assignmentsRepaired", assignmentsRepaired(s)))
  ensures (inv(s) ==> canAssignmentsRepaired(s) ==> stepUnreadableAssignmentsAreKept(s, assignmentsRepaired(s)))
  ensures (inv(s) ==> canAssignmentsRepaired(s) ==> stepUnreadableModelsStayUnreadable(s, assignmentsRepaired(s)))
{
  if inv(s) && canAssignmentsRepaired(s) {
    LocalSameAssignmentsKeep(s, assignmentsRepaired(s));
  }
}

lemma finishLoading_ensures(s: LocalModels, loaded: bool)
  ensures (inv(s) ==> canFinishLoading(s, loaded) ==> alwaysSlotsMatchTheirModelsRole(finishLoading(s, loaded)))
  ensures (inv(s) ==> canFinishLoading(s, loaded) ==> alwaysActiveModelPassedItsChecks(finishLoading(s, loaded)))
  ensures (inv(s) ==> canFinishLoading(s, loaded) ==> alwaysAssignedModelsAreInstalled(finishLoading(s, loaded)))
  ensures (inv(s) ==> canFinishLoading(s, loaded) ==> stepOneAssignmentPerChange(s, "finishLoading", finishLoading(s, loaded)))
  ensures (inv(s) ==> canFinishLoading(s, loaded) ==> stepUnreadableAssignmentsAreKept(s, finishLoading(s, loaded)))
  ensures (inv(s) ==> canFinishLoading(s, loaded) ==> stepUnreadableModelsStayUnreadable(s, finishLoading(s, loaded)))
{
  if inv(s) && canFinishLoading(s, loaded) {
    LocalSameAssignmentsKeep(s, finishLoading(s, loaded));
  }
}

lemma deactivateModel_ensures(s: LocalModels)
  ensures (inv(s) ==> canDeactivateModel(s) ==> alwaysSlotsMatchTheirModelsRole(deactivateModel(s)))
  ensures (inv(s) ==> canDeactivateModel(s) ==> alwaysActiveModelPassedItsChecks(deactivateModel(s)))
  ensures (inv(s) ==> canDeactivateModel(s) ==> alwaysAssignedModelsAreInstalled(deactivateModel(s)))
  ensures (inv(s) ==> canDeactivateModel(s) ==> stepOneAssignmentPerChange(s, "deactivateModel", deactivateModel(s)))
  ensures (inv(s) ==> canDeactivateModel(s) ==> stepUnreadableAssignmentsAreKept(s, deactivateModel(s)))
  ensures (inv(s) ==> canDeactivateModel(s) ==> stepUnreadableModelsStayUnreadable(s, deactivateModel(s)))
{
  if inv(s) && canDeactivateModel(s) {
    LocalSameAssignmentsKeep(s, deactivateModel(s));
  }
}

lemma activateModel_ensures(s: LocalModels, modelId: string)
  ensures (inv(s) ==> canActivateModel(s, modelId) ==> alwaysSlotsMatchTheirModelsRole(activateModel(s, modelId)))
  ensures (inv(s) ==> canActivateModel(s, modelId) ==> alwaysActiveModelPassedItsChecks(activateModel(s, modelId)))
  ensures (inv(s) ==> canActivateModel(s, modelId) ==> alwaysAssignedModelsAreInstalled(activateModel(s, modelId)))
  ensures (inv(s) ==> canActivateModel(s, modelId) ==> stepOneAssignmentPerChange(s, "activateModel", activateModel(s, modelId)))
  ensures (inv(s) ==> canActivateModel(s, modelId) ==> stepUnreadableAssignmentsAreKept(s, activateModel(s, modelId)))
  ensures (inv(s) ==> canActivateModel(s, modelId) ==> stepUnreadableModelsStayUnreadable(s, activateModel(s, modelId)))
{
  if inv(s) && canActivateModel(s, modelId) {
    var after := activateModel(s, modelId);
    var role := modelOf(s, modelId).role;
    LocalFoldsHold(s);
    forall slot | slot in allSlots && assignedTo(after, slot) != ""
      ensures servesSlot(modelOf(after, assignedTo(after, slot)).role, slot) && installed(after, assignedTo(after, slot))
    {
      LocalActivatedAssignments(allSlots, s.assignments, role, modelId, slot);
    }
    LocalFoldsKept(after);
  }
}

lemma initialHolds_ensures()
  ensures inv(initialHolds())
{
  var s := initialHolds();
  forall slot | slot in allSlots
    ensures assignedTo(s, slot) == ""
  {
  }
  LocalFoldsKept(s);
}
