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
