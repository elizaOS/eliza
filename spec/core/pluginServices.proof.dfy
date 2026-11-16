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
  hide *;
  reveal inv(), withdrawNextType(), alwaysLiveClassOwnerUnique(), alwaysSealedOwnedClassesStable();
  if inv(s) && canWithdrawNextType(s, epochId) {
    PluginRetirementWithdrawalPreservesTypePlan(s, epochId);
    PluginWithdrawalPreservesServiceReceiptIdentity(s, epochId);
    PluginWithdrawalKeepsEarlierTypeStatus(s, epochId);
    PluginWithdrawalKeepsStopReceipts(s, epochId);
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
    ensures o.stopCalls > 0 || ((exists c :: c in after.services.classes && c.live == o.id && c.registered)
        && (exists p :: p in after.services.published && o.id in p.instances)) ||
      (exists r :: r in after.retirements &&
        (exists g :: g in r.groups &&
          (missingStopObservedFor(g, o.id) ||
            (core__pluginRegistry_epochOwnsResources(after.plugins, r.epochId) && o.id in g.instances))))
  {
    if o.stopCalls <= 0 && !((exists c :: c in s.services.classes && c.live == o.id && c.registered)
          && (exists p :: p in s.services.published && o.id in p.instances)) {
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
    PluginReceiptsRetainDeclaredType(s, after);
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
    after.services.classes[i].id == s.services.classes[i].id
      && after.services.classes[i].serviceType == s.services.classes[i].serviceType
      && after.services.classes[i].registered == s.services.classes[i].registered
      && after.services.classes[i].live == s.services.classes[i].live
  requires after.services.declarations == s.services.declarations && after.services.stopped == s.services.stopped
  requires after.services.published == s.services.published
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
  PluginReceiptsRetainDeclaredType(s, after);
  forall obj | obj in after.services.objects
    ensures obj.stopCalls > 0
      || ((exists c | c in after.services.classes :: c.live == obj.id && c.registered)
        && (exists p :: p in after.services.published && obj.id in p.instances))
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
  PluginRegistrationAddsReceiptWithClassType(s, epochId, classId, serviceType, hasStopHook);
  PluginServiceFrameRetainsStopReceipts(s, after);
  PluginOwnedClassRegistrationRetainsUniqueLiveOwners(s, after, OwnedClass(epochId, classId, serviceType, hasStopHook));
  forall o | o in after.services.objects && o.stopCalls <= 0
    ensures ((exists c :: c in after.services.classes && c.live == o.id && c.registered)
        && (exists p :: p in after.services.published && o.id in p.instances)) ||
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
        (g.phase.GroupStoppingInstances? || g.phase.GroupStoppingClasses? || g.phase.GroupFinished? || g.phase.GroupFailed?) &&
        !(exists d :: d in after.services.declarations && d.serviceType == g.serviceType) &&
        !(exists other :: (other in after.retirements && (exists pending :: (pending in other.groups &&
          pending.serviceType == g.serviceType && pending.phase.GroupWaiting?)))) ::
          core__serviceInstances_serviceTypeEntry(after.services, g.serviceType).status.TypeUnknown?
    {
      forall g | g in r.groups &&
        (g.phase.GroupStoppingInstances? || g.phase.GroupStoppingClasses? || g.phase.GroupFinished? || g.phase.GroupFailed?) &&
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
      ensures after.services.classes[i].id == s.services.classes[i].id
        && after.services.classes[i].serviceType == s.services.classes[i].serviceType
        && after.services.classes[i].registered == s.services.classes[i].registered
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
      ensures after.services.classes[i].id == s.services.classes[i].id
        && after.services.classes[i].serviceType == s.services.classes[i].serviceType
        && after.services.classes[i].registered == s.services.classes[i].registered
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
      ensures after.services.classes[i].id == s.services.classes[i].id
        && after.services.classes[i].serviceType == s.services.classes[i].serviceType
        && after.services.classes[i].registered == s.services.classes[i].registered
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
      (!after.services.stopped && (g.phase.GroupStoppingInstances? || g.phase.GroupStoppingClasses? || g.phase.GroupFinished? || g.phase.GroupFailed?)
        && !(exists d :: d in after.services.declarations && d.serviceType == g.serviceType)
        && !(exists other :: (other in after.retirements &&
          (exists pending :: pending in other.groups && pending.serviceType == g.serviceType && pending.phase.GroupWaiting?))))
      ==> core__serviceInstances_serviceTypeEntry(after.services, g.serviceType).status.TypeUnknown?
  {
    forall g | g in r.groups && !after.services.stopped && (g.phase.GroupStoppingInstances? || g.phase.GroupStoppingClasses? || g.phase.GroupFinished? || g.phase.GroupFailed?)
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
  PluginReceiptsRetainDeclaredType(s, after);
  forall obj | obj in after.services.objects
    ensures obj.stopCalls > 0
      || ((exists c | c in after.services.classes :: c.live == obj.id && c.registered)
        && (exists p :: p in after.services.published && obj.id in p.instances))
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
        after.classes[i].id == s.classes[i].id && after.classes[i].serviceType == s.classes[i].serviceType
          && after.classes[i].registered == s.classes[i].registered && after.classes[i].live == s.classes[i].live)
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
      ensures after.classes[i].id == s.classes[i].id && after.classes[i].serviceType == s.classes[i].serviceType
          && after.classes[i].registered == s.classes[i].registered && after.classes[i].live == s.classes[i].live
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
      && admitted.published == s.published
      && |admitted.classes| == |s.classes|
      && (forall i | 0 <= i < |s.classes| ::
        admitted.classes[i].id == s.classes[i].id && admitted.classes[i].serviceType == s.classes[i].serviceType
          && admitted.classes[i].registered == s.classes[i].registered && admitted.classes[i].live == s.classes[i].live)
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

lemma PluginReceiptLookupPreservesClassType(before: core__serviceInstances_ServiceInstances,
    after: core__serviceInstances_ServiceInstances, classId: int)
  requires 0 < classId && core__serviceInstances_serviceClass(before, classId).id == classId
  requires |before.classes| <= |after.classes| <= |before.classes| + 1
  requires forall i | 0 <= i < |before.classes| ::
    before.classes[i].id == after.classes[i].id && before.classes[i].serviceType == after.classes[i].serviceType
  ensures core__serviceInstances_serviceClass(after, classId).id == classId &&
    core__serviceInstances_serviceClass(after, classId).serviceType == core__serviceInstances_serviceClass(before, classId).serviceType
{
  hide *;
  reveal core__serviceInstances_serviceClass(), core__serviceInstances_noClass, ProofLib.Filter();
  var byId := (cls: core__serviceInstances_ServiceClassEntry) => cls.id == classId;
  var typeIdentity := (prior: core__serviceInstances_ServiceClassEntry, current: core__serviceInstances_ServiceClassEntry) =>
    prior.id == current.id && prior.serviceType == current.serviceType;
  var prefix := after.classes[..|before.classes|];
  var oldMatches := ProofLib.Filter(byId, before.classes);
  var newPrefix := ProofLib.Filter(byId, prefix);
  ProofLib.FilterPointwise(byId, byId, typeIdentity, before.classes, prefix);
  assert |oldMatches| > 0 && |newPrefix| > 0;
  if |before.classes| < |after.classes| {
    var added := after.classes[|before.classes|];
    assert after.classes == prefix + [added];
    ProofLib.FilterAppend(byId, prefix, added);
  } else {
    assert after.classes == prefix;
  }
  var matches := ProofLib.Filter(byId, after.classes);
  assert |matches| > 0 && matches[0] == newPrefix[0];
}

lemma PluginReceiptsRetainDeclaredType(s: PluginServices, after: PluginServices)
  requires alwaysServiceOwnerEpochExists(s)
  requires s.ownership == after.ownership && s.plugins == after.plugins
  requires |s.services.classes| <= |after.services.classes| <= |s.services.classes| + 1
  requires forall i | 0 <= i < |s.services.classes| ::
    s.services.classes[i].id == after.services.classes[i].id && s.services.classes[i].serviceType == after.services.classes[i].serviceType
  ensures alwaysServiceOwnerEpochExists(after)
{
  hide *;
  reveal alwaysServiceOwnerEpochExists();
  forall owner | owner in after.ownership
    ensures owner.classId > 0 && core__pluginRegistry_epoch(after.plugins, owner.epochId).id == owner.epochId
    ensures core__serviceInstances_serviceClass(after.services, owner.classId).id == owner.classId &&
      core__serviceInstances_serviceClass(after.services, owner.classId).serviceType == owner.serviceType
  {
    PluginReceiptLookupPreservesClassType(s.services, after.services, owner.classId);
  }
}

lemma PluginRegistrationAddsReceiptWithClassType(s: PluginServices, epochId: int, classId: int,
    serviceType: string, hasStopHook: bool)
  requires alwaysServiceOwnerEpochExists(s) && canRegisterOwnedClass(s, epochId, classId, serviceType, hasStopHook)
  requires core__pluginRegistry_epoch(s.plugins, epochId).id == epochId
  ensures alwaysServiceOwnerEpochExists(registerOwnedClass(s, epochId, classId, serviceType, hasStopHook))
{
  hide *;
  reveal alwaysServiceOwnerEpochExists(), canRegisterOwnedClass(), registerOwnedClass();
  reveal core__serviceInstances_canRegisterClass(), core__serviceInstances_registerClass(), core__serviceInstances_registerType();
  reveal core__serviceInstances_putType(), core__serviceInstances_serviceClass(), core__serviceInstances_noClass, ProofLib.Filter();
  var after := registerOwnedClass(s, epochId, classId, serviceType, hasStopHook);
  var ownerView := after.(ownership := s.ownership);
  forall i | 0 <= i < |s.services.classes|
    ensures after.services.classes[i].id == s.services.classes[i].id &&
      after.services.classes[i].serviceType == s.services.classes[i].serviceType
  {}
  PluginReceiptsRetainDeclaredType(s, ownerView);
  var byId := (cls: core__serviceInstances_ServiceClassEntry) => cls.id == classId;
  var known := core__serviceInstances_serviceClass(s.services, classId);
  if known.id == 0 {
    var added := after.services.classes[|s.services.classes|];
    assert after.services.classes == s.services.classes + [added] && added.id == classId && added.serviceType == serviceType;
    var prior := ProofLib.Filter(byId, s.services.classes);
    if |prior| > 0 {
      ProofLib.FilterMember(byId, s.services.classes, prior[0]);
      assert false;
    }
    ProofLib.FilterAppend(byId, s.services.classes, added);
  } else {
    var prior := ProofLib.Filter(byId, s.services.classes);
    assert |prior| > 0;
    ProofLib.FilterMember(byId, s.services.classes, prior[0]);
    assert known.id == classId && known.serviceType == serviceType;
    PluginReceiptLookupPreservesClassType(s.services, after.services, classId);
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
  requires alwaysChildLifecyclesValid(finishClassStart(s, attemptId, instanceId))
  ensures alwaysNoOrphanInstance(finishClassStart(s, attemptId, instanceId))
{
  hide *;
  reveal inv(), alwaysNoOrphanInstance(), alwaysChildLifecyclesValid(), finishClassStart();
  reveal core__serviceInstances_alwaysClassAndObjectIdentities();
  PluginReturningStartObjectRows(s, attemptId, instanceId);
  PluginReturnedStartPublicationKeepsRegisteredObjects(s, attemptId, instanceId);
  PluginReturningStartClassOwners(s, attemptId, instanceId);
  var before := s.services;
  var after := finishClassStart(s, attemptId, instanceId);
  forall obj | obj in after.services.objects
    ensures obj.stopCalls > 0
      || ((exists c | c in after.services.classes :: c.live == obj.id && c.registered)
        && (exists p :: p in after.services.published && obj.id in p.instances))
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
    PluginReturningStartRetainsReceiptTypes(s, attemptId, instanceId);
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

lemma PluginReturningStartRetainsReceiptTypes(s: PluginServices, attemptId: int, instanceId: int)
  requires alwaysServiceOwnerEpochExists(s)
  ensures alwaysServiceOwnerEpochExists(finishClassStart(s, attemptId, instanceId))
{
  hide *;
  reveal finishClassStart(), core__serviceInstances_returnInstance(), core__serviceInstances_stopObjectOnce();
  reveal core__serviceInstances_setTypeStatus(), core__serviceInstances_putType(), core__serviceInstances_replacePublication();
  var after := finishClassStart(s, attemptId, instanceId);
  forall i | 0 <= i < |s.services.classes|
    ensures after.services.classes[i].id == s.services.classes[i].id &&
      after.services.classes[i].serviceType == s.services.classes[i].serviceType
  {}
  PluginReceiptsRetainDeclaredType(s, after);
}

lemma PluginRetirementTypeHasOneGroup(r: ServiceRetirement, cursor: int, other: int)
  requires retirementGroupsFollowPlan(r)
  requires 0 <= cursor < |r.groups| && 0 <= other < |r.groups|
  requires r.groups[cursor].serviceType == r.groups[other].serviceType
  ensures cursor == other
{
  hide *;
  reveal retirementGroupsFollowPlan(), retirementGroupMatchesPosition(), ProofLib.Filter();
  if cursor != other {
    PluginRetirementPlanPosition(r, cursor);
    PluginRetirementPlanPosition(r, other);
    var serviceType := r.groups[cursor].serviceType;
    assert r.plan[cursor] == serviceType && r.plan[other] == serviceType;
    assert serviceType in r.plan;
    var matches := (value: string) => value == serviceType;
    ProofLib.FilterTwo(matches, r.plan, cursor, other);
    assert |ProofLib.Filter(matches, r.plan)| == 1;
  }
}

lemma PluginClassGroupEditProjection(s: PluginServices, beforePlacement: PluginServices, next: RetirementGroup, epochId: int)
  requires alwaysRetirementsFollowTypePlan(s) && beforePlacement.retirements == s.retirements
  requires currentGroup(s, epochId).phase.GroupStoppingClasses?
  requires next == currentGroup(s, epochId).(classCursor := next.classCursor, hook := next.hook)
  ensures var after := putCurrentGroup(next, epochId, beforePlacement);
    |after.retirements| == |s.retirements| &&
      (forall i | 0 <= i < |s.retirements| ::
        var prior := s.retirements[i];
        var updated := after.retirements[i];
        updated.(groups := prior.groups) == prior && |updated.groups| == |prior.groups|
          && (forall j | 0 <= j < |prior.groups| ::
            updated.groups[j].(classCursor := prior.groups[j].classCursor, hook := prior.groups[j].hook) == prior.groups[j]))
{
  hide *;
  reveal alwaysRetirementsFollowTypePlan(), retirementGroupsFollowPlan(), putCurrentGroup(), currentGroup(), noGroup;
  var after := putCurrentGroup(next, epochId, beforePlacement);
  forall i | 0 <= i < |s.retirements|
    ensures var prior := s.retirements[i];
      var updated := after.retirements[i];
      updated.(groups := prior.groups) == prior && |updated.groups| == |prior.groups|
        && (forall j | 0 <= j < |prior.groups| ::
          updated.groups[j].(classCursor := prior.groups[j].classCursor, hook := prior.groups[j].hook) == prior.groups[j])
  {
    var prior := s.retirements[i];
    var updated := after.retirements[i];
    if prior.epochId == epochId {
      assert prior in s.retirements;
      PluginRetirementPlanLookup(s, prior);
      assert 0 <= prior.cursor < |prior.groups|;
      var current := prior.groups[prior.cursor];
      assert currentGroup(s, epochId) == current;
      forall j | 0 <= j < |prior.groups|
        ensures updated.groups[j].(classCursor := prior.groups[j].classCursor, hook := prior.groups[j].hook) == prior.groups[j]
      {
        if prior.groups[j].serviceType == next.serviceType {
          PluginRetirementTypeHasOneGroup(prior, prior.cursor, j);
          assert prior.groups[j] == current;
        }
      }
    }
  }
}

lemma PluginClassGroupEditKeepsCurrentPlan(before: ServiceRetirement, after: ServiceRetirement)
  requires retirementGroupsFollowPlan(before)
  requires after.(groups := before.groups) == before && |after.groups| == |before.groups|
  requires forall i | 0 <= i < |before.groups| ::
    after.groups[i].(classCursor := before.groups[i].classCursor, hook := before.groups[i].hook) == before.groups[i]
  ensures retirementGroupsFollowPlan(after)
{
  hide *;
  reveal retirementGroupsFollowPlan(), retirementGroupMatchesPosition(), groupFinishedOrSkipped();
  PluginRetirementWithdrawalHasPositionEvidence(before);
  forall i | 0 <= i < |after.groups|
    ensures retirementGroupMatchesPosition(after, i, after.groups[i])
  {
    assert retirementGroupMatchesPosition(before, i, before.groups[i]);
    assert before.groups[i].phase == after.groups[i].phase && before.groups[i].serviceType == after.groups[i].serviceType;
  }
  PluginRetirementWithdrawalHasPositionEvidence(after);
}

lemma PluginClassGroupEditPreservesPlans(s: PluginServices, beforePlacement: PluginServices, next: RetirementGroup, epochId: int)
  requires alwaysRetirementsFollowTypePlan(s)
  requires beforePlacement.retirements == s.retirements && beforePlacement.plugins == s.plugins
  requires currentGroup(s, epochId).phase.GroupStoppingClasses?
  requires next == currentGroup(s, epochId).(classCursor := next.classCursor, hook := next.hook)
  ensures alwaysRetirementsFollowTypePlan(putCurrentGroup(next, epochId, beforePlacement))
{
  hide *;
  reveal alwaysRetirementsFollowTypePlan(), putCurrentGroup(), ProofLib.Filter();
  var after := putCurrentGroup(next, epochId, beforePlacement);
  PluginClassGroupEditProjection(s, beforePlacement, next, epochId);
  forall row | row in after.retirements
    ensures row.epochId > 0 && core__pluginRegistry_epoch(after.plugins, row.epochId).id == row.epochId
    ensures core__pluginRegistry_epochRetiring(after.plugins, row.epochId) ||
      !core__pluginRegistry_epochOwnsResources(after.plugins, row.epochId)
    ensures |ProofLib.Filter((other: ServiceRetirement) => other.epochId == row.epochId, after.retirements)| == 1
    ensures retirementGroupsFollowPlan(row)
  {
    var i :| 0 <= i < |after.retirements| && after.retirements[i] == row;
    var prior := s.retirements[i];
    assert prior in s.retirements && prior.epochId == row.epochId;
    var byEpoch := (other: ServiceRetirement) => other.epochId == row.epochId;
    ProofLib.FilterLengthPointwise(byEpoch, byEpoch, s.retirements, after.retirements);
    PluginClassGroupEditKeepsCurrentPlan(prior, row);
  }
}

lemma invokeClassHook_ensures(s: PluginServices, epochId: int)
  ensures (inv(s) ==> canInvokeClassHook(s, epochId) ==> alwaysLiveClassOwnerUnique(invokeClassHook(s, epochId)))
  ensures (inv(s) ==> canInvokeClassHook(s, epochId) ==> alwaysServiceOwnerEpochExists(invokeClassHook(s, epochId)))
  ensures (inv(s) ==> canInvokeClassHook(s, epochId) ==> alwaysChildLifecyclesValid(invokeClassHook(s, epochId)))
  ensures (inv(s) ==> canInvokeClassHook(s, epochId) ==> alwaysRetirementsFollowTypePlan(invokeClassHook(s, epochId)))
  ensures (inv(s) ==> canInvokeClassHook(s, epochId) ==> alwaysNoOrphanInstance(invokeClassHook(s, epochId)))
  ensures (inv(s) ==> canInvokeClassHook(s, epochId) ==> alwaysRetiredUndeclaredTypeIsUnknown(invokeClassHook(s, epochId)))
  ensures (inv(s) ==> canInvokeClassHook(s, epochId) ==> alwaysStopObservationsFollowSlots(invokeClassHook(s, epochId)))
  ensures (inv(s) ==> canInvokeClassHook(s, epochId) ==> alwaysRetiredEpochHasNoResources(invokeClassHook(s, epochId)))
  ensures (inv(s) ==> canInvokeClassHook(s, epochId) ==> alwaysSealedOwnedClassesStable(invokeClassHook(s, epochId)))
{
  hide *;
  reveal inv(), canInvokeClassHook(), invokeClassHook(), clearRetiredClassFailure(), ProofLib.Filter();
  reveal alwaysLiveClassOwnerUnique(), alwaysSealedOwnedClassesStable(), putCurrentGroup();
  if inv(s) && canInvokeClassHook(s, epochId) {
    var beforePlacement := clearRetiredClassFailure(currentClassHook(s, epochId).id, s);
    var next := currentGroup(s, epochId).(hook := ClassHookPhase.HookPending);
    PluginClassGroupEditPreservesPlans(s, beforePlacement, next, epochId);
    var after := invokeClassHook(s, epochId);
    forall i | 0 <= i < |s.services.classes|
      ensures after.services.classes[i].id == s.services.classes[i].id
        && after.services.classes[i].serviceType == s.services.classes[i].serviceType
    {}
    PluginReceiptsRetainDeclaredType(s, after);
    PluginClassGroupEditProjection(s, beforePlacement, next, epochId);
    forall i | 0 <= i < |s.services.classes|
      ensures after.services.classes[i].(failed := s.services.classes[i].failed) == s.services.classes[i]
    {}
    PluginRetirementChildRulesMatchImportedInvariants(s);
    PluginClassFailureFlagsKeepClassRules(s.services, after.services);
    PluginRetirementChildRulesMatchImportedInvariants(after);
    PluginClassOnlyEditRetainsCapturedStops(s, after);
    PluginClassOnlyEditKeepsTypeStatus(s, after);
    PluginClassOnlyEditKeepsObjectCustody(s, after);
  }
}

lemma finishClassSlot_ensures(s: PluginServices, epochId: int)
  ensures (inv(s) ==> canFinishClassSlot(s, epochId) ==> alwaysLiveClassOwnerUnique(finishClassSlot(s, epochId)))
  ensures (inv(s) ==> canFinishClassSlot(s, epochId) ==> alwaysServiceOwnerEpochExists(finishClassSlot(s, epochId)))
  ensures (inv(s) ==> canFinishClassSlot(s, epochId) ==> alwaysChildLifecyclesValid(finishClassSlot(s, epochId)))
  ensures (inv(s) ==> canFinishClassSlot(s, epochId) ==> alwaysRetirementsFollowTypePlan(finishClassSlot(s, epochId)))
  ensures (inv(s) ==> canFinishClassSlot(s, epochId) ==> alwaysNoOrphanInstance(finishClassSlot(s, epochId)))
  ensures (inv(s) ==> canFinishClassSlot(s, epochId) ==> alwaysRetiredUndeclaredTypeIsUnknown(finishClassSlot(s, epochId)))
  ensures (inv(s) ==> canFinishClassSlot(s, epochId) ==> alwaysStopObservationsFollowSlots(finishClassSlot(s, epochId)))
  ensures (inv(s) ==> canFinishClassSlot(s, epochId) ==> alwaysRetiredEpochHasNoResources(finishClassSlot(s, epochId)))
  ensures (inv(s) ==> canFinishClassSlot(s, epochId) ==> alwaysSealedOwnedClassesStable(finishClassSlot(s, epochId)))
{
  hide *;
  reveal inv(), canFinishClassSlot(), finishClassSlot(), clearRetiredClassFailure(), ProofLib.Filter();
  reveal alwaysLiveClassOwnerUnique(), alwaysSealedOwnedClassesStable(), putCurrentGroup();
  if inv(s) && canFinishClassSlot(s, epochId) {
    var current := currentGroup(s, epochId);
    var cls := currentClassHook(s, epochId);
    var cleared := if current.hook.HookReady? then clearRetiredClassFailure(cls.id, s) else s;
    var retained := (o: OwnedClass) => ((o.classId != cls.id) || (o.epochId != epochId));
    var prior := cleared.(liveOwners := ProofLib.Filter(retained, cleared.liveOwners));
    var next := current.(classCursor := current.classCursor + 1, hook := ClassHookPhase.HookReady);
    assert finishClassSlot(s, epochId) == putCurrentGroup(next, epochId, prior);
    PluginClassGroupEditPreservesPlans(s, prior, next, epochId);
    var after := finishClassSlot(s, epochId);
    forall i | 0 <= i < |s.services.classes|
      ensures after.services.classes[i].id == s.services.classes[i].id
        && after.services.classes[i].serviceType == s.services.classes[i].serviceType
    {}
    PluginReceiptsRetainDeclaredType(s, after);
    PluginFilteringKeepsLiveClassOwners(s, after, retained);
    PluginClassGroupEditProjection(s, prior, next, epochId);
    forall i | 0 <= i < |s.services.classes|
      ensures after.services.classes[i].(failed := s.services.classes[i].failed) == s.services.classes[i]
    {}
    PluginRetirementChildRulesMatchImportedInvariants(s);
    PluginClassFailureFlagsKeepClassRules(s.services, after.services);
    PluginRetirementChildRulesMatchImportedInvariants(after);
    PluginClassOnlyEditRetainsCapturedStops(s, after);
    PluginClassOnlyEditKeepsTypeStatus(s, after);
    PluginClassOnlyEditKeepsObjectCustody(s, after);
  }
}

lemma PluginFilteringKeepsLiveClassOwners(s: PluginServices, after: PluginServices, retain: OwnedClass -> bool)
  requires alwaysLiveClassOwnerUnique(s) && s.ownership == after.ownership
  requires after.liveOwners == ProofLib.Filter(retain, s.liveOwners)
  ensures alwaysLiveClassOwnerUnique(after)
{
  hide *;
  reveal alwaysLiveClassOwnerUnique(), ProofLib.Filter();
  forall owner | owner in after.liveOwners
    ensures owner in after.ownership
    ensures |ProofLib.Filter((other: OwnedClass) => other.classId == owner.classId, after.liveOwners)| == 1
  {
    ProofLib.FilterMember(retain, s.liveOwners, owner);
    var byClass := (other: OwnedClass) => other.classId == owner.classId;
    ProofLib.FilterOfFilterLength(retain, byClass, byClass, s.liveOwners);
    ProofLib.FilterMember(byClass, after.liveOwners, owner);
  }
}

lemma PluginWithdrawalKeepsUnrelatedDeclaration(classes: seq<RetireClass>,
    services: core__serviceInstances_ServiceInstances, declaration: core__serviceInstances_ServiceDeclaration)
  requires declaration in services.declarations
  requires forall c | c in classes :: c.id != declaration.classId
  ensures var withdraw := (acc: core__serviceInstances_ServiceInstances, c: RetireClass) =>
    core__serviceInstances_withdrawClass(c.id, acc);
    declaration in Std.Collections.Seq.FoldLeft(withdraw, services, classes).declarations
{
  hide *;
  reveal core__serviceInstances_withdrawClass(), Std.Collections.Seq.FoldLeft(), ProofLib.Filter();
  var withdraw := (acc: core__serviceInstances_ServiceInstances, c: RetireClass) => core__serviceInstances_withdrawClass(c.id, acc);
  var after := Std.Collections.Seq.FoldLeft(withdraw, services, classes);
  if |classes| == 0 {
    assert after == services;
  } else {
    var prefix := classes[..|classes|-1];
    var last := classes[|classes|-1];
    assert classes == prefix + [last] && last.id != declaration.classId;
    assert forall c | c in prefix :: c.id != declaration.classId;
    PluginWithdrawalKeepsUnrelatedDeclaration(prefix, services, declaration);
    ProofLib.FoldLeftAppend(withdraw, services, prefix, last);
    var prior := Std.Collections.Seq.FoldLeft(withdraw, services, prefix);
    assert after == withdraw(prior, last);
    var retain := (d: core__serviceInstances_ServiceDeclaration) => d.classId != last.id;
    ProofLib.FilterMember(retain, prior.declarations, declaration);
  }
}

lemma PluginWithdrawnTypeKeepsForeignDeclarations(s: PluginServices, epochId: int,
    declaration: core__serviceInstances_ServiceDeclaration)
  requires alwaysChildLifecyclesValid(s) && alwaysServiceOwnerEpochExists(s)
  requires declaration in s.services.declarations
  requires var plan := retirement(s, epochId);
    declaration.serviceType != (if 0 <= plan.cursor < |plan.plan| then plan.plan[plan.cursor] else "")
  ensures declaration in withdrawNextType(s, epochId).services.declarations
{
  hide *;
  reveal alwaysChildLifecyclesValid(), alwaysServiceOwnerEpochExists(), withdrawNextType(), ProofLib.Filter();
  reveal core__serviceInstances_alwaysDeclarationsMatch();
  reveal core__serviceInstances_removePublishedInstances(), core__serviceInstances_replacePublication();
  var plan := retirement(s, epochId);
  var serviceType := if 0 <= plan.cursor < |plan.plan| then plan.plan[plan.cursor] else "";
  if exists d :: d in s.services.declarations && d.serviceType == serviceType {
    var selected := (o: OwnedClass) => o.epochId == epochId && o.serviceType == serviceType;
    var owners := ProofLib.Filter(selected, s.ownership);
    reveal retirementClassesForType();
    var classes := retirementClassesForType(s, epochId, serviceType);
    assert |classes| == |owners|;
    assert forall i | 0 <= i < |owners| :: classes[i] == RetireClass(owners[i].classId, owners[i].hasStopHook);
    forall c | c in classes
      ensures c.id != declaration.classId
    {
      var i :| 0 <= i < |classes| && classes[i] == c;
      var prior := owners[i];
      ProofLib.FilterMember(selected, s.ownership, prior);
      if c.id == declaration.classId {
        assert core__serviceInstances_serviceClass(s.services, c.id).serviceType == serviceType;
        assert core__serviceInstances_serviceClass(s.services, c.id).serviceType == declaration.serviceType;
        assert false;
      }
    }
    PluginWithdrawalKeepsUnrelatedDeclaration(classes, s.services, declaration);
    reveal withdrawRetiringClasses();
    var withdrawn := withdrawRetiringClasses(classes, s.services);
    assert withdrawNextType(s, epochId).services.declarations == withdrawn.declarations;
  }
}

lemma PluginWithdrawalFoldKeepsClassIdentity(classes: seq<RetireClass>, s: core__serviceInstances_ServiceInstances)
  ensures var withdraw := (acc: core__serviceInstances_ServiceInstances, c: RetireClass) =>
    core__serviceInstances_withdrawClass(c.id, acc);
    var after := Std.Collections.Seq.FoldLeft(withdraw, s, classes);
    after.(classes := s.classes, declarations := s.declarations) == s
      && |after.classes| == |s.classes|
      && (forall i | 0 <= i < |s.classes| ::
        after.classes[i].id == s.classes[i].id && after.classes[i].serviceType == s.classes[i].serviceType)
{
  hide *;
  reveal core__serviceInstances_withdrawClass(), Std.Collections.Seq.FoldLeft();
  var withdraw := (acc: core__serviceInstances_ServiceInstances, c: RetireClass) => core__serviceInstances_withdrawClass(c.id, acc);
  var after := Std.Collections.Seq.FoldLeft(withdraw, s, classes);
  if |classes| == 0 {
    assert after == s;
  } else {
    var prefix := classes[..|classes|-1];
    var last := classes[|classes|-1];
    PluginWithdrawalFoldKeepsClassIdentity(prefix, s);
    ProofLib.FoldLeftAppend(withdraw, s, prefix, last);
    var prior := Std.Collections.Seq.FoldLeft(withdraw, s, prefix);
    assert classes == prefix + [last] && after == withdraw(prior, last);
    forall i | 0 <= i < |s.classes|
      ensures after.classes[i].id == s.classes[i].id && after.classes[i].serviceType == s.classes[i].serviceType
    {}
  }
}

lemma PluginWithdrawalPreservesServiceReceiptIdentity(s: PluginServices, epochId: int)
  requires alwaysServiceOwnerEpochExists(s)
  ensures alwaysServiceOwnerEpochExists(withdrawNextType(s, epochId))
{
  hide *;
  reveal withdrawNextType(), core__serviceInstances_removePublishedInstances(), core__serviceInstances_replacePublication();
  reveal ProofLib.Filter();
  var plan := retirement(s, epochId);
  var serviceType := if 0 <= plan.cursor < |plan.plan| then plan.plan[plan.cursor] else "";
  var classes := retirementClassesForType(s, epochId, serviceType);
  var after := withdrawNextType(s, epochId);
  if exists d :: d in s.services.declarations && d.serviceType == serviceType {
    PluginWithdrawalFoldKeepsClassIdentity(classes, s.services);
    reveal withdrawRetiringClasses();
    var withdrawn := withdrawRetiringClasses(classes, s.services);
    assert after.services.classes == withdrawn.classes;
  }
  PluginReceiptsRetainDeclaredType(s, after);
}

lemma PluginWithdrawalGroupsKeepEarlierEntries(s: PluginServices, epochId: int)
  requires canWithdrawNextType(s, epochId)
  ensures var after := withdrawNextType(s, epochId);
    var selected := retirement(s, epochId);
    var serviceType := selected.plan[selected.cursor];
    |after.retirements| == |s.retirements|
      && (forall i | 0 <= i < |s.retirements| ::
        var prior := s.retirements[i];
        var row := after.retirements[i];
        |prior.groups| <= |row.groups| <= |prior.groups| + 1
          && row.groups[..|prior.groups|] == prior.groups
          && (|prior.groups| < |row.groups| ==> (row.groups[|prior.groups|].phase.GroupWaiting?
            || row.groups[|prior.groups|].phase.GroupSkipped?)))
      && ((exists d :: d in s.services.declarations && d.serviceType == serviceType)
        ==> (exists row :: row in after.retirements && (exists group :: group in row.groups && group.serviceType == serviceType && group.phase.GroupWaiting?)))
{
  hide *;
  reveal canWithdrawNextType(), withdrawNextType(), skippedGroupPhase, missingGroupPhase;
  var prior := retirement(s, epochId);
  var serviceType := prior.plan[prior.cursor];
  var after := withdrawNextType(s, epochId);
  forall i | 0 <= i < |s.retirements|
    ensures |s.retirements[i].groups| <= |after.retirements[i].groups| <= |s.retirements[i].groups| + 1
    ensures after.retirements[i].groups[..|s.retirements[i].groups|] == s.retirements[i].groups
    ensures |s.retirements[i].groups| < |after.retirements[i].groups| ==>
      (after.retirements[i].groups[|s.retirements[i].groups|].phase.GroupWaiting? ||
        after.retirements[i].groups[|s.retirements[i].groups|].phase.GroupSkipped?)
  {}
  if exists d :: d in s.services.declarations && d.serviceType == serviceType {
    reveal retirement(), noRetirement, ProofLib.Filter();
    var byEpoch := (r: ServiceRetirement) => r.epochId == epochId;
    var matches := ProofLib.Filter(byEpoch, s.retirements);
    assert |matches| > 0 && matches[0] == prior;
    ProofLib.FilterMember(byEpoch, s.retirements, prior);
    var i :| 0 <= i < |s.retirements| && s.retirements[i] == prior;
    var row := after.retirements[i];
    assert row in after.retirements;
    var group := row.groups[|prior.groups|];
    assert group in row.groups && group.serviceType == serviceType && group.phase.GroupWaiting?;
  }
}

lemma PluginWithdrawalKeepsStatusLedger(s: PluginServices, epochId: int)
  requires canWithdrawNextType(s, epochId)
  ensures withdrawNextType(s, epochId).services.typeEntries == s.services.typeEntries
  ensures withdrawNextType(s, epochId).services.stopped == s.services.stopped
{
  hide *;
  reveal canWithdrawNextType(), withdrawNextType(), withdrawRetiringClasses();
  reveal core__serviceInstances_removePublishedInstances(), core__serviceInstances_replacePublication();
  var prior := retirement(s, epochId);
  var serviceType := prior.plan[prior.cursor];
  var after := withdrawNextType(s, epochId);
  var classes := retirementClassesForType(s, epochId, serviceType);
  if exists d :: d in s.services.declarations && d.serviceType == serviceType {
    PluginWithdrawalFoldKeepsClassIdentity(classes, s.services);
    var withdrawn := withdrawRetiringClasses(classes, s.services);
    assert after.services.typeEntries == withdrawn.typeEntries && after.services.stopped == withdrawn.stopped;
  }
}

lemma PluginWithdrawalKeepsDeclarationAndWaitAbsence(s: PluginServices, epochId: int, query: string)
  requires inv(s) && canWithdrawNextType(s, epochId)
  requires var after := withdrawNextType(s, epochId);
    !(exists d :: d in after.services.declarations && d.serviceType == query)
      && !(exists ret :: ret in after.retirements && (exists p :: p in ret.groups && p.serviceType == query && p.phase.GroupWaiting?))
  ensures !(exists d :: d in s.services.declarations && d.serviceType == query)
  ensures !(exists ret :: ret in s.retirements && (exists p :: p in ret.groups && p.serviceType == query && p.phase.GroupWaiting?))
{
  hide *;
  reveal inv(), canWithdrawNextType();
  var prior := retirement(s, epochId);
  var serviceType := prior.plan[prior.cursor];
  var after := withdrawNextType(s, epochId);
  PluginWithdrawalGroupsKeepEarlierEntries(s, epochId);
  if exists d :: d in s.services.declarations && d.serviceType == query {
    var declaration :| declaration in s.services.declarations && declaration.serviceType == query;
    if query != serviceType {
      PluginWithdrawnTypeKeepsForeignDeclarations(s, epochId, declaration);
    } else {
      assert exists row :: row in after.retirements && (exists wait :: wait in row.groups && wait.serviceType == query && wait.phase.GroupWaiting?);
    }
    assert false;
  }
  if exists ret :: ret in s.retirements && (exists p :: p in ret.groups && p.serviceType == query && p.phase.GroupWaiting?) {
    var i :| 0 <= i < |s.retirements| && (exists p :: p in s.retirements[i].groups && p.serviceType == query && p.phase.GroupWaiting?);
    var row := after.retirements[i];
    var pending :| pending in s.retirements[i].groups && pending.serviceType == query && pending.phase.GroupWaiting?;
    assert row in after.retirements && pending in row.groups;
    assert false;
  }
}

lemma PluginWithdrawalKeepsEarlierTypeStatus(s: PluginServices, epochId: int)
  requires inv(s) && canWithdrawNextType(s, epochId)
  ensures alwaysRetiredUndeclaredTypeIsUnknown(withdrawNextType(s, epochId))
{
  hide *;
  reveal inv(), alwaysRetiredUndeclaredTypeIsUnknown(), core__serviceInstances_serviceTypeEntry();
  var after := withdrawNextType(s, epochId);
  PluginWithdrawalKeepsStatusLedger(s, epochId);
  PluginWithdrawalGroupsKeepEarlierEntries(s, epochId);
  if !after.services.stopped {
    forall row | row in after.retirements
      ensures forall g | g in row.groups
        && (g.phase.GroupStoppingInstances? || g.phase.GroupStoppingClasses? || g.phase.GroupFinished? || g.phase.GroupFailed?)
        && !(exists d :: d in after.services.declarations && d.serviceType == g.serviceType)
        && !(exists ret :: ret in after.retirements && (exists p :: p in ret.groups && p.serviceType == g.serviceType && p.phase.GroupWaiting?)) ::
          core__serviceInstances_serviceTypeEntry(after.services, g.serviceType).status.TypeUnknown?
    {
      var i :| 0 <= i < |after.retirements| && after.retirements[i] == row;
      var earlier := s.retirements[i];
      assert earlier in s.retirements;
      forall g | g in row.groups
        && (g.phase.GroupStoppingInstances? || g.phase.GroupStoppingClasses? || g.phase.GroupFinished? || g.phase.GroupFailed?)
        && !(exists d :: d in after.services.declarations && d.serviceType == g.serviceType)
        && !(exists ret :: ret in after.retirements && (exists p :: p in ret.groups && p.serviceType == g.serviceType && p.phase.GroupWaiting?))
        ensures core__serviceInstances_serviceTypeEntry(after.services, g.serviceType).status.TypeUnknown?
      {
        var j :| 0 <= j < |row.groups| && row.groups[j] == g;
        assert j < |earlier.groups| && earlier.groups[j] == g && g in earlier.groups;
        PluginWithdrawalKeepsDeclarationAndWaitAbsence(s, epochId, g.serviceType);
      }
    }
  }
}

lemma PluginLiveClassHasDeclaration(s: core__serviceInstances_ServiceInstances, cls: core__serviceInstances_ServiceClassEntry)
  requires core__serviceInstances_alwaysDeclarationsMatch(s) && core__serviceInstances_alwaysClassAndObjectIdentities(s)
  requires cls in s.classes && cls.live != 0
  ensures exists d :: d in s.declarations && d.classId == cls.id && d.serviceType == cls.serviceType
{
  hide *;
  reveal core__serviceInstances_alwaysDeclarationsMatch(), core__serviceInstances_alwaysClassAndObjectIdentities();
  reveal core__serviceInstances_serviceClass(), ProofLib.Filter();
  var byId := (c: core__serviceInstances_ServiceClassEntry) => c.id == cls.id;
  var matches := ProofLib.Filter(byId, s.classes);
  ProofLib.FilterMember(byId, s.classes, cls);
  assert |matches| == 1 && matches[0] == cls && cls.registered;
  var declaration :| declaration in s.declarations && declaration.classId == cls.id;
  assert declaration.serviceType == cls.serviceType;
}

lemma PluginClassInstanceProjectionIncludesDeclaredObject(s: core__serviceInstances_ServiceInstances,
    d: core__serviceInstances_ServiceDeclaration)
  requires d in s.declarations && core__serviceInstances_serviceClass(s, d.classId).live != 0
  ensures core__serviceInstances_serviceClass(s, d.classId).live in core__serviceInstances_classInstances(s, d.serviceType)
{
  hide *;
  reveal core__serviceInstances_classInstances(), ProofLib.Filter();
  var selected := (entry: core__serviceInstances_ServiceDeclaration) => ((entry.serviceType == d.serviceType)
    && (core__serviceInstances_serviceClass(s, entry.classId).live != 0));
  var matches := ProofLib.Filter(selected, s.declarations);
  ProofLib.FilterMember(selected, s.declarations, d);
  var i :| 0 <= i < |matches| && matches[i] == d;
  var instances := core__serviceInstances_classInstances(s, d.serviceType);
  assert instances[i] == core__serviceInstances_serviceClass(s, d.classId).live;
}

lemma PluginReplacementPublishesInstance(s: core__serviceInstances_ServiceInstances, serviceType: string,
    instances: seq<int>, wanted: int)
  requires wanted in instances
  ensures var after := core__serviceInstances_replacePublication(serviceType, instances, s);
    exists p :: p in after.published && wanted in p.instances
{
  hide *;
  reveal core__serviceInstances_replacePublication();
  var after := core__serviceInstances_replacePublication(serviceType, instances, s);
  var row := core__serviceInstances_ServicePublication(serviceType, instances);
  if exists p :: p in s.published && p.serviceType == serviceType {
    var i :| 0 <= i < |s.published| && s.published[i].serviceType == serviceType;
    assert after.published[i] == row;
  } else {
    assert after.published == s.published + [row];
  }
  assert row in after.published;
}

lemma PluginReturnedStartPublicationKeepsRegisteredObjects(s: PluginServices, attemptId: int, instanceId: int)
  requires inv(s) && canFinishClassStart(s, attemptId, instanceId)
  requires alwaysChildLifecyclesValid(finishClassStart(s, attemptId, instanceId))
  ensures var after := finishClassStart(s, attemptId, instanceId);
    var owner := core__serviceInstances_serviceClass(s.services,
      core__serviceInstances_serviceAttempt(s.services, attemptId).classId);
    (!s.services.stopped && owner.registered ==> (exists p :: p in after.services.published && instanceId in p.instances))
      && (forall p | p in s.services.published :: (forall id | id in p.instances ::
        (exists current :: current in after.services.published && id in current.instances)))
{
  hide *;
  reveal inv(), canFinishClassStart(), alwaysChildLifecyclesValid(), finishClassStart(), core__serviceInstances_returnInstance();
  reveal core__serviceInstances_canReturnInstance(), core__serviceInstances_stopObjectOnce();
  reveal core__serviceInstances_setTypeStatus(), core__serviceInstances_putType(), core__serviceInstances_replacePublication();
  reveal core__serviceInstances_alwaysPublicationIdentitiesValid();
  var before := s.services;
  var after := finishClassStart(s, attemptId, instanceId).services;
  var owner := core__serviceInstances_serviceClass(before, core__serviceInstances_serviceAttempt(before, attemptId).classId);
  if !before.stopped && owner.registered {
    PluginReturningStartClassOwners(s, attemptId, instanceId);
    var prepared := before.(objects := after.objects, attempts := after.attempts, classes := after.classes);
    var serviceType := owner.serviceType;
    assert after.published == core__serviceInstances_replacePublication(serviceType,
      core__serviceInstances_classInstances(prepared, serviceType), prepared).published;
    assert prepared.classes == after.classes && prepared.declarations == after.declarations;
    reveal core__serviceInstances_serviceClass(), core__serviceInstances_noClass, ProofLib.Filter();
    var changedClass := core__serviceInstances_serviceAttempt(before, attemptId).classId;
    var byOwner := (row: core__serviceInstances_ServiceClassEntry) => row.id == changedClass;
    var oldClasses := ProofLib.Filter(byOwner, before.classes);
    assert |oldClasses| > 0 && oldClasses[0] == owner;
    ProofLib.FilterMember(byOwner, before.classes, owner);
    assert owner in before.classes;
    var index :| 0 <= index < |before.classes| && before.classes[index] == owner;
    var replacement := after.classes[index];
    assert replacement in after.classes && replacement.live == instanceId && replacement.serviceType == serviceType;
    PluginPublishedClassOccursInCurrentList(after, prepared, replacement);
    PluginReplacementPublishesInstance(prepared, serviceType, core__serviceInstances_classInstances(prepared, serviceType), instanceId);
    forall p | p in before.published
      ensures forall id | id in p.instances :: (exists current :: current in after.published && id in current.instances)
    {
      if p.serviceType != serviceType {
        var i :| 0 <= i < |before.published| && before.published[i] == p;
        assert after.published[i] == p && p in after.published;
      } else {
        forall id | id in p.instances
          ensures exists current :: current in after.published && id in current.instances
        {
          var cls :| cls in before.classes && cls.serviceType == serviceType && cls.live == id;
          reveal core__serviceInstances_alwaysDeclarationsMatch();
          assert id > 0 && cls.registered && cls in after.classes;
          PluginPublishedClassOccursInCurrentList(after, prepared, cls);
          PluginReplacementPublishesInstance(prepared, serviceType, core__serviceInstances_classInstances(prepared, serviceType), id);
        }
      }
    }
  } else {
    assert after.published == before.published;
  }
}

lemma PluginPublishedClassOccursInCurrentList(after: core__serviceInstances_ServiceInstances,
    prepared: core__serviceInstances_ServiceInstances, cls: core__serviceInstances_ServiceClassEntry)
  requires core__serviceInstances_alwaysDeclarationsMatch(after) && core__serviceInstances_alwaysClassAndObjectIdentities(after)
  requires cls in after.classes && cls.live != 0
  requires prepared.classes == after.classes && prepared.declarations == after.declarations
  ensures cls.live in core__serviceInstances_classInstances(prepared, cls.serviceType)
{
  hide *;
  reveal core__serviceInstances_serviceClass(), core__serviceInstances_alwaysClassAndObjectIdentities(), ProofLib.Filter();
  PluginLiveClassHasDeclaration(after, cls);
  var declaration :| declaration in after.declarations && declaration.classId == cls.id && declaration.serviceType == cls.serviceType;
  var byId := (c: core__serviceInstances_ServiceClassEntry) => c.id == cls.id;
  var matches := ProofLib.Filter(byId, after.classes);
  ProofLib.FilterMember(byId, after.classes, cls);
  assert |matches| == 1 && matches[0] == cls;
  assert core__serviceInstances_serviceClass(prepared, declaration.classId) == cls;
  PluginClassInstanceProjectionIncludesDeclaredObject(prepared, declaration);
}

lemma PluginShutdownObjectBatch(ids: seq<int>, s: core__serviceInstances_ServiceInstances)
  requires core__serviceInstances_alwaysObjectStopOnce(s)
  ensures var visit := (acc: core__serviceInstances_ServiceInstances, id: int) => core__serviceInstances_stopObjectOnce(id, acc);
    var after := Std.Collections.Seq.FoldLeft(visit, s, ids);
    after.(objects := s.objects) == s && core__serviceInstances_alwaysObjectStopOnce(after)
      && |after.objects| == |s.objects|
      && (forall i | 0 <= i < |s.objects| ::
        after.objects[i].id == s.objects[i].id
          && (s.objects[i].stopCalls > 0 || s.objects[i].id in ids ==> after.objects[i].stopCalls > 0)
          && ((s.objects[i].stopPhase.StopSucceeded? || s.objects[i].stopPhase.StopFailed?)
            ==> after.objects[i].stopPhase == s.objects[i].stopPhase))
{
  hide *;
  reveal core__serviceInstances_stopObjectOnce(), core__serviceInstances_alwaysObjectStopOnce(), Std.Collections.Seq.FoldLeft();
  var visit := (acc: core__serviceInstances_ServiceInstances, id: int) => core__serviceInstances_stopObjectOnce(id, acc);
  var after := Std.Collections.Seq.FoldLeft(visit, s, ids);
  if |ids| == 0 {
    assert after == s;
  } else {
    var prefix := ids[..|ids|-1];
    var last := ids[|ids|-1];
    PluginShutdownObjectBatch(prefix, s);
    ProofLib.FoldLeftAppend(visit, s, prefix, last);
    var prior := Std.Collections.Seq.FoldLeft(visit, s, prefix);
    assert ids == prefix + [last] && after == visit(prior, last);
    forall i | 0 <= i < |s.objects|
      ensures after.objects[i].id == s.objects[i].id
      ensures s.objects[i].stopCalls > 0 || s.objects[i].id in ids ==> after.objects[i].stopCalls > 0
      ensures (s.objects[i].stopPhase.StopSucceeded? || s.objects[i].stopPhase.StopFailed?)
        ==> after.objects[i].stopPhase == s.objects[i].stopPhase
    {
      assert prior.objects[i] in prior.objects;
      if s.objects[i].id in ids {
        assert s.objects[i].id in prefix || s.objects[i].id == last;
      }
    }
    forall obj | obj in after.objects
      ensures obj.stopCalls >= 0 && obj.stopCalls <= 1 && (!obj.stopPhase.StopNotRequested? <==> obj.stopCalls == 1)
    {
      var i :| 0 <= i < |after.objects| && after.objects[i] == obj;
      assert prior.objects[i] in prior.objects;
    }
  }
}

lemma PluginShutdownPublicationBatch(rows: seq<core__serviceInstances_ServicePublication>,
    s: core__serviceInstances_ServiceInstances)
  requires core__serviceInstances_alwaysObjectStopOnce(s)
  ensures var visit := (acc: core__serviceInstances_ServiceInstances, p: core__serviceInstances_ServicePublication) =>
      core__serviceInstances_stopPublishedType(p, acc);
    var after := Std.Collections.Seq.FoldLeft(visit, s, rows);
    after.(objects := s.objects) == s && core__serviceInstances_alwaysObjectStopOnce(after) && |after.objects| == |s.objects|
      && (forall i | 0 <= i < |s.objects| ::
        after.objects[i].id == s.objects[i].id
          && (s.objects[i].stopCalls > 0 || (exists p :: p in rows && s.objects[i].id in p.instances) ==> after.objects[i].stopCalls > 0)
          && ((s.objects[i].stopPhase.StopSucceeded? || s.objects[i].stopPhase.StopFailed?)
            ==> after.objects[i].stopPhase == s.objects[i].stopPhase))
{
  hide *;
  reveal core__serviceInstances_stopPublishedType(), Std.Collections.Seq.FoldLeft();
  var visit := (acc: core__serviceInstances_ServiceInstances, p: core__serviceInstances_ServicePublication) =>
    core__serviceInstances_stopPublishedType(p, acc);
  var after := Std.Collections.Seq.FoldLeft(visit, s, rows);
  if |rows| == 0 {
    assert after == s;
  } else {
    var prefix := rows[..|rows|-1];
    var last := rows[|rows|-1];
    PluginShutdownPublicationBatch(prefix, s);
    ProofLib.FoldLeftAppend(visit, s, prefix, last);
    var prior := Std.Collections.Seq.FoldLeft(visit, s, prefix);
    assert rows == prefix + [last] && after == visit(prior, last);
    PluginShutdownObjectBatch(last.instances, prior);
    forall i | 0 <= i < |s.objects|
      ensures after.objects[i].id == s.objects[i].id
      ensures s.objects[i].stopCalls > 0 || (exists p :: p in rows && s.objects[i].id in p.instances) ==> after.objects[i].stopCalls > 0
      ensures (s.objects[i].stopPhase.StopSucceeded? || s.objects[i].stopPhase.StopFailed?)
        ==> after.objects[i].stopPhase == s.objects[i].stopPhase
    {
      if exists p :: p in rows && s.objects[i].id in p.instances {
        var publisher :| publisher in rows && s.objects[i].id in publisher.instances;
        if publisher != last {
          assert publisher in prefix;
        }
      }
    }
  }
}

lemma PluginShutdownPreservesObjectCustody(s: PluginServices)
  requires inv(s)
  ensures alwaysNoOrphanInstance(stopServices(s))
  ensures alwaysStopObservationsFollowSlots(stopServices(s)) && alwaysRetiredEpochHasNoResources(stopServices(s))
  ensures alwaysServiceOwnerEpochExists(stopServices(s))
{
  hide *;
  reveal inv(), alwaysChildLifecyclesValid(), alwaysNoOrphanInstance(), stopServices(), core__serviceInstances_stopRuntime();
  var previous := s.services;
  var visit := (acc: core__serviceInstances_ServiceInstances, p: core__serviceInstances_ServicePublication) =>
    core__serviceInstances_stopPublishedType(p, acc);
  var stopped := Std.Collections.Seq.FoldLeft(visit, previous, previous.published);
  var after := stopServices(s);
  PluginShutdownPublicationBatch(previous.published, previous);
  assert after.services.objects == stopped.objects;
  forall obj | obj in after.services.objects
    ensures obj.stopCalls > 0
      || (exists r | r in after.retirements :: (exists g | g in r.groups ::
        missingStopObservedFor(g, obj.id)
          || (core__pluginRegistry_epochOwnsResources(after.plugins, r.epochId) && obj.id in g.instances)))
  {
    var i :| 0 <= i < |after.services.objects| && after.services.objects[i] == obj;
    assert previous.objects[i] in previous.objects;
  }
  PluginMappedObjectsRetainStopReceipts(s, after);
  forall i | 0 <= i < |s.services.classes|
    ensures after.services.classes[i].id == s.services.classes[i].id
      && after.services.classes[i].serviceType == s.services.classes[i].serviceType
  {}
  PluginReceiptsRetainDeclaredType(s, after);
}

lemma stopServices_ensures(s: PluginServices)
  ensures (inv(s) ==> canStopServices(s) ==> alwaysLiveClassOwnerUnique(stopServices(s)))
  ensures (inv(s) ==> canStopServices(s) ==> alwaysServiceOwnerEpochExists(stopServices(s)))
  ensures (inv(s) ==> canStopServices(s) ==> alwaysChildLifecyclesValid(stopServices(s)))
  ensures (inv(s) ==> canStopServices(s) ==> alwaysRetirementsFollowTypePlan(stopServices(s)))
  ensures (inv(s) ==> canStopServices(s) ==> alwaysNoOrphanInstance(stopServices(s)))
  ensures (inv(s) ==> canStopServices(s) ==> alwaysRetiredUndeclaredTypeIsUnknown(stopServices(s)))
  ensures (inv(s) ==> canStopServices(s) ==> alwaysStopObservationsFollowSlots(stopServices(s)))
  ensures (inv(s) ==> canStopServices(s) ==> alwaysRetiredEpochHasNoResources(stopServices(s)))
  ensures (inv(s) ==> canStopServices(s) ==> alwaysSealedOwnedClassesStable(stopServices(s)))
{
  hide *;
  reveal inv(), canStopServices(), stopServices(), core__serviceInstances_inv(), core__serviceInstances_stopRuntime();
  reveal alwaysLiveClassOwnerUnique(), alwaysServiceOwnerEpochExists(), alwaysRetirementsFollowTypePlan();
  reveal alwaysRetiredUndeclaredTypeIsUnknown(), alwaysSealedOwnedClassesStable();
  if inv(s) && canStopServices(s) {
    var after := stopServices(s);
    PluginRetirementChildRulesMatchImportedInvariants(s);
    core__serviceInstances_stopRuntime_ensures(s.services);
    PluginRetirementChildRulesMatchImportedInvariants(after);
    PluginShutdownPreservesObjectCustody(s);
  }
}

lemma PluginClassFailureFlagsKeepLookup(s: core__serviceInstances_ServiceInstances,
    after: core__serviceInstances_ServiceInstances, classId: int)
  requires |s.classes| == |after.classes|
  requires forall i | 0 <= i < |s.classes| :: after.classes[i].(failed := s.classes[i].failed) == s.classes[i]
  ensures var before := core__serviceInstances_serviceClass(s, classId);
    core__serviceInstances_serviceClass(after, classId).(failed := before.failed) == before
{
  hide *;
  reveal core__serviceInstances_serviceClass(), ProofLib.Filter();
  var byId := (cls: core__serviceInstances_ServiceClassEntry) => cls.id == classId;
  var onlyFailure := (prior: core__serviceInstances_ServiceClassEntry, next: core__serviceInstances_ServiceClassEntry) =>
    next.(failed := prior.failed) == prior;
  ProofLib.FilterPointwise(byId, byId, onlyFailure, s.classes, after.classes);
}

lemma PluginClassFailureFlagsKeepClassRules(s: core__serviceInstances_ServiceInstances,
    after: core__serviceInstances_ServiceInstances)
  requires core__serviceInstances_inv(s) && after.(classes := s.classes) == s
  requires |s.classes| == |after.classes|
  requires forall i | 0 <= i < |s.classes| :: after.classes[i].(failed := s.classes[i].failed) == s.classes[i]
  ensures core__serviceInstances_inv(after)
{
  hide *;
  reveal core__serviceInstances_inv(), core__serviceInstances_alwaysClassAndObjectIdentities(), core__serviceInstances_alwaysDeclarationsMatch();
  reveal core__serviceInstances_alwaysPendingAttemptsOwned(), core__serviceInstances_alwaysClassOwnsKnownObjects();
  reveal core__serviceInstances_alwaysPublicationIdentitiesValid(), core__serviceInstances_alwaysStoppedHasNoPublication();
  reveal core__serviceInstances_alwaysAttemptGeneration(), core__serviceInstances_serviceAttempt(), core__serviceInstances_serviceObject();
  reveal core__serviceInstances_alwaysTypeEntriesUnique(), core__serviceInstances_alwaysTypeReferencesRetained();
  reveal core__serviceInstances_alwaysAggregateAndLoadIdsUnique(), core__serviceInstances_alwaysAcquisitionIdsUnique();
  reveal core__serviceInstances_alwaysInitWaitingHasNoAggregate(), core__serviceInstances_alwaysCapturedAttemptsExist();
  reveal core__serviceInstances_alwaysObjectStopOnce(), core__serviceInstances_alwaysFailedTypeHasNoPublication();
  reveal core__serviceInstances_hasFailedPublishedType(), core__serviceInstances_firstLive(), core__serviceInstances_publishedInstances();
  reveal ProofLib.Filter();
  forall cls | cls in after.classes
    ensures cls.id > 0 && cls.generation >= 0 && cls.pending >= 0
    ensures |ProofLib.Filter((other: core__serviceInstances_ServiceClassEntry) => other.id == cls.id, after.classes)| == 1
    ensures cls.live == 0 || (cls.registered && (exists o :: o in after.objects && o.id == cls.live))
    ensures cls.registered == (exists d :: d in after.declarations && d.classId == cls.id)
    ensures after.stopped ==> cls.live == 0
    ensures cls.pending == 0 || (core__serviceInstances_serviceAttempt(after, cls.pending).classId == cls.id
      && core__serviceInstances_serviceAttempt(after, cls.pending).generation == cls.generation
      && (core__serviceInstances_serviceAttempt(after, cls.pending).phase.StartInvoking?
        || core__serviceInstances_serviceAttempt(after, cls.pending).phase.StartObserver?
        || core__serviceInstances_serviceAttempt(after, cls.pending).phase.StartLateStop?))
  {
    var i :| 0 <= i < |after.classes| && after.classes[i] == cls;
    assert s.classes[i] in s.classes;
    var byId := (other: core__serviceInstances_ServiceClassEntry) => other.id == cls.id;
    ProofLib.FilterLengthPointwise(byId, byId, s.classes, after.classes);
  }
  forall d | d in after.declarations
    ensures d.serviceType != "" && core__serviceInstances_serviceClass(after, d.classId).registered
      && core__serviceInstances_serviceClass(after, d.classId).serviceType == d.serviceType
  {
    PluginClassFailureFlagsKeepLookup(s, after, d.classId);
  }
  forall a | a in after.attempts
    ensures a.generation <= core__serviceInstances_serviceClass(after, a.classId).generation
    ensures (!after.stopped && a.phase.StartInvoking?) ==> (core__serviceInstances_serviceClass(after, a.classId).pending == a.id
      && core__serviceInstances_serviceClass(after, a.classId).live == 0)
  {
    PluginClassFailureFlagsKeepLookup(s, after, a.classId);
  }
  forall p | p in after.published
    ensures forall id | id in p.instances ::
      (exists cls :: cls in after.classes && cls.serviceType == p.serviceType && cls.live == id)
  {
    forall id | id in p.instances
      ensures exists cls :: cls in after.classes && cls.serviceType == p.serviceType && cls.live == id
    {
      var i :| 0 <= i < |s.classes| && s.classes[i].serviceType == p.serviceType && s.classes[i].live == id;
      assert after.classes[i] in after.classes;
    }
  }
}

lemma PluginClassOnlyEditKeepsGroupStops(g: RetirementGroup, updated: RetirementGroup,
    before: core__serviceInstances_ServiceInstances, after: core__serviceInstances_ServiceInstances)
  requires updated.(classCursor := g.classCursor, hook := g.hook) == g
  requires before.objects == after.objects
  ensures allStopObservationsValid(updated, after) == allStopObservationsValid(g, before)
{
  hide *;
  reveal validStopObservation();
  PluginStopObjectUpdateGroupObservations(g, before);
  PluginStopObjectUpdateGroupObservations(updated, after);
  forall i | 0 <= i < |g.observedStops|
    ensures validStopObservation(updated, i, updated.observedStops[i], after) ==
      validStopObservation(g, i, g.observedStops[i], before)
  {
    PluginServiceFrameStopSlotStable(before, after, g.observedStops[i]);
  }
}

lemma PluginClassOnlyEditRetainsCapturedStops(s: PluginServices, after: PluginServices)
  requires inv(s) && alwaysRetirementsFollowTypePlan(after)
  requires after.plugins == s.plugins && after.services.objects == s.services.objects
  requires |after.retirements| == |s.retirements|
  requires forall i | 0 <= i < |s.retirements| ::
    var prior := s.retirements[i];
    var updated := after.retirements[i];
    updated.(groups := prior.groups) == prior && |updated.groups| == |prior.groups|
      && (forall j | 0 <= j < |prior.groups| ::
        updated.groups[j].(classCursor := prior.groups[j].classCursor, hook := prior.groups[j].hook) == prior.groups[j])
  ensures alwaysStopObservationsFollowSlots(after) && alwaysRetiredEpochHasNoResources(after)
{
  hide *;
  reveal inv(), alwaysStopObservationsFollowSlots(), alwaysRetiredEpochHasNoResources(), retirementSettled();
  reveal classPhaseFollowsInstances();
  forall r | r in after.retirements
    ensures !core__pluginRegistry_epochOwnsResources(after.plugins, r.epochId) ==> retirementSettled(after, r.epochId)
    ensures forall g | g in r.groups ::
      0 <= g.instanceCursor <= |g.instances| && g.instanceCursor <= |g.observedStops| <= |g.instances|
        && |g.observedStops| <= g.instanceCursor + 1 && classPhaseFollowsInstances(g) && allStopObservationsValid(g, after.services)
    ensures forall g | g in r.groups && !core__pluginRegistry_epochOwnsResources(after.plugins, r.epochId) ::
      g.instanceCursor == |g.instances| && (forall slot | slot in g.observedStops :: stopSlotSettled(slot, after.services))
  {
    var i :| 0 <= i < |after.retirements| && after.retirements[i] == r;
    var prior := s.retirements[i];
    assert prior in s.retirements && prior.epochId == r.epochId;
    if !core__pluginRegistry_epochOwnsResources(after.plugins, r.epochId) {
      PluginRetirementPlanLookup(s, prior);
      PluginRetirementPlanLookup(after, r);
    }
    forall g | g in r.groups
      ensures 0 <= g.instanceCursor <= |g.instances| && g.instanceCursor <= |g.observedStops| <= |g.instances|
        && |g.observedStops| <= g.instanceCursor + 1 && classPhaseFollowsInstances(g) && allStopObservationsValid(g, after.services)
      ensures !core__pluginRegistry_epochOwnsResources(after.plugins, r.epochId) ==>
        (g.instanceCursor == |g.instances| && (forall slot | slot in g.observedStops :: stopSlotSettled(slot, after.services)))
    {
      var j :| 0 <= j < |r.groups| && r.groups[j] == g;
      var earlier := prior.groups[j];
      assert earlier in prior.groups && g.observedStops == earlier.observedStops;
      PluginClassOnlyEditKeepsGroupStops(earlier, g, s.services, after.services);
      if !core__pluginRegistry_epochOwnsResources(after.plugins, r.epochId) {
        forall slot | slot in g.observedStops
          ensures stopSlotSettled(slot, after.services)
        {
          PluginServiceFrameStopSlotStable(s.services, after.services, slot);
        }
      }
    }
  }
}

lemma PluginClassOnlyEditKeepsWaitingGroups(s: PluginServices, after: PluginServices, serviceType: string)
  requires |after.retirements| == |s.retirements|
  requires forall i | 0 <= i < |s.retirements| ::
    var prior := s.retirements[i];
    var updated := after.retirements[i];
    |updated.groups| == |prior.groups|
      && (forall j | 0 <= j < |prior.groups| ::
        updated.groups[j].(classCursor := prior.groups[j].classCursor, hook := prior.groups[j].hook) == prior.groups[j])
  requires exists r :: r in s.retirements && (exists g :: g in r.groups && g.serviceType == serviceType && g.phase.GroupWaiting?)
  ensures exists r :: r in after.retirements && (exists g :: g in r.groups && g.serviceType == serviceType && g.phase.GroupWaiting?)
{
  hide *;
  var i :| 0 <= i < |s.retirements| &&
    (exists g :: g in s.retirements[i].groups && g.serviceType == serviceType && g.phase.GroupWaiting?);
  var j :| 0 <= j < |s.retirements[i].groups| &&
    s.retirements[i].groups[j].serviceType == serviceType && s.retirements[i].groups[j].phase.GroupWaiting?;
  assert after.retirements[i] in after.retirements && after.retirements[i].groups[j] in after.retirements[i].groups;
}

lemma PluginClassOnlyEditKeepsTypeStatus(s: PluginServices, after: PluginServices)
  requires alwaysRetiredUndeclaredTypeIsUnknown(s)
  requires after.services.typeEntries == s.services.typeEntries && after.services.declarations == s.services.declarations
  requires after.services.stopped == s.services.stopped
  requires |after.retirements| == |s.retirements|
  requires forall i | 0 <= i < |s.retirements| ::
    var prior := s.retirements[i];
    var updated := after.retirements[i];
    |updated.groups| == |prior.groups|
      && (forall j | 0 <= j < |prior.groups| ::
        updated.groups[j].(classCursor := prior.groups[j].classCursor, hook := prior.groups[j].hook) == prior.groups[j])
  ensures alwaysRetiredUndeclaredTypeIsUnknown(after)
{
  hide *;
  reveal alwaysRetiredUndeclaredTypeIsUnknown(), core__serviceInstances_serviceTypeEntry();
  if !after.services.stopped {
    forall r | r in after.retirements
      ensures forall g | g in r.groups
        && (g.phase.GroupStoppingInstances? || g.phase.GroupStoppingClasses? || g.phase.GroupFinished? || g.phase.GroupFailed?)
        && !(exists d :: d in after.services.declarations && d.serviceType == g.serviceType)
        && !(exists row :: row in after.retirements && (exists waiting :: waiting in row.groups && waiting.serviceType == g.serviceType && waiting.phase.GroupWaiting?)) ::
          core__serviceInstances_serviceTypeEntry(after.services, g.serviceType).status.TypeUnknown?
    {
      var i :| 0 <= i < |after.retirements| && after.retirements[i] == r;
      var earlier := s.retirements[i];
      assert earlier in s.retirements;
      forall g | g in r.groups
        && (g.phase.GroupStoppingInstances? || g.phase.GroupStoppingClasses? || g.phase.GroupFinished? || g.phase.GroupFailed?)
        && !(exists d :: d in after.services.declarations && d.serviceType == g.serviceType)
        && !(exists row :: row in after.retirements && (exists waiting :: waiting in row.groups && waiting.serviceType == g.serviceType && waiting.phase.GroupWaiting?))
        ensures core__serviceInstances_serviceTypeEntry(after.services, g.serviceType).status.TypeUnknown?
      {
        var j :| 0 <= j < |r.groups| && r.groups[j] == g;
        assert earlier.groups[j] in earlier.groups && earlier.groups[j].phase == g.phase && earlier.groups[j].serviceType == g.serviceType;
        if exists row :: row in s.retirements && (exists waiting :: waiting in row.groups && waiting.serviceType == g.serviceType && waiting.phase.GroupWaiting?) {
          PluginClassOnlyEditKeepsWaitingGroups(s, after, g.serviceType);
          assert false;
        }
      }
    }
  }
}

lemma PluginClassOnlyEditKeepsObjectCustody(s: PluginServices, after: PluginServices)
  requires alwaysNoOrphanInstance(s) && after.plugins == s.plugins
  requires after.services.objects == s.services.objects && after.services.published == s.services.published
  requires |after.services.classes| == |s.services.classes|
  requires forall i | 0 <= i < |s.services.classes| ::
    after.services.classes[i].(failed := s.services.classes[i].failed) == s.services.classes[i]
  requires |after.retirements| == |s.retirements|
  requires forall i | 0 <= i < |s.retirements| ::
    var prior := s.retirements[i];
    var updated := after.retirements[i];
    updated.epochId == prior.epochId && |updated.groups| == |prior.groups|
      && (forall j | 0 <= j < |prior.groups| ::
        updated.groups[j].(classCursor := prior.groups[j].classCursor, hook := prior.groups[j].hook) == prior.groups[j])
  ensures alwaysNoOrphanInstance(after)
{
  hide *;
  reveal alwaysNoOrphanInstance(), missingStopObservedFor();
  forall o | o in after.services.objects
    ensures o.stopCalls > 0 || ((exists cls :: cls in after.services.classes && cls.live == o.id && cls.registered)
      && (exists p :: p in after.services.published && o.id in p.instances))
      || (exists r :: r in after.retirements && (exists g :: g in r.groups && (missingStopObservedFor(g, o.id) || (core__pluginRegistry_epochOwnsResources(after.plugins, r.epochId) && o.id in g.instances))))
  {
    if exists cls :: cls in s.services.classes && cls.live == o.id && cls.registered {
      var i :| 0 <= i < |s.services.classes| && s.services.classes[i].live == o.id && s.services.classes[i].registered;
      assert after.services.classes[i] in after.services.classes;
    }
    if exists r :: r in s.retirements && (exists g :: g in r.groups && (missingStopObservedFor(g, o.id) || (core__pluginRegistry_epochOwnsResources(s.plugins, r.epochId) && o.id in g.instances))) {
      var i :| 0 <= i < |s.retirements| && (exists g :: g in s.retirements[i].groups && (missingStopObservedFor(g, o.id) || (core__pluginRegistry_epochOwnsResources(s.plugins, s.retirements[i].epochId) && o.id in g.instances)));
      var j :| 0 <= j < |s.retirements[i].groups| && (missingStopObservedFor(s.retirements[i].groups[j], o.id) ||
        (core__pluginRegistry_epochOwnsResources(s.plugins, s.retirements[i].epochId) && o.id in s.retirements[i].groups[j].instances));
      assert after.retirements[i] in after.retirements && after.retirements[i].groups[j] in after.retirements[i].groups;
    }
  }
}

lemma PluginCurrentGroupReplacementProjects(s: PluginServices, beforePlacement: PluginServices,
    next: RetirementGroup, epochId: int)
  requires alwaysRetirementsFollowTypePlan(s)
  requires currentGroup(s, epochId) != noGroup && next.serviceType == currentGroup(s, epochId).serviceType
  requires |beforePlacement.retirements| == |s.retirements|
  requires forall i | 0 <= i < |s.retirements| ::
    beforePlacement.retirements[i].epochId == s.retirements[i].epochId
      && beforePlacement.retirements[i].groups == s.retirements[i].groups
  ensures var after := putCurrentGroup(next, epochId, beforePlacement);
    |after.retirements| == |s.retirements| &&
      (forall i | 0 <= i < |s.retirements| ::
        var prior := s.retirements[i];
        var base := beforePlacement.retirements[i];
        var updated := after.retirements[i];
        updated.(groups := base.groups) == base && |updated.groups| == |prior.groups|
          && (prior.epochId == epochId ==> 0 <= prior.cursor < |prior.groups|)
          && (forall j | 0 <= j < |prior.groups| ::
            updated.groups[j] == (if prior.epochId == epochId && j == prior.cursor then next else prior.groups[j])))
{
  hide *;
  reveal alwaysRetirementsFollowTypePlan(), retirementGroupsFollowPlan(), putCurrentGroup(), currentGroup();
  var after := putCurrentGroup(next, epochId, beforePlacement);
  forall i | 0 <= i < |s.retirements|
    ensures var prior := s.retirements[i];
      var base := beforePlacement.retirements[i];
      var updated := after.retirements[i];
      updated.(groups := base.groups) == base && |updated.groups| == |prior.groups|
        && (prior.epochId == epochId ==> 0 <= prior.cursor < |prior.groups|)
        && (forall j | 0 <= j < |prior.groups| ::
          updated.groups[j] == (if prior.epochId == epochId && j == prior.cursor then next else prior.groups[j]))
  {
    var prior := s.retirements[i];
    var updated := after.retirements[i];
    if prior.epochId == epochId {
      assert prior in s.retirements;
      PluginRetirementPlanLookup(s, prior);
      assert 0 <= prior.cursor < |prior.groups|;
      var current := prior.groups[prior.cursor];
      assert currentGroup(s, epochId) == current;
      forall j | 0 <= j < |prior.groups|
        ensures updated.groups[j] == (if j == prior.cursor then next else prior.groups[j])
      {
        if prior.groups[j].serviceType == next.serviceType {
          PluginRetirementTypeHasOneGroup(prior, prior.cursor, j);
        }
      }
    }
  }
}

lemma PluginActiveGroupReplacementRetainsPlan(before: ServiceRetirement, after: ServiceRetirement, next: RetirementGroup)
  requires retirementGroupsFollowPlan(before) && !before.exited
  requires 0 <= before.cursor < |before.groups|
  requires next.serviceType == before.groups[before.cursor].serviceType
  requires next.phase.GroupWaiting? || next.phase.GroupStoppingInstances? || next.phase.GroupStoppingClasses?
  requires after.plan == before.plan && after.cursor == before.cursor && after.exited == before.exited
  requires |after.groups| == |before.groups|
  requires forall i | 0 <= i < |before.groups| :: after.groups[i] == (if i == before.cursor then next else before.groups[i])
  ensures retirementGroupsFollowPlan(after)
{
  hide *;
  reveal retirementGroupsFollowPlan(), retirementGroupMatchesPosition(), groupFinishedOrSkipped();
  PluginRetirementWithdrawalHasPositionEvidence(before);
  forall i | 0 <= i < |after.groups|
    ensures retirementGroupMatchesPosition(after, i, after.groups[i])
  {
    assert retirementGroupMatchesPosition(before, i, before.groups[i]);
  }
  PluginRetirementWithdrawalHasPositionEvidence(after);
  assert before.groups[before.cursor].phase.GroupFailed? == before.exited;
}

lemma PluginActiveGroupReplacementRetainsPlans(s: PluginServices, beforePlacement: PluginServices,
    next: RetirementGroup, epochId: int)
  requires alwaysRetirementsFollowTypePlan(s)
  requires currentGroup(s, epochId) != noGroup && next.serviceType == currentGroup(s, epochId).serviceType
  requires next.phase.GroupWaiting? || next.phase.GroupStoppingInstances? || next.phase.GroupStoppingClasses?
  requires var current := currentGroup(s, epochId);
    current.phase.GroupWaiting? || current.phase.GroupStoppingInstances? || current.phase.GroupStoppingClasses?
  requires beforePlacement.plugins == s.plugins && |beforePlacement.retirements| == |s.retirements|
  requires forall i | 0 <= i < |s.retirements| ::
    beforePlacement.retirements[i].(failures := s.retirements[i].failures) == s.retirements[i]
      && (s.retirements[i].epochId != epochId ==> beforePlacement.retirements[i] == s.retirements[i])
  ensures alwaysRetirementsFollowTypePlan(putCurrentGroup(next, epochId, beforePlacement))
{
  hide *;
  reveal alwaysRetirementsFollowTypePlan(), retirementGroupsFollowPlan(), currentGroup(), putCurrentGroup(), ProofLib.Filter();
  var after := putCurrentGroup(next, epochId, beforePlacement);
  PluginCurrentGroupReplacementProjects(s, beforePlacement, next, epochId);
  forall r | r in after.retirements
    ensures r.epochId > 0 && core__pluginRegistry_epoch(after.plugins, r.epochId).id == r.epochId
    ensures core__pluginRegistry_epochRetiring(after.plugins, r.epochId) ||
      !core__pluginRegistry_epochOwnsResources(after.plugins, r.epochId)
    ensures |ProofLib.Filter((other: ServiceRetirement) => other.epochId == r.epochId, after.retirements)| == 1
    ensures retirementGroupsFollowPlan(r)
  {
    var i :| 0 <= i < |after.retirements| && after.retirements[i] == r;
    var prior := s.retirements[i];
    assert prior in s.retirements && prior.epochId == r.epochId;
    var byEpoch := (other: ServiceRetirement) => other.epochId == r.epochId;
    ProofLib.FilterLengthPointwise(byEpoch, byEpoch, s.retirements, after.retirements);
    if r.epochId == epochId {
      PluginRetirementPlanLookup(s, prior);
      assert currentGroup(s, epochId) == prior.groups[prior.cursor] && !prior.exited;
      PluginActiveGroupReplacementRetainsPlan(prior, r, next);
    } else {
      assert r == prior;
    }
  }
}

lemma PluginCapturedStopIdentityHasObject(s: core__serviceInstances_ServiceInstances, id: int)
  requires core__serviceInstances_alwaysClassAndObjectIdentities(s)
  requires core__serviceInstances_serviceObject(s, id).id != 0
  ensures core__serviceInstances_canRequestObjectStop(s, id)
{
  hide *;
  reveal core__serviceInstances_canRequestObjectStop(), core__serviceInstances_serviceObject();
  reveal core__serviceInstances_alwaysClassAndObjectIdentities(), core__serviceInstances_noObject, ProofLib.Filter();
  var byId := (o: core__serviceInstances_ServiceObject) => o.id == id;
  var matches := ProofLib.Filter(byId, s.objects);
  assert |matches| > 0;
  ProofLib.FilterMember(byId, s.objects, matches[0]);
}

lemma requestOwnedStops_ensures(s: PluginServices, epochId: int)
  ensures (inv(s) ==> canRequestOwnedStops(s, epochId) ==> alwaysLiveClassOwnerUnique(requestOwnedStops(s, epochId)))
  ensures (inv(s) ==> canRequestOwnedStops(s, epochId) ==> alwaysServiceOwnerEpochExists(requestOwnedStops(s, epochId)))
  ensures (inv(s) ==> canRequestOwnedStops(s, epochId) ==> alwaysChildLifecyclesValid(requestOwnedStops(s, epochId)))
  ensures (inv(s) ==> canRequestOwnedStops(s, epochId) ==> alwaysRetirementsFollowTypePlan(requestOwnedStops(s, epochId)))
  ensures (inv(s) ==> canRequestOwnedStops(s, epochId) ==> alwaysNoOrphanInstance(requestOwnedStops(s, epochId)))
  ensures (inv(s) ==> canRequestOwnedStops(s, epochId) ==> alwaysRetiredUndeclaredTypeIsUnknown(requestOwnedStops(s, epochId)))
  ensures (inv(s) ==> canRequestOwnedStops(s, epochId) ==> alwaysStopObservationsFollowSlots(requestOwnedStops(s, epochId)))
  ensures (inv(s) ==> canRequestOwnedStops(s, epochId) ==> alwaysRetiredEpochHasNoResources(requestOwnedStops(s, epochId)))
  ensures (inv(s) ==> canRequestOwnedStops(s, epochId) ==> alwaysSealedOwnedClassesStable(requestOwnedStops(s, epochId)))
{
  hide *;
  reveal inv(), canRequestOwnedStops(), requestOwnedStops(), putCurrentGroup(), noGroup;
  reveal alwaysLiveClassOwnerUnique(), alwaysSealedOwnedClassesStable(), core__serviceInstances_reconcileType(), core__serviceInstances_putType();
  if inv(s) && canRequestOwnedStops(s, epochId) {
    var current := currentGroup(s, epochId);
    var next := current.(phase := if |current.instances| == 0 then RetirementGroupPhase.GroupStoppingClasses else RetirementGroupPhase.GroupStoppingInstances);
    var placement := s.(services := core__serviceInstances_reconcileType(current.serviceType, s.services));
    var after := requestOwnedStops(s, epochId);
    assert after == putCurrentGroup(next, epochId, placement);
    PluginActiveGroupReplacementRetainsPlans(s, placement, next, epochId);
    PluginReceiptsRetainDeclaredType(s, after);

    reveal alwaysStopObservationsFollowSlots();
    PluginActiveRetirementHasResources(s, epochId);
    PluginWaitingGroupStartsWithSameSlots(current, s.services, after.services);
    PluginActiveReplacementRetainsStopReceipts(s, placement, next, epochId);
    PluginRetirementChildRulesMatchImportedInvariants(s);
    PluginReconciliationKeepsTypeRules(s.services, current.serviceType);
    PluginReconciliationKeepsChildInvariant(s.services, current.serviceType);
    PluginRetirementChildRulesMatchImportedInvariants(after);
    PluginActiveReplacementRetainsObjectCustody(s, placement, next, epochId);
    PluginActiveReplacementRetainsTypeStatus(s, placement, next, epochId);
  }
}

lemma claimInstanceStop_ensures(s: PluginServices, epochId: int)
  ensures (inv(s) ==> canClaimInstanceStop(s, epochId) ==> alwaysLiveClassOwnerUnique(claimInstanceStop(s, epochId)))
  ensures (inv(s) ==> canClaimInstanceStop(s, epochId) ==> alwaysServiceOwnerEpochExists(claimInstanceStop(s, epochId)))
  ensures (inv(s) ==> canClaimInstanceStop(s, epochId) ==> alwaysChildLifecyclesValid(claimInstanceStop(s, epochId)))
  ensures (inv(s) ==> canClaimInstanceStop(s, epochId) ==> alwaysRetirementsFollowTypePlan(claimInstanceStop(s, epochId)))
  ensures (inv(s) ==> canClaimInstanceStop(s, epochId) ==> alwaysNoOrphanInstance(claimInstanceStop(s, epochId)))
  ensures (inv(s) ==> canClaimInstanceStop(s, epochId) ==> alwaysRetiredUndeclaredTypeIsUnknown(claimInstanceStop(s, epochId)))
  ensures (inv(s) ==> canClaimInstanceStop(s, epochId) ==> alwaysStopObservationsFollowSlots(claimInstanceStop(s, epochId)))
  ensures (inv(s) ==> canClaimInstanceStop(s, epochId) ==> alwaysRetiredEpochHasNoResources(claimInstanceStop(s, epochId)))
  ensures (inv(s) ==> canClaimInstanceStop(s, epochId) ==> alwaysSealedOwnedClassesStable(claimInstanceStop(s, epochId)))
{
  hide *;
  reveal inv(), canClaimInstanceStop(), claimInstanceStop(), putCurrentGroup(), noGroup;
  reveal alwaysLiveClassOwnerUnique(), alwaysSealedOwnedClassesStable(), core__serviceInstances_stopObjectOnce(), core__serviceInstances_requestObjectStop(), core__serviceInstances_inv();
  if inv(s) && canClaimInstanceStop(s, epochId) {
    var current := currentGroup(s, epochId);
    var objectId := currentInstance(s, epochId);
    var slot := observedInstanceSlot(objectId, InstanceStopObservation.AwaitedStopSlot);
    var next := current.(observedStops := current.observedStops + [slot]);
    var placement := s.(services := core__serviceInstances_stopObjectOnce(objectId, s.services));
    var after := claimInstanceStop(s, epochId);
    assert after == putCurrentGroup(next, epochId, placement);
    PluginActiveGroupReplacementRetainsPlans(s, placement, next, epochId);
    PluginReceiptsRetainDeclaredType(s, after);
    reveal alwaysChildLifecyclesValid();
    PluginCapturedStopIdentityHasObject(s.services, objectId);
    PluginRetirementChildRulesMatchImportedInvariants(s);
    core__serviceInstances_requestObjectStop_ensures(s.services, objectId);
    PluginRetirementChildRulesMatchImportedInvariants(after);
    reveal alwaysStopObservationsFollowSlots();
    PluginActiveRetirementHasResources(s, epochId);
    PluginActiveInstanceSlotIndex(s, epochId);
    forall i | 0 <= i < |s.services.objects|
      ensures after.services.objects[i].id == s.services.objects[i].id
        && ((s.services.objects[i].stopPhase.StopSucceeded? || s.services.objects[i].stopPhase.StopFailed?)
          ==> after.services.objects[i].stopPhase == s.services.objects[i].stopPhase)
    {}
    PluginAppendingStopSlotKeepsGroup(current, s.services, after.services, false);
    PluginActiveReplacementRetainsStopReceipts(s, placement, next, epochId);
    reveal core__serviceInstances_alwaysObjectStopOnce();
    forall i | 0 <= i < |s.services.objects|
      ensures s.services.objects[i].stopCalls <= after.services.objects[i].stopCalls
    {
      assert s.services.objects[i] in s.services.objects;
    }
    PluginActiveReplacementRetainsObjectCustody(s, placement, next, epochId);
    assert !current.phase.GroupWaiting? && placement.services.typeEntries == s.services.typeEntries;
    reveal core__serviceInstances_serviceTypeEntry();
    forall query
      ensures core__serviceInstances_serviceTypeEntry(placement.services, query).status ==
        core__serviceInstances_serviceTypeEntry(s.services, query).status
    {}
    PluginActiveReplacementRetainsTypeStatus(s, placement, next, epochId);
  }
}

lemma skipMissingStop_ensures(s: PluginServices, epochId: int)
  ensures (inv(s) ==> canSkipMissingStop(s, epochId) ==> alwaysLiveClassOwnerUnique(skipMissingStop(s, epochId)))
  ensures (inv(s) ==> canSkipMissingStop(s, epochId) ==> alwaysServiceOwnerEpochExists(skipMissingStop(s, epochId)))
  ensures (inv(s) ==> canSkipMissingStop(s, epochId) ==> alwaysChildLifecyclesValid(skipMissingStop(s, epochId)))
  ensures (inv(s) ==> canSkipMissingStop(s, epochId) ==> alwaysRetirementsFollowTypePlan(skipMissingStop(s, epochId)))
  ensures (inv(s) ==> canSkipMissingStop(s, epochId) ==> alwaysNoOrphanInstance(skipMissingStop(s, epochId)))
  ensures (inv(s) ==> canSkipMissingStop(s, epochId) ==> alwaysRetiredUndeclaredTypeIsUnknown(skipMissingStop(s, epochId)))
  ensures (inv(s) ==> canSkipMissingStop(s, epochId) ==> alwaysStopObservationsFollowSlots(skipMissingStop(s, epochId)))
  ensures (inv(s) ==> canSkipMissingStop(s, epochId) ==> alwaysRetiredEpochHasNoResources(skipMissingStop(s, epochId)))
  ensures (inv(s) ==> canSkipMissingStop(s, epochId) ==> alwaysSealedOwnedClassesStable(skipMissingStop(s, epochId)))
{
  hide *;
  reveal inv(), canSkipMissingStop(), skipMissingStop(), putCurrentGroup(), noGroup;
  reveal alwaysLiveClassOwnerUnique(), alwaysSealedOwnedClassesStable(), advanceInstanceSlot(), canClaimInstanceStop(), alwaysChildLifecyclesValid();
  if inv(s) && canSkipMissingStop(s, epochId) {
    var current := currentGroup(s, epochId);
    var slot := observedInstanceSlot(currentInstance(s, epochId), InstanceStopObservation.MissingStopSlot);
    var next := advanceInstanceSlot(current.(observedStops := current.observedStops + [slot]));
    var placement := s;
    var after := skipMissingStop(s, epochId);
    assert after == putCurrentGroup(next, epochId, placement);
    PluginActiveGroupReplacementRetainsPlans(s, placement, next, epochId);
    PluginReceiptsRetainDeclaredType(s, after);

    reveal alwaysStopObservationsFollowSlots();
    PluginActiveRetirementHasResources(s, epochId);
    PluginActiveInstanceSlotIndex(s, epochId);
    PluginAppendingStopSlotKeepsGroup(current, s.services, after.services, true);
    PluginActiveReplacementRetainsStopReceipts(s, placement, next, epochId);
    PluginActiveReplacementRetainsObjectCustody(s, placement, next, epochId);
    PluginActiveReplacementRetainsTypeStatus(s, placement, next, epochId);
  }
}

lemma observeInstanceStop_ensures(s: PluginServices, epochId: int)
  ensures (inv(s) ==> canObserveInstanceStop(s, epochId) ==> alwaysLiveClassOwnerUnique(observeInstanceStop(s, epochId)))
  ensures (inv(s) ==> canObserveInstanceStop(s, epochId) ==> alwaysServiceOwnerEpochExists(observeInstanceStop(s, epochId)))
  ensures (inv(s) ==> canObserveInstanceStop(s, epochId) ==> alwaysChildLifecyclesValid(observeInstanceStop(s, epochId)))
  ensures (inv(s) ==> canObserveInstanceStop(s, epochId) ==> alwaysRetirementsFollowTypePlan(observeInstanceStop(s, epochId)))
  ensures (inv(s) ==> canObserveInstanceStop(s, epochId) ==> alwaysNoOrphanInstance(observeInstanceStop(s, epochId)))
  ensures (inv(s) ==> canObserveInstanceStop(s, epochId) ==> alwaysRetiredUndeclaredTypeIsUnknown(observeInstanceStop(s, epochId)))
  ensures (inv(s) ==> canObserveInstanceStop(s, epochId) ==> alwaysStopObservationsFollowSlots(observeInstanceStop(s, epochId)))
  ensures (inv(s) ==> canObserveInstanceStop(s, epochId) ==> alwaysRetiredEpochHasNoResources(observeInstanceStop(s, epochId)))
  ensures (inv(s) ==> canObserveInstanceStop(s, epochId) ==> alwaysSealedOwnedClassesStable(observeInstanceStop(s, epochId)))
{
  hide *;
  reveal inv(), canObserveInstanceStop(), observeInstanceStop(), putCurrentGroup(), noGroup;
  reveal alwaysLiveClassOwnerUnique(), alwaysSealedOwnedClassesStable(), advanceInstanceSlot(), alwaysChildLifecyclesValid();
  if inv(s) && canObserveInstanceStop(s, epochId) {
    var current := currentGroup(s, epochId);
    var obj := core__serviceInstances_serviceObject(s.services, currentInstance(s, epochId));
    var placement := s.(retirements := seq(|s.retirements|, i requires 0 <= i < |s.retirements| =>
      var r := s.retirements[i]; if r.epochId == epochId && obj.stopPhase.StopFailed? then r.(failures := r.failures + [obj.errorId]) else r));
    var next := advanceInstanceSlot(current);
    var after := observeInstanceStop(s, epochId);
    assert after == putCurrentGroup(next, epochId, placement);
    PluginActiveGroupReplacementRetainsPlans(s, placement, next, epochId);
    PluginReceiptsRetainDeclaredType(s, after);

    reveal alwaysStopObservationsFollowSlots();
    PluginActiveRetirementHasResources(s, epochId);
    reveal stopSlotObservation(), noObservedInstanceSlot, stopSlotSettled(), validStopObservation();
    PluginActiveInstanceSlotIndex(s, epochId);
    PluginStopObjectUpdateGroupObservations(current, s.services);
    assert |current.observedStops| == current.instanceCursor + 1;
    var slot := current.observedStops[current.instanceCursor];
    assert validStopObservation(current, current.instanceCursor, slot, s.services);
    assert slot.instanceId == currentInstance(s, epochId) && stopSlotSettled(slot, s.services);
    PluginAdvancingSettledStopSlotKeepsGroup(current, s.services);
    PluginActiveReplacementRetainsStopReceipts(s, placement, next, epochId);
    PluginActiveReplacementRetainsObjectCustody(s, placement, next, epochId);
    PluginActiveReplacementRetainsTypeStatus(s, placement, next, epochId);
  }
}

lemma PluginActiveRetirementHasResources(s: PluginServices, epochId: int)
  requires inv(s)
  requires var g := currentGroup(s, epochId);
    g.phase.GroupWaiting? || g.phase.GroupStoppingInstances? || g.phase.GroupStoppingClasses?
  ensures core__pluginRegistry_epochOwnsResources(s.plugins, epochId)
  ensures retirement(s, epochId) in s.retirements && currentGroup(s, epochId) in retirement(s, epochId).groups
{
  hide *;
  reveal inv(), retirement(), currentGroup(), noRetirement, noGroup, ProofLib.Filter();
  reveal alwaysRetirementsFollowTypePlan(), retirementGroupsFollowPlan();
  reveal alwaysRetiredEpochHasNoResources(), retirementSettled();
  var byEpoch := (row: ServiceRetirement) => row.epochId == epochId;
  var matches := ProofLib.Filter(byEpoch, s.retirements);
  var row := retirement(s, epochId);
  var g := currentGroup(s, epochId);
  assert 0 <= row.cursor < |row.groups| && g == row.groups[row.cursor];
  assert |matches| > 0 && matches[0] == row;
  ProofLib.FilterMember(byEpoch, s.retirements, row);
  assert row in s.retirements && row.epochId == epochId;
  if !core__pluginRegistry_epochOwnsResources(s.plugins, epochId) {
    assert retirementSettled(s, epochId) && (row.exited || row.cursor == |row.plan|);
    assert !row.exited && row.cursor < |row.plan|;
    assert false;
  }
}

lemma PluginActiveInstanceSlotIndex(s: PluginServices, epochId: int)
  requires inv(s)
  requires currentGroup(s, epochId).phase.GroupStoppingInstances?
  requires core__serviceInstances_serviceObject(s.services, currentInstance(s, epochId)).id != 0
  ensures var g := currentGroup(s, epochId);
    0 <= g.instanceCursor < |g.instances| && currentInstance(s, epochId) == g.instances[g.instanceCursor]
{
  hide *;
  reveal inv(), currentInstance(), core__serviceInstances_serviceObject(), core__serviceInstances_noObject;
  reveal alwaysChildLifecyclesValid(), core__serviceInstances_alwaysClassAndObjectIdentities(), alwaysStopObservationsFollowSlots();
  reveal ProofLib.Filter();
  PluginActiveRetirementHasResources(s, epochId);
  var g := currentGroup(s, epochId);
  if g.instanceCursor == |g.instances| {
    assert currentInstance(s, epochId) == 0;
    var byId := (o: core__serviceInstances_ServiceObject) => o.id == 0;
    ProofLib.FilterNone(byId, s.services.objects);
    assert false;
  }
}

lemma PluginAppendingStopSlotKeepsGroup(g: RetirementGroup, before: core__serviceInstances_ServiceInstances,
    after: core__serviceInstances_ServiceInstances, missing: bool)
  requires g.phase.GroupStoppingInstances?
  requires 0 <= g.instanceCursor < |g.instances| && |g.observedStops| == g.instanceCursor
  requires allStopObservationsValid(g, before)
  requires |before.objects| == |after.objects|
  requires forall i | 0 <= i < |before.objects| ::
    before.objects[i].id == after.objects[i].id
      && ((before.objects[i].stopPhase.StopSucceeded? || before.objects[i].stopPhase.StopFailed?)
        ==> before.objects[i].stopPhase == after.objects[i].stopPhase)
  ensures var slot := observedInstanceSlot(g.instances[g.instanceCursor],
      if missing then InstanceStopObservation.MissingStopSlot else InstanceStopObservation.AwaitedStopSlot);
    var appended := g.(observedStops := g.observedStops + [slot]);
    var next := if missing then advanceInstanceSlot(appended) else appended;
    0 <= next.instanceCursor <= |next.instances| && next.instanceCursor <= |next.observedStops| <= |next.instances|
      && |next.observedStops| <= next.instanceCursor + 1 && classPhaseFollowsInstances(next)
      && allStopObservationsValid(next, after)
{
  hide *;
  reveal observedInstanceSlot(), advanceInstanceSlot(), classPhaseFollowsInstances(), validStopObservation(), stopSlotSettled();
  var slot := observedInstanceSlot(g.instances[g.instanceCursor],
    if missing then InstanceStopObservation.MissingStopSlot else InstanceStopObservation.AwaitedStopSlot);
  var appended := g.(observedStops := g.observedStops + [slot]);
  var next := if missing then advanceInstanceSlot(appended) else appended;
  PluginStopObjectUpdateGroupObservations(g, before);
  forall i | 0 <= i < |next.observedStops|
    ensures validStopObservation(next, i, next.observedStops[i], after)
  {
    if i < |g.observedStops| {
      assert validStopObservation(g, i, g.observedStops[i], before);
      PluginStopObjectUpdateRetainsSettledSlot(before, after, g.observedStops[i]);
    } else {
      assert i == g.instanceCursor && next.observedStops[i] == slot;
    }
  }
  PluginStopObjectUpdateGroupObservations(next, after);
}

lemma PluginAdvancingSettledStopSlotKeepsGroup(g: RetirementGroup, services: core__serviceInstances_ServiceInstances)
  requires g.phase.GroupStoppingInstances?
  requires 0 <= g.instanceCursor < |g.instances| && |g.observedStops| == g.instanceCursor + 1
  requires allStopObservationsValid(g, services)
  requires stopSlotSettled(g.observedStops[g.instanceCursor], services)
  ensures var next := advanceInstanceSlot(g);
    0 <= next.instanceCursor <= |next.instances| && next.instanceCursor <= |next.observedStops| <= |next.instances|
      && |next.observedStops| <= next.instanceCursor + 1 && classPhaseFollowsInstances(next)
      && allStopObservationsValid(next, services)
{
  hide *;
  reveal advanceInstanceSlot(), classPhaseFollowsInstances(), validStopObservation();
  var next := advanceInstanceSlot(g);
  PluginStopObjectUpdateGroupObservations(g, services);
  forall i | 0 <= i < |next.observedStops|
    ensures validStopObservation(next, i, next.observedStops[i], services)
  {
    assert validStopObservation(g, i, g.observedStops[i], services);
  }
  PluginStopObjectUpdateGroupObservations(next, services);
}

lemma PluginWaitingGroupStartsWithSameSlots(g: RetirementGroup, before: core__serviceInstances_ServiceInstances,
    after: core__serviceInstances_ServiceInstances)
  requires g.phase.GroupWaiting? && before.objects == after.objects
  requires 0 <= g.instanceCursor <= |g.instances| && g.instanceCursor <= |g.observedStops| <= |g.instances|
  requires |g.observedStops| <= g.instanceCursor + 1 && allStopObservationsValid(g, before)
  ensures var next := g.(phase := if |g.instances| == 0 then RetirementGroupPhase.GroupStoppingClasses
      else RetirementGroupPhase.GroupStoppingInstances);
    classPhaseFollowsInstances(next) && allStopObservationsValid(next, after)
{
  hide *;
  reveal classPhaseFollowsInstances(), validStopObservation();
  var next := g.(phase := if |g.instances| == 0 then RetirementGroupPhase.GroupStoppingClasses
    else RetirementGroupPhase.GroupStoppingInstances);
  PluginStopObjectUpdateGroupObservations(g, before);
  forall i | 0 <= i < |next.observedStops|
    ensures validStopObservation(next, i, next.observedStops[i], after)
  {
    assert validStopObservation(g, i, g.observedStops[i], before);
    assert i < g.instanceCursor;
    PluginServiceFrameStopSlotStable(before, after, g.observedStops[i]);
  }
  PluginStopObjectUpdateGroupObservations(next, after);
}

lemma PluginActiveReplacementRetainsStopReceipts(s: PluginServices, placement: PluginServices,
    next: RetirementGroup, epochId: int)
  requires inv(s) && currentGroup(s, epochId) != noGroup
  requires var g := currentGroup(s, epochId);
    g.phase.GroupWaiting? || g.phase.GroupStoppingInstances? || g.phase.GroupStoppingClasses?
  requires next.serviceType == currentGroup(s, epochId).serviceType && placement.plugins == s.plugins
  requires |placement.retirements| == |s.retirements|
  requires forall i | 0 <= i < |s.retirements| ::
    placement.retirements[i].epochId == s.retirements[i].epochId
      && placement.retirements[i].groups == s.retirements[i].groups
      && (s.retirements[i].epochId != epochId ==> placement.retirements[i] == s.retirements[i])
  requires |placement.services.objects| == |s.services.objects|
  requires forall i | 0 <= i < |s.services.objects| ::
    placement.services.objects[i].id == s.services.objects[i].id
      && ((s.services.objects[i].stopPhase.StopSucceeded? || s.services.objects[i].stopPhase.StopFailed?)
        ==> placement.services.objects[i].stopPhase == s.services.objects[i].stopPhase)
  requires 0 <= next.instanceCursor <= |next.instances| && next.instanceCursor <= |next.observedStops| <= |next.instances|
  requires |next.observedStops| <= next.instanceCursor + 1 && classPhaseFollowsInstances(next)
  requires allStopObservationsValid(next, placement.services)
  requires alwaysRetirementsFollowTypePlan(putCurrentGroup(next, epochId, placement))
  ensures alwaysStopObservationsFollowSlots(putCurrentGroup(next, epochId, placement))
  ensures alwaysRetiredEpochHasNoResources(putCurrentGroup(next, epochId, placement))
{
  hide *;
  reveal inv(), putCurrentGroup(), alwaysStopObservationsFollowSlots(), alwaysRetiredEpochHasNoResources(), retirementSettled();
  var after := putCurrentGroup(next, epochId, placement);
  var framed := s.(services := placement.services);
  PluginMappedObjectsRetainStopReceipts(s, framed);
  PluginActiveRetirementHasResources(s, epochId);
  PluginCurrentGroupReplacementProjects(s, placement, next, epochId);
  forall row | row in after.retirements
    ensures !core__pluginRegistry_epochOwnsResources(after.plugins, row.epochId) ==> retirementSettled(after, row.epochId)
    ensures forall g | g in row.groups ::
      0 <= g.instanceCursor <= |g.instances| && g.instanceCursor <= |g.observedStops| <= |g.instances|
        && |g.observedStops| <= g.instanceCursor + 1 && classPhaseFollowsInstances(g) && allStopObservationsValid(g, after.services)
    ensures forall g | g in row.groups && !core__pluginRegistry_epochOwnsResources(after.plugins, row.epochId) ::
      g.instanceCursor == |g.instances| && (forall slot | slot in g.observedStops :: stopSlotSettled(slot, after.services))
  {
    var i :| 0 <= i < |after.retirements| && after.retirements[i] == row;
    var previous := s.retirements[i];
    assert previous in framed.retirements && previous.epochId == row.epochId;
    if !core__pluginRegistry_epochOwnsResources(after.plugins, row.epochId) {
      assert row.epochId != epochId && row == previous;
      PluginRetirementPlanLookup(s, previous);
      PluginRetirementPlanLookup(after, row);
    }
    forall group | group in row.groups
      ensures 0 <= group.instanceCursor <= |group.instances| && group.instanceCursor <= |group.observedStops| <= |group.instances|
        && |group.observedStops| <= group.instanceCursor + 1 && classPhaseFollowsInstances(group)
        && allStopObservationsValid(group, after.services)
      ensures !core__pluginRegistry_epochOwnsResources(after.plugins, row.epochId) ==>
        (group.instanceCursor == |group.instances| && (forall slot | slot in group.observedStops :: stopSlotSettled(slot, after.services)))
    {
      var j :| 0 <= j < |row.groups| && row.groups[j] == group;
      if previous.epochId == epochId && j == previous.cursor {
        assert group == next;
      } else {
        assert group in previous.groups;
      }
    }
  }
}

lemma PluginActiveReplacementRetainsObjectCustody(s: PluginServices, placement: PluginServices,
    next: RetirementGroup, epochId: int)
  requires alwaysNoOrphanInstance(s) && alwaysRetirementsFollowTypePlan(s)
  requires var g := currentGroup(s, epochId);
    g != noGroup && next.serviceType == g.serviceType && next.instances == g.instances
      && |g.observedStops| <= |next.observedStops| && next.observedStops[..|g.observedStops|] == g.observedStops
  requires placement.plugins == s.plugins && |placement.retirements| == |s.retirements|
  requires forall i | 0 <= i < |s.retirements| ::
    placement.retirements[i].epochId == s.retirements[i].epochId && placement.retirements[i].groups == s.retirements[i].groups
  requires placement.services.classes == s.services.classes && placement.services.published == s.services.published
  requires |placement.services.objects| == |s.services.objects|
  requires forall i | 0 <= i < |s.services.objects| ::
    s.services.objects[i].id == placement.services.objects[i].id && s.services.objects[i].stopCalls <= placement.services.objects[i].stopCalls
  ensures alwaysNoOrphanInstance(putCurrentGroup(next, epochId, placement))
{
  hide *;
  reveal alwaysNoOrphanInstance(), putCurrentGroup(), currentGroup(), missingStopObservedFor();
  var after := putCurrentGroup(next, epochId, placement);
  PluginCurrentGroupReplacementProjects(s, placement, next, epochId);
  forall obj | obj in after.services.objects
    ensures obj.stopCalls > 0
      || ((exists c :: c in after.services.classes && c.live == obj.id && c.registered)
        && (exists p :: p in after.services.published && obj.id in p.instances))
      || (exists row :: (row in after.retirements &&
        (exists g :: (g in row.groups && (missingStopObservedFor(g, obj.id)
          || (core__pluginRegistry_epochOwnsResources(after.plugins, row.epochId) && obj.id in g.instances))))))
  {
    var i :| 0 <= i < |after.services.objects| && after.services.objects[i] == obj;
    var before := s.services.objects[i];
    assert before in s.services.objects && before.id == obj.id;
    if exists row :: (row in s.retirements &&
      (exists g :: (g in row.groups && (missingStopObservedFor(g, obj.id)
        || (core__pluginRegistry_epochOwnsResources(s.plugins, row.epochId) && obj.id in g.instances))))) {
      var j :| 0 <= j < |s.retirements| &&
        (exists g :: (g in s.retirements[j].groups && (missingStopObservedFor(g, obj.id)
          || (core__pluginRegistry_epochOwnsResources(s.plugins, s.retirements[j].epochId) && obj.id in g.instances))));
      var previous := s.retirements[j];
      var row := after.retirements[j];
      var k :| 0 <= k < |previous.groups| && (missingStopObservedFor(previous.groups[k], obj.id)
        || (core__pluginRegistry_epochOwnsResources(s.plugins, previous.epochId) && obj.id in previous.groups[k].instances));
      var current := row.groups[k];
      assert row in after.retirements && current in row.groups && row.epochId == previous.epochId;
      if previous.epochId == epochId && k == previous.cursor {
        assert previous in s.retirements;
        PluginRetirementPlanLookup(s, previous);
        assert previous.groups[k] == currentGroup(s, epochId) && current == next;
      } else {
        assert current == previous.groups[k];
      }
      assert current.instances == previous.groups[k].instances;
      assert |previous.groups[k].observedStops| <= |current.observedStops|;
      assert current.observedStops[..|previous.groups[k].observedStops|] == previous.groups[k].observedStops;
      if missingStopObservedFor(previous.groups[k], obj.id) {
        var slot :| slot in previous.groups[k].observedStops && slot.instanceId == obj.id && slot.observed.MissingStopSlot?;
        assert slot in current.observedStops[..|previous.groups[k].observedStops|];
        assert slot in current.observedStops && missingStopObservedFor(current, obj.id);
      }
    }
  }
}

lemma PluginActiveReplacementKeepsWaitingForOtherTypes(s: PluginServices, placement: PluginServices, next: RetirementGroup,
    epochId: int, query: string)
  requires alwaysRetirementsFollowTypePlan(s)
  requires var current := currentGroup(s, epochId);
    current != noGroup && next.serviceType == current.serviceType && (query != current.serviceType || !current.phase.GroupWaiting?)
  requires |placement.retirements| == |s.retirements|
  requires forall i | 0 <= i < |s.retirements| ::
    placement.retirements[i].epochId == s.retirements[i].epochId && placement.retirements[i].groups == s.retirements[i].groups
  requires exists r :: r in s.retirements && (exists g :: g in r.groups && g.serviceType == query && g.phase.GroupWaiting?)
  ensures var after := putCurrentGroup(next, epochId, placement);
    exists r :: r in after.retirements && (exists g :: g in r.groups && g.serviceType == query && g.phase.GroupWaiting?)
{
  hide *;
  reveal alwaysRetirementsFollowTypePlan(), currentGroup(), noGroup;
  var after := putCurrentGroup(next, epochId, placement);
  PluginCurrentGroupReplacementProjects(s, placement, next, epochId);
  var i :| 0 <= i < |s.retirements| &&
    (exists g :: g in s.retirements[i].groups && g.serviceType == query && g.phase.GroupWaiting?);
  var row := s.retirements[i];
  var j :| 0 <= j < |row.groups| && row.groups[j].serviceType == query && row.groups[j].phase.GroupWaiting?;
  if row.epochId == epochId {
    assert row in s.retirements;
    PluginRetirementPlanLookup(s, row);
    assert j != row.cursor;
  }
  assert after.retirements[i] in after.retirements && row.groups[j] in after.retirements[i].groups;
}

lemma PluginActiveReplacementRetainsTypeStatus(s: PluginServices, placement: PluginServices, next: RetirementGroup, epochId: int)
  requires inv(s)
  requires var current := currentGroup(s, epochId);
    current != noGroup && next.serviceType == current.serviceType
      && (current.phase.GroupWaiting? || current.phase.GroupStoppingInstances? || current.phase.GroupStoppingClasses?)
  requires |placement.retirements| == |s.retirements|
  requires forall i | 0 <= i < |s.retirements| ::
    placement.retirements[i].epochId == s.retirements[i].epochId && placement.retirements[i].groups == s.retirements[i].groups
  requires placement.services.declarations == s.services.declarations && placement.services.stopped == s.services.stopped
  requires forall query | query != next.serviceType || !currentGroup(s, epochId).phase.GroupWaiting? ::
    core__serviceInstances_serviceTypeEntry(placement.services, query).status == core__serviceInstances_serviceTypeEntry(s.services, query).status
  requires currentGroup(s, epochId).phase.GroupWaiting?
    && !(exists d :: d in s.services.declarations && d.serviceType == next.serviceType)
    ==> core__serviceInstances_serviceTypeEntry(placement.services, next.serviceType).status.TypeUnknown?
  ensures alwaysRetiredUndeclaredTypeIsUnknown(putCurrentGroup(next, epochId, placement))
{
  hide *;
  reveal inv(), alwaysRetiredUndeclaredTypeIsUnknown(), putCurrentGroup(), currentGroup();
  var after := putCurrentGroup(next, epochId, placement);
  var current := currentGroup(s, epochId);
  PluginCurrentGroupReplacementProjects(s, placement, next, epochId);
  if !after.services.stopped {
    forall row | row in after.retirements
      ensures forall g | g in row.groups
        && (g.phase.GroupStoppingInstances? || g.phase.GroupStoppingClasses? || g.phase.GroupFinished? || g.phase.GroupFailed?)
        && !(exists d :: d in after.services.declarations && d.serviceType == g.serviceType)
        && !(exists r :: r in after.retirements && (exists wait :: wait in r.groups && wait.serviceType == g.serviceType && wait.phase.GroupWaiting?)) ::
          core__serviceInstances_serviceTypeEntry(after.services, g.serviceType).status.TypeUnknown?
    {
      var i :| 0 <= i < |after.retirements| && after.retirements[i] == row;
      var previous := s.retirements[i];
      assert previous in s.retirements;
      if previous.epochId == epochId {
        PluginRetirementPlanLookup(s, previous);
        assert current == previous.groups[previous.cursor];
      }
      forall g | g in row.groups
        && (g.phase.GroupStoppingInstances? || g.phase.GroupStoppingClasses? || g.phase.GroupFinished? || g.phase.GroupFailed?)
        && !(exists d :: d in after.services.declarations && d.serviceType == g.serviceType)
        && !(exists r :: r in after.retirements && (exists wait :: wait in r.groups && wait.serviceType == g.serviceType && wait.phase.GroupWaiting?))
        ensures core__serviceInstances_serviceTypeEntry(after.services, g.serviceType).status.TypeUnknown?
      {
        if g.serviceType != next.serviceType || !current.phase.GroupWaiting? {
          var j :| 0 <= j < |row.groups| && row.groups[j] == g;
          var earlier := previous.groups[j];
          assert earlier in previous.groups && earlier.serviceType == g.serviceType;
          assert earlier.phase.GroupStoppingInstances? || earlier.phase.GroupStoppingClasses? || earlier.phase.GroupFinished? || earlier.phase.GroupFailed?;
          if exists r :: r in s.retirements && (exists wait :: wait in r.groups && wait.serviceType == g.serviceType && wait.phase.GroupWaiting?) {
            PluginActiveReplacementKeepsWaitingForOtherTypes(s, placement, next, epochId, g.serviceType);
            assert false;
          }
        }
      }
    }
  }
}

lemma PluginTypeEntryReplacementKeepsUniqueKeys(s: core__serviceInstances_ServiceInstances,
    entry: core__serviceInstances_TypeEntry)
  requires core__serviceInstances_alwaysTypeEntriesUnique(s)
  ensures core__serviceInstances_alwaysTypeEntriesUnique(core__serviceInstances_putType(entry, s))
{
  hide *;
  reveal core__serviceInstances_alwaysTypeEntriesUnique(), core__serviceInstances_putType(), ProofLib.Filter();
  var after := core__serviceInstances_putType(entry, s);
  var existsBefore := exists e :: e in s.typeEntries && e.serviceType == entry.serviceType;
  forall row | row in after.typeEntries
    ensures |ProofLib.Filter((e: core__serviceInstances_TypeEntry) => e.serviceType == row.serviceType, after.typeEntries)| == 1
  {
    var byType := (e: core__serviceInstances_TypeEntry) => e.serviceType == row.serviceType;
    if existsBefore {
      var i :| 0 <= i < |after.typeEntries| && after.typeEntries[i] == row;
      var previous := s.typeEntries[i];
      assert previous in s.typeEntries && previous.serviceType == row.serviceType;
      ProofLib.FilterLengthPointwise(byType, byType, s.typeEntries, after.typeEntries);
    } else {
      assert after.typeEntries == s.typeEntries + [entry];
      ProofLib.FilterAppend(byType, s.typeEntries, entry);
      if row == entry {
        ProofLib.FilterNone(byType, s.typeEntries);
      } else {
        assert row in s.typeEntries && row.serviceType != entry.serviceType;
      }
    }
  }
}

lemma PluginReconciliationKeepsTypeRules(s: core__serviceInstances_ServiceInstances, serviceType: string)
  requires core__serviceInstances_inv(s)
  ensures core__serviceInstances_alwaysTypeEntriesUnique(core__serviceInstances_reconcileType(serviceType, s))
  ensures core__serviceInstances_alwaysTypeReferencesRetained(core__serviceInstances_reconcileType(serviceType, s))
  ensures core__serviceInstances_alwaysFailedTypeHasNoPublication(core__serviceInstances_reconcileType(serviceType, s))
  ensures var after := core__serviceInstances_reconcileType(serviceType, s);
    ((!(exists d :: d in s.declarations && d.serviceType == serviceType))
      ==> core__serviceInstances_serviceTypeEntry(after, serviceType).status.TypeUnknown?)
      && (forall query | query != serviceType ::
        core__serviceInstances_serviceTypeEntry(after, query).status == core__serviceInstances_serviceTypeEntry(s, query).status)
{
  hide *;
  reveal core__serviceInstances_inv(), core__serviceInstances_reconcileType(), core__serviceInstances_putType();
  reveal core__serviceInstances_alwaysTypeReferencesRetained(), core__serviceInstances_serviceTypeEntry(), core__serviceInstances_noTypeEntry;
  reveal core__serviceInstances_hasFailedPublishedType(), core__serviceInstances_alwaysFailedTypeHasNoPublication();
  reveal core__serviceInstances_firstLive(), core__serviceInstances_publishedInstances(), ProofLib.Filter();
  var entry := core__serviceInstances_serviceTypeEntry(s, serviceType);
  var published := core__serviceInstances_firstLive(s, serviceType) != 0;
  var declared := exists d :: d in s.declarations && d.serviceType == serviceType;
  var retained := published || declared;
  var updated := entry.(serviceType := serviceType,
    status := if published then core__serviceInstances_TypeStatus.TypeRegistered
      else if declared then core__serviceInstances_TypeStatus.TypePending else core__serviceInstances_TypeStatus.TypeUnknown,
    promiseId := if retained then entry.promiseId else 0, handlerId := if retained then entry.handlerId else 0);
  var after := core__serviceInstances_reconcileType(serviceType, s);
  assert after == core__serviceInstances_putType(updated, s);
  PluginTypeEntryReplacementKeepsUniqueKeys(s, updated);
  var byType := (e: core__serviceInstances_TypeEntry) => e.serviceType == serviceType;
  var matches := ProofLib.Filter(byType, s.typeEntries);
  if |matches| > 0 {
    ProofLib.FilterMember(byType, s.typeEntries, entry);
  }
  forall e | e in after.typeEntries
    ensures e.promiseId == 0 || (exists p :: p in after.loadPromises && p.id == e.promiseId && p.serviceType == e.serviceType)
    ensures e.handlerId == 0 || (e.handlerId == e.promiseId && (exists p :: p in after.loadPromises && p.id == e.handlerId && p.phase.LoadPending?))
    ensures e.latestAggregate == 0 || (exists a :: a in after.aggregates && a.id == e.latestAggregate && a.serviceType == e.serviceType)
    ensures e.status.TypeFailed? ==> core__serviceInstances_firstLive(after, e.serviceType) == 0
  {
    if e == updated {
      if entry !in s.typeEntries { assert entry == core__serviceInstances_noTypeEntry; }
    } else {
      assert e in s.typeEntries;
    }
  }
  if published {
    PluginPublishedServiceHasDeclaration(s, serviceType);
  }
  forall query
    ensures core__serviceInstances_serviceTypeEntry(after, query).status ==
      (if query == serviceType then updated.status else core__serviceInstances_serviceTypeEntry(s, query).status)
  {
    PluginTypeLookupAfterPut(s, updated, query);
  }
}

lemma PluginReconciliationKeepsChildInvariant(s: core__serviceInstances_ServiceInstances, serviceType: string)
  requires core__serviceInstances_inv(s)
  ensures core__serviceInstances_inv(core__serviceInstances_reconcileType(serviceType, s))
{
  hide *;
  reveal core__serviceInstances_inv(), core__serviceInstances_reconcileType(), core__serviceInstances_putType();
  reveal core__serviceInstances_alwaysAggregateAndLoadIdsUnique(), core__serviceInstances_alwaysAcquisitionIdsUnique();
  reveal core__serviceInstances_alwaysInitWaitingHasNoAggregate(), core__serviceInstances_alwaysClassAndObjectIdentities();
  reveal core__serviceInstances_alwaysPendingAttemptsOwned(), core__serviceInstances_alwaysCapturedAttemptsExist();
  reveal core__serviceInstances_alwaysDeclarationsMatch(), core__serviceInstances_alwaysObjectStopOnce();
  reveal core__serviceInstances_alwaysClassOwnsKnownObjects(), core__serviceInstances_alwaysPublicationIdentitiesValid();
  reveal core__serviceInstances_alwaysAttemptGeneration(), core__serviceInstances_alwaysStoppedHasNoPublication();
  reveal core__serviceInstances_serviceClass(), core__serviceInstances_serviceAttempt(), core__serviceInstances_serviceObject();
  PluginReconciliationKeepsTypeRules(s, serviceType);
}

lemma PluginClassPhaseChangeKeepsPlan(before: ServiceRetirement, after: ServiceRetirement)
  requires retirementGroupsFollowPlan(before) && 0 <= before.cursor < |before.groups|
  requires before.groups[before.cursor].phase.GroupStoppingClasses?
  requires after.plan == before.plan && |after.groups| == |before.groups|
  requires after.groups[..before.cursor] == before.groups[..before.cursor]
  requires after.groups[before.cursor].serviceType == before.groups[before.cursor].serviceType
  requires var phase := after.groups[before.cursor].phase;
    phase.GroupFinished? || phase.GroupFailed? || phase.GroupStoppingClasses?
  requires after.cursor == before.cursor + (if after.groups[before.cursor].phase.GroupFinished? then 1 else 0)
  requires after.exited == after.groups[before.cursor].phase.GroupFailed?
  ensures retirementGroupsFollowPlan(after)
{
  hide *;
  reveal retirementGroupsFollowPlan(), retirementGroupMatchesPosition(), groupFinishedOrSkipped();
  var current := before.cursor;
  PluginRetirementWithdrawalHasPositionEvidence(before);
  assert |before.groups| == current + 1;
  forall i | 0 <= i < |after.groups|
    ensures retirementGroupMatchesPosition(after, i, after.groups[i])
  {
    if i < current {
      assert after.groups[i] == before.groups[i] && i < after.cursor;
      assert retirementGroupMatchesPosition(before, i, before.groups[i]);
    } else {
      assert i == current && i < |before.plan|;
      assert retirementGroupMatchesPosition(before, current, before.groups[current]);
    }
  }
  PluginRetirementWithdrawalHasPositionEvidence(after);
}

lemma PluginClassPhaseTransitionPreservesPlans(s: PluginServices, after: PluginServices, epochId: int,
    phase: RetirementGroupPhase)
  requires alwaysRetirementsFollowTypePlan(s) && currentGroup(s, epochId).phase.GroupStoppingClasses?
  requires phase.GroupFinished? || phase.GroupFailed? || phase.GroupStoppingClasses?
  requires after.plugins == s.plugins && |after.retirements| == |s.retirements|
  requires forall i | 0 <= i < |s.retirements| ::
    var before := s.retirements[i];
    var updated := after.retirements[i];
    updated.epochId == before.epochId && updated.plan == before.plan
      && |updated.groups| == |before.groups|
      && updated.cursor == before.cursor + (if before.epochId == epochId && phase.GroupFinished? then 1 else 0)
      && updated.exited == (if before.epochId == epochId then phase.GroupFailed? else before.exited)
      && (before.epochId != epochId ==> updated == before)
      && (before.epochId == epochId ==> (0 <= before.cursor < |before.groups|
        && updated.groups[..before.cursor] == before.groups[..before.cursor]
        && updated.groups[before.cursor].serviceType == before.groups[before.cursor].serviceType
        && updated.groups[before.cursor].phase == phase))
  ensures alwaysRetirementsFollowTypePlan(after)
{
  hide *;
  reveal alwaysRetirementsFollowTypePlan(), currentGroup(), ProofLib.Filter();
  forall row | row in after.retirements
    ensures row.epochId > 0 && core__pluginRegistry_epoch(after.plugins, row.epochId).id == row.epochId
    ensures core__pluginRegistry_epochRetiring(after.plugins, row.epochId) ||
      !core__pluginRegistry_epochOwnsResources(after.plugins, row.epochId)
    ensures |ProofLib.Filter((other: ServiceRetirement) => other.epochId == row.epochId, after.retirements)| == 1
    ensures retirementGroupsFollowPlan(row)
  {
    var i :| 0 <= i < |after.retirements| && after.retirements[i] == row;
    var prior := s.retirements[i];
    assert prior in s.retirements && prior.epochId == row.epochId;
    var byEpoch := (other: ServiceRetirement) => other.epochId == row.epochId;
    ProofLib.FilterLengthPointwise(byEpoch, byEpoch, s.retirements, after.retirements);
    if row.epochId == epochId {
      PluginRetirementPlanLookup(s, prior);
      PluginClassPhaseChangeKeepsPlan(prior, row);
    }
  }
}

lemma PluginClassPhaseCompletionKeepsSlots(g: RetirementGroup, next: RetirementGroup,
    services: core__serviceInstances_ServiceInstances)
  requires g.phase.GroupStoppingClasses? && classPhaseFollowsInstances(g)
  requires g.instanceCursor <= |g.observedStops| <= |g.instances| && allStopObservationsValid(g, services)
  requires next.(phase := g.phase, hook := g.hook) == g
  requires next.phase.GroupFinished? || next.phase.GroupFailed? || next.phase.GroupStoppingClasses?
  ensures classPhaseFollowsInstances(next) && allStopObservationsValid(next, services)
{
  hide *;
  reveal classPhaseFollowsInstances(), validStopObservation();
  PluginStopObjectUpdateGroupObservations(g, services);
  forall i | 0 <= i < |next.observedStops|
    ensures validStopObservation(next, i, next.observedStops[i], services)
  {
    assert i < g.instanceCursor && validStopObservation(g, i, g.observedStops[i], services);
  }
  PluginStopObjectUpdateGroupObservations(next, services);
}

lemma PluginClassPhaseCompletionKeepsPluginRules(s: PluginServices, placement: PluginServices, next: RetirementGroup, epochId: int)
  requires inv(s) && currentGroup(s, epochId).phase.GroupStoppingClasses?
  requires next == currentGroup(s, epochId).(phase := next.phase, hook := next.hook)
  requires next.phase.GroupFinished? || next.phase.GroupFailed? || next.phase.GroupStoppingClasses?
  requires placement.(retirements := s.retirements) == s && |placement.retirements| == |s.retirements|
  requires forall i | 0 <= i < |s.retirements| ::
    var before := s.retirements[i];
    var pending := placement.retirements[i];
    pending == (if before.epochId != epochId then before else before.(
      cursor := before.cursor + (if next.phase.GroupFinished? then 1 else 0),
      exited := next.phase.GroupFailed?, hookError := pending.hookError))
  ensures inv(putCurrentGroup(next, epochId, placement))
{
  hide *;
  reveal inv(), putCurrentGroup(), currentGroup(), noGroup, retirementGroupsFollowPlan();
  reveal alwaysLiveClassOwnerUnique(), alwaysSealedOwnedClassesStable(), alwaysChildLifecyclesValid();
  reveal alwaysStopObservationsFollowSlots();
  var current := currentGroup(s, epochId);
  var after := putCurrentGroup(next, epochId, placement);
  PluginActiveRetirementHasResources(s, epochId);
  var row := retirement(s, epochId);
  assert row in s.retirements && current in row.groups;
  PluginClassPhaseCompletionKeepsSlots(current, next, s.services);
  PluginCurrentGroupReplacementProjects(s, placement, next, epochId);
  forall i | 0 <= i < |s.retirements|
    ensures var before := s.retirements[i];
      var updated := after.retirements[i];
      updated.epochId == before.epochId && updated.plan == before.plan
        && |updated.groups| == |before.groups|
        && updated.cursor == before.cursor + (if before.epochId == epochId && next.phase.GroupFinished? then 1 else 0)
        && updated.exited == (if before.epochId == epochId then next.phase.GroupFailed? else before.exited)
        && (before.epochId != epochId ==> updated == before)
        && (before.epochId == epochId ==> (0 <= before.cursor < |before.groups|
          && updated.groups[..before.cursor] == before.groups[..before.cursor]
          && updated.groups[before.cursor].serviceType == before.groups[before.cursor].serviceType
          && updated.groups[before.cursor].phase == next.phase))
  {
    var before := s.retirements[i];
    var updated := after.retirements[i];
    if before.epochId == epochId {
      assert before in s.retirements;
      PluginRetirementPlanLookup(s, before);
      assert current == before.groups[before.cursor] && updated.groups[before.cursor] == next;
      forall j | 0 <= j < before.cursor ensures updated.groups[j] == before.groups[j] {}
      assert updated.groups[..before.cursor] == before.groups[..before.cursor];
    }
  }
  PluginClassPhaseTransitionPreservesPlans(s, after, epochId, next.phase);
  PluginReceiptsRetainDeclaredType(s, after);
  PluginActiveReplacementRetainsObjectCustody(s, placement, next, epochId);
  PluginActiveReplacementRetainsTypeStatus(s, placement, next, epochId);
  PluginActiveReplacementRetainsStopReceipts(s, placement, next, epochId);
}

lemma finishClassHook_ensures(s: PluginServices, epochId: int, ok: bool, errorId: string)
  ensures (inv(s) ==> canFinishClassHook(s, epochId, ok, errorId) ==> alwaysLiveClassOwnerUnique(finishClassHook(s, epochId, ok, errorId)))
  ensures (inv(s) ==> canFinishClassHook(s, epochId, ok, errorId) ==> alwaysServiceOwnerEpochExists(finishClassHook(s, epochId, ok, errorId)))
  ensures (inv(s) ==> canFinishClassHook(s, epochId, ok, errorId) ==> alwaysChildLifecyclesValid(finishClassHook(s, epochId, ok, errorId)))
  ensures (inv(s) ==> canFinishClassHook(s, epochId, ok, errorId) ==> alwaysRetirementsFollowTypePlan(finishClassHook(s, epochId, ok, errorId)))
  ensures (inv(s) ==> canFinishClassHook(s, epochId, ok, errorId) ==> alwaysNoOrphanInstance(finishClassHook(s, epochId, ok, errorId)))
  ensures (inv(s) ==> canFinishClassHook(s, epochId, ok, errorId) ==> alwaysRetiredUndeclaredTypeIsUnknown(finishClassHook(s, epochId, ok, errorId)))
  ensures (inv(s) ==> canFinishClassHook(s, epochId, ok, errorId) ==> alwaysStopObservationsFollowSlots(finishClassHook(s, epochId, ok, errorId)))
  ensures (inv(s) ==> canFinishClassHook(s, epochId, ok, errorId) ==> alwaysRetiredEpochHasNoResources(finishClassHook(s, epochId, ok, errorId)))
  ensures (inv(s) ==> canFinishClassHook(s, epochId, ok, errorId) ==> alwaysSealedOwnedClassesStable(finishClassHook(s, epochId, ok, errorId)))
{
  hide *;
  reveal inv(), canFinishClassHook(), finishClassHook(), retirementGroupsFollowPlan(), currentGroup(), noGroup;
  if inv(s) && canFinishClassHook(s, epochId, ok, errorId) {
    var current := currentGroup(s, epochId);
    assert current.phase.GroupStoppingClasses? && current != noGroup;
    var next := if ok then current.(hook := ClassHookPhase.HookFinished)
      else current.(hook := ClassHookPhase.HookFailed, phase := RetirementGroupPhase.GroupFailed);
    var rows := s.retirements;
    var placement := if ok then s else s.(retirements := seq(|rows|, i requires 0 <= i < |rows| =>
      if rows[i].epochId == epochId then rows[i].(exited := true, hookError := errorId) else rows[i]));
    var result := finishClassHook(s, epochId, ok, errorId);
    if ok {
      assert result == putCurrentGroup(next, epochId, placement);
    } else {
      var resultPlacement := s.(retirements := seq(|rows|, i requires 0 <= i < |rows| =>
        var r := rows[i];
        if r.epochId == epochId then r.(exited := true, hookError := errorId) else r));
      assert result == putCurrentGroup(next, epochId, resultPlacement);
      forall i | 0 <= i < |rows|
        ensures resultPlacement.retirements[i] == placement.retirements[i]
      {}
      assert resultPlacement.retirements == placement.retirements && resultPlacement == placement;
    }
    assert result == putCurrentGroup(next, epochId, placement);
    forall i | 0 <= i < |rows|
      ensures var before := rows[i];
        var pending := placement.retirements[i];
        pending == (if before.epochId != epochId then before else before.(
          cursor := before.cursor, exited := next.phase.GroupFailed?, hookError := pending.hookError))
    {
      var before := rows[i];
      if before.epochId == epochId {
        assert before in s.retirements;
        PluginRetirementPlanLookup(s, before);
        assert retirement(s, epochId) == before && 0 <= before.cursor < |before.groups|;
        reveal alwaysRetirementsFollowTypePlan();
        assert retirementGroupsFollowPlan(before) && before.groups[before.cursor] == current;
        assert !before.exited;
      }
    }
    PluginClassPhaseCompletionKeepsPluginRules(s, placement, next, epochId);
  }
}

lemma finishRetirementGroup_ensures(s: PluginServices, epochId: int)
  ensures (inv(s) ==> canFinishRetirementGroup(s, epochId) ==> alwaysLiveClassOwnerUnique(finishRetirementGroup(s, epochId)))
  ensures (inv(s) ==> canFinishRetirementGroup(s, epochId) ==> alwaysServiceOwnerEpochExists(finishRetirementGroup(s, epochId)))
  ensures (inv(s) ==> canFinishRetirementGroup(s, epochId) ==> alwaysChildLifecyclesValid(finishRetirementGroup(s, epochId)))
  ensures (inv(s) ==> canFinishRetirementGroup(s, epochId) ==> alwaysRetirementsFollowTypePlan(finishRetirementGroup(s, epochId)))
  ensures (inv(s) ==> canFinishRetirementGroup(s, epochId) ==> alwaysNoOrphanInstance(finishRetirementGroup(s, epochId)))
  ensures (inv(s) ==> canFinishRetirementGroup(s, epochId) ==> alwaysRetiredUndeclaredTypeIsUnknown(finishRetirementGroup(s, epochId)))
  ensures (inv(s) ==> canFinishRetirementGroup(s, epochId) ==> alwaysStopObservationsFollowSlots(finishRetirementGroup(s, epochId)))
  ensures (inv(s) ==> canFinishRetirementGroup(s, epochId) ==> alwaysRetiredEpochHasNoResources(finishRetirementGroup(s, epochId)))
  ensures (inv(s) ==> canFinishRetirementGroup(s, epochId) ==> alwaysSealedOwnedClassesStable(finishRetirementGroup(s, epochId)))
{
  hide *;
  reveal inv(), canFinishRetirementGroup(), finishRetirementGroup(), putCurrentGroup(), retirementGroupsFollowPlan(), currentGroup(), noGroup;
  if inv(s) && canFinishRetirementGroup(s, epochId) {
    var current := currentGroup(s, epochId);
    assert current.phase.GroupStoppingClasses? && current != noGroup;
    var next := current.(phase := RetirementGroupPhase.GroupFinished);
    var rows := s.retirements;
    var placement := s.(retirements := seq(|rows|, i requires 0 <= i < |rows| =>
      if rows[i].epochId == epochId then rows[i].(cursor := rows[i].cursor + 1) else rows[i]));
    var after := putCurrentGroup(next, epochId, placement);
    var result := finishRetirementGroup(s, epochId);
    forall i | 0 <= i < |rows|
      ensures after.retirements[i] == result.retirements[i]
      ensures var before := rows[i];
        var pending := placement.retirements[i];
        pending == (if before.epochId != epochId then before else before.(
          cursor := before.cursor + 1, exited := false, hookError := pending.hookError))
    {
      var before := rows[i];
      if before.epochId == epochId {
        assert before in s.retirements;
        PluginRetirementPlanLookup(s, before);
        assert retirement(s, epochId) == before && 0 <= before.cursor < |before.groups|;
        reveal alwaysRetirementsFollowTypePlan();
        assert retirementGroupsFollowPlan(before) && before.groups[before.cursor] == current;
        assert !before.exited;
      }
    }
    assert after.retirements == result.retirements && after == result;
    PluginClassPhaseCompletionKeepsPluginRules(s, placement, next, epochId);
  }
}

lemma finishNextClassHook_ensures(s: PluginServices, ok: bool, errorId: string)
  ensures (inv(s) ==> canFinishNextClassHook(s, ok, errorId) ==> alwaysLiveClassOwnerUnique(finishNextClassHook(s, ok, errorId)))
  ensures (inv(s) ==> canFinishNextClassHook(s, ok, errorId) ==> alwaysServiceOwnerEpochExists(finishNextClassHook(s, ok, errorId)))
  ensures (inv(s) ==> canFinishNextClassHook(s, ok, errorId) ==> alwaysChildLifecyclesValid(finishNextClassHook(s, ok, errorId)))
  ensures (inv(s) ==> canFinishNextClassHook(s, ok, errorId) ==> alwaysRetirementsFollowTypePlan(finishNextClassHook(s, ok, errorId)))
  ensures (inv(s) ==> canFinishNextClassHook(s, ok, errorId) ==> alwaysNoOrphanInstance(finishNextClassHook(s, ok, errorId)))
  ensures (inv(s) ==> canFinishNextClassHook(s, ok, errorId) ==> alwaysRetiredUndeclaredTypeIsUnknown(finishNextClassHook(s, ok, errorId)))
  ensures (inv(s) ==> canFinishNextClassHook(s, ok, errorId) ==> alwaysStopObservationsFollowSlots(finishNextClassHook(s, ok, errorId)))
  ensures (inv(s) ==> canFinishNextClassHook(s, ok, errorId) ==> alwaysRetiredEpochHasNoResources(finishNextClassHook(s, ok, errorId)))
  ensures (inv(s) ==> canFinishNextClassHook(s, ok, errorId) ==> alwaysSealedOwnedClassesStable(finishNextClassHook(s, ok, errorId)))
{
  hide *;
  reveal canFinishNextClassHook(), finishNextClassHook();
  if inv(s) && canFinishNextClassHook(s, ok, errorId) {
    finishClassHook_ensures(s, pendingClassHookEpoch(s), ok, errorId);
  }
}

lemma PluginWithdrawalKeepsStopReceipts(s: PluginServices, epochId: int)
  requires inv(s) && canWithdrawNextType(s, epochId)
  requires alwaysRetirementsFollowTypePlan(withdrawNextType(s, epochId))
  ensures alwaysStopObservationsFollowSlots(withdrawNextType(s, epochId))
  ensures alwaysRetiredEpochHasNoResources(withdrawNextType(s, epochId))
{
  hide *;
  reveal inv(), canWithdrawNextType(), withdrawNextType(), alwaysStopObservationsFollowSlots();
  reveal alwaysRetiredEpochHasNoResources(), retirementSettled(), allStopObservationsValid(), classPhaseFollowsInstances();
  reveal core__pluginRegistry_epochRetiring(), core__pluginRegistry_epochOwnsResources();
  reveal withdrawRetiringClasses(), core__serviceInstances_removePublishedInstances(), core__serviceInstances_replacePublication();
  reveal missingGroupPhase, skippedGroupPhase, uncheckedSequence, Std.Collections.Seq.FoldLeft();
  var prior := retirement(s, epochId);
  var serviceType := prior.plan[prior.cursor];
  var classes := retirementClassesForType(s, epochId, serviceType);
  PluginWithdrawalFoldKeepsClassIdentity(classes, s.services);
  var after := withdrawNextType(s, epochId);
  assert after.services.objects == s.services.objects && after.plugins == s.plugins;
  var frame := s.(services := after.services);
  PluginMappedObjectsRetainStopReceipts(s, frame);
  PluginWithdrawalGroupsKeepEarlierEntries(s, epochId);
  forall row | row in after.retirements
    ensures forall g | g in row.groups ::
      0 <= g.instanceCursor <= |g.instances| && g.instanceCursor <= |g.observedStops| <= |g.instances|
        && |g.observedStops| <= g.instanceCursor + 1 && classPhaseFollowsInstances(g)
        && allStopObservationsValid(g, after.services)
    ensures !core__pluginRegistry_epochOwnsResources(after.plugins, row.epochId) ==> retirementSettled(after, row.epochId)
    ensures forall g | g in row.groups && !core__pluginRegistry_epochOwnsResources(after.plugins, row.epochId) ::
      g.instanceCursor == |g.instances| && (forall slot | slot in g.observedStops :: stopSlotSettled(slot, after.services))
  {
    var i :| 0 <= i < |after.retirements| && after.retirements[i] == row;
    var before := s.retirements[i];
    assert before in frame.retirements && row.epochId == before.epochId;
    if !core__pluginRegistry_epochOwnsResources(after.plugins, row.epochId) {
      assert row.epochId != epochId && row == before;
      PluginRetirementPlanLookup(s, before);
      PluginRetirementPlanLookup(after, row);
    }
    forall g | g in row.groups
      ensures 0 <= g.instanceCursor <= |g.instances| && g.instanceCursor <= |g.observedStops| <= |g.instances|
        && |g.observedStops| <= g.instanceCursor + 1 && classPhaseFollowsInstances(g)
        && allStopObservationsValid(g, after.services)
      ensures !core__pluginRegistry_epochOwnsResources(after.plugins, row.epochId) ==>
        (g.instanceCursor == |g.instances| && (forall slot | slot in g.observedStops :: stopSlotSettled(slot, after.services)))
    {
      var j :| 0 <= j < |row.groups| && row.groups[j] == g;
      if j < |before.groups| {
        assert g in before.groups;
      } else {
        assert j == |before.groups| && before.epochId == epochId;
        assert g.observedStops == [] && g.instanceCursor == 0;
        assert g.phase.GroupWaiting? || (g.phase.GroupSkipped? && g.instances == []);
      }
    }
  }
}
