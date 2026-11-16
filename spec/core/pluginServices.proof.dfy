lemma withdrawNextType_ensures(s: PluginServices, epochId: int)
  ensures (inv(s) ==> canWithdrawNextType(s, epochId) ==> alwaysLiveClassOwnerUnique(withdrawNextType(s, epochId)))
  ensures (inv(s) ==> canWithdrawNextType(s, epochId) ==> alwaysServiceOwnerEpochExists(withdrawNextType(s, epochId)))
  ensures (inv(s) ==> canWithdrawNextType(s, epochId) ==> alwaysChildLifecyclesValid(withdrawNextType(s, epochId)))
  ensures (inv(s) ==> canWithdrawNextType(s, epochId) ==> alwaysRetirementsFollowTypePlan(withdrawNextType(s, epochId)))
  ensures (inv(s) ==> canWithdrawNextType(s, epochId) ==> alwaysNoOrphanInstance(withdrawNextType(s, epochId)))
  ensures (inv(s) ==> canWithdrawNextType(s, epochId) ==> alwaysRetiredUndeclaredTypeIsUnknown(withdrawNextType(s, epochId)))
  ensures (inv(s) ==> canWithdrawNextType(s, epochId) ==> alwaysStopObservationsFollowSlots(withdrawNextType(s, epochId)))
  ensures (inv(s) ==> canWithdrawNextType(s, epochId) ==> alwaysRetiredEpochHasNoResources(withdrawNextType(s, epochId)))
  ensures (inv(s) ==> canWithdrawNextType(s, epochId) ==> alwaysSealedOwnedClassesStable(withdrawNextType(s, epochId)))
{
  if inv(s) && canWithdrawNextType(s, epochId) {
    PluginRetirementWithdrawalPreservesTypePlan(s, epochId);
  }
}

lemma cleanPlugin_ensures(s: PluginServices, epochId: int)
  ensures (inv(s) ==> canCleanPlugin(s, epochId) ==> alwaysLiveClassOwnerUnique(cleanPlugin(s, epochId)))
  ensures (inv(s) ==> canCleanPlugin(s, epochId) ==> alwaysServiceOwnerEpochExists(cleanPlugin(s, epochId)))
  ensures (inv(s) ==> canCleanPlugin(s, epochId) ==> alwaysChildLifecyclesValid(cleanPlugin(s, epochId)))
  ensures (inv(s) ==> canCleanPlugin(s, epochId) ==> alwaysRetirementsFollowTypePlan(cleanPlugin(s, epochId)))
  ensures (inv(s) ==> canCleanPlugin(s, epochId) ==> alwaysNoOrphanInstance(cleanPlugin(s, epochId)))
  ensures (inv(s) ==> canCleanPlugin(s, epochId) ==> alwaysRetiredUndeclaredTypeIsUnknown(cleanPlugin(s, epochId)))
  ensures (inv(s) ==> canCleanPlugin(s, epochId) ==> alwaysStopObservationsFollowSlots(cleanPlugin(s, epochId)))
  ensures (inv(s) ==> canCleanPlugin(s, epochId) ==> alwaysRetiredEpochHasNoResources(cleanPlugin(s, epochId)))
  ensures (inv(s) ==> canCleanPlugin(s, epochId) ==> alwaysSealedOwnedClassesStable(cleanPlugin(s, epochId)))
{
  hide *;
  reveal inv(), cleanPlugin(), canCleanPlugin(), alwaysSealedOwnedClassesStable(), core__pluginRegistry_inv();
  if inv(s) && canCleanPlugin(s, epochId) {
    PluginRetirementCleanPreservesEpochOwners(s, epochId);
    PluginRetirementCleanKeepsServiceState(s, epochId);
    PluginRetirementCleanupKeepsAllObjectsOwned(s, epochId);
    PluginRetirementCleanupRetainsCompletedObservations(s, epochId);
    PluginRetirementChildRulesMatchImportedInvariants(s);
    core__pluginRegistry_cleanPlugin_ensures(s.plugins, epochId);
    PluginRetirementChildRulesMatchImportedInvariants(cleanPlugin(s, epochId));
  }
}

lemma PluginRetirementIndexedValidation<T>(
    validate: (SequenceValidation, T) -> SequenceValidation, validAt: (int, T) -> bool,
    initialCheck: SequenceValidation, rows: seq<T>)
  requires initialCheck.index == 0 && initialCheck.valid
  requires forall check: SequenceValidation, row: T ::
    validate(check, row) == SequenceValidation(check.index + 1, check.valid && validAt(check.index, row))
  ensures var folded := Std.Collections.Seq.FoldLeft(validate, initialCheck, rows);
    folded.index == |rows| && (folded.valid <==> (forall i | 0 <= i < |rows| :: validAt(i, rows[i])))
{
  hide *;
  reveal Std.Collections.Seq.FoldLeft();
  var result := Std.Collections.Seq.FoldLeft(validate, initialCheck, rows);
  if |rows| == 0 {
    assert result == initialCheck;
    assert result.index == 0 && result.valid;
    assert forall i | 0 <= i < |rows| :: validAt(i, rows[i]);
  } else {
    var prior := rows[..|rows| - 1];
    var last := rows[|rows| - 1];
    PluginRetirementIndexedValidation(validate, validAt, initialCheck, prior);
    ProofLib.FoldLeftAppend(validate, initialCheck, prior, last);
    assert rows == prior + [last];
    var folded := Std.Collections.Seq.FoldLeft(validate, initialCheck, prior);
    assert folded.index == |prior|;
    assert folded.valid <==> (forall i | 0 <= i < |prior| :: validAt(i, prior[i]));
    assert result == validate(folded, last);
    assert result == SequenceValidation(folded.index + 1, folded.valid && validAt(folded.index, last));
    assert result.index == |rows|;
    assert result.valid == (folded.valid && validAt(|prior|, last));
    if result.valid {
      forall i | 0 <= i < |rows|
        ensures validAt(i, rows[i])
      {
        if i < |prior| {
          assert rows[i] == prior[i] && validAt(i, prior[i]);
        } else {
          assert i == |prior| && rows[i] == last;
        }
      }
    }
    if forall i | 0 <= i < |rows| :: validAt(i, rows[i]) {
      forall i | 0 <= i < |prior|
        ensures validAt(i, prior[i])
      {
        assert rows[i] == prior[i] && validAt(i, rows[i]);
      }
      assert validAt(|prior|, rows[|prior|]);
      assert folded.valid && result.valid;
    }
  }
}

lemma PluginRetirementPlanPosition(r: ServiceRetirement, i: int)
  requires retirementGroupsFollowPlan(r) && 0 <= i < |r.groups|
  ensures retirementGroupMatchesPosition(r, i, r.groups[i])
{
  hide *;
  reveal retirementGroupsFollowPlan(), validateRetirementGroup();
  var validAt := (index: int, group: RetirementGroup) => retirementGroupMatchesPosition(r, index, group);
  reveal uncheckedSequence;
  var original := (check: SequenceValidation, g: RetirementGroup) => validateRetirementGroup(check, r, g);
  assert Std.Collections.Seq.FoldLeft(original, uncheckedSequence, r.groups).valid;
  PluginRetirementIndexedValidation(original, validAt, uncheckedSequence, r.groups);
  assert forall j | 0 <= j < |r.groups| :: validAt(j, r.groups[j]);
  assert validAt(i, r.groups[i]);
}

lemma PluginRetirementPlanInstanceCursors(r: ServiceRetirement)
  requires retirementGroupsFollowPlan(r) && (r.exited || r.cursor == |r.plan|)
  requires forall g | g in r.groups :: classPhaseFollowsInstances(g)
  ensures forall g | g in r.groups :: g.instanceCursor == |g.instances|
{
  hide *;
  reveal retirementGroupsFollowPlan(), retirementGroupMatchesPosition(), groupFinishedOrSkipped(), classPhaseFollowsInstances();
  forall g | g in r.groups
    ensures g.instanceCursor == |g.instances|
  {
    var i :| 0 <= i < |r.groups| && r.groups[i] == g;
    PluginRetirementPlanPosition(r, i);
    if i < r.cursor {
      assert groupFinishedOrSkipped(g);
    } else {
      assert i == r.cursor && r.exited && g.phase.GroupFailed?;
    }
  }
}

lemma PluginRetirementCompletedGroupObservations(g: RetirementGroup, services: core__serviceInstances_ServiceInstances)
  requires allStopObservationsValid(g, services)
  requires g.instanceCursor == |g.instances| && |g.observedStops| == |g.instances|
  ensures forall i | 0 <= i < |g.instances| ::
    g.observedStops[i].instanceId == g.instances[i] && stopSlotSettled(g.observedStops[i], services)
{
  hide *;
  reveal allStopObservationsValid(), validateNextStop(), validStopObservation();
  var validAt := (index: int, slot: InstanceSlot) => validStopObservation(g, index, slot, services);
  reveal uncheckedSequence;
  var original := (check: SequenceValidation, slot: InstanceSlot) => validateNextStop(check, g, slot, services);
  assert Std.Collections.Seq.FoldLeft(original, uncheckedSequence, g.observedStops).valid;
  PluginRetirementIndexedValidation(original, validAt, uncheckedSequence, g.observedStops);
  assert forall i | 0 <= i < |g.observedStops| :: validAt(i, g.observedStops[i]);
  forall i | 0 <= i < |g.instances|
    ensures g.observedStops[i].instanceId == g.instances[i] && stopSlotSettled(g.observedStops[i], services)
  {
    assert validAt(i, g.observedStops[i]);
  }
}

lemma PluginRetirementCleanupKeepsInstanceReceipts(s: PluginServices, epochId: int)
  requires alwaysRetirementsFollowTypePlan(s) && alwaysStopObservationsFollowSlots(s)
  requires canCleanPlugin(s, epochId)
  ensures forall g | g in retirement(s, epochId).groups ::
    g.instanceCursor == |g.instances| && |g.observedStops| == |g.instances| &&
    (forall i | 0 <= i < |g.instances| ::
      g.observedStops[i].instanceId == g.instances[i] && stopSlotSettled(g.observedStops[i], s.services))
{
  hide *;
  reveal alwaysRetirementsFollowTypePlan(), alwaysStopObservationsFollowSlots();
  reveal canCleanPlugin(), retirementSettled(), retirement(), ProofLib.Filter();
  var r := retirement(s, epochId);
  var byEpoch := (row: ServiceRetirement) => (row.epochId == epochId);
  var matched := ProofLib.Filter(byEpoch, s.retirements);
  assert retirementSettled(s, epochId);
  reveal noRetirement;
  assert r.epochId != 0 && noRetirement.epochId == 0;
  assert r == (if |matched| > 0 then matched[0] else noRetirement);
  assert |matched| > 0 && matched[0] == r;
  assert r in matched;
  ProofLib.FilterMember(byEpoch, s.retirements, r);
  assert forall g | g in r.groups :: classPhaseFollowsInstances(g);
  PluginRetirementPlanInstanceCursors(r);
  forall g | g in r.groups
    ensures g.instanceCursor == |g.instances| && |g.observedStops| == |g.instances|
    ensures forall i | 0 <= i < |g.instances| ::
      g.observedStops[i].instanceId == g.instances[i] && stopSlotSettled(g.observedStops[i], s.services)
  {
    PluginRetirementCompletedGroupObservations(g, s.services);
  }
}

lemma PluginRetirementEpochAfterCleanup(s: PluginServices, epochId: int, query: int)
  ensures core__pluginRegistry_epoch(cleanPlugin(s, epochId).plugins, query).id ==
    core__pluginRegistry_epoch(s.plugins, query).id
  ensures query == epochId ==> !core__pluginRegistry_epochOwnsResources(cleanPlugin(s, epochId).plugins, query)
  ensures query != epochId ==>
    core__pluginRegistry_epoch(cleanPlugin(s, epochId).plugins, query) == core__pluginRegistry_epoch(s.plugins, query)
  ensures query != epochId ==>
    core__pluginRegistry_epochOwnsResources(cleanPlugin(s, epochId).plugins, query) ==
      core__pluginRegistry_epochOwnsResources(s.plugins, query)
{
  hide *;
  reveal cleanPlugin(), core__pluginRegistry_cleanPlugin(), core__pluginRegistry_epoch(), ProofLib.Filter();
  reveal core__pluginRegistry_epochOwnsResources(), core__pluginRegistry_activePhase(), core__plugins_finishCleanup();
  reveal core__pluginRegistry_absentEpoch;
  var before := s.plugins.epochs;
  var after := cleanPlugin(s, epochId).plugins.epochs;
  var selected := (row: core__pluginRegistry_PluginEpoch) => (row.id == query);
  var cleaned := (row: core__pluginRegistry_PluginEpoch) =>
    if row.id == epochId then row.(lifecycle := core__plugins_finishCleanup(row.lifecycle)) else row;
  var retained := (a: core__pluginRegistry_PluginEpoch, b: core__pluginRegistry_PluginEpoch) => b == cleaned(a);
  forall i | 0 <= i < |before|
    ensures selected(before[i]) == selected(after[i]) && retained(before[i], after[i])
  {}
  ProofLib.FilterPointwise(selected, selected, retained, before, after);
  var matches := ProofLib.Filter(selected, before);
  var updatedMatches := ProofLib.Filter(selected, after);
  if |matches| > 0 {
    ProofLib.FilterMember(selected, before, matches[0]);
    assert updatedMatches[0] == cleaned(matches[0]);
  }
}

lemma PluginRetirementCleanPreservesEpochOwners(s: PluginServices, epochId: int)
  requires alwaysServiceOwnerEpochExists(s) && alwaysRetirementsFollowTypePlan(s)
  ensures alwaysServiceOwnerEpochExists(cleanPlugin(s, epochId))
  ensures alwaysRetirementsFollowTypePlan(cleanPlugin(s, epochId))
{
  hide *;
  reveal cleanPlugin(), alwaysServiceOwnerEpochExists(), alwaysRetirementsFollowTypePlan();
  reveal core__pluginRegistry_epochRetiring();
  var after := cleanPlugin(s, epochId);
  forall owner | owner in after.ownership
    ensures core__pluginRegistry_epoch(after.plugins, owner.epochId).id == owner.epochId
  {
    PluginRetirementEpochAfterCleanup(s, epochId, owner.epochId);
  }
  forall plan | plan in after.retirements
    ensures plan.epochId > 0 && core__pluginRegistry_epoch(after.plugins, plan.epochId).id == plan.epochId
    ensures core__pluginRegistry_epochRetiring(after.plugins, plan.epochId) ||
      !core__pluginRegistry_epochOwnsResources(after.plugins, plan.epochId)
  {
    PluginRetirementEpochAfterCleanup(s, epochId, plan.epochId);
  }
}

lemma PluginRetirementCleanKeepsServiceState(s: PluginServices, epochId: int)
  requires alwaysLiveClassOwnerUnique(s) && alwaysStopObservationsFollowSlots(s)
  requires alwaysRetiredUndeclaredTypeIsUnknown(s)
  ensures alwaysLiveClassOwnerUnique(cleanPlugin(s, epochId))
  ensures alwaysStopObservationsFollowSlots(cleanPlugin(s, epochId))
  ensures alwaysRetiredUndeclaredTypeIsUnknown(cleanPlugin(s, epochId))
{
  hide *;
  reveal cleanPlugin(), alwaysLiveClassOwnerUnique(), alwaysStopObservationsFollowSlots(), alwaysRetiredUndeclaredTypeIsUnknown();
}

lemma PluginRetirementChildRulesMatchImportedInvariants(s: PluginServices)
  ensures alwaysChildLifecyclesValid(s) ==
    (core__pluginRegistry_inv(s.plugins) && core__serviceInstances_inv(s.services))
{
  hide *;
  reveal alwaysChildLifecyclesValid(), core__pluginRegistry_inv(), core__serviceInstances_inv();
}

lemma PluginRetirementPlanLookup(s: PluginServices, plan: ServiceRetirement)
  requires alwaysRetirementsFollowTypePlan(s) && plan in s.retirements
  ensures retirement(s, plan.epochId) == plan
{
  hide *;
  reveal alwaysRetirementsFollowTypePlan(), retirement(), ProofLib.Filter();
  var byEpoch := (row: ServiceRetirement) => (row.epochId == plan.epochId);
  var matches := ProofLib.Filter(byEpoch, s.retirements);
  ProofLib.FilterMember(byEpoch, s.retirements, plan);
  assert |matches| == 1 && plan in matches;
}

lemma PluginRetirementUncalledObjectUsesMissingSlot(services: core__serviceInstances_ServiceInstances,
    instance: core__serviceInstances_ServiceObject, slot: InstanceSlot)
  requires core__serviceInstances_alwaysClassAndObjectIdentities(services)
  requires core__serviceInstances_alwaysObjectStopOnce(services)
  requires instance in services.objects && instance.stopCalls == 0 && instance.id == slot.instanceId
  requires stopSlotSettled(slot, services)
  ensures slot.observed.MissingStopSlot?
{
  hide *;
  reveal core__serviceInstances_alwaysClassAndObjectIdentities(), core__serviceInstances_alwaysObjectStopOnce();
  reveal core__serviceInstances_serviceObject(), stopSlotSettled(), ProofLib.Filter();
  var byObject := (other: core__serviceInstances_ServiceObject) => (other.id == instance.id);
  var matches := ProofLib.Filter(byObject, services.objects);
  ProofLib.FilterMember(byObject, services.objects, instance);
  assert |matches| == 1 && matches[0] == instance;
  assert core__serviceInstances_serviceObject(services, slot.instanceId) == instance;
  assert instance.stopPhase.StopNotRequested?;
}

lemma PluginRetirementCleanupKeepsAllObjectsOwned(s: PluginServices, epochId: int)
  requires alwaysRetirementsFollowTypePlan(s) && alwaysStopObservationsFollowSlots(s)
  requires alwaysNoOrphanInstance(s) && alwaysChildLifecyclesValid(s)
  requires canCleanPlugin(s, epochId)
  ensures alwaysNoOrphanInstance(cleanPlugin(s, epochId))
{
  hide *;
  reveal cleanPlugin(), alwaysNoOrphanInstance(), alwaysChildLifecyclesValid();
  reveal core__serviceInstances_alwaysObjectStopOnce();
  var after := cleanPlugin(s, epochId);
  PluginRetirementCleanupKeepsInstanceReceipts(s, epochId);
  forall o | o in after.services.objects
    ensures o.stopCalls > 0 || (exists c :: c in after.services.classes && c.live == o.id && c.registered) ||
      (exists r :: r in after.retirements &&
        (exists g :: g in r.groups &&
          (missingStopObservedFor(g, o.id) ||
            (core__pluginRegistry_epochOwnsResources(after.plugins, r.epochId) && o.id in g.instances))))
  {
    if o.stopCalls <= 0 && !(exists c :: c in s.services.classes && c.live == o.id && c.registered) {
      assert o in s.services.objects && o.stopCalls == 0;
      var r :| r in s.retirements &&
        (exists g :: g in r.groups &&
          (missingStopObservedFor(g, o.id) ||
            (core__pluginRegistry_epochOwnsResources(s.plugins, r.epochId) && o.id in g.instances)));
      var g :| g in r.groups && (missingStopObservedFor(g, o.id) ||
        (core__pluginRegistry_epochOwnsResources(s.plugins, r.epochId) && o.id in g.instances));
      if !missingStopObservedFor(g, o.id) {
        if r.epochId != epochId {
          PluginRetirementEpochAfterCleanup(s, epochId, r.epochId);
        } else {
          PluginRetirementPlanLookup(s, r);
          var i :| 0 <= i < |g.instances| && g.instances[i] == o.id;
          var slot := g.observedStops[i];
          PluginRetirementUncalledObjectUsesMissingSlot(s.services, o, slot);
          assert slot in g.observedStops;
          reveal missingStopObservedFor();
          assert missingStopObservedFor(g, o.id);
        }
      }
      assert r in after.retirements && g in r.groups;
    }
  }
}

lemma PluginRetirementCleanupRetainsCompletedObservations(s: PluginServices, epochId: int)
  requires alwaysRetirementsFollowTypePlan(s) && alwaysStopObservationsFollowSlots(s)
  requires canCleanPlugin(s, epochId) && alwaysRetiredEpochHasNoResources(s)
  ensures alwaysRetiredEpochHasNoResources(cleanPlugin(s, epochId))
{
  hide *;
  reveal cleanPlugin(), retirementSettled(), alwaysRetiredEpochHasNoResources(), canCleanPlugin();
  var after := cleanPlugin(s, epochId);
  PluginRetirementCleanupKeepsInstanceReceipts(s, epochId);
  assert after.retirements == s.retirements;
  reveal retirement();
  forall r | r in after.retirements && !core__pluginRegistry_epochOwnsResources(after.plugins, r.epochId)
    ensures retirementSettled(after, r.epochId)
    ensures forall g | g in r.groups ::
      g.instanceCursor == |g.instances| && (forall slot | slot in g.observedStops :: stopSlotSettled(slot, after.services))
  {
    if r.epochId != epochId {
      PluginRetirementEpochAfterCleanup(s, epochId, r.epochId);
    } else {
      PluginRetirementPlanLookup(s, r);
      forall g | g in r.groups
        ensures g.instanceCursor == |g.instances|
        ensures forall slot | slot in g.observedStops :: stopSlotSettled(slot, after.services)
      {
        forall slot | slot in g.observedStops
          ensures stopSlotSettled(slot, after.services)
        {
          var i :| 0 <= i < |g.observedStops| && g.observedStops[i] == slot;
        }
      }
    }
  }
}

lemma PluginRetirementWithdrawalHasPositionEvidence(r: ServiceRetirement)
  ensures Std.Collections.Seq.FoldLeft((check: SequenceValidation, g: RetirementGroup) => validateRetirementGroup(check, r, g),
    uncheckedSequence, r.groups).valid <==>
    (forall i | 0 <= i < |r.groups| :: retirementGroupMatchesPosition(r, i, r.groups[i]))
{
  hide *;
  reveal uncheckedSequence;
  reveal validateRetirementGroup();
  var validAt := (i: int, g: RetirementGroup) => retirementGroupMatchesPosition(r, i, g);
  var validate := (check: SequenceValidation, g: RetirementGroup) => validateRetirementGroup(check, r, g);
  PluginRetirementIndexedValidation(validate, validAt, uncheckedSequence, r.groups);
}

lemma PluginRetirementWithdrawalAppendsPlannedGroup(before: ServiceRetirement, after: ServiceRetirement, group: RetirementGroup)
  requires retirementGroupsFollowPlan(before) && !before.exited
  requires before.cursor == |before.groups| && before.cursor < |before.plan|
  requires group.serviceType == before.plan[before.cursor]
  requires group.phase.GroupSkipped? || group.phase.GroupWaiting?
  requires after.plan == before.plan && !after.exited && after.groups == before.groups + [group]
  requires after.cursor == before.cursor + (if group.phase.GroupSkipped? then 1 else 0)
  ensures retirementGroupsFollowPlan(after)
{
  hide *;
  reveal retirementGroupsFollowPlan(), retirementGroupMatchesPosition(), groupFinishedOrSkipped();
  PluginRetirementWithdrawalHasPositionEvidence(before);
  forall i | 0 <= i < |after.groups|
    ensures retirementGroupMatchesPosition(after, i, after.groups[i])
  {
    if i < |before.groups| {
      assert retirementGroupMatchesPosition(before, i, before.groups[i]);
      assert i < before.cursor && i < after.cursor && after.groups[i] == before.groups[i];
    } else {
      assert i == before.cursor && after.groups[i] == group;
    }
  }
  PluginRetirementWithdrawalHasPositionEvidence(after);
  if after.cursor < |after.groups| {
    assert after.groups[after.cursor] == group && group.phase.GroupWaiting?;
  }
}

lemma PluginRetirementWithdrawalPreservesTypePlan(s: PluginServices, epochId: int)
  requires alwaysRetirementsFollowTypePlan(s) && canWithdrawNextType(s, epochId)
  ensures alwaysRetirementsFollowTypePlan(withdrawNextType(s, epochId))
{
  hide *;
  reveal alwaysRetirementsFollowTypePlan(), canWithdrawNextType(), withdrawNextType();
  reveal skippedGroupPhase, missingGroupPhase;
  reveal ProofLib.Filter();
  var after := withdrawNextType(s, epochId);
  assert after.plugins == s.plugins && |after.retirements| == |s.retirements|;
  forall row | row in after.retirements
    ensures row.epochId > 0 && core__pluginRegistry_epoch(after.plugins, row.epochId).id == row.epochId
    ensures core__pluginRegistry_epochRetiring(after.plugins, row.epochId) ||
      !core__pluginRegistry_epochOwnsResources(after.plugins, row.epochId)
    ensures |ProofLib.Filter((other: ServiceRetirement) => (other.epochId == row.epochId), after.retirements)| == 1
    ensures retirementGroupsFollowPlan(row)
  {
    var i :| 0 <= i < |after.retirements| && after.retirements[i] == row;
    var prior := s.retirements[i];
    assert prior in s.retirements && prior.epochId == row.epochId;
    var byEpoch := (other: ServiceRetirement) => (other.epochId == row.epochId);
    ProofLib.FilterLengthPointwise(byEpoch, byEpoch, s.retirements, after.retirements);
    if row.epochId == epochId {
      PluginRetirementPlanLookup(s, prior);
      assert 0 <= prior.cursor < |row.groups|;
      var group := row.groups[prior.cursor];
      PluginRetirementWithdrawalAppendsPlannedGroup(prior, row, group);
    }
  }
}

lemma finishInitialization_ensures(s: PluginServices, ok: bool)
  ensures (inv(s) ==> canFinishInitialization(s, ok) ==> alwaysLiveClassOwnerUnique(finishInitialization(s, ok)))
  ensures (inv(s) ==> canFinishInitialization(s, ok) ==> alwaysServiceOwnerEpochExists(finishInitialization(s, ok)))
  ensures (inv(s) ==> canFinishInitialization(s, ok) ==> alwaysChildLifecyclesValid(finishInitialization(s, ok)))
  ensures (inv(s) ==> canFinishInitialization(s, ok) ==> alwaysRetirementsFollowTypePlan(finishInitialization(s, ok)))
  ensures (inv(s) ==> canFinishInitialization(s, ok) ==> alwaysNoOrphanInstance(finishInitialization(s, ok)))
  ensures (inv(s) ==> canFinishInitialization(s, ok) ==> alwaysRetiredUndeclaredTypeIsUnknown(finishInitialization(s, ok)))
  ensures (inv(s) ==> canFinishInitialization(s, ok) ==> alwaysStopObservationsFollowSlots(finishInitialization(s, ok)))
  ensures (inv(s) ==> canFinishInitialization(s, ok) ==> alwaysRetiredEpochHasNoResources(finishInitialization(s, ok)))
  ensures (inv(s) ==> canFinishInitialization(s, ok) ==> alwaysSealedOwnedClassesStable(finishInitialization(s, ok)))
{
  hide *;
  reveal inv(), finishInitialization(), canFinishInitialization(), core__serviceInstances_finishInitialization(), core__serviceInstances_inv();
  if inv(s) && canFinishInitialization(s, ok) {
    reveal core__serviceInstances_serviceTypeEntry();
    PluginServiceFrameKeepsLocalRules(s, finishInitialization(s, ok));
    PluginRetirementChildRulesMatchImportedInvariants(s);
    core__serviceInstances_finishInitialization_ensures(s.services, ok);
    PluginRetirementChildRulesMatchImportedInvariants(finishInitialization(s, ok));
  }
}

lemma settleTypeAggregate_ensures(s: PluginServices, callId: int)
  ensures (inv(s) ==> canSettleTypeAggregate(s, callId) ==> alwaysLiveClassOwnerUnique(settleTypeAggregate(s, callId)))
  ensures (inv(s) ==> canSettleTypeAggregate(s, callId) ==> alwaysServiceOwnerEpochExists(settleTypeAggregate(s, callId)))
  ensures (inv(s) ==> canSettleTypeAggregate(s, callId) ==> alwaysChildLifecyclesValid(settleTypeAggregate(s, callId)))
  ensures (inv(s) ==> canSettleTypeAggregate(s, callId) ==> alwaysRetirementsFollowTypePlan(settleTypeAggregate(s, callId)))
  ensures (inv(s) ==> canSettleTypeAggregate(s, callId) ==> alwaysNoOrphanInstance(settleTypeAggregate(s, callId)))
  ensures (inv(s) ==> canSettleTypeAggregate(s, callId) ==> alwaysRetiredUndeclaredTypeIsUnknown(settleTypeAggregate(s, callId)))
  ensures (inv(s) ==> canSettleTypeAggregate(s, callId) ==> alwaysStopObservationsFollowSlots(settleTypeAggregate(s, callId)))
  ensures (inv(s) ==> canSettleTypeAggregate(s, callId) ==> alwaysRetiredEpochHasNoResources(settleTypeAggregate(s, callId)))
  ensures (inv(s) ==> canSettleTypeAggregate(s, callId) ==> alwaysSealedOwnedClassesStable(settleTypeAggregate(s, callId)))
{
  hide *;
  reveal inv(), settleTypeAggregate(), canSettleTypeAggregate(), core__serviceInstances_settleTypeAggregate(), core__serviceInstances_inv();
  if inv(s) && canSettleTypeAggregate(s, callId) {
    reveal core__serviceInstances_serviceTypeEntry();
    PluginServiceFrameKeepsLocalRules(s, settleTypeAggregate(s, callId));
    PluginRetirementChildRulesMatchImportedInvariants(s);
    core__serviceInstances_settleTypeAggregate_ensures(s.services, callId);
    PluginRetirementChildRulesMatchImportedInvariants(settleTypeAggregate(s, callId));
  }
}

lemma clearTypeAggregate_ensures(s: PluginServices, callId: int)
  ensures (inv(s) ==> canClearTypeAggregate(s, callId) ==> alwaysLiveClassOwnerUnique(clearTypeAggregate(s, callId)))
  ensures (inv(s) ==> canClearTypeAggregate(s, callId) ==> alwaysServiceOwnerEpochExists(clearTypeAggregate(s, callId)))
  ensures (inv(s) ==> canClearTypeAggregate(s, callId) ==> alwaysChildLifecyclesValid(clearTypeAggregate(s, callId)))
  ensures (inv(s) ==> canClearTypeAggregate(s, callId) ==> alwaysRetirementsFollowTypePlan(clearTypeAggregate(s, callId)))
  ensures (inv(s) ==> canClearTypeAggregate(s, callId) ==> alwaysNoOrphanInstance(clearTypeAggregate(s, callId)))
  ensures (inv(s) ==> canClearTypeAggregate(s, callId) ==> alwaysRetiredUndeclaredTypeIsUnknown(clearTypeAggregate(s, callId)))
  ensures (inv(s) ==> canClearTypeAggregate(s, callId) ==> alwaysStopObservationsFollowSlots(clearTypeAggregate(s, callId)))
  ensures (inv(s) ==> canClearTypeAggregate(s, callId) ==> alwaysRetiredEpochHasNoResources(clearTypeAggregate(s, callId)))
  ensures (inv(s) ==> canClearTypeAggregate(s, callId) ==> alwaysSealedOwnedClassesStable(clearTypeAggregate(s, callId)))
{
  hide *;
  reveal inv(), clearTypeAggregate(), canClearTypeAggregate(), core__serviceInstances_clearTypeAggregate(), core__serviceInstances_inv();
  if inv(s) && canClearTypeAggregate(s, callId) {
    PluginServiceFrameClearAggregateKeepsGroupStatuses(s, callId);
    PluginServiceFrameKeepsLocalRules(s, clearTypeAggregate(s, callId));
    PluginRetirementChildRulesMatchImportedInvariants(s);
    core__serviceInstances_clearTypeAggregate_ensures(s.services, callId);
    PluginRetirementChildRulesMatchImportedInvariants(clearTypeAggregate(s, callId));
  }
}

lemma settleEnsure_ensures(s: PluginServices, callId: int)
  ensures (inv(s) ==> canSettleEnsure(s, callId) ==> alwaysLiveClassOwnerUnique(settleEnsure(s, callId)))
  ensures (inv(s) ==> canSettleEnsure(s, callId) ==> alwaysServiceOwnerEpochExists(settleEnsure(s, callId)))
  ensures (inv(s) ==> canSettleEnsure(s, callId) ==> alwaysChildLifecyclesValid(settleEnsure(s, callId)))
  ensures (inv(s) ==> canSettleEnsure(s, callId) ==> alwaysRetirementsFollowTypePlan(settleEnsure(s, callId)))
  ensures (inv(s) ==> canSettleEnsure(s, callId) ==> alwaysNoOrphanInstance(settleEnsure(s, callId)))
  ensures (inv(s) ==> canSettleEnsure(s, callId) ==> alwaysRetiredUndeclaredTypeIsUnknown(settleEnsure(s, callId)))
  ensures (inv(s) ==> canSettleEnsure(s, callId) ==> alwaysStopObservationsFollowSlots(settleEnsure(s, callId)))
  ensures (inv(s) ==> canSettleEnsure(s, callId) ==> alwaysRetiredEpochHasNoResources(settleEnsure(s, callId)))
  ensures (inv(s) ==> canSettleEnsure(s, callId) ==> alwaysSealedOwnedClassesStable(settleEnsure(s, callId)))
{
  hide *;
  reveal inv(), canSettleEnsure(), settleEnsure(), core__serviceInstances_settleAcquire(), core__serviceInstances_putType();
  reveal core__serviceInstances_inv();
  reveal alwaysLiveClassOwnerUnique(), alwaysServiceOwnerEpochExists(), alwaysRetirementsFollowTypePlan();
  reveal alwaysNoOrphanInstance(), alwaysSealedOwnedClassesStable();
  if inv(s) && canSettleEnsure(s, callId) {
    var after := settleEnsure(s, callId);
    PluginRetirementChildRulesMatchImportedInvariants(s);
    core__serviceInstances_settleAcquire_ensures(s.services, callId);
    PluginRetirementChildRulesMatchImportedInvariants(after);
    PluginServiceFrameRetainsStopReceipts(s, after);
    PluginAcquireSettlementPreservesTypeStatus(s, callId);
  }
}

lemma PluginServiceFrameStopSlotStable(before: core__serviceInstances_ServiceInstances,
    after: core__serviceInstances_ServiceInstances, slot: InstanceSlot)
  requires before.objects == after.objects
  ensures stopSlotSettled(slot, before) == stopSlotSettled(slot, after)
{
  hide *;
  reveal stopSlotSettled(), core__serviceInstances_serviceObject();
}

lemma PluginServiceFrameObservationFoldStable(before: core__serviceInstances_ServiceInstances,
    after: core__serviceInstances_ServiceInstances, group: RetirementGroup)
  requires before.objects == after.objects
  ensures allStopObservationsValid(group, before) == allStopObservationsValid(group, after)
{
  hide *;
  reveal allStopObservationsValid(), validateNextStop(), validStopObservation();
  var fromBefore := (row: SequenceValidation, slot: InstanceSlot) => validateNextStop(row, group, slot, before);
  var fromAfter := (row: SequenceValidation, slot: InstanceSlot) => validateNextStop(row, group, slot, after);
  forall row: SequenceValidation, i | 0 <= i < |group.observedStops|
    ensures fromBefore(row, group.observedStops[i]) == fromAfter(row, group.observedStops[i])
  {
    PluginServiceFrameStopSlotStable(before, after, group.observedStops[i]);
  }
  ProofLib.FoldLeftPointwise(fromBefore, fromAfter, uncheckedSequence, group.observedStops, group.observedStops);
}

lemma PluginServiceFrameRetainsStopReceipts(s: PluginServices, after: PluginServices)
  requires alwaysStopObservationsFollowSlots(s) && alwaysRetiredEpochHasNoResources(s)
  requires after.retirements == s.retirements && after.plugins == s.plugins && after.services.objects == s.services.objects
  ensures alwaysStopObservationsFollowSlots(after) && alwaysRetiredEpochHasNoResources(after)
{
  hide *;
  reveal alwaysStopObservationsFollowSlots(), alwaysRetiredEpochHasNoResources(), retirementSettled(), retirement();
  forall r | r in after.retirements
    ensures forall g | g in r.groups ::
      allStopObservationsValid(g, s.services) == allStopObservationsValid(g, after.services)
    ensures forall g | g in r.groups ::
      (forall slot | slot in g.observedStops :: stopSlotSettled(slot, s.services) == stopSlotSettled(slot, after.services))
  {
    forall g | g in r.groups
      ensures allStopObservationsValid(g, s.services) == allStopObservationsValid(g, after.services)
      ensures forall slot | slot in g.observedStops :: stopSlotSettled(slot, s.services) == stopSlotSettled(slot, after.services)
    {
      PluginServiceFrameObservationFoldStable(s.services, after.services, g);
      forall slot | slot in g.observedStops
        ensures stopSlotSettled(slot, s.services) == stopSlotSettled(slot, after.services)
      {
        PluginServiceFrameStopSlotStable(s.services, after.services, slot);
      }
    }
  }
}

lemma PluginServiceFrameAfterFinishInitialization(s: PluginServices, ok: bool)
  requires alwaysStopObservationsFollowSlots(s) && alwaysRetiredEpochHasNoResources(s)
  ensures alwaysStopObservationsFollowSlots(finishInitialization(s, ok)) && alwaysRetiredEpochHasNoResources(finishInitialization(s, ok))
{
  hide *;
  reveal finishInitialization(), core__serviceInstances_finishInitialization();
  PluginServiceFrameRetainsStopReceipts(s, finishInitialization(s, ok));
}

lemma PluginServiceFrameAfterSettleTypeAggregate(s: PluginServices, callId: int)
  requires alwaysStopObservationsFollowSlots(s) && alwaysRetiredEpochHasNoResources(s)
  ensures alwaysStopObservationsFollowSlots(settleTypeAggregate(s, callId)) && alwaysRetiredEpochHasNoResources(settleTypeAggregate(s, callId))
{
  hide *;
  reveal settleTypeAggregate(), core__serviceInstances_settleTypeAggregate();
  PluginServiceFrameRetainsStopReceipts(s, settleTypeAggregate(s, callId));
}

lemma PluginServiceFrameAfterClearTypeAggregate(s: PluginServices, callId: int)
  requires alwaysStopObservationsFollowSlots(s) && alwaysRetiredEpochHasNoResources(s)
  ensures alwaysStopObservationsFollowSlots(clearTypeAggregate(s, callId)) && alwaysRetiredEpochHasNoResources(clearTypeAggregate(s, callId))
{
  hide *;
  reveal clearTypeAggregate(), core__serviceInstances_clearTypeAggregate();
  PluginServiceFrameRetainsStopReceipts(s, clearTypeAggregate(s, callId));
}

lemma PluginEpochFrameLookup(before: core__pluginRegistry_PluginEpochs, after: core__pluginRegistry_PluginEpochs, query: int)
  requires |before.epochs| == |after.epochs|
  requires forall i | 0 <= i < |before.epochs| ::
    before.epochs[i].id == after.epochs[i].id &&
      core__pluginRegistry_activePhase(before.epochs[i].lifecycle.phase) == core__pluginRegistry_activePhase(after.epochs[i].lifecycle.phase) &&
      (before.epochs[i].lifecycle.phase.RollingBack? || before.epochs[i].lifecycle.phase.Unloading?) == (after.epochs[i].lifecycle.phase.RollingBack? || after.epochs[i].lifecycle.phase.Unloading?)
  ensures core__pluginRegistry_epoch(before, query).id == core__pluginRegistry_epoch(after, query).id
  ensures core__pluginRegistry_epochOwnsResources(before, query) == core__pluginRegistry_epochOwnsResources(after, query)
  ensures core__pluginRegistry_epochRetiring(before, query) == core__pluginRegistry_epochRetiring(after, query)
{
  hide *;
  reveal core__pluginRegistry_epoch(), core__pluginRegistry_epochOwnsResources(), core__pluginRegistry_epochRetiring();
  reveal ProofLib.Filter();
  var selected := (row: core__pluginRegistry_PluginEpoch) => (row.id == query);
  var frame := (prior: core__pluginRegistry_PluginEpoch, retained: core__pluginRegistry_PluginEpoch) =>
    prior.id == retained.id &&
      core__pluginRegistry_activePhase(prior.lifecycle.phase) == core__pluginRegistry_activePhase(retained.lifecycle.phase) &&
      (prior.lifecycle.phase.RollingBack? || prior.lifecycle.phase.Unloading?) == (retained.lifecycle.phase.RollingBack? || retained.lifecycle.phase.Unloading?);
  forall i | 0 <= i < |before.epochs|
    ensures selected(before.epochs[i]) == selected(after.epochs[i]) && frame(before.epochs[i], after.epochs[i])
  {}
  ProofLib.FilterPointwise(selected, selected, frame, before.epochs, after.epochs);
}

lemma PluginEpochFrameProjectedRules(s: PluginServices, after: PluginServices)
  requires inv(s) && after == s.(plugins := after.plugins)
  requires forall owner | owner in s.ownership ::
    core__pluginRegistry_epoch(s.plugins, owner.epochId).id == core__pluginRegistry_epoch(after.plugins, owner.epochId).id
  requires forall plan | plan in s.retirements ::
    core__pluginRegistry_epoch(s.plugins, plan.epochId).id == core__pluginRegistry_epoch(after.plugins, plan.epochId).id &&
    core__pluginRegistry_epochOwnsResources(s.plugins, plan.epochId) ==
      core__pluginRegistry_epochOwnsResources(after.plugins, plan.epochId) &&
    core__pluginRegistry_epochRetiring(s.plugins, plan.epochId) ==
      core__pluginRegistry_epochRetiring(after.plugins, plan.epochId)
  ensures alwaysLiveClassOwnerUnique(after) && alwaysServiceOwnerEpochExists(after)
  ensures alwaysRetirementsFollowTypePlan(after) && alwaysNoOrphanInstance(after)
  ensures alwaysRetiredUndeclaredTypeIsUnknown(after) && alwaysStopObservationsFollowSlots(after)
  ensures alwaysRetiredEpochHasNoResources(after) && alwaysSealedOwnedClassesStable(after)
{
  hide *;
  reveal inv(), alwaysLiveClassOwnerUnique(), alwaysServiceOwnerEpochExists(), alwaysRetirementsFollowTypePlan();
  reveal alwaysNoOrphanInstance(), alwaysRetiredUndeclaredTypeIsUnknown(), alwaysStopObservationsFollowSlots();
  reveal alwaysRetiredEpochHasNoResources(), retirementSettled(), retirement(), alwaysSealedOwnedClassesStable();
}

lemma PluginEpochFrameKeepsOwnership(s: PluginServices, after: PluginServices)
  requires inv(s) && after == s.(plugins := after.plugins)
  requires |s.plugins.epochs| == |after.plugins.epochs|
  requires forall i | 0 <= i < |s.plugins.epochs| ::
    s.plugins.epochs[i].id == after.plugins.epochs[i].id &&
      core__pluginRegistry_activePhase(s.plugins.epochs[i].lifecycle.phase) == core__pluginRegistry_activePhase(after.plugins.epochs[i].lifecycle.phase) &&
      (s.plugins.epochs[i].lifecycle.phase.RollingBack? || s.plugins.epochs[i].lifecycle.phase.Unloading?) == (after.plugins.epochs[i].lifecycle.phase.RollingBack? || after.plugins.epochs[i].lifecycle.phase.Unloading?)
  ensures alwaysLiveClassOwnerUnique(after) && alwaysServiceOwnerEpochExists(after)
  ensures alwaysRetirementsFollowTypePlan(after) && alwaysNoOrphanInstance(after)
  ensures alwaysRetiredUndeclaredTypeIsUnknown(after) && alwaysStopObservationsFollowSlots(after)
  ensures alwaysRetiredEpochHasNoResources(after) && alwaysSealedOwnedClassesStable(after)
{
  hide *;
  forall owner | owner in s.ownership
    ensures core__pluginRegistry_epoch(s.plugins, owner.epochId).id ==
      core__pluginRegistry_epoch(after.plugins, owner.epochId).id
  {
    PluginEpochFrameLookup(s.plugins, after.plugins, owner.epochId);
  }
  forall plan | plan in s.retirements
    ensures core__pluginRegistry_epoch(s.plugins, plan.epochId).id ==
      core__pluginRegistry_epoch(after.plugins, plan.epochId).id
    ensures core__pluginRegistry_epochOwnsResources(s.plugins, plan.epochId) ==
      core__pluginRegistry_epochOwnsResources(after.plugins, plan.epochId)
    ensures core__pluginRegistry_epochRetiring(s.plugins, plan.epochId) ==
      core__pluginRegistry_epochRetiring(after.plugins, plan.epochId)
  {
    PluginEpochFrameLookup(s.plugins, after.plugins, plan.epochId);
  }
  PluginEpochFrameProjectedRules(s, after);
}

lemma PluginEpochFrameJoin(s: PluginServices, epochId: int)
  requires inv(s)
  ensures alwaysLiveClassOwnerUnique(joinPlugin(s, epochId)) && alwaysServiceOwnerEpochExists(joinPlugin(s, epochId))
  ensures alwaysRetirementsFollowTypePlan(joinPlugin(s, epochId)) && alwaysNoOrphanInstance(joinPlugin(s, epochId))
  ensures alwaysRetiredUndeclaredTypeIsUnknown(joinPlugin(s, epochId)) && alwaysStopObservationsFollowSlots(joinPlugin(s, epochId))
  ensures alwaysRetiredEpochHasNoResources(joinPlugin(s, epochId)) && alwaysSealedOwnedClassesStable(joinPlugin(s, epochId))
{
  hide *;
  reveal joinPlugin(), core__pluginRegistry_joinPlugin(), core__plugins_joinRegistration();
  PluginEpochFrameKeepsOwnership(s, joinPlugin(s, epochId));
}

lemma PluginEpochFrameDispose(s: PluginServices, epochId: int, ok: bool)
  requires inv(s)
  ensures alwaysLiveClassOwnerUnique(disposePlugin(s, epochId, ok)) && alwaysServiceOwnerEpochExists(disposePlugin(s, epochId, ok))
  ensures alwaysRetirementsFollowTypePlan(disposePlugin(s, epochId, ok)) && alwaysNoOrphanInstance(disposePlugin(s, epochId, ok))
  ensures alwaysRetiredUndeclaredTypeIsUnknown(disposePlugin(s, epochId, ok)) && alwaysStopObservationsFollowSlots(disposePlugin(s, epochId, ok))
  ensures alwaysRetiredEpochHasNoResources(disposePlugin(s, epochId, ok)) && alwaysSealedOwnedClassesStable(disposePlugin(s, epochId, ok))
{
  hide *;
  reveal disposePlugin(), core__pluginRegistry_disposePlugin(), core__plugins_finishDispose();
  PluginEpochFrameKeepsOwnership(s, disposePlugin(s, epochId, ok));
}

lemma PluginEpochFrameCommit(s: PluginServices, epochId: int)
  requires inv(s) && canCommitPlugin(s, epochId)
  requires core__pluginRegistry_alwaysEpochIdentityUnique(s.plugins)
  ensures alwaysLiveClassOwnerUnique(commitPlugin(s, epochId)) && alwaysServiceOwnerEpochExists(commitPlugin(s, epochId))
  ensures alwaysRetirementsFollowTypePlan(commitPlugin(s, epochId)) && alwaysNoOrphanInstance(commitPlugin(s, epochId))
  ensures alwaysRetiredUndeclaredTypeIsUnknown(commitPlugin(s, epochId)) && alwaysStopObservationsFollowSlots(commitPlugin(s, epochId))
  ensures alwaysRetiredEpochHasNoResources(commitPlugin(s, epochId)) && alwaysSealedOwnedClassesStable(commitPlugin(s, epochId))
{
  hide *;
  reveal commitPlugin(), core__pluginRegistry_commitPlugin(), core__plugins_commitRegistration();
  reveal canCommitPlugin(), core__pluginRegistry_canCommitPlugin(), core__plugins_canCommitRegistration();
  reveal core__pluginRegistry_alwaysEpochIdentityUnique(), core__pluginRegistry_epoch();
  reveal core__pluginRegistry_activePhase(), ProofLib.Filter();
  var prior := s.plugins.epochs;
  var after := commitPlugin(s, epochId);
  var retained := after.plugins.epochs;
  var byEpoch := (row: core__pluginRegistry_PluginEpoch) => (row.id == epochId);
  var matches := ProofLib.Filter(byEpoch, prior);
  forall i | 0 <= i < |prior|
    ensures prior[i].id == retained[i].id
    ensures core__pluginRegistry_activePhase(prior[i].lifecycle.phase) ==
      core__pluginRegistry_activePhase(retained[i].lifecycle.phase)
    ensures (prior[i].lifecycle.phase.RollingBack? || prior[i].lifecycle.phase.Unloading?) ==
      (retained[i].lifecycle.phase.RollingBack? || retained[i].lifecycle.phase.Unloading?)
  {
    var row := prior[i];
    if row.id == epochId {
      assert row in prior;
      ProofLib.FilterMember(byEpoch, prior, row);
      assert |matches| == 1 && matches[0] == row;
      assert core__pluginRegistry_epoch(s.plugins, epochId) == row;
      assert row.lifecycle.phase.Registering?;
    }
  }
  PluginEpochFrameKeepsOwnership(s, after);
}

lemma joinPlugin_ensures(s: PluginServices, epochId: int)
  ensures (inv(s) ==> canJoinPlugin(s, epochId) ==> alwaysLiveClassOwnerUnique(joinPlugin(s, epochId)))
  ensures (inv(s) ==> canJoinPlugin(s, epochId) ==> alwaysServiceOwnerEpochExists(joinPlugin(s, epochId)))
  ensures (inv(s) ==> canJoinPlugin(s, epochId) ==> alwaysChildLifecyclesValid(joinPlugin(s, epochId)))
  ensures (inv(s) ==> canJoinPlugin(s, epochId) ==> alwaysRetirementsFollowTypePlan(joinPlugin(s, epochId)))
  ensures (inv(s) ==> canJoinPlugin(s, epochId) ==> alwaysNoOrphanInstance(joinPlugin(s, epochId)))
  ensures (inv(s) ==> canJoinPlugin(s, epochId) ==> alwaysRetiredUndeclaredTypeIsUnknown(joinPlugin(s, epochId)))
  ensures (inv(s) ==> canJoinPlugin(s, epochId) ==> alwaysStopObservationsFollowSlots(joinPlugin(s, epochId)))
  ensures (inv(s) ==> canJoinPlugin(s, epochId) ==> alwaysRetiredEpochHasNoResources(joinPlugin(s, epochId)))
  ensures (inv(s) ==> canJoinPlugin(s, epochId) ==> alwaysSealedOwnedClassesStable(joinPlugin(s, epochId)))
{
  hide *;
  reveal inv(), joinPlugin(), canJoinPlugin(), core__pluginRegistry_inv();
  if inv(s) && canJoinPlugin(s, epochId) {
    PluginEpochFrameJoin(s, epochId);
    PluginRetirementChildRulesMatchImportedInvariants(s);
    core__pluginRegistry_joinPlugin_ensures(s.plugins, epochId);
    PluginRetirementChildRulesMatchImportedInvariants(joinPlugin(s, epochId));
  }
}

lemma disposePlugin_ensures(s: PluginServices, epochId: int, ok: bool)
  ensures (inv(s) ==> canDisposePlugin(s, epochId, ok) ==> alwaysLiveClassOwnerUnique(disposePlugin(s, epochId, ok)))
  ensures (inv(s) ==> canDisposePlugin(s, epochId, ok) ==> alwaysServiceOwnerEpochExists(disposePlugin(s, epochId, ok)))
  ensures (inv(s) ==> canDisposePlugin(s, epochId, ok) ==> alwaysChildLifecyclesValid(disposePlugin(s, epochId, ok)))
  ensures (inv(s) ==> canDisposePlugin(s, epochId, ok) ==> alwaysRetirementsFollowTypePlan(disposePlugin(s, epochId, ok)))
  ensures (inv(s) ==> canDisposePlugin(s, epochId, ok) ==> alwaysNoOrphanInstance(disposePlugin(s, epochId, ok)))
  ensures (inv(s) ==> canDisposePlugin(s, epochId, ok) ==> alwaysRetiredUndeclaredTypeIsUnknown(disposePlugin(s, epochId, ok)))
  ensures (inv(s) ==> canDisposePlugin(s, epochId, ok) ==> alwaysStopObservationsFollowSlots(disposePlugin(s, epochId, ok)))
  ensures (inv(s) ==> canDisposePlugin(s, epochId, ok) ==> alwaysRetiredEpochHasNoResources(disposePlugin(s, epochId, ok)))
  ensures (inv(s) ==> canDisposePlugin(s, epochId, ok) ==> alwaysSealedOwnedClassesStable(disposePlugin(s, epochId, ok)))
{
  hide *;
  reveal inv(), disposePlugin(), canDisposePlugin(), core__pluginRegistry_inv();
  if inv(s) && canDisposePlugin(s, epochId, ok) {
    PluginEpochFrameDispose(s, epochId, ok);
    PluginRetirementChildRulesMatchImportedInvariants(s);
    core__pluginRegistry_disposePlugin_ensures(s.plugins, epochId, ok);
    PluginRetirementChildRulesMatchImportedInvariants(disposePlugin(s, epochId, ok));
  }
}

lemma finishNextPluginDisposal_ensures(s: PluginServices, ok: bool)
  ensures (inv(s) ==> canFinishNextPluginDisposal(s, ok) ==> alwaysLiveClassOwnerUnique(finishNextPluginDisposal(s, ok)))
  ensures (inv(s) ==> canFinishNextPluginDisposal(s, ok) ==> alwaysServiceOwnerEpochExists(finishNextPluginDisposal(s, ok)))
  ensures (inv(s) ==> canFinishNextPluginDisposal(s, ok) ==> alwaysChildLifecyclesValid(finishNextPluginDisposal(s, ok)))
  ensures (inv(s) ==> canFinishNextPluginDisposal(s, ok) ==> alwaysRetirementsFollowTypePlan(finishNextPluginDisposal(s, ok)))
  ensures (inv(s) ==> canFinishNextPluginDisposal(s, ok) ==> alwaysNoOrphanInstance(finishNextPluginDisposal(s, ok)))
  ensures (inv(s) ==> canFinishNextPluginDisposal(s, ok) ==> alwaysRetiredUndeclaredTypeIsUnknown(finishNextPluginDisposal(s, ok)))
  ensures (inv(s) ==> canFinishNextPluginDisposal(s, ok) ==> alwaysStopObservationsFollowSlots(finishNextPluginDisposal(s, ok)))
  ensures (inv(s) ==> canFinishNextPluginDisposal(s, ok) ==> alwaysRetiredEpochHasNoResources(finishNextPluginDisposal(s, ok)))
  ensures (inv(s) ==> canFinishNextPluginDisposal(s, ok) ==> alwaysSealedOwnedClassesStable(finishNextPluginDisposal(s, ok)))
{
  hide *;
  reveal finishNextPluginDisposal(), canFinishNextPluginDisposal();
  if inv(s) && canFinishNextPluginDisposal(s, ok) {
    disposePlugin_ensures(s, pendingPluginDisposal(s), ok);
  }
}

lemma commitPlugin_ensures(s: PluginServices, epochId: int)
  ensures (inv(s) ==> canCommitPlugin(s, epochId) ==> alwaysLiveClassOwnerUnique(commitPlugin(s, epochId)))
  ensures (inv(s) ==> canCommitPlugin(s, epochId) ==> alwaysServiceOwnerEpochExists(commitPlugin(s, epochId)))
  ensures (inv(s) ==> canCommitPlugin(s, epochId) ==> alwaysChildLifecyclesValid(commitPlugin(s, epochId)))
  ensures (inv(s) ==> canCommitPlugin(s, epochId) ==> alwaysRetirementsFollowTypePlan(commitPlugin(s, epochId)))
  ensures (inv(s) ==> canCommitPlugin(s, epochId) ==> alwaysNoOrphanInstance(commitPlugin(s, epochId)))
  ensures (inv(s) ==> canCommitPlugin(s, epochId) ==> alwaysRetiredUndeclaredTypeIsUnknown(commitPlugin(s, epochId)))
  ensures (inv(s) ==> canCommitPlugin(s, epochId) ==> alwaysStopObservationsFollowSlots(commitPlugin(s, epochId)))
  ensures (inv(s) ==> canCommitPlugin(s, epochId) ==> alwaysRetiredEpochHasNoResources(commitPlugin(s, epochId)))
  ensures (inv(s) ==> canCommitPlugin(s, epochId) ==> alwaysSealedOwnedClassesStable(commitPlugin(s, epochId)))
{
  hide *;
  reveal inv(), commitPlugin(), canCommitPlugin(), core__pluginRegistry_inv();
  if inv(s) && canCommitPlugin(s, epochId) {
    PluginRetirementChildRulesMatchImportedInvariants(s);
    PluginEpochFrameCommit(s, epochId);
    core__pluginRegistry_commitPlugin_ensures(s.plugins, epochId);
    PluginRetirementChildRulesMatchImportedInvariants(commitPlugin(s, epochId));
  }
}

lemma PluginEpochFrameRecordedEpochPrecedesNext(registry: core__pluginRegistry_PluginEpochs, query: int)
  requires core__pluginRegistry_alwaysEpochIdentityUnique(registry)
  requires core__pluginRegistry_epoch(registry, query).id == query
  ensures query < registry.nextEpoch
{
  hide *;
  reveal core__pluginRegistry_alwaysEpochIdentityUnique(), core__pluginRegistry_epoch(), ProofLib.Filter();
  reveal core__pluginRegistry_absentEpoch;
  var selected := (row: core__pluginRegistry_PluginEpoch) => (row.id == query);
  var matches := ProofLib.Filter(selected, registry.epochs);
  if |matches| > 0 {
    ProofLib.FilterMember(selected, registry.epochs, matches[0]);
  }
}

lemma PluginEpochFrameLookupAfterAppend(prior: core__pluginRegistry_PluginEpochs,
    after: core__pluginRegistry_PluginEpochs, appended: core__pluginRegistry_PluginEpoch, query: int)
  requires after.epochs == prior.epochs + [appended] && query != appended.id
  ensures core__pluginRegistry_epoch(prior, query) == core__pluginRegistry_epoch(after, query)
{
  hide *;
  reveal core__pluginRegistry_epoch(), ProofLib.Filter();
  var selected := (row: core__pluginRegistry_PluginEpoch) => (row.id == query);
  ProofLib.FilterAppend(selected, prior.epochs, appended);
}

lemma PluginEpochFrameBegin(s: PluginServices, name: string, adapter: bool)
  requires inv(s) && core__pluginRegistry_alwaysEpochIdentityUnique(s.plugins)
  ensures alwaysLiveClassOwnerUnique(beginPlugin(s, name, adapter)) && alwaysServiceOwnerEpochExists(beginPlugin(s, name, adapter))
  ensures alwaysRetirementsFollowTypePlan(beginPlugin(s, name, adapter)) && alwaysNoOrphanInstance(beginPlugin(s, name, adapter))
  ensures alwaysRetiredUndeclaredTypeIsUnknown(beginPlugin(s, name, adapter)) && alwaysStopObservationsFollowSlots(beginPlugin(s, name, adapter))
  ensures alwaysRetiredEpochHasNoResources(beginPlugin(s, name, adapter)) && alwaysSealedOwnedClassesStable(beginPlugin(s, name, adapter))
{
  hide *;
  reveal inv(), beginPlugin(), core__pluginRegistry_beginPlugin(), alwaysServiceOwnerEpochExists(), alwaysRetirementsFollowTypePlan();
  reveal core__pluginRegistry_epochOwnsResources(), core__pluginRegistry_epochRetiring();
  var after := beginPlugin(s, name, adapter);
  var appended := after.plugins.epochs[|s.plugins.epochs|];
  assert appended.id == s.plugins.nextEpoch;
  forall owner | owner in s.ownership
    ensures core__pluginRegistry_epoch(s.plugins, owner.epochId).id ==
      core__pluginRegistry_epoch(after.plugins, owner.epochId).id
  {
    PluginEpochFrameRecordedEpochPrecedesNext(s.plugins, owner.epochId);
    PluginEpochFrameLookupAfterAppend(s.plugins, after.plugins, appended, owner.epochId);
  }
  forall plan | plan in s.retirements
    ensures core__pluginRegistry_epoch(s.plugins, plan.epochId).id ==
      core__pluginRegistry_epoch(after.plugins, plan.epochId).id
    ensures core__pluginRegistry_epochOwnsResources(s.plugins, plan.epochId) ==
      core__pluginRegistry_epochOwnsResources(after.plugins, plan.epochId)
    ensures core__pluginRegistry_epochRetiring(s.plugins, plan.epochId) ==
      core__pluginRegistry_epochRetiring(after.plugins, plan.epochId)
  {
    PluginEpochFrameRecordedEpochPrecedesNext(s.plugins, plan.epochId);
    PluginEpochFrameLookupAfterAppend(s.plugins, after.plugins, appended, plan.epochId);
  }
  PluginEpochFrameProjectedRules(s, after);
}

lemma beginPlugin_ensures(s: PluginServices, name: string, adapter: bool)
  ensures (inv(s) ==> canBeginPlugin(s, name, adapter) ==> alwaysLiveClassOwnerUnique(beginPlugin(s, name, adapter)))
  ensures (inv(s) ==> canBeginPlugin(s, name, adapter) ==> alwaysServiceOwnerEpochExists(beginPlugin(s, name, adapter)))
  ensures (inv(s) ==> canBeginPlugin(s, name, adapter) ==> alwaysChildLifecyclesValid(beginPlugin(s, name, adapter)))
  ensures (inv(s) ==> canBeginPlugin(s, name, adapter) ==> alwaysRetirementsFollowTypePlan(beginPlugin(s, name, adapter)))
  ensures (inv(s) ==> canBeginPlugin(s, name, adapter) ==> alwaysNoOrphanInstance(beginPlugin(s, name, adapter)))
  ensures (inv(s) ==> canBeginPlugin(s, name, adapter) ==> alwaysRetiredUndeclaredTypeIsUnknown(beginPlugin(s, name, adapter)))
  ensures (inv(s) ==> canBeginPlugin(s, name, adapter) ==> alwaysStopObservationsFollowSlots(beginPlugin(s, name, adapter)))
  ensures (inv(s) ==> canBeginPlugin(s, name, adapter) ==> alwaysRetiredEpochHasNoResources(beginPlugin(s, name, adapter)))
  ensures (inv(s) ==> canBeginPlugin(s, name, adapter) ==> alwaysSealedOwnedClassesStable(beginPlugin(s, name, adapter)))
{
  hide *;
  reveal inv(), beginPlugin(), canBeginPlugin(), core__pluginRegistry_inv();
  if inv(s) && canBeginPlugin(s, name, adapter) {
    PluginRetirementChildRulesMatchImportedInvariants(s);
    PluginEpochFrameBegin(s, name, adapter);
    core__pluginRegistry_beginPlugin_ensures(s.plugins, name, adapter);
    PluginRetirementChildRulesMatchImportedInvariants(beginPlugin(s, name, adapter));
  }
}

lemma PluginRetirementCaptureTypesHaveOneEntry(s: PluginServices, epochId: int)
  ensures forall serviceType | serviceType in plannedTypes(s, epochId) ::
    |ProofLib.Filter((other: string) => (other == serviceType), plannedTypes(s, epochId))| == 1
{
  hide *;
  reveal plannedTypes(), ProofLib.Filter();
  var byEpoch := (owner: OwnedClass) => (owner.epochId == epochId);
  var owners := ProofLib.Filter(byEpoch, s.ownership);
  var types := seq(|owners|, i requires 0 <= i < |owners| => owners[i].serviceType);
  var appendType := (acc: seq<string>, serviceType: string) =>
    if serviceType in acc then acc else acc + [serviceType];
  var appendOwnerType := (acc: seq<string>, owner: OwnedClass) =>
    if owner.serviceType in acc then acc else acc + [owner.serviceType];
  var empty: seq<string> := [];
  reveal ProofLib.Distinct();
  ProofLib.FoldLeftDedupDistinct(appendType, empty, types);
  ProofLib.FoldLeftPointwise(appendOwnerType, appendType, empty, owners, types);
  assert ProofLib.Distinct(plannedTypes(s, epochId));
  forall serviceType | serviceType in plannedTypes(s, epochId)
    ensures |ProofLib.Filter((other: string) => (other == serviceType), plannedTypes(s, epochId))| == 1
  {
    ProofLib.FilterDistinctCountOne((other: string) => (other == serviceType), plannedTypes(s, epochId), serviceType);
  }
}

lemma PluginRetirementCaptureStartsWithEmptyGroups(s: PluginServices, epochId: int)
  ensures |captureRetirement(epochId, s).retirements| == |s.retirements| + 1
  ensures captureRetirement(epochId, s).retirements[..|s.retirements|] == s.retirements
  ensures var added := captureRetirement(epochId, s).retirements[|s.retirements|];
    added.epochId == epochId && retirementGroupsFollowPlan(added)
{
  hide *;
  reveal captureRetirement(), retirementGroupsFollowPlan(), Std.Collections.Seq.FoldLeft(), ProofLib.Filter();
  reveal uncheckedSequence;
  PluginRetirementCaptureTypesHaveOneEntry(s, epochId);
}

lemma PluginRetirementCaptureHasNoEarlierPlan(s: PluginServices, epochId: int)
  requires alwaysRetirementsFollowTypePlan(s)
  requires core__pluginRegistry_epochOwnsResources(s.plugins, epochId)
  requires !core__pluginRegistry_epochRetiring(s.plugins, epochId)
  ensures forall r | r in s.retirements :: r.epochId != epochId
{
  hide *;
  reveal alwaysRetirementsFollowTypePlan();
  forall r | r in s.retirements
    ensures r.epochId != epochId
  {
    if r.epochId == epochId {
      assert false;
    }
  }
}

lemma PluginRetirementStartActiveEpochPositive(s: PluginServices, epochId: int)
  requires core__pluginRegistry_alwaysEpochIdentityUnique(s.plugins)
  requires core__pluginRegistry_activePhase(core__pluginRegistry_epoch(s.plugins, epochId).lifecycle.phase)
  ensures epochId > 0 && core__pluginRegistry_epoch(s.plugins, epochId).id == epochId
{
  hide *;
  reveal core__pluginRegistry_alwaysEpochIdentityUnique(), core__pluginRegistry_epoch(), core__pluginRegistry_activePhase(), ProofLib.Filter();
  reveal core__pluginRegistry_absentEpoch, core__plugins_initial;
  var byEpoch := (row: core__pluginRegistry_PluginEpoch) => (row.id == epochId);
  var matches := ProofLib.Filter(byEpoch, s.plugins.epochs);
  assert |matches| > 0;
  ProofLib.FilterMember(byEpoch, s.plugins.epochs, matches[0]);
}

lemma PluginRetirementStartChangedPhaseLookup(before: core__pluginRegistry_PluginEpochs,
    after: core__pluginRegistry_PluginEpochs, changed: int, phase: core__plugins_PluginPhase, query: int)
  requires |before.epochs| == |after.epochs|
  requires forall i | 0 <= i < |before.epochs| ::
    before.epochs[i].id == after.epochs[i].id &&
    after.epochs[i].lifecycle.phase == (if before.epochs[i].id == changed then phase else before.epochs[i].lifecycle.phase)
  ensures core__pluginRegistry_epoch(before, query).id == core__pluginRegistry_epoch(after, query).id
  ensures query != changed ==> core__pluginRegistry_epochRetiring(before, query) == core__pluginRegistry_epochRetiring(after, query)
  ensures query != changed ==> core__pluginRegistry_epochOwnsResources(before, query) == core__pluginRegistry_epochOwnsResources(after, query)
  ensures query == changed && core__pluginRegistry_epoch(before, query).id != 0 ==>
    core__pluginRegistry_epoch(after, query).lifecycle.phase == phase
{
  hide *;
  reveal core__pluginRegistry_epoch(), core__pluginRegistry_epochOwnsResources(), core__pluginRegistry_epochRetiring(), ProofLib.Filter();
  reveal core__pluginRegistry_absentEpoch;
  var selected := (row: core__pluginRegistry_PluginEpoch) => (row.id == query);
  var frame := (prior: core__pluginRegistry_PluginEpoch, retained: core__pluginRegistry_PluginEpoch) =>
    prior.id == retained.id && retained.lifecycle.phase == (if prior.id == changed then phase else prior.lifecycle.phase);
  forall i | 0 <= i < |before.epochs|
    ensures selected(before.epochs[i]) == selected(after.epochs[i]) && frame(before.epochs[i], after.epochs[i])
  {}
  ProofLib.FilterPointwise(selected, selected, frame, before.epochs, after.epochs);
  var matches := ProofLib.Filter(selected, before.epochs);
  if |matches| > 0 {
    ProofLib.FilterMember(selected, before.epochs, matches[0]);
  }
}

lemma PluginRetirementStartKeepsTypePlan(s: PluginServices, after: PluginServices,
    epochId: int, phase: core__plugins_PluginPhase)
  requires alwaysServiceOwnerEpochExists(s) && alwaysRetirementsFollowTypePlan(s)
  requires epochId > 0 && core__pluginRegistry_epoch(s.plugins, epochId).id == epochId
  requires core__pluginRegistry_epochOwnsResources(s.plugins, epochId) && !core__pluginRegistry_epochRetiring(s.plugins, epochId)
  requires phase.RollingBack? || phase.Unloading?
  requires after == captureRetirement(epochId, s.(plugins := after.plugins))
  requires |s.plugins.epochs| == |after.plugins.epochs|
  requires forall i | 0 <= i < |s.plugins.epochs| ::
    s.plugins.epochs[i].id == after.plugins.epochs[i].id &&
    after.plugins.epochs[i].lifecycle.phase == (if s.plugins.epochs[i].id == epochId then phase else s.plugins.epochs[i].lifecycle.phase)
  ensures alwaysServiceOwnerEpochExists(after) && alwaysRetirementsFollowTypePlan(after)
  ensures |after.retirements| == |s.retirements| + 1
  ensures after.retirements == s.retirements + [after.retirements[|s.retirements|]]
  ensures after.retirements[|s.retirements|].groups == []
  ensures forall r | r in s.retirements ::
    (r.epochId != epochId &&
      core__pluginRegistry_epochOwnsResources(s.plugins, r.epochId) == core__pluginRegistry_epochOwnsResources(after.plugins, r.epochId))
  ensures core__pluginRegistry_epochOwnsResources(after.plugins, after.retirements[|s.retirements|].epochId)
{
  hide *;
  reveal captureRetirement(), alwaysRetirementsFollowTypePlan(), alwaysServiceOwnerEpochExists(), ProofLib.Filter();
  reveal core__pluginRegistry_epochRetiring(), core__pluginRegistry_epochOwnsResources(), core__pluginRegistry_activePhase();
  PluginRetirementCaptureHasNoEarlierPlan(s, epochId);
  PluginRetirementCaptureStartsWithEmptyGroups(s.(plugins := after.plugins), epochId);
  var added := after.retirements[|s.retirements|];
  assert after.retirements == s.retirements + [added];
  forall owner | owner in s.ownership
    ensures core__pluginRegistry_epoch(after.plugins, owner.epochId).id == owner.epochId
  {
    PluginRetirementStartChangedPhaseLookup(s.plugins, after.plugins, epochId, phase, owner.epochId);
  }
  forall prior | prior in s.retirements
    ensures prior.epochId != epochId &&
      core__pluginRegistry_epochOwnsResources(s.plugins, prior.epochId) == core__pluginRegistry_epochOwnsResources(after.plugins, prior.epochId)
  {
    PluginRetirementStartChangedPhaseLookup(s.plugins, after.plugins, epochId, phase, prior.epochId);
  }
  forall r | r in after.retirements
    ensures r.epochId > 0 && core__pluginRegistry_epoch(after.plugins, r.epochId).id == r.epochId
    ensures core__pluginRegistry_epochRetiring(after.plugins, r.epochId) || !core__pluginRegistry_epochOwnsResources(after.plugins, r.epochId)
    ensures |ProofLib.Filter((other: ServiceRetirement) => (other.epochId == r.epochId), after.retirements)| == 1
    ensures retirementGroupsFollowPlan(r)
  {
    var byEpoch := (other: ServiceRetirement) => (other.epochId == r.epochId);
    ProofLib.FilterAppend(byEpoch, s.retirements, added);
    PluginRetirementStartChangedPhaseLookup(s.plugins, after.plugins, epochId, phase, r.epochId);
    if r == added {
      assert added.epochId == epochId;
      ProofLib.FilterNone(byEpoch, s.retirements);
    } else {
      assert r in s.retirements && r.epochId != epochId;
    }
  }
  PluginRetirementStartChangedPhaseLookup(s.plugins, after.plugins, epochId, phase, epochId);
}

lemma PluginRetirementStartKeepsReceiptsAndOwners(s: PluginServices, after: PluginServices, added: ServiceRetirement)
  requires inv(s) && alwaysRetirementsFollowTypePlan(after)
  requires after.retirements == s.retirements + [added] && added.groups == []
  requires after.services == s.services && after.ownership == s.ownership && after.liveOwners == s.liveOwners
  requires after.requestsClosed == s.requestsClosed && alwaysServiceOwnerEpochExists(after)
  requires core__pluginRegistry_epochOwnsResources(after.plugins, added.epochId)
  requires forall r | r in s.retirements ::
    core__pluginRegistry_epochOwnsResources(s.plugins, r.epochId) == core__pluginRegistry_epochOwnsResources(after.plugins, r.epochId)
  ensures alwaysLiveClassOwnerUnique(after) && alwaysNoOrphanInstance(after)
  ensures alwaysStopObservationsFollowSlots(after) && alwaysRetiredEpochHasNoResources(after)
  ensures alwaysRetiredUndeclaredTypeIsUnknown(after) && alwaysSealedOwnedClassesStable(after)
{
  hide *;
  reveal inv(), alwaysLiveClassOwnerUnique(), alwaysNoOrphanInstance(), alwaysStopObservationsFollowSlots();
  reveal alwaysRetiredEpochHasNoResources(), alwaysRetiredUndeclaredTypeIsUnknown(), alwaysSealedOwnedClassesStable(), retirementSettled();
  forall r | r in after.retirements && !core__pluginRegistry_epochOwnsResources(after.plugins, r.epochId)
    ensures retirementSettled(after, r.epochId)
    ensures forall group | group in r.groups ::
      group.instanceCursor == |group.instances| &&
      (forall slot | slot in group.observedStops :: stopSlotSettled(slot, after.services))
  {
    assert r in s.retirements && !core__pluginRegistry_epochOwnsResources(s.plugins, r.epochId);
    PluginRetirementPlanLookup(s, r);
    PluginRetirementPlanLookup(after, r);
  }
}

lemma PluginRetirementStartFailPlugin(s: PluginServices, epochId: int)
  requires inv(s) && canFailPlugin(s, epochId)
  ensures alwaysServiceOwnerEpochExists(failPlugin(s, epochId)) && alwaysRetirementsFollowTypePlan(failPlugin(s, epochId))
  ensures alwaysLiveClassOwnerUnique(failPlugin(s, epochId)) && alwaysNoOrphanInstance(failPlugin(s, epochId))
  ensures alwaysStopObservationsFollowSlots(failPlugin(s, epochId)) && alwaysRetiredEpochHasNoResources(failPlugin(s, epochId))
  ensures alwaysRetiredUndeclaredTypeIsUnknown(failPlugin(s, epochId)) && alwaysSealedOwnedClassesStable(failPlugin(s, epochId))
{
  hide *;
  reveal inv(), alwaysChildLifecyclesValid(), failPlugin(), canFailPlugin(), captureRetirement();
  reveal core__pluginRegistry_failPlugin(), core__pluginRegistry_canFailPlugin(), core__plugins_failRegistration(), core__plugins_canFailRegistration();
  reveal core__pluginRegistry_activePhase(), core__pluginRegistry_epochOwnsResources(), core__pluginRegistry_epochRetiring();
  PluginRetirementStartActiveEpochPositive(s, epochId);
  var after := failPlugin(s, epochId);
  PluginRetirementStartKeepsTypePlan(s, after, epochId, core__plugins_PluginPhase.RollingBack);
  PluginRetirementStartKeepsReceiptsAndOwners(s, after, after.retirements[|s.retirements|]);
}

lemma PluginRetirementStartUnloadPlugin(s: PluginServices, epochId: int)
  requires inv(s) && canUnloadPlugin(s, epochId)
  ensures alwaysServiceOwnerEpochExists(unloadPlugin(s, epochId)) && alwaysRetirementsFollowTypePlan(unloadPlugin(s, epochId))
  ensures alwaysLiveClassOwnerUnique(unloadPlugin(s, epochId)) && alwaysNoOrphanInstance(unloadPlugin(s, epochId))
  ensures alwaysStopObservationsFollowSlots(unloadPlugin(s, epochId)) && alwaysRetiredEpochHasNoResources(unloadPlugin(s, epochId))
  ensures alwaysRetiredUndeclaredTypeIsUnknown(unloadPlugin(s, epochId)) && alwaysSealedOwnedClassesStable(unloadPlugin(s, epochId))
{
  hide *;
  reveal inv(), alwaysChildLifecyclesValid(), unloadPlugin(), canUnloadPlugin(), captureRetirement();
  reveal core__pluginRegistry_unloadPlugin(), core__pluginRegistry_canUnloadPlugin(), core__plugins_beginUnload(), core__plugins_canBeginUnload();
  reveal core__pluginRegistry_activePhase(), core__pluginRegistry_epochOwnsResources(), core__pluginRegistry_epochRetiring();
  PluginRetirementStartActiveEpochPositive(s, epochId);
  var after := unloadPlugin(s, epochId);
  PluginRetirementStartKeepsTypePlan(s, after, epochId, core__plugins_PluginPhase.Unloading);
  PluginRetirementStartKeepsReceiptsAndOwners(s, after, after.retirements[|s.retirements|]);
}

lemma failPlugin_ensures(s: PluginServices, epochId: int)
  ensures (inv(s) ==> canFailPlugin(s, epochId) ==> alwaysLiveClassOwnerUnique(failPlugin(s, epochId)))
  ensures (inv(s) ==> canFailPlugin(s, epochId) ==> alwaysServiceOwnerEpochExists(failPlugin(s, epochId)))
  ensures (inv(s) ==> canFailPlugin(s, epochId) ==> alwaysChildLifecyclesValid(failPlugin(s, epochId)))
  ensures (inv(s) ==> canFailPlugin(s, epochId) ==> alwaysRetirementsFollowTypePlan(failPlugin(s, epochId)))
  ensures (inv(s) ==> canFailPlugin(s, epochId) ==> alwaysNoOrphanInstance(failPlugin(s, epochId)))
  ensures (inv(s) ==> canFailPlugin(s, epochId) ==> alwaysRetiredUndeclaredTypeIsUnknown(failPlugin(s, epochId)))
  ensures (inv(s) ==> canFailPlugin(s, epochId) ==> alwaysStopObservationsFollowSlots(failPlugin(s, epochId)))
  ensures (inv(s) ==> canFailPlugin(s, epochId) ==> alwaysRetiredEpochHasNoResources(failPlugin(s, epochId)))
  ensures (inv(s) ==> canFailPlugin(s, epochId) ==> alwaysSealedOwnedClassesStable(failPlugin(s, epochId)))
{
  hide *;
  reveal inv(), failPlugin(), canFailPlugin(), core__pluginRegistry_inv(), captureRetirement();
  if inv(s) && canFailPlugin(s, epochId) {
    PluginRetirementStartFailPlugin(s, epochId);
    PluginRetirementChildRulesMatchImportedInvariants(s);
    core__pluginRegistry_failPlugin_ensures(s.plugins, epochId);
    PluginRetirementChildRulesMatchImportedInvariants(failPlugin(s, epochId));
  }
}

lemma unloadPlugin_ensures(s: PluginServices, epochId: int)
  ensures (inv(s) ==> canUnloadPlugin(s, epochId) ==> alwaysLiveClassOwnerUnique(unloadPlugin(s, epochId)))
  ensures (inv(s) ==> canUnloadPlugin(s, epochId) ==> alwaysServiceOwnerEpochExists(unloadPlugin(s, epochId)))
  ensures (inv(s) ==> canUnloadPlugin(s, epochId) ==> alwaysChildLifecyclesValid(unloadPlugin(s, epochId)))
  ensures (inv(s) ==> canUnloadPlugin(s, epochId) ==> alwaysRetirementsFollowTypePlan(unloadPlugin(s, epochId)))
  ensures (inv(s) ==> canUnloadPlugin(s, epochId) ==> alwaysNoOrphanInstance(unloadPlugin(s, epochId)))
  ensures (inv(s) ==> canUnloadPlugin(s, epochId) ==> alwaysRetiredUndeclaredTypeIsUnknown(unloadPlugin(s, epochId)))
  ensures (inv(s) ==> canUnloadPlugin(s, epochId) ==> alwaysStopObservationsFollowSlots(unloadPlugin(s, epochId)))
  ensures (inv(s) ==> canUnloadPlugin(s, epochId) ==> alwaysRetiredEpochHasNoResources(unloadPlugin(s, epochId)))
  ensures (inv(s) ==> canUnloadPlugin(s, epochId) ==> alwaysSealedOwnedClassesStable(unloadPlugin(s, epochId)))
{
  hide *;
  reveal inv(), unloadPlugin(), canUnloadPlugin(), core__pluginRegistry_inv(), captureRetirement();
  if inv(s) && canUnloadPlugin(s, epochId) {
    PluginRetirementStartUnloadPlugin(s, epochId);
    PluginRetirementChildRulesMatchImportedInvariants(s);
    core__pluginRegistry_unloadPlugin_ensures(s.plugins, epochId);
    PluginRetirementChildRulesMatchImportedInvariants(unloadPlugin(s, epochId));
  }
}

lemma finishNextRegistration_ensures(s: PluginServices, ok: bool)
  ensures (inv(s) ==> canFinishNextRegistration(s, ok) ==> alwaysLiveClassOwnerUnique(finishNextRegistration(s, ok)))
  ensures (inv(s) ==> canFinishNextRegistration(s, ok) ==> alwaysServiceOwnerEpochExists(finishNextRegistration(s, ok)))
  ensures (inv(s) ==> canFinishNextRegistration(s, ok) ==> alwaysChildLifecyclesValid(finishNextRegistration(s, ok)))
  ensures (inv(s) ==> canFinishNextRegistration(s, ok) ==> alwaysRetirementsFollowTypePlan(finishNextRegistration(s, ok)))
  ensures (inv(s) ==> canFinishNextRegistration(s, ok) ==> alwaysNoOrphanInstance(finishNextRegistration(s, ok)))
  ensures (inv(s) ==> canFinishNextRegistration(s, ok) ==> alwaysRetiredUndeclaredTypeIsUnknown(finishNextRegistration(s, ok)))
  ensures (inv(s) ==> canFinishNextRegistration(s, ok) ==> alwaysStopObservationsFollowSlots(finishNextRegistration(s, ok)))
  ensures (inv(s) ==> canFinishNextRegistration(s, ok) ==> alwaysRetiredEpochHasNoResources(finishNextRegistration(s, ok)))
  ensures (inv(s) ==> canFinishNextRegistration(s, ok) ==> alwaysSealedOwnedClassesStable(finishNextRegistration(s, ok)))
{
  hide *;
  reveal canFinishNextRegistration(), finishNextRegistration();
  if inv(s) && canFinishNextRegistration(s, ok) {
    var epochId := pendingRegistration(s);
    if ok {
      commitPlugin_ensures(s, epochId);
    } else {
      failPlugin_ensures(s, epochId);
    }
  }
}

lemma PluginServiceFrameKeepsLocalRules(s: PluginServices, after: PluginServices)
  requires inv(s) && after == s.(services := after.services)
  requires after.services.objects == s.services.objects && |after.services.classes| == |s.services.classes|
  requires forall i | 0 <= i < |s.services.classes| ::
    after.services.classes[i].registered == s.services.classes[i].registered
      && after.services.classes[i].live == s.services.classes[i].live
  requires after.services.declarations == s.services.declarations && after.services.stopped == s.services.stopped
  requires forall r | r in s.retirements ::
    (forall g | g in r.groups && !(exists d :: d in s.services.declarations && d.serviceType == g.serviceType) ::
      core__serviceInstances_serviceTypeEntry(s.services, g.serviceType).status ==
      core__serviceInstances_serviceTypeEntry(after.services, g.serviceType).status)
  ensures alwaysLiveClassOwnerUnique(after) && alwaysServiceOwnerEpochExists(after)
  ensures alwaysRetirementsFollowTypePlan(after) && alwaysNoOrphanInstance(after)
  ensures alwaysRetiredUndeclaredTypeIsUnknown(after) && alwaysSealedOwnedClassesStable(after)
  ensures alwaysStopObservationsFollowSlots(after) && alwaysRetiredEpochHasNoResources(after)
{
  hide *;
  reveal inv(), alwaysLiveClassOwnerUnique(), alwaysServiceOwnerEpochExists(), alwaysRetirementsFollowTypePlan();
  reveal alwaysNoOrphanInstance(), alwaysRetiredUndeclaredTypeIsUnknown(), alwaysSealedOwnedClassesStable();
  forall obj | obj in after.services.objects
    ensures obj.stopCalls > 0
      || (exists c | c in after.services.classes :: c.live == obj.id && c.registered)
      || (exists r | r in after.retirements :: exists g | g in r.groups ::
        missingStopObservedFor(g, obj.id)
        || (core__pluginRegistry_epochOwnsResources(after.plugins, r.epochId) && obj.id in g.instances))
  {
    if exists c | c in s.services.classes :: c.live == obj.id && c.registered {
      var c :| c in s.services.classes && c.live == obj.id && c.registered;
      var i :| 0 <= i < |s.services.classes| && s.services.classes[i] == c;
      assert after.services.classes[i] in after.services.classes;
    }
  }
  PluginServiceFrameRetainsStopReceipts(s, after);
}

lemma PluginServiceFrameClearAggregateKeepsTypeStatus(s: core__serviceInstances_ServiceInstances, callId: int, query: string)
  ensures core__serviceInstances_serviceTypeEntry(core__serviceInstances_clearTypeAggregate(s, callId), query).status ==
    core__serviceInstances_serviceTypeEntry(s, query).status
{
  hide *;
  reveal core__serviceInstances_clearTypeAggregate(), core__serviceInstances_serviceTypeEntry(), ProofLib.Filter();
  var before := s.typeEntries;
  var after := core__serviceInstances_clearTypeAggregate(s, callId).typeEntries;
  var selected := (row: core__serviceInstances_TypeEntry) => (row.serviceType == query);
  var sameStatus := (prior: core__serviceInstances_TypeEntry, next: core__serviceInstances_TypeEntry) => prior.status == next.status;
  forall i | 0 <= i < |before|
    ensures selected(before[i]) == selected(after[i]) && sameStatus(before[i], after[i])
  {}
  ProofLib.FilterPointwise(selected, selected, sameStatus, before, after);
}

lemma PluginServiceFrameClearAggregateKeepsGroupStatuses(s: PluginServices, callId: int)
  ensures forall r | r in s.retirements ::
    (forall g | g in r.groups ::
      core__serviceInstances_serviceTypeEntry(s.services, g.serviceType).status ==
      core__serviceInstances_serviceTypeEntry(clearTypeAggregate(s, callId).services, g.serviceType).status)
{
  hide *;
  reveal clearTypeAggregate();
  forall r | r in s.retirements
    ensures forall g | g in r.groups ::
      core__serviceInstances_serviceTypeEntry(s.services, g.serviceType).status ==
      core__serviceInstances_serviceTypeEntry(clearTypeAggregate(s, callId).services, g.serviceType).status
  {
    forall g | g in r.groups
      ensures core__serviceInstances_serviceTypeEntry(s.services, g.serviceType).status ==
        core__serviceInstances_serviceTypeEntry(clearTypeAggregate(s, callId).services, g.serviceType).status
    {
      PluginServiceFrameClearAggregateKeepsTypeStatus(s.services, callId, g.serviceType);
    }
  }
}

lemma PluginOwnedClassFilterKeepsDifferentClass(owners: seq<OwnedClass>, replaced: int, kept: int)
  requires kept != replaced
  ensures ProofLib.Filter((owner: OwnedClass) => (owner.classId == kept),
    ProofLib.Filter((owner: OwnedClass) => (owner.classId != replaced), owners)) ==
    ProofLib.Filter((owner: OwnedClass) => (owner.classId == kept), owners)
{
  hide *;
  var preserve := (owner: OwnedClass) => (owner.classId != replaced);
  var selectClass := (owner: OwnedClass) => (owner.classId == kept);
  if |owners| == 0 {
    ProofLib.FilterNil(preserve, owners);
    ProofLib.FilterNil(selectClass, owners);
  } else {
    PluginOwnedClassFilterKeepsDifferentClass(owners[1..], replaced, kept);
    ProofLib.FilterCons(preserve, owners);
    ProofLib.FilterCons(selectClass, owners);
    var head := owners[0];
    var tail := owners[1..];
    var filtered := ProofLib.Filter(preserve, owners);
    var retainedTail := ProofLib.Filter(preserve, tail);
    assert ProofLib.Filter(selectClass, retainedTail) == ProofLib.Filter(selectClass, tail);
    if preserve(head) {
      assert filtered == [head] + retainedTail;
      assert filtered[0] == head && filtered[1..] == retainedTail;
      ProofLib.FilterCons(selectClass, filtered);
    } else {
      assert !selectClass(head);
      assert filtered == retainedTail;
    }
  }
}

lemma PluginOwnedClassRegistrationRetainsUniqueLiveOwners(s: PluginServices, after: PluginServices, captured: OwnedClass)
  requires alwaysLiveClassOwnerUnique(s)
  requires after.ownership == s.ownership + [captured]
  requires after.liveOwners == ProofLib.Filter((owner: OwnedClass) => (owner.classId != captured.classId), s.liveOwners) + [captured]
  ensures alwaysLiveClassOwnerUnique(after)
{
  hide *;
  reveal alwaysLiveClassOwnerUnique(), ProofLib.Filter();
  var preserve := (owner: OwnedClass) => (owner.classId != captured.classId);
  var remaining := ProofLib.Filter(preserve, s.liveOwners);
  forall owner | owner in after.liveOwners
    ensures owner in after.ownership
    ensures |ProofLib.Filter((other: OwnedClass) => (other.classId == owner.classId), after.liveOwners)| == 1
  {
    var selectClass := (other: OwnedClass) => (other.classId == owner.classId);
    ProofLib.FilterAppend(selectClass, remaining, captured);
    if owner == captured {
      forall i | 0 <= i < |remaining|
        ensures !selectClass(remaining[i])
      {
        ProofLib.FilterMember(preserve, s.liveOwners, remaining[i]);
      }
      ProofLib.FilterNone(selectClass, remaining);
    } else {
      ProofLib.FilterMember(preserve, s.liveOwners, owner);
      PluginOwnedClassFilterKeepsDifferentClass(s.liveOwners, captured.classId, owner.classId);
    }
  }
}

lemma PluginOwnedClassExistingServiceClassRetained(s: core__serviceInstances_ServiceInstances, classId: int,
    serviceType: string, prior: core__serviceInstances_ServiceClassEntry)
  requires prior in s.classes
  ensures exists retained ::
    (retained in core__serviceInstances_registerClass(s, classId, serviceType).classes &&
      retained.id == prior.id && retained.live == prior.live && (prior.registered ==> retained.registered))
{
  hide *;
  reveal core__serviceInstances_registerClass(), core__serviceInstances_registerType(), core__serviceInstances_putType();
  var after := core__serviceInstances_registerClass(s, classId, serviceType);
  var i :| 0 <= i < |s.classes| && s.classes[i] == prior;
  assert i < |after.classes|;
  assert after.classes[i] in after.classes;
}

lemma PluginOwnedClassOtherTypeStatusRetained(s: core__serviceInstances_ServiceInstances, classId: int,
    serviceType: string, query: string)
  requires query != serviceType
  ensures core__serviceInstances_serviceTypeEntry(core__serviceInstances_registerClass(s, classId, serviceType), query) ==
    core__serviceInstances_serviceTypeEntry(s, query)
{
  hide *;
  reveal core__serviceInstances_registerClass(), core__serviceInstances_registerType(), core__serviceInstances_putType();
  reveal core__serviceInstances_serviceTypeEntry(), ProofLib.Filter();
  var before := s.typeEntries;
  var after := core__serviceInstances_registerClass(s, classId, serviceType).typeEntries;
  var selectType := (row: core__serviceInstances_TypeEntry) => (row.serviceType == query);
  if exists row :: row in before && row.serviceType == serviceType {
    var retained := (prior: core__serviceInstances_TypeEntry, candidate: core__serviceInstances_TypeEntry) =>
      !selectType(prior) || prior == candidate;
    forall i | 0 <= i < |before|
      ensures selectType(before[i]) == selectType(after[i]) && retained(before[i], after[i])
    {}
    ProofLib.FilterPointwise(selectType, selectType, retained, before, after);
    var matches := ProofLib.Filter(selectType, before);
    if |matches| > 0 {
      ProofLib.FilterMember(selectType, before, matches[0]);
    }
  } else {
    var added := after[|before|];
    assert after == before + [added] && added.serviceType == serviceType;
    ProofLib.FilterAppend(selectType, before, added);
  }
}

lemma PluginOwnedClassRegistrationPreservesPluginRules(s: PluginServices, epochId: int, classId: int,
    serviceType: string, hasStopHook: bool)
  requires inv(s) && canRegisterOwnedClass(s, epochId, classId, serviceType, hasStopHook)
  ensures alwaysLiveClassOwnerUnique(registerOwnedClass(s, epochId, classId, serviceType, hasStopHook))
  ensures alwaysServiceOwnerEpochExists(registerOwnedClass(s, epochId, classId, serviceType, hasStopHook))
  ensures alwaysRetirementsFollowTypePlan(registerOwnedClass(s, epochId, classId, serviceType, hasStopHook))
  ensures alwaysNoOrphanInstance(registerOwnedClass(s, epochId, classId, serviceType, hasStopHook))
  ensures alwaysRetiredUndeclaredTypeIsUnknown(registerOwnedClass(s, epochId, classId, serviceType, hasStopHook))
  ensures alwaysStopObservationsFollowSlots(registerOwnedClass(s, epochId, classId, serviceType, hasStopHook))
  ensures alwaysRetiredEpochHasNoResources(registerOwnedClass(s, epochId, classId, serviceType, hasStopHook))
  ensures alwaysSealedOwnedClassesStable(registerOwnedClass(s, epochId, classId, serviceType, hasStopHook))
{
  hide *;
  reveal inv(), registerOwnedClass(), canRegisterOwnedClass(), ProofLib.Filter();
  reveal core__pluginRegistry_epochAdmitsClass(), core__pluginRegistry_activePhase(), alwaysChildLifecyclesValid();
  reveal core__serviceInstances_registerClass(), core__serviceInstances_registerType(), core__serviceInstances_putType();
  reveal alwaysServiceOwnerEpochExists(), alwaysRetirementsFollowTypePlan(), alwaysSealedOwnedClassesStable();
  reveal alwaysNoOrphanInstance(), alwaysRetiredUndeclaredTypeIsUnknown();
  var after := registerOwnedClass(s, epochId, classId, serviceType, hasStopHook);
  PluginRetirementStartActiveEpochPositive(s, epochId);
  PluginServiceFrameRetainsStopReceipts(s, after);
  PluginOwnedClassRegistrationRetainsUniqueLiveOwners(s, after, OwnedClass(epochId, classId, serviceType, hasStopHook));
  forall o | o in after.services.objects && o.stopCalls <= 0
    ensures (exists c :: c in after.services.classes && c.live == o.id && c.registered) ||
      (exists r :: (r in after.retirements && (exists g :: (g in r.groups &&
        (missingStopObservedFor(g, o.id) ||
          (core__pluginRegistry_epochOwnsResources(after.plugins, r.epochId) && o.id in g.instances))))))
  {
    if exists c :: c in s.services.classes && c.live == o.id && c.registered {
      var c :| c in s.services.classes && c.live == o.id && c.registered;
      PluginOwnedClassExistingServiceClassRetained(s.services, classId, serviceType, c);
    }
  }
  if !after.services.stopped {
    forall r | r in after.retirements
      ensures forall g | g in r.groups &&
        (g.phase.GroupFinished? || g.phase.GroupFailed?) &&
        !(exists d :: d in after.services.declarations && d.serviceType == g.serviceType) &&
        !(exists other :: (other in after.retirements && (exists pending :: (pending in other.groups &&
          pending.serviceType == g.serviceType && pending.phase.GroupWaiting?)))) ::
          core__serviceInstances_serviceTypeEntry(after.services, g.serviceType).status.TypeUnknown?
    {
      forall g | g in r.groups &&
        (g.phase.GroupFinished? || g.phase.GroupFailed?) &&
        !(exists d :: d in after.services.declarations && d.serviceType == g.serviceType) &&
        !(exists other :: (other in after.retirements && (exists pending :: (pending in other.groups &&
          pending.serviceType == g.serviceType && pending.phase.GroupWaiting?))))
        ensures core__serviceInstances_serviceTypeEntry(after.services, g.serviceType).status.TypeUnknown?
      {
        assert core__serviceInstances_ServiceDeclaration(classId, serviceType) in after.services.declarations;
        assert g.serviceType != serviceType;
        PluginOwnedClassOtherTypeStatusRetained(s.services, classId, serviceType, g.serviceType);
      }
    }
  }
}

lemma registerOwnedClass_ensures(s: PluginServices, epochId: int, classId: int, serviceType: string, hasStopHook: bool)
  ensures (inv(s) ==> canRegisterOwnedClass(s, epochId, classId, serviceType, hasStopHook) ==> alwaysLiveClassOwnerUnique(registerOwnedClass(s, epochId, classId, serviceType, hasStopHook)))
  ensures (inv(s) ==> canRegisterOwnedClass(s, epochId, classId, serviceType, hasStopHook) ==> alwaysServiceOwnerEpochExists(registerOwnedClass(s, epochId, classId, serviceType, hasStopHook)))
  ensures (inv(s) ==> canRegisterOwnedClass(s, epochId, classId, serviceType, hasStopHook) ==> alwaysChildLifecyclesValid(registerOwnedClass(s, epochId, classId, serviceType, hasStopHook)))
  ensures (inv(s) ==> canRegisterOwnedClass(s, epochId, classId, serviceType, hasStopHook) ==> alwaysRetirementsFollowTypePlan(registerOwnedClass(s, epochId, classId, serviceType, hasStopHook)))
  ensures (inv(s) ==> canRegisterOwnedClass(s, epochId, classId, serviceType, hasStopHook) ==> alwaysNoOrphanInstance(registerOwnedClass(s, epochId, classId, serviceType, hasStopHook)))
  ensures (inv(s) ==> canRegisterOwnedClass(s, epochId, classId, serviceType, hasStopHook) ==> alwaysRetiredUndeclaredTypeIsUnknown(registerOwnedClass(s, epochId, classId, serviceType, hasStopHook)))
  ensures (inv(s) ==> canRegisterOwnedClass(s, epochId, classId, serviceType, hasStopHook) ==> alwaysStopObservationsFollowSlots(registerOwnedClass(s, epochId, classId, serviceType, hasStopHook)))
  ensures (inv(s) ==> canRegisterOwnedClass(s, epochId, classId, serviceType, hasStopHook) ==> alwaysRetiredEpochHasNoResources(registerOwnedClass(s, epochId, classId, serviceType, hasStopHook)))
  ensures (inv(s) ==> canRegisterOwnedClass(s, epochId, classId, serviceType, hasStopHook) ==> alwaysSealedOwnedClassesStable(registerOwnedClass(s, epochId, classId, serviceType, hasStopHook)))
{
  hide *;
  reveal inv(), canRegisterOwnedClass(), registerOwnedClass(), core__serviceInstances_inv();
  if inv(s) && canRegisterOwnedClass(s, epochId, classId, serviceType, hasStopHook) {
    PluginOwnedClassRegistrationPreservesPluginRules(s, epochId, classId, serviceType, hasStopHook);
    PluginRetirementChildRulesMatchImportedInvariants(s);
    core__serviceInstances_registerClass_ensures(s.services, classId, serviceType);
    PluginRetirementChildRulesMatchImportedInvariants(registerOwnedClass(s, epochId, classId, serviceType, hasStopHook));
  }
}

lemma failClassStart_ensures(s: PluginServices, attemptId: int, errorId: string)
  ensures (inv(s) ==> canFailClassStart(s, attemptId, errorId) ==> alwaysLiveClassOwnerUnique(failClassStart(s, attemptId, errorId)))
  ensures (inv(s) ==> canFailClassStart(s, attemptId, errorId) ==> alwaysServiceOwnerEpochExists(failClassStart(s, attemptId, errorId)))
  ensures (inv(s) ==> canFailClassStart(s, attemptId, errorId) ==> alwaysChildLifecyclesValid(failClassStart(s, attemptId, errorId)))
  ensures (inv(s) ==> canFailClassStart(s, attemptId, errorId) ==> alwaysRetirementsFollowTypePlan(failClassStart(s, attemptId, errorId)))
  ensures (inv(s) ==> canFailClassStart(s, attemptId, errorId) ==> alwaysNoOrphanInstance(failClassStart(s, attemptId, errorId)))
  ensures (inv(s) ==> canFailClassStart(s, attemptId, errorId) ==> alwaysRetiredUndeclaredTypeIsUnknown(failClassStart(s, attemptId, errorId)))
  ensures (inv(s) ==> canFailClassStart(s, attemptId, errorId) ==> alwaysStopObservationsFollowSlots(failClassStart(s, attemptId, errorId)))
  ensures (inv(s) ==> canFailClassStart(s, attemptId, errorId) ==> alwaysRetiredEpochHasNoResources(failClassStart(s, attemptId, errorId)))
  ensures (inv(s) ==> canFailClassStart(s, attemptId, errorId) ==> alwaysSealedOwnedClassesStable(failClassStart(s, attemptId, errorId)))
{
  hide *;
  reveal inv(), core__serviceInstances_inv(), core__serviceInstances_serviceTypeEntry();
  reveal failClassStart(), canFailClassStart(), core__serviceInstances_failStart(), core__serviceInstances_rejectStartAttempt();
  if inv(s) && canFailClassStart(s, attemptId, errorId) {
    var after := failClassStart(s, attemptId, errorId);
    forall i | 0 <= i < |s.services.classes|
      ensures after.services.classes[i].registered == s.services.classes[i].registered
        && after.services.classes[i].live == s.services.classes[i].live
    {}
    PluginServiceFrameKeepsLocalRules(s, after);
    PluginRetirementChildRulesMatchImportedInvariants(s);
    core__serviceInstances_failStart_ensures(s.services, attemptId, errorId);
    PluginRetirementChildRulesMatchImportedInvariants(after);
  }
}

lemma finishLateStart_ensures(s: PluginServices, attemptId: int)
  ensures (inv(s) ==> canFinishLateStart(s, attemptId) ==> alwaysLiveClassOwnerUnique(finishLateStart(s, attemptId)))
  ensures (inv(s) ==> canFinishLateStart(s, attemptId) ==> alwaysServiceOwnerEpochExists(finishLateStart(s, attemptId)))
  ensures (inv(s) ==> canFinishLateStart(s, attemptId) ==> alwaysChildLifecyclesValid(finishLateStart(s, attemptId)))
  ensures (inv(s) ==> canFinishLateStart(s, attemptId) ==> alwaysRetirementsFollowTypePlan(finishLateStart(s, attemptId)))
  ensures (inv(s) ==> canFinishLateStart(s, attemptId) ==> alwaysNoOrphanInstance(finishLateStart(s, attemptId)))
  ensures (inv(s) ==> canFinishLateStart(s, attemptId) ==> alwaysRetiredUndeclaredTypeIsUnknown(finishLateStart(s, attemptId)))
  ensures (inv(s) ==> canFinishLateStart(s, attemptId) ==> alwaysStopObservationsFollowSlots(finishLateStart(s, attemptId)))
  ensures (inv(s) ==> canFinishLateStart(s, attemptId) ==> alwaysRetiredEpochHasNoResources(finishLateStart(s, attemptId)))
  ensures (inv(s) ==> canFinishLateStart(s, attemptId) ==> alwaysSealedOwnedClassesStable(finishLateStart(s, attemptId)))
{
  hide *;
  reveal inv(), core__serviceInstances_inv(), core__serviceInstances_serviceTypeEntry();
  reveal finishLateStart(), canFinishLateStart(), core__serviceInstances_finishLateStart(), core__serviceInstances_rejectStartAttempt();
  if inv(s) && canFinishLateStart(s, attemptId) {
    var after := finishLateStart(s, attemptId);
    forall i | 0 <= i < |s.services.classes|
      ensures after.services.classes[i].registered == s.services.classes[i].registered
        && after.services.classes[i].live == s.services.classes[i].live
    {}
    PluginServiceFrameKeepsLocalRules(s, after);
    PluginRetirementChildRulesMatchImportedInvariants(s);
    core__serviceInstances_finishLateStart_ensures(s.services, attemptId);
    PluginRetirementChildRulesMatchImportedInvariants(after);
  }
}

lemma finishClassObserver_ensures(s: PluginServices, attemptId: int, ok: bool)
  ensures (inv(s) ==> canFinishClassObserver(s, attemptId, ok) ==> alwaysLiveClassOwnerUnique(finishClassObserver(s, attemptId, ok)))
  ensures (inv(s) ==> canFinishClassObserver(s, attemptId, ok) ==> alwaysServiceOwnerEpochExists(finishClassObserver(s, attemptId, ok)))
  ensures (inv(s) ==> canFinishClassObserver(s, attemptId, ok) ==> alwaysChildLifecyclesValid(finishClassObserver(s, attemptId, ok)))
  ensures (inv(s) ==> canFinishClassObserver(s, attemptId, ok) ==> alwaysRetirementsFollowTypePlan(finishClassObserver(s, attemptId, ok)))
  ensures (inv(s) ==> canFinishClassObserver(s, attemptId, ok) ==> alwaysNoOrphanInstance(finishClassObserver(s, attemptId, ok)))
  ensures (inv(s) ==> canFinishClassObserver(s, attemptId, ok) ==> alwaysRetiredUndeclaredTypeIsUnknown(finishClassObserver(s, attemptId, ok)))
  ensures (inv(s) ==> canFinishClassObserver(s, attemptId, ok) ==> alwaysStopObservationsFollowSlots(finishClassObserver(s, attemptId, ok)))
  ensures (inv(s) ==> canFinishClassObserver(s, attemptId, ok) ==> alwaysRetiredEpochHasNoResources(finishClassObserver(s, attemptId, ok)))
  ensures (inv(s) ==> canFinishClassObserver(s, attemptId, ok) ==> alwaysSealedOwnedClassesStable(finishClassObserver(s, attemptId, ok)))
{
  hide *;
  reveal inv(), core__serviceInstances_inv(), core__serviceInstances_serviceTypeEntry();
  reveal finishClassObserver(), canFinishClassObserver(), core__serviceInstances_finishObserver();
  if inv(s) && canFinishClassObserver(s, attemptId, ok) {
    var after := finishClassObserver(s, attemptId, ok);
    forall i | 0 <= i < |s.services.classes|
      ensures after.services.classes[i].registered == s.services.classes[i].registered
        && after.services.classes[i].live == s.services.classes[i].live
    {}
    PluginServiceFrameKeepsLocalRules(s, after);
    PluginRetirementChildRulesMatchImportedInvariants(s);
    core__serviceInstances_finishObserver_ensures(s.services, attemptId, ok);
    PluginRetirementChildRulesMatchImportedInvariants(after);
  }
}

lemma finishNextObserver_ensures(s: PluginServices, ok: bool)
  ensures (inv(s) ==> canFinishNextObserver(s, ok) ==> alwaysLiveClassOwnerUnique(finishNextObserver(s, ok)))
  ensures (inv(s) ==> canFinishNextObserver(s, ok) ==> alwaysServiceOwnerEpochExists(finishNextObserver(s, ok)))
  ensures (inv(s) ==> canFinishNextObserver(s, ok) ==> alwaysChildLifecyclesValid(finishNextObserver(s, ok)))
  ensures (inv(s) ==> canFinishNextObserver(s, ok) ==> alwaysRetirementsFollowTypePlan(finishNextObserver(s, ok)))
  ensures (inv(s) ==> canFinishNextObserver(s, ok) ==> alwaysNoOrphanInstance(finishNextObserver(s, ok)))
  ensures (inv(s) ==> canFinishNextObserver(s, ok) ==> alwaysRetiredUndeclaredTypeIsUnknown(finishNextObserver(s, ok)))
  ensures (inv(s) ==> canFinishNextObserver(s, ok) ==> alwaysStopObservationsFollowSlots(finishNextObserver(s, ok)))
  ensures (inv(s) ==> canFinishNextObserver(s, ok) ==> alwaysRetiredEpochHasNoResources(finishNextObserver(s, ok)))
  ensures (inv(s) ==> canFinishNextObserver(s, ok) ==> alwaysSealedOwnedClassesStable(finishNextObserver(s, ok)))
{
  hide *;
  reveal inv(), finishNextObserver(), canFinishNextObserver(), core__serviceInstances_finishNextObserver(), core__serviceInstances_canFinishNextObserver();
  reveal finishClassObserver(), canFinishClassObserver();
  if inv(s) && canFinishNextObserver(s, ok) {
    var attemptId := core__serviceInstances_nextObservableAttempt(s.services);
    finishClassObserver_ensures(s, attemptId, ok);
  }
}

lemma finishNextLateStart_ensures(s: PluginServices)
  ensures (inv(s) ==> canFinishNextLateStart(s) ==> alwaysLiveClassOwnerUnique(finishNextLateStart(s)))
  ensures (inv(s) ==> canFinishNextLateStart(s) ==> alwaysServiceOwnerEpochExists(finishNextLateStart(s)))
  ensures (inv(s) ==> canFinishNextLateStart(s) ==> alwaysChildLifecyclesValid(finishNextLateStart(s)))
  ensures (inv(s) ==> canFinishNextLateStart(s) ==> alwaysRetirementsFollowTypePlan(finishNextLateStart(s)))
  ensures (inv(s) ==> canFinishNextLateStart(s) ==> alwaysNoOrphanInstance(finishNextLateStart(s)))
  ensures (inv(s) ==> canFinishNextLateStart(s) ==> alwaysRetiredUndeclaredTypeIsUnknown(finishNextLateStart(s)))
  ensures (inv(s) ==> canFinishNextLateStart(s) ==> alwaysStopObservationsFollowSlots(finishNextLateStart(s)))
  ensures (inv(s) ==> canFinishNextLateStart(s) ==> alwaysRetiredEpochHasNoResources(finishNextLateStart(s)))
  ensures (inv(s) ==> canFinishNextLateStart(s) ==> alwaysSealedOwnedClassesStable(finishNextLateStart(s)))
{
  hide *;
  reveal inv(), finishNextLateStart(), canFinishNextLateStart(), core__serviceInstances_finishNextLateStart(), core__serviceInstances_canFinishNextLateStart();
  reveal finishLateStart(), canFinishLateStart();
  if inv(s) && canFinishNextLateStart(s) {
    var attemptId := core__serviceInstances_nextRetiredAttempt(s.services);
    finishLateStart_ensures(s, attemptId);
  }
}

lemma sealRequests_ensures(s: PluginServices)
  ensures (inv(s) ==> canSealRequests(s) ==> alwaysLiveClassOwnerUnique(sealRequests(s)))
  ensures (inv(s) ==> canSealRequests(s) ==> alwaysServiceOwnerEpochExists(sealRequests(s)))
  ensures (inv(s) ==> canSealRequests(s) ==> alwaysChildLifecyclesValid(sealRequests(s)))
  ensures (inv(s) ==> canSealRequests(s) ==> alwaysRetirementsFollowTypePlan(sealRequests(s)))
  ensures (inv(s) ==> canSealRequests(s) ==> alwaysNoOrphanInstance(sealRequests(s)))
  ensures (inv(s) ==> canSealRequests(s) ==> alwaysRetiredUndeclaredTypeIsUnknown(sealRequests(s)))
  ensures (inv(s) ==> canSealRequests(s) ==> alwaysStopObservationsFollowSlots(sealRequests(s)))
  ensures (inv(s) ==> canSealRequests(s) ==> alwaysRetiredEpochHasNoResources(sealRequests(s)))
  ensures (inv(s) ==> canSealRequests(s) ==> alwaysSealedOwnedClassesStable(sealRequests(s)))
{
  hide *;
  reveal inv(), sealRequests(), alwaysLiveClassOwnerUnique(), alwaysServiceOwnerEpochExists();
  reveal alwaysChildLifecyclesValid(), alwaysRetirementsFollowTypePlan(), alwaysNoOrphanInstance();
  reveal alwaysRetiredUndeclaredTypeIsUnknown(), alwaysStopObservationsFollowSlots();
  reveal alwaysRetiredEpochHasNoResources(), retirementSettled(), retirement(), alwaysSealedOwnedClassesStable();
}

lemma PluginTypeLookupAfterPut(s: core__serviceInstances_ServiceInstances, entry: core__serviceInstances_TypeEntry,
    query: string)
  ensures core__serviceInstances_serviceTypeEntry(core__serviceInstances_putType(entry, s), query) ==
    (if query == entry.serviceType then entry else core__serviceInstances_serviceTypeEntry(s, query))
{
  hide *;
  reveal core__serviceInstances_putType(), core__serviceInstances_serviceTypeEntry(), ProofLib.Filter();
  var prior := s.typeEntries;
  var after := core__serviceInstances_putType(entry, s).typeEntries;
  var selects := (row: core__serviceInstances_TypeEntry) => row.serviceType == query;
  if exists row :: row in prior && row.serviceType == entry.serviceType {
    if query == entry.serviceType {
      var existing :| existing in prior && existing.serviceType == query;
      var i :| 0 <= i < |prior| && prior[i] == existing;
      assert after[i] == entry && entry in after;
      ProofLib.FilterMember(selects, after, entry);
      var matches := ProofLib.Filter(selects, after);
      assert |matches| > 0;
      ProofLib.FilterMember(selects, after, matches[0]);
      var j :| 0 <= j < |after| && after[j] == matches[0];
      assert after[j] == entry;
    } else {
      var retained := (priorRow: core__serviceInstances_TypeEntry, nextRow: core__serviceInstances_TypeEntry) =>
        !selects(priorRow) || priorRow == nextRow;
      forall i | 0 <= i < |prior|
        ensures selects(prior[i]) == selects(after[i]) && retained(prior[i], after[i])
      {}
      ProofLib.FilterPointwise(selects, selects, retained, prior, after);
      var matches := ProofLib.Filter(selects, prior);
      if |matches| > 0 {
        ProofLib.FilterMember(selects, prior, matches[0]);
      }
    }
  } else {
    assert after == prior + [entry];
    if query == entry.serviceType {
      ProofLib.FilterNone(selects, prior);
    }
    ProofLib.FilterAppend(selects, prior, entry);
  }
}

lemma PluginPublishedServiceHasDeclaration(s: core__serviceInstances_ServiceInstances, serviceType: string)
  requires core__serviceInstances_alwaysPublicationIdentitiesValid(s)
  requires core__serviceInstances_alwaysClassAndObjectIdentities(s)
  requires core__serviceInstances_alwaysDeclarationsMatch(s)
  requires core__serviceInstances_firstLive(s, serviceType) != 0
  ensures exists d :: d in s.declarations && d.serviceType == serviceType
{
  hide *;
  reveal core__serviceInstances_firstLive(), core__serviceInstances_publishedInstances(), core__serviceInstances_absentPublication;
  reveal core__serviceInstances_alwaysPublicationIdentitiesValid(), core__serviceInstances_alwaysClassAndObjectIdentities();
  reveal core__serviceInstances_alwaysDeclarationsMatch(), core__serviceInstances_serviceClass(), ProofLib.Filter();
  var selectType := (p: core__serviceInstances_ServicePublication) => p.serviceType == serviceType;
  var published := ProofLib.Filter(selectType, s.published);
  assert |published| > 0;
  var publication := published[0];
  ProofLib.FilterMember(selectType, s.published, publication);
  var instance := core__serviceInstances_firstLive(s, serviceType);
  assert instance in publication.instances;
  var c :| c in s.classes && c.serviceType == serviceType && c.live == instance;
  assert c.registered;
  var byId := (owner: core__serviceInstances_ServiceClassEntry) => owner.id == c.id;
  var owners := ProofLib.Filter(byId, s.classes);
  ProofLib.FilterMember(byId, s.classes, c);
  assert |owners| == 1 && owners[0] == c;
  assert core__serviceInstances_serviceClass(s, c.id) == c;
  var declaration :| declaration in s.declarations && declaration.classId == c.id;
  assert declaration.serviceType == c.serviceType;
}

lemma PluginAcquireSettlementPreservesTypeStatus(s: PluginServices, callId: int)
  requires inv(s)
  ensures alwaysRetiredUndeclaredTypeIsUnknown(settleEnsure(s, callId))
{
  hide *;
  reveal inv(), settleEnsure(), core__serviceInstances_settleAcquire(), core__serviceInstances_putType();
  reveal alwaysChildLifecyclesValid(), alwaysRetiredUndeclaredTypeIsUnknown();
  var before := s.services;
  var after := settleEnsure(s, callId);
  var serviceType := core__serviceInstances_acquireCall(before, callId).serviceType;
  var previous := core__serviceInstances_serviceTypeEntry(before, serviceType);
  var result := core__serviceInstances_firstLive(before, serviceType);
  var haveDeclarations := exists d :: d in before.declarations && d.serviceType == serviceType;
  var updated := previous.(serviceType := serviceType,
    status := if result != 0 then core__serviceInstances_TypeStatus.TypeRegistered
      else if haveDeclarations then core__serviceInstances_TypeStatus.TypeFailed
      else core__serviceInstances_TypeStatus.TypeUnknown,
    promiseId := if result == 0 && previous.handlerId != 0 then 0 else previous.promiseId,
    handlerId := 0);
  var callsSettled := after.services.(typeEntries := before.typeEntries);
  assert after.services == core__serviceInstances_putType(updated, callsSettled);
  if result != 0 {
    PluginPublishedServiceHasDeclaration(before, serviceType);
  }
  forall r | r in after.retirements
    ensures forall g | g in r.groups ::
      (!after.services.stopped && (g.phase.GroupFinished? || g.phase.GroupFailed?)
        && !(exists d :: d in after.services.declarations && d.serviceType == g.serviceType)
        && !(exists other :: (other in after.retirements &&
          (exists pending :: pending in other.groups && pending.serviceType == g.serviceType && pending.phase.GroupWaiting?))))
      ==> core__serviceInstances_serviceTypeEntry(after.services, g.serviceType).status.TypeUnknown?
  {
    forall g | g in r.groups && !after.services.stopped && (g.phase.GroupFinished? || g.phase.GroupFailed?)
        && !(exists d :: d in after.services.declarations && d.serviceType == g.serviceType)
        && !(exists other :: (other in after.retirements &&
          (exists pending :: pending in other.groups && pending.serviceType == g.serviceType && pending.phase.GroupWaiting?)))
      ensures core__serviceInstances_serviceTypeEntry(after.services, g.serviceType).status.TypeUnknown?
    {
      reveal core__serviceInstances_serviceTypeEntry();
      PluginTypeLookupAfterPut(callsSettled, updated, g.serviceType);
    }
  }
}

lemma PluginStopObjectUpdateRetainsSettledSlot(before: core__serviceInstances_ServiceInstances,
    after: core__serviceInstances_ServiceInstances, slot: InstanceSlot)
  requires |before.objects| <= |after.objects| <= |before.objects| + 1
  requires forall i | 0 <= i < |before.objects| ::
    before.objects[i].id == after.objects[i].id
      && ((before.objects[i].stopPhase.StopSucceeded? || before.objects[i].stopPhase.StopFailed?) ==> before.objects[i].stopPhase == after.objects[i].stopPhase)
  requires stopSlotSettled(slot, before)
  ensures stopSlotSettled(slot, after)
{
  hide *;
  reveal stopSlotSettled(), core__serviceInstances_serviceObject(), core__serviceInstances_noObject, ProofLib.Filter();
  if !slot.observed.MissingStopSlot? {
    var byId := (o: core__serviceInstances_ServiceObject) => o.id == slot.instanceId;
    var stillSettled := (prior: core__serviceInstances_ServiceObject, next: core__serviceInstances_ServiceObject) =>
      (prior.stopPhase.StopSucceeded? || prior.stopPhase.StopFailed?) ==> prior.stopPhase == next.stopPhase;
    var prefix := after.objects[..|before.objects|];
    var prior := ProofLib.Filter(byId, before.objects);
    var newPrefix := ProofLib.Filter(byId, prefix);
    ProofLib.FilterPointwise(byId, byId, stillSettled, before.objects, prefix);
    assert |prior| > 0 && |newPrefix| > 0;
    ProofLib.FilterMember(byId, before.objects, prior[0]);
    assert stillSettled(prior[0], newPrefix[0]);
    if |before.objects| < |after.objects| {
      var appended := after.objects[|before.objects|];
      assert after.objects == prefix + [appended];
      ProofLib.FilterAppend(byId, prefix, appended);
    } else {
      assert after.objects == prefix;
    }
    var newMatches := ProofLib.Filter(byId, after.objects);
    assert |newMatches| > 0 && newMatches[0] == newPrefix[0];
  }
}

lemma PluginStopObjectUpdateGroupObservations(g: RetirementGroup, services: core__serviceInstances_ServiceInstances)
  ensures allStopObservationsValid(g, services) <==>
    (forall i | 0 <= i < |g.observedStops| :: validStopObservation(g, i, g.observedStops[i], services))
{
  hide *;
  reveal allStopObservationsValid(), validateNextStop(), uncheckedSequence;
  var validAt := (i: int, slot: InstanceSlot) => validStopObservation(g, i, slot, services);
  var validate := (check: SequenceValidation, slot: InstanceSlot) => validateNextStop(check, g, slot, services);
  PluginRetirementIndexedValidation(validate, validAt, uncheckedSequence, g.observedStops);
}

lemma PluginStopObjectUpdatePreservesReceipts(s: PluginServices, after: PluginServices)
  requires inv(s) && after == s.(services := s.services.(objects := after.services.objects))
  requires |s.services.objects| == |after.services.objects|
  requires forall i | 0 <= i < |s.services.objects| ::
    s.services.objects[i].id == after.services.objects[i].id
      && s.services.objects[i].stopCalls == after.services.objects[i].stopCalls
      && (!s.services.objects[i].stopPhase.StopWaiting? ==> s.services.objects[i].stopPhase == after.services.objects[i].stopPhase)
  ensures alwaysStopObservationsFollowSlots(after) && alwaysRetiredEpochHasNoResources(after)
  ensures alwaysLiveClassOwnerUnique(after) && alwaysServiceOwnerEpochExists(after)
  ensures alwaysRetirementsFollowTypePlan(after) && alwaysNoOrphanInstance(after)
  ensures alwaysRetiredUndeclaredTypeIsUnknown(after) && alwaysSealedOwnedClassesStable(after)
{
  hide *;
  reveal inv();
  reveal alwaysLiveClassOwnerUnique(), alwaysServiceOwnerEpochExists(), alwaysRetirementsFollowTypePlan();
  reveal alwaysNoOrphanInstance(), alwaysRetiredUndeclaredTypeIsUnknown(), core__serviceInstances_serviceTypeEntry();
  reveal alwaysSealedOwnedClassesStable();
  forall obj | obj in after.services.objects
    ensures obj.stopCalls > 0
      || (exists c | c in after.services.classes :: c.live == obj.id && c.registered)
      || (exists r | r in after.retirements :: exists g | g in r.groups ::
        missingStopObservedFor(g, obj.id)
          || (core__pluginRegistry_epochOwnsResources(after.plugins, r.epochId) && obj.id in g.instances))
  {
    var i :| 0 <= i < |after.services.objects| && after.services.objects[i] == obj;
    assert s.services.objects[i] in s.services.objects;
  }
  PluginMappedObjectsRetainStopReceipts(s, after);
}

lemma PluginMappedObjectsRetainStopReceipts(s: PluginServices, after: PluginServices)
  requires alwaysStopObservationsFollowSlots(s) && alwaysRetiredEpochHasNoResources(s)
  requires after.retirements == s.retirements && after.plugins == s.plugins
  requires |s.services.objects| <= |after.services.objects| <= |s.services.objects| + 1
  requires forall i | 0 <= i < |s.services.objects| ::
    s.services.objects[i].id == after.services.objects[i].id
      && ((s.services.objects[i].stopPhase.StopSucceeded? || s.services.objects[i].stopPhase.StopFailed?)
        ==> s.services.objects[i].stopPhase == after.services.objects[i].stopPhase)
  ensures alwaysStopObservationsFollowSlots(after) && alwaysRetiredEpochHasNoResources(after)
{
  hide *;
  reveal alwaysStopObservationsFollowSlots(), alwaysRetiredEpochHasNoResources(), retirementSettled(), retirement();
  forall r | r in after.retirements
    ensures forall g | g in r.groups :: allStopObservationsValid(g, after.services)
    ensures forall g | g in r.groups && !core__pluginRegistry_epochOwnsResources(after.plugins, r.epochId) ::
      (forall slot | slot in g.observedStops :: stopSlotSettled(slot, after.services))
  {
    forall g | g in r.groups
      ensures allStopObservationsValid(g, after.services)
      ensures !core__pluginRegistry_epochOwnsResources(after.plugins, r.epochId) ==>
        (forall slot | slot in g.observedStops :: stopSlotSettled(slot, after.services))
    {
      PluginStopObjectUpdateGroupObservations(g, s.services);
      forall i | 0 <= i < |g.observedStops|
        ensures validStopObservation(g, i, g.observedStops[i], after.services)
      {
        reveal validStopObservation();
        var slot := g.observedStops[i];
        assert validStopObservation(g, i, slot, s.services);
        if i < g.instanceCursor {
          PluginStopObjectUpdateRetainsSettledSlot(s.services, after.services, slot);
        }
      }
      PluginStopObjectUpdateGroupObservations(g, after.services);
      if !core__pluginRegistry_epochOwnsResources(after.plugins, r.epochId) {
        forall slot | slot in g.observedStops ensures stopSlotSettled(slot, after.services) {
          PluginStopObjectUpdateRetainsSettledSlot(s.services, after.services, slot);
        }
      }
    }
  }
}

lemma PluginSettlingStopChangesOnlyWaitingObject(s: core__serviceInstances_ServiceInstances,
    instanceId: int, ok: bool, errorId: string)
  requires core__serviceInstances_alwaysClassAndObjectIdentities(s)
  requires core__serviceInstances_canSettleObjectStop(s, instanceId, ok, errorId)
  ensures var after := core__serviceInstances_settleObjectStop(s, instanceId, ok, errorId);
    forall i | 0 <= i < |s.objects| && !s.objects[i].stopPhase.StopWaiting? ::
      after.objects[i].stopPhase == s.objects[i].stopPhase
{
  hide *;
  reveal core__serviceInstances_settleObjectStop(), core__serviceInstances_canSettleObjectStop();
  reveal core__serviceInstances_alwaysClassAndObjectIdentities(), core__serviceInstances_serviceObject(), ProofLib.Filter();
  var byId := (o: core__serviceInstances_ServiceObject) => o.id == instanceId;
  var matches := ProofLib.Filter(byId, s.objects);
  forall i | 0 <= i < |s.objects| && !s.objects[i].stopPhase.StopWaiting?
    ensures core__serviceInstances_settleObjectStop(s, instanceId, ok, errorId).objects[i].stopPhase == s.objects[i].stopPhase
  {
    var original := s.objects[i];
    if original.id == instanceId {
      assert original in s.objects;
      ProofLib.FilterMember(byId, s.objects, original);
      assert |matches| == 1 && matches[0] == original;
      assert core__serviceInstances_serviceObject(s, instanceId) == original;
      assert false;
    }
  }
}

lemma invokeClassStop_ensures(s: PluginServices, instanceId: int)
  ensures (inv(s) ==> canInvokeClassStop(s, instanceId) ==> alwaysLiveClassOwnerUnique(invokeClassStop(s, instanceId)))
  ensures (inv(s) ==> canInvokeClassStop(s, instanceId) ==> alwaysServiceOwnerEpochExists(invokeClassStop(s, instanceId)))
  ensures (inv(s) ==> canInvokeClassStop(s, instanceId) ==> alwaysChildLifecyclesValid(invokeClassStop(s, instanceId)))
  ensures (inv(s) ==> canInvokeClassStop(s, instanceId) ==> alwaysRetirementsFollowTypePlan(invokeClassStop(s, instanceId)))
  ensures (inv(s) ==> canInvokeClassStop(s, instanceId) ==> alwaysNoOrphanInstance(invokeClassStop(s, instanceId)))
  ensures (inv(s) ==> canInvokeClassStop(s, instanceId) ==> alwaysRetiredUndeclaredTypeIsUnknown(invokeClassStop(s, instanceId)))
  ensures (inv(s) ==> canInvokeClassStop(s, instanceId) ==> alwaysStopObservationsFollowSlots(invokeClassStop(s, instanceId)))
  ensures (inv(s) ==> canInvokeClassStop(s, instanceId) ==> alwaysRetiredEpochHasNoResources(invokeClassStop(s, instanceId)))
  ensures (inv(s) ==> canInvokeClassStop(s, instanceId) ==> alwaysSealedOwnedClassesStable(invokeClassStop(s, instanceId)))
{
  hide *;
  reveal inv(), canInvokeClassStop(), invokeClassStop(), core__serviceInstances_invokeObjectStop();
  reveal core__serviceInstances_inv();
  if inv(s) && canInvokeClassStop(s, instanceId) {
    var after := invokeClassStop(s, instanceId);
    forall i | 0 <= i < |s.services.objects|
      ensures s.services.objects[i].id == after.services.objects[i].id
        && s.services.objects[i].stopCalls == after.services.objects[i].stopCalls
        && (!s.services.objects[i].stopPhase.StopWaiting? ==> s.services.objects[i].stopPhase == after.services.objects[i].stopPhase)
    {}
    PluginStopObjectUpdatePreservesReceipts(s, after);
    PluginRetirementChildRulesMatchImportedInvariants(s);
    core__serviceInstances_invokeObjectStop_ensures(s.services, instanceId);
    PluginRetirementChildRulesMatchImportedInvariants(after);
  }
}

lemma finishClassStop_ensures(s: PluginServices, instanceId: int, ok: bool, errorId: string)
  ensures (inv(s) ==> canFinishClassStop(s, instanceId, ok, errorId) ==> alwaysLiveClassOwnerUnique(finishClassStop(s, instanceId, ok, errorId)))
  ensures (inv(s) ==> canFinishClassStop(s, instanceId, ok, errorId) ==> alwaysServiceOwnerEpochExists(finishClassStop(s, instanceId, ok, errorId)))
  ensures (inv(s) ==> canFinishClassStop(s, instanceId, ok, errorId) ==> alwaysChildLifecyclesValid(finishClassStop(s, instanceId, ok, errorId)))
  ensures (inv(s) ==> canFinishClassStop(s, instanceId, ok, errorId) ==> alwaysRetirementsFollowTypePlan(finishClassStop(s, instanceId, ok, errorId)))
  ensures (inv(s) ==> canFinishClassStop(s, instanceId, ok, errorId) ==> alwaysNoOrphanInstance(finishClassStop(s, instanceId, ok, errorId)))
  ensures (inv(s) ==> canFinishClassStop(s, instanceId, ok, errorId) ==> alwaysRetiredUndeclaredTypeIsUnknown(finishClassStop(s, instanceId, ok, errorId)))
  ensures (inv(s) ==> canFinishClassStop(s, instanceId, ok, errorId) ==> alwaysStopObservationsFollowSlots(finishClassStop(s, instanceId, ok, errorId)))
  ensures (inv(s) ==> canFinishClassStop(s, instanceId, ok, errorId) ==> alwaysRetiredEpochHasNoResources(finishClassStop(s, instanceId, ok, errorId)))
  ensures (inv(s) ==> canFinishClassStop(s, instanceId, ok, errorId) ==> alwaysSealedOwnedClassesStable(finishClassStop(s, instanceId, ok, errorId)))
{
  hide *;
  reveal inv(), canFinishClassStop(), finishClassStop(), core__serviceInstances_settleObjectStop();
  if inv(s) && canFinishClassStop(s, instanceId, ok, errorId) {
    var after := finishClassStop(s, instanceId, ok, errorId);
    reveal alwaysChildLifecyclesValid();
    PluginSettlingStopChangesOnlyWaitingObject(s.services, instanceId, ok, errorId);
    forall i | 0 <= i < |s.services.objects|
      ensures s.services.objects[i].id == after.services.objects[i].id
        && s.services.objects[i].stopCalls == after.services.objects[i].stopCalls
        && (!s.services.objects[i].stopPhase.StopWaiting? ==> s.services.objects[i].stopPhase == after.services.objects[i].stopPhase)
    {}
    PluginStopObjectUpdatePreservesReceipts(s, after);
    PluginRetirementChildRulesMatchImportedInvariants(s);
    core__serviceInstances_settleObjectStop_ensures(s.services, instanceId, ok, errorId);
    PluginRetirementChildRulesMatchImportedInvariants(after);
  }
}

lemma PluginAdmissionFoldProjection(rows: seq<core__serviceInstances_ServiceDeclaration>, serviceType: string,
    hasFallback: bool, s: core__serviceInstances_ServiceInstances)
  ensures var visit := (acc: core__serviceInstances_ServiceInstances, d: core__serviceInstances_ServiceDeclaration) =>
    if d.serviceType == serviceType && core__serviceInstances_serviceClass(acc, d.classId).live == 0
      && core__serviceInstances_serviceClass(acc, d.classId).pending == 0
      && !(core__serviceInstances_serviceClass(acc, d.classId).failed && hasFallback)
    then core__serviceInstances_beginClassAttempt(d.classId, acc) else acc;
    var after := Std.Collections.Seq.FoldLeft(visit, s, rows);
    after.(classes := s.classes, attempts := s.attempts, nextAttempt := s.nextAttempt) == s
      && |after.classes| == |s.classes|
      && (forall i | 0 <= i < |s.classes| ::
        after.classes[i].registered == s.classes[i].registered && after.classes[i].live == s.classes[i].live)
      && ((forall d | d in rows :: d.serviceType != serviceType) ==> after == s)
{
  hide *;
  reveal core__serviceInstances_beginClassAttempt(), Std.Collections.Seq.FoldLeft();
  var visit := (acc: core__serviceInstances_ServiceInstances, d: core__serviceInstances_ServiceDeclaration) =>
    if d.serviceType == serviceType && core__serviceInstances_serviceClass(acc, d.classId).live == 0
      && core__serviceInstances_serviceClass(acc, d.classId).pending == 0
      && !(core__serviceInstances_serviceClass(acc, d.classId).failed && hasFallback)
    then core__serviceInstances_beginClassAttempt(d.classId, acc) else acc;
  var result := Std.Collections.Seq.FoldLeft(visit, s, rows);
  if |rows| == 0 {
    assert result == s;
  } else {
    var prior := rows[..|rows|-1];
    var last := rows[|rows|-1];
    PluginAdmissionFoldProjection(prior, serviceType, hasFallback, s);
    ProofLib.FoldLeftAppend(visit, s, prior, last);
    var middle := Std.Collections.Seq.FoldLeft(visit, s, prior);
    var after := visit(middle, last);
    assert rows == prior + [last] && result == after;
    forall i | 0 <= i < |s.classes|
      ensures after.classes[i].registered == s.classes[i].registered && after.classes[i].live == s.classes[i].live
    {}
    if forall d | d in rows :: d.serviceType != serviceType {
      assert forall d | d in prior :: d.serviceType != serviceType;
      assert last in rows && last.serviceType != serviceType;
      assert middle == s && after == middle;
    }
  }
}

lemma PluginAdmissionProjection(s: core__serviceInstances_ServiceInstances, callId: int, serviceType: string)
  ensures var admitted := core__serviceInstances_admittedAcquire(callId, serviceType, s);
    admitted.objects == s.objects && admitted.declarations == s.declarations && admitted.stopped == s.stopped
      && |admitted.classes| == |s.classes|
      && (forall i | 0 <= i < |s.classes| ::
        admitted.classes[i].registered == s.classes[i].registered && admitted.classes[i].live == s.classes[i].live)
      && (forall query | query != serviceType || !(exists d :: d in s.declarations && d.serviceType == query) ::
        core__serviceInstances_serviceTypeEntry(admitted, query).status == core__serviceInstances_serviceTypeEntry(s, query).status)
{
  hide *;
  reveal core__serviceInstances_admittedAcquire(), core__serviceInstances_ensureClasses();
  reveal core__serviceInstances_setTypeStatus(), core__serviceInstances_publishTypeAggregate(), core__serviceInstances_putType();
  reveal core__serviceInstances_serviceTypeEntry();
  var absent := s.stopped || s.initialization.InitializationFailed?
    || (s.initialization.InitializationReady? && !(exists c :: c in s.classes && c.registered && c.serviceType == serviceType));
  var noStart := absent || s.initialization.InitializationPending?;
  var ensured := if noStart then s else core__serviceInstances_ensureClasses(serviceType, s);
  var starting := if ensured.nextAttempt != s.nextAttempt && core__serviceInstances_firstLive(s, serviceType) == 0
    then core__serviceInstances_setTypeStatus(serviceType, core__serviceInstances_TypeStatus.TypeRegistering, ensured) else ensured;
  var published := if noStart then starting else core__serviceInstances_publishTypeAggregate(callId, serviceType, starting);
  var after := core__serviceInstances_admittedAcquire(callId, serviceType, s);
  assert after.(calls := published.calls) == published;
  if !noStart {
    PluginAdmissionFoldProjection(s.declarations, serviceType, |core__serviceInstances_classInstances(s, serviceType)| != 0, s);
  }
  forall query | query != serviceType || !(exists d :: d in s.declarations && d.serviceType == query)
    ensures core__serviceInstances_serviceTypeEntry(after, query).status == core__serviceInstances_serviceTypeEntry(s, query).status
  {
    if ensured.nextAttempt != s.nextAttempt && core__serviceInstances_firstLive(s, serviceType) == 0 {
      assert query != serviceType;
      var previous := core__serviceInstances_serviceTypeEntry(ensured, serviceType);
      PluginTypeLookupAfterPut(ensured, previous.(serviceType := serviceType, status := core__serviceInstances_TypeStatus.TypeRegistering), query);
    }
    if !noStart {
      var previous := core__serviceInstances_serviceTypeEntry(starting, serviceType);
      var aggregateView := published.(typeEntries := starting.typeEntries);
      var entry := previous.(serviceType := serviceType, latestAggregate := callId);
      assert published == core__serviceInstances_putType(entry, aggregateView);
      PluginTypeLookupAfterPut(aggregateView, entry, query);
    }
  }
}

lemma PluginAdmissionPreservesLocalRules(s: PluginServices, forCall: core__serviceInstances_ServiceInstances,
    after: PluginServices, callId: int, serviceType: string)
  requires inv(s) && forCall == s.services.(calls := forCall.calls)
  requires after == s.(services := core__serviceInstances_admittedAcquire(callId, serviceType, forCall))
  ensures alwaysLiveClassOwnerUnique(after) && alwaysServiceOwnerEpochExists(after)
  ensures alwaysRetirementsFollowTypePlan(after) && alwaysNoOrphanInstance(after)
  ensures alwaysRetiredUndeclaredTypeIsUnknown(after) && alwaysSealedOwnedClassesStable(after)
  ensures alwaysStopObservationsFollowSlots(after) && alwaysRetiredEpochHasNoResources(after)
{
  hide *;
  reveal core__serviceInstances_serviceTypeEntry();
  PluginAdmissionProjection(forCall, callId, serviceType);
  forall r | r in s.retirements
    ensures forall g | g in r.groups && !(exists d :: d in s.services.declarations && d.serviceType == g.serviceType) ::
      core__serviceInstances_serviceTypeEntry(s.services, g.serviceType).status == core__serviceInstances_serviceTypeEntry(after.services, g.serviceType).status
  {
    forall g | g in r.groups && !(exists d :: d in s.services.declarations && d.serviceType == g.serviceType)
      ensures core__serviceInstances_serviceTypeEntry(s.services, g.serviceType).status == core__serviceInstances_serviceTypeEntry(after.services, g.serviceType).status
    {}
  }
  PluginServiceFrameKeepsLocalRules(s, after);
}

lemma ensureServices_ensures(s: PluginServices, callId: int, serviceType: string)
  ensures (inv(s) ==> canEnsureServices(s, callId, serviceType) ==> alwaysLiveClassOwnerUnique(ensureServices(s, callId, serviceType)))
  ensures (inv(s) ==> canEnsureServices(s, callId, serviceType) ==> alwaysServiceOwnerEpochExists(ensureServices(s, callId, serviceType)))
  ensures (inv(s) ==> canEnsureServices(s, callId, serviceType) ==> alwaysChildLifecyclesValid(ensureServices(s, callId, serviceType)))
  ensures (inv(s) ==> canEnsureServices(s, callId, serviceType) ==> alwaysRetirementsFollowTypePlan(ensureServices(s, callId, serviceType)))
  ensures (inv(s) ==> canEnsureServices(s, callId, serviceType) ==> alwaysNoOrphanInstance(ensureServices(s, callId, serviceType)))
  ensures (inv(s) ==> canEnsureServices(s, callId, serviceType) ==> alwaysRetiredUndeclaredTypeIsUnknown(ensureServices(s, callId, serviceType)))
  ensures (inv(s) ==> canEnsureServices(s, callId, serviceType) ==> alwaysStopObservationsFollowSlots(ensureServices(s, callId, serviceType)))
  ensures (inv(s) ==> canEnsureServices(s, callId, serviceType) ==> alwaysRetiredEpochHasNoResources(ensureServices(s, callId, serviceType)))
  ensures (inv(s) ==> canEnsureServices(s, callId, serviceType) ==> alwaysSealedOwnedClassesStable(ensureServices(s, callId, serviceType)))
{
  hide *;
  reveal inv(), canEnsureServices(), ensureServices(), core__serviceInstances_acquireServices(), core__serviceInstances_inv();
  if inv(s) && canEnsureServices(s, callId, serviceType) {
    var after := ensureServices(s, callId, serviceType);
    PluginAdmissionPreservesLocalRules(s, s.services, after, callId, serviceType);
    PluginRetirementChildRulesMatchImportedInvariants(s);
    core__serviceInstances_acquireServices_ensures(s.services, callId, serviceType);
    PluginRetirementChildRulesMatchImportedInvariants(after);
  }
}

lemma resumeEnsure_ensures(s: PluginServices, callId: int)
  ensures (inv(s) ==> canResumeEnsure(s, callId) ==> alwaysLiveClassOwnerUnique(resumeEnsure(s, callId)))
  ensures (inv(s) ==> canResumeEnsure(s, callId) ==> alwaysServiceOwnerEpochExists(resumeEnsure(s, callId)))
  ensures (inv(s) ==> canResumeEnsure(s, callId) ==> alwaysChildLifecyclesValid(resumeEnsure(s, callId)))
  ensures (inv(s) ==> canResumeEnsure(s, callId) ==> alwaysRetirementsFollowTypePlan(resumeEnsure(s, callId)))
  ensures (inv(s) ==> canResumeEnsure(s, callId) ==> alwaysNoOrphanInstance(resumeEnsure(s, callId)))
  ensures (inv(s) ==> canResumeEnsure(s, callId) ==> alwaysRetiredUndeclaredTypeIsUnknown(resumeEnsure(s, callId)))
  ensures (inv(s) ==> canResumeEnsure(s, callId) ==> alwaysStopObservationsFollowSlots(resumeEnsure(s, callId)))
  ensures (inv(s) ==> canResumeEnsure(s, callId) ==> alwaysRetiredEpochHasNoResources(resumeEnsure(s, callId)))
  ensures (inv(s) ==> canResumeEnsure(s, callId) ==> alwaysSealedOwnedClassesStable(resumeEnsure(s, callId)))
{
  hide *;
  reveal inv(), canResumeEnsure(), resumeEnsure(), core__serviceInstances_resumeAcquire(), core__serviceInstances_inv();
  if inv(s) && canResumeEnsure(s, callId) {
    var after := resumeEnsure(s, callId);
    var captured := core__serviceInstances_acquireCall(s.services, callId);
    reveal ProofLib.Filter();
    var forCall := s.services.(calls := ProofLib.Filter((other: core__serviceInstances_Acquire) => (other.id != callId), s.services.calls));
    assert after.services == core__serviceInstances_admittedAcquire(callId, captured.serviceType, forCall);
    PluginAdmissionPreservesLocalRules(s, forCall, after, callId, captured.serviceType);
    PluginRetirementChildRulesMatchImportedInvariants(s);
    core__serviceInstances_resumeAcquire_ensures(s.services, callId);
    PluginRetirementChildRulesMatchImportedInvariants(after);
  }
}

lemma PluginReturningStartKeepsStopReceipts(s: PluginServices, attemptId: int, instanceId: int)
  requires inv(s) && canFinishClassStart(s, attemptId, instanceId)
  ensures alwaysStopObservationsFollowSlots(finishClassStart(s, attemptId, instanceId))
  ensures alwaysRetiredEpochHasNoResources(finishClassStart(s, attemptId, instanceId))
{
  hide *;
  reveal inv(), finishClassStart(), core__serviceInstances_returnInstance(), core__serviceInstances_stopObjectOnce();
  reveal core__serviceInstances_setTypeStatus(), core__serviceInstances_putType(), core__serviceInstances_replacePublication();
  var after := finishClassStart(s, attemptId, instanceId);
  forall i | 0 <= i < |s.services.objects|
    ensures s.services.objects[i].id == after.services.objects[i].id
      && ((s.services.objects[i].stopPhase.StopSucceeded? || s.services.objects[i].stopPhase.StopFailed?)
        ==> s.services.objects[i].stopPhase == after.services.objects[i].stopPhase)
  {}
  PluginMappedObjectsRetainStopReceipts(s, after);
}

lemma PluginReturningStartObjectRows(s: PluginServices, attemptId: int, instanceId: int)
  requires inv(s) && canFinishClassStart(s, attemptId, instanceId)
  ensures var before := s.services;
    var owner := core__serviceInstances_serviceClass(before, core__serviceInstances_serviceAttempt(before, attemptId).classId);
    var late := before.stopped || !owner.registered;
    forall obj | obj in finishClassStart(s, attemptId, instanceId).services.objects ::
      (obj.id != instanceId ==> obj in before.objects) && (obj.id == instanceId && late ==> obj.stopCalls > 0)
{
  hide *;
  reveal inv(), alwaysChildLifecyclesValid(), finishClassStart();
  reveal core__serviceInstances_returnInstance(), core__serviceInstances_stopObjectOnce(), core__serviceInstances_setTypeStatus();
  reveal core__serviceInstances_putType(), core__serviceInstances_replacePublication(), core__serviceInstances_alwaysObjectStopOnce();
  var before := s.services;
  var owner := core__serviceInstances_serviceClass(before, core__serviceInstances_serviceAttempt(before, attemptId).classId);
  var late := before.stopped || !owner.registered;
  var after := finishClassStart(s, attemptId, instanceId).services;
  forall obj | obj in after.objects
    ensures obj.id != instanceId ==> obj in before.objects
    ensures obj.id == instanceId && late ==> obj.stopCalls > 0
  {
    var i :| 0 <= i < |after.objects| && after.objects[i] == obj;
    if obj.id != instanceId {
      assert i < |before.objects| && obj == before.objects[i] && obj in before.objects;
    } else if late && i < |before.objects| {
      var prior := before.objects[i];
      assert prior in before.objects && prior.id == instanceId;
    }
  }
}

lemma PluginReturningStartClassOwners(s: PluginServices, attemptId: int, instanceId: int)
  requires inv(s) && canFinishClassStart(s, attemptId, instanceId)
  ensures var before := s.services;
    var owner := core__serviceInstances_serviceClass(before, core__serviceInstances_serviceAttempt(before, attemptId).classId);
    var late := before.stopped || !owner.registered;
    var after := finishClassStart(s, attemptId, instanceId).services;
    (!late ==> (exists c :: c in after.classes && c.live == instanceId && c.registered))
      && (forall c | c in before.classes && c.live != 0 && c.registered :: c in after.classes)
{
  hide *;
  reveal inv(), alwaysChildLifecyclesValid(), canFinishClassStart(), finishClassStart();
  reveal core__serviceInstances_returnInstance(), core__serviceInstances_canReturnInstance(), core__serviceInstances_stopObjectOnce();
  reveal core__serviceInstances_setTypeStatus(), core__serviceInstances_putType(), core__serviceInstances_replacePublication();
  reveal core__serviceInstances_serviceAttempt(), core__serviceInstances_serviceClass(), core__serviceInstances_noClass;
  reveal core__serviceInstances_alwaysPendingAttemptsOwned(), core__serviceInstances_alwaysClassAndObjectIdentities(), ProofLib.Filter();
  var before := s.services;
  var after := finishClassStart(s, attemptId, instanceId).services;
  var invoking := core__serviceInstances_serviceAttempt(before, attemptId);
  var owner := core__serviceInstances_serviceClass(before, invoking.classId);
  if !before.stopped && owner.registered {
    reveal core__serviceInstances_noAttempt;
    var byAttempt := (a: core__serviceInstances_ServiceAttempt) => a.id == attemptId;
    var matches := ProofLib.Filter(byAttempt, before.attempts);
    assert invoking.id > 0 && invoking.phase.StartInvoking?;
    assert |matches| > 0 && invoking == matches[0];
    ProofLib.FilterMember(byAttempt, before.attempts, invoking);
    assert invoking in before.attempts && owner.live == 0;
    var byClass := (c: core__serviceInstances_ServiceClassEntry) => c.id == invoking.classId;
    ProofLib.FilterMember(byClass, before.classes, owner);
    assert owner in before.classes && owner.id == invoking.classId;
    var i :| 0 <= i < |before.classes| && before.classes[i] == owner;
    assert after.classes[i] in after.classes && after.classes[i].registered && after.classes[i].live == instanceId;
    forall cls | cls in before.classes && cls.live != 0 && cls.registered
      ensures cls in after.classes
    {
      if cls.id == invoking.classId {
        ProofLib.FilterMember(byClass, before.classes, cls);
        var matches := ProofLib.Filter(byClass, before.classes);
        assert |matches| == 1 && matches[0] == owner && matches[0] == cls;
        assert false;
      }
      var j :| 0 <= j < |before.classes| && before.classes[j] == cls;
      assert after.classes[j] == cls && cls in after.classes;
    }
  } else {
    assert after.classes == before.classes;
  }
}

lemma PluginReturningStartKeepsObjectOwners(s: PluginServices, attemptId: int, instanceId: int)
  requires inv(s) && canFinishClassStart(s, attemptId, instanceId)
  ensures alwaysNoOrphanInstance(finishClassStart(s, attemptId, instanceId))
{
  hide *;
  reveal inv(), alwaysNoOrphanInstance(), alwaysChildLifecyclesValid(), finishClassStart();
  reveal core__serviceInstances_alwaysClassAndObjectIdentities();
  PluginReturningStartObjectRows(s, attemptId, instanceId);
  PluginReturningStartClassOwners(s, attemptId, instanceId);
  var before := s.services;
  var after := finishClassStart(s, attemptId, instanceId);
  forall obj | obj in after.services.objects
    ensures obj.stopCalls > 0
      || (exists c | c in after.services.classes :: c.live == obj.id && c.registered)
      || (exists r | r in after.retirements :: (exists g | g in r.groups ::
        missingStopObservedFor(g, obj.id)
          || (core__pluginRegistry_epochOwnsResources(after.plugins, r.epochId) && obj.id in g.instances)))
  {
    if obj.id != instanceId {
      assert obj in before.objects && obj.id != 0;
    }
  }
}

lemma PluginReturningStartKeepsTypeStatus(s: PluginServices, attemptId: int, instanceId: int)
  requires inv(s) && canFinishClassStart(s, attemptId, instanceId)
  ensures alwaysRetiredUndeclaredTypeIsUnknown(finishClassStart(s, attemptId, instanceId))
{
  hide *;
  reveal inv(), alwaysChildLifecyclesValid(), alwaysRetiredUndeclaredTypeIsUnknown();
  reveal finishClassStart(), core__serviceInstances_returnInstance(), core__serviceInstances_stopObjectOnce();
  reveal core__serviceInstances_setTypeStatus(), core__serviceInstances_putType(), core__serviceInstances_replacePublication();
  reveal core__serviceInstances_serviceTypeEntry();
  var before := s.services;
  var after := finishClassStart(s, attemptId, instanceId);
  var ownerId := core__serviceInstances_serviceAttempt(before, attemptId).classId;
  var owner := core__serviceInstances_serviceClass(before, ownerId);
  if !before.stopped && owner.registered {
    reveal core__serviceInstances_alwaysDeclarationsMatch(), core__serviceInstances_serviceClass(), core__serviceInstances_noClass;
    reveal ProofLib.Filter();
    var byId := (c: core__serviceInstances_ServiceClassEntry) => c.id == ownerId;
    ProofLib.FilterMember(byId, before.classes, owner);
    assert owner in before.classes && owner.id == ownerId;
    var declaration :| declaration in before.declarations && declaration.classId == ownerId;
    assert declaration.serviceType == owner.serviceType;
    var beforeStatus := after.services.(typeEntries := before.typeEntries);
    var entry := core__serviceInstances_serviceTypeEntry(before, owner.serviceType).(
      serviceType := owner.serviceType, status := core__serviceInstances_TypeStatus.TypeRegistered);
    assert after.services == core__serviceInstances_putType(entry, beforeStatus);
    forall r | r in after.retirements
      ensures forall g | g in r.groups && !(exists d :: d in before.declarations && d.serviceType == g.serviceType) ::
        core__serviceInstances_serviceTypeEntry(after.services, g.serviceType).status ==
        core__serviceInstances_serviceTypeEntry(before, g.serviceType).status
    {
      forall g | g in r.groups && !(exists d :: d in before.declarations && d.serviceType == g.serviceType)
        ensures core__serviceInstances_serviceTypeEntry(after.services, g.serviceType).status ==
          core__serviceInstances_serviceTypeEntry(before, g.serviceType).status
      {
        assert g.serviceType != owner.serviceType;
        PluginTypeLookupAfterPut(beforeStatus, entry, g.serviceType);
      }
    }
  }
}

lemma finishClassStart_ensures(s: PluginServices, attemptId: int, instanceId: int)
  ensures (inv(s) ==> canFinishClassStart(s, attemptId, instanceId) ==> alwaysLiveClassOwnerUnique(finishClassStart(s, attemptId, instanceId)))
  ensures (inv(s) ==> canFinishClassStart(s, attemptId, instanceId) ==> alwaysServiceOwnerEpochExists(finishClassStart(s, attemptId, instanceId)))
  ensures (inv(s) ==> canFinishClassStart(s, attemptId, instanceId) ==> alwaysChildLifecyclesValid(finishClassStart(s, attemptId, instanceId)))
  ensures (inv(s) ==> canFinishClassStart(s, attemptId, instanceId) ==> alwaysRetirementsFollowTypePlan(finishClassStart(s, attemptId, instanceId)))
  ensures (inv(s) ==> canFinishClassStart(s, attemptId, instanceId) ==> alwaysNoOrphanInstance(finishClassStart(s, attemptId, instanceId)))
  ensures (inv(s) ==> canFinishClassStart(s, attemptId, instanceId) ==> alwaysRetiredUndeclaredTypeIsUnknown(finishClassStart(s, attemptId, instanceId)))
  ensures (inv(s) ==> canFinishClassStart(s, attemptId, instanceId) ==> alwaysStopObservationsFollowSlots(finishClassStart(s, attemptId, instanceId)))
  ensures (inv(s) ==> canFinishClassStart(s, attemptId, instanceId) ==> alwaysRetiredEpochHasNoResources(finishClassStart(s, attemptId, instanceId)))
  ensures (inv(s) ==> canFinishClassStart(s, attemptId, instanceId) ==> alwaysSealedOwnedClassesStable(finishClassStart(s, attemptId, instanceId)))
{
  hide *;
  reveal inv(), canFinishClassStart(), finishClassStart(), core__serviceInstances_inv();
  reveal alwaysLiveClassOwnerUnique(), alwaysServiceOwnerEpochExists(), alwaysRetirementsFollowTypePlan(), alwaysSealedOwnedClassesStable();
  if inv(s) && canFinishClassStart(s, attemptId, instanceId) {
    var after := finishClassStart(s, attemptId, instanceId);
    PluginRetirementChildRulesMatchImportedInvariants(s);
    core__serviceInstances_returnInstance_ensures(s.services, attemptId, instanceId);
    PluginRetirementChildRulesMatchImportedInvariants(after);
    PluginReturningStartKeepsTypeStatus(s, attemptId, instanceId);
    PluginReturningStartKeepsObjectOwners(s, attemptId, instanceId);
    PluginReturningStartKeepsStopReceipts(s, attemptId, instanceId);
  }
}

lemma resolveNextStart_ensures(s: PluginServices, ok: bool, instanceId: int, errorId: string)
  ensures (inv(s) ==> canResolveNextStart(s, ok, instanceId, errorId) ==> alwaysLiveClassOwnerUnique(resolveNextStart(s, ok, instanceId, errorId)))
  ensures (inv(s) ==> canResolveNextStart(s, ok, instanceId, errorId) ==> alwaysServiceOwnerEpochExists(resolveNextStart(s, ok, instanceId, errorId)))
  ensures (inv(s) ==> canResolveNextStart(s, ok, instanceId, errorId) ==> alwaysChildLifecyclesValid(resolveNextStart(s, ok, instanceId, errorId)))
  ensures (inv(s) ==> canResolveNextStart(s, ok, instanceId, errorId) ==> alwaysRetirementsFollowTypePlan(resolveNextStart(s, ok, instanceId, errorId)))
  ensures (inv(s) ==> canResolveNextStart(s, ok, instanceId, errorId) ==> alwaysNoOrphanInstance(resolveNextStart(s, ok, instanceId, errorId)))
  ensures (inv(s) ==> canResolveNextStart(s, ok, instanceId, errorId) ==> alwaysRetiredUndeclaredTypeIsUnknown(resolveNextStart(s, ok, instanceId, errorId)))
  ensures (inv(s) ==> canResolveNextStart(s, ok, instanceId, errorId) ==> alwaysStopObservationsFollowSlots(resolveNextStart(s, ok, instanceId, errorId)))
  ensures (inv(s) ==> canResolveNextStart(s, ok, instanceId, errorId) ==> alwaysRetiredEpochHasNoResources(resolveNextStart(s, ok, instanceId, errorId)))
  ensures (inv(s) ==> canResolveNextStart(s, ok, instanceId, errorId) ==> alwaysSealedOwnedClassesStable(resolveNextStart(s, ok, instanceId, errorId)))
{
  hide *;
  reveal inv(), canResolveNextStart(), resolveNextStart(), core__serviceInstances_resolveNextStart(), core__serviceInstances_canResolveNextStart();
  reveal finishClassStart(), canFinishClassStart(), failClassStart(), canFailClassStart();
  if inv(s) && canResolveNextStart(s, ok, instanceId, errorId) {
    var attemptId := core__serviceInstances_nextInvokingAttempt(s.services);
    if ok {
      finishClassStart_ensures(s, attemptId, instanceId);
    } else {
      failClassStart_ensures(s, attemptId, errorId);
    }
  }
}
