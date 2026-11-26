lemma PluginEpochIdentityFilters(s: PluginServices)
  ensures alwaysEpochIdentityUnique(s) ==
    (s.nextEpoch > 0 && forall e :: e in s.epochs ==> e.id > 0 && e.id < s.nextEpoch && |ProofLib.Filter((other: PluginEpoch) => (other.id == e.id), s.epochs)| == 1)
{}

lemma PluginEpochNameFilters(s: PluginServices)
  ensures alwaysOneActiveEpochPerName(s) ==
    (forall e :: e in s.epochs && activePhase(e.lifecycle.phase) ==> |ProofLib.Filter((other: PluginEpoch) => ((other.name == e.name) && activePhase(other.lifecycle.phase)), s.epochs)| == 1)
{}

lemma PluginEpochMapIdentity(before: PluginServices, after: PluginServices)
  requires alwaysEpochIdentityUnique(before) && before.nextEpoch == after.nextEpoch
  requires |before.epochs| == |after.epochs|
  requires forall i :: 0 <= i < |before.epochs| ==> before.epochs[i].id == after.epochs[i].id
  ensures alwaysEpochIdentityUnique(after)
{
  PluginEpochIdentityFilters(before);
  PluginEpochIdentityFilters(after);
  forall e | e in after.epochs
    ensures e.id > 0 && e.id < after.nextEpoch && |ProofLib.Filter((other: PluginEpoch) => (other.id == e.id), after.epochs)| == 1
  {
    var i :| 0 <= i < |after.epochs| && after.epochs[i] == e;
    assert before.epochs[i] in before.epochs;
    ProofLib.FilterLengthPointwise((other: PluginEpoch) => (other.id == e.id), (other: PluginEpoch) => (other.id == e.id), before.epochs, after.epochs);
  }
}

lemma PluginEpochMapNames(before: PluginServices, after: PluginServices)
  requires alwaysOneActiveEpochPerName(before)
  requires |before.epochs| == |after.epochs|
  requires forall i :: 0 <= i < |before.epochs| ==>
    (before.epochs[i].name == after.epochs[i].name &&
      (activePhase(after.epochs[i].lifecycle.phase) ==> activePhase(before.epochs[i].lifecycle.phase)))
  ensures alwaysOneActiveEpochPerName(after)
{
  PluginEpochNameFilters(before);
  PluginEpochNameFilters(after);
  forall e | e in after.epochs && activePhase(e.lifecycle.phase)
    ensures |ProofLib.Filter((other: PluginEpoch) => ((other.name == e.name) && activePhase(other.lifecycle.phase)), after.epochs)| == 1
  {
    var i :| 0 <= i < |after.epochs| && after.epochs[i] == e;
    var prior := before.epochs[i];
    assert prior in before.epochs && activePhase(prior.lifecycle.phase) && prior.name == e.name;
    var byName := (other: PluginEpoch) => ((other.name == e.name) && activePhase(other.lifecycle.phase));
    var beforeMatches := ProofLib.Filter(byName, before.epochs);
    ProofLib.FilterMember(byName, before.epochs, prior);
    assert |beforeMatches| == 1 && beforeMatches[0] == prior;
    assert before.epochs[i] == prior && byName(prior) && byName(after.epochs[i]);
    forall j | 0 <= j < |after.epochs| && i != j ensures !byName(after.epochs[j])
    {
      var other := after.epochs[j];
      if byName(other) {
        var previousItem := before.epochs[j];
        assert previousItem in before.epochs && byName(previousItem);
        ProofLib.FilterTwo(byName, before.epochs, i, j);
        assert false;
      }
    }
    ProofLib.FilterOne(byName, after.epochs, i);
    ProofLib.FilterMember(byName, after.epochs, e);
  }
}

lemma PluginEpochLookup(s: PluginServices, epochId: int)
  ensures epoch(s, epochId) == (var matches := ProofLib.Filter((e: PluginEpoch) => (e.id == epochId), s.epochs); if |matches| > 0 then matches[0] else absentEpoch)
{}

lemma PluginEpochExact(s: PluginServices, item: PluginEpoch)
  requires alwaysEpochIdentityUnique(s) && item in s.epochs
  ensures epoch(s, item.id) == item
{
  PluginEpochLookup(s, item.id);
  PluginEpochIdentityFilters(s);
  var matching := ProofLib.Filter((e: PluginEpoch) => (e.id == item.id), s.epochs);
  ProofLib.FilterSamePredicate((e: PluginEpoch) => (e.id == item.id), (other: PluginEpoch) => (other.id == item.id), s.epochs);
  ProofLib.FilterMember((e: PluginEpoch) => (e.id == item.id), s.epochs, item);
  assert |matching| == 1 && matching[0] == item;
}

lemma EpochsAfterBeginPlugin(s: PluginServices, name: string, adapter: bool)
  requires alwaysEpochIdentityUnique(s) && alwaysOneActiveEpochPerName(s) && alwaysEpochOutcomeHonest(s)
  requires canBeginPlugin(s, name, adapter)
  ensures alwaysEpochIdentityUnique(beginPlugin(s, name, adapter))
  ensures alwaysOneActiveEpochPerName(beginPlugin(s, name, adapter))
  ensures alwaysEpochOutcomeHonest(beginPlugin(s, name, adapter))
{
  if canBeginPlugin(s, name, adapter) {
    var after := beginPlugin(s, name, adapter);
    var created := PluginEpoch(s.nextEpoch, name, core__plugins_beginRegistration(core__plugins_initial, adapter));
    assert after.epochs == s.epochs + [created];
    PluginEpochIdentityFilters(s);
    PluginEpochIdentityFilters(after);
    PluginEpochNameFilters(s);
    PluginEpochNameFilters(after);
    forall item | item in after.epochs
      ensures item.id > 0 && item.id < after.nextEpoch && |ProofLib.Filter((other: PluginEpoch) => (other.id == item.id), after.epochs)| == 1
    {
      ProofLib.FilterAppend((other: PluginEpoch) => (other.id == item.id), s.epochs, created);
      if item == created { ProofLib.FilterNone((other: PluginEpoch) => (other.id == item.id), s.epochs); }
      else { assert item in s.epochs; }
    }
    forall item | item in after.epochs && activePhase(item.lifecycle.phase)
      ensures |ProofLib.Filter((other: PluginEpoch) => ((other.name == item.name) && activePhase(other.lifecycle.phase)), after.epochs)| == 1
    {
      var sameName := (other: PluginEpoch) => ((other.name == item.name) && activePhase(other.lifecycle.phase));
      ProofLib.FilterAppend(sameName, s.epochs, created);
      if item == created { ProofLib.FilterNone(sameName, s.epochs); }
      else {
        assert item in s.epochs;
        assert item.name != name;
      }
    }
  }
}

lemma EpochsAfterJoinPlugin(s: PluginServices, epochId: int)
  requires alwaysEpochIdentityUnique(s) && alwaysOneActiveEpochPerName(s) && alwaysEpochOutcomeHonest(s)
  requires canJoinPlugin(s, epochId)
  ensures alwaysEpochIdentityUnique(joinPlugin(s, epochId))
  ensures alwaysOneActiveEpochPerName(joinPlugin(s, epochId))
  ensures alwaysEpochOutcomeHonest(joinPlugin(s, epochId))
{
  if canJoinPlugin(s, epochId) {
    var after := joinPlugin(s, epochId);
    PluginEpochMapIdentity(s, after);
    PluginEpochMapNames(s, after);
    forall item | item in after.epochs
      ensures core__plugins_alwaysRegistrationOutcomeAgrees(item.lifecycle) &&
        core__plugins_alwaysOneDispose(item.lifecycle) && core__plugins_alwaysCleanedHasNoContributions(item.lifecycle) &&
        core__plugins_alwaysServiceStopsOnce(item.lifecycle) && core__plugins_alwaysConnectorWithdrawalFollowsDisposal(item.lifecycle)
    {
      var i :| 0 <= i < |after.epochs| && after.epochs[i] == item;
      var prior := s.epochs[i];
      assert prior in s.epochs;
      if prior.id == epochId {
        PluginEpochExact(s, prior);
        core__plugins_joinRegistration_ensures(prior.lifecycle);
      }
    }
  }
}

lemma EpochsAfterCommitPlugin(s: PluginServices, epochId: int)
  requires alwaysEpochIdentityUnique(s) && alwaysOneActiveEpochPerName(s) && alwaysEpochOutcomeHonest(s)
  requires canCommitPlugin(s, epochId)
  ensures alwaysEpochIdentityUnique(commitPlugin(s, epochId))
  ensures alwaysOneActiveEpochPerName(commitPlugin(s, epochId))
  ensures alwaysEpochOutcomeHonest(commitPlugin(s, epochId))
{
  if canCommitPlugin(s, epochId) {
    var after := commitPlugin(s, epochId);
    forall i | 0 <= i < |s.epochs|
      ensures s.epochs[i].name == after.epochs[i].name &&
        (activePhase(after.epochs[i].lifecycle.phase) ==> activePhase(s.epochs[i].lifecycle.phase))
    {
      var prior := s.epochs[i];
      assert prior in s.epochs;
      if prior.id == epochId {
        PluginEpochExact(s, prior);
      }
    }
    PluginEpochMapIdentity(s, after);
    PluginEpochMapNames(s, after);
    forall item | item in after.epochs
      ensures core__plugins_alwaysRegistrationOutcomeAgrees(item.lifecycle) &&
        core__plugins_alwaysOneDispose(item.lifecycle) && core__plugins_alwaysCleanedHasNoContributions(item.lifecycle) &&
        core__plugins_alwaysServiceStopsOnce(item.lifecycle) && core__plugins_alwaysConnectorWithdrawalFollowsDisposal(item.lifecycle)
    {
      var i :| 0 <= i < |after.epochs| && after.epochs[i] == item;
      var prior := s.epochs[i];
      assert prior in s.epochs;
      if prior.id == epochId {
        PluginEpochExact(s, prior);
        core__plugins_commitRegistration_ensures(prior.lifecycle);
      }
    }
  }
}

lemma EpochsAfterFailPlugin(s: PluginServices, epochId: int)
  requires alwaysEpochIdentityUnique(s) && alwaysOneActiveEpochPerName(s) && alwaysEpochOutcomeHonest(s)
  requires canFailPlugin(s, epochId)
  ensures alwaysEpochIdentityUnique(failPlugin(s, epochId))
  ensures alwaysOneActiveEpochPerName(failPlugin(s, epochId))
  ensures alwaysEpochOutcomeHonest(failPlugin(s, epochId))
{
  if canFailPlugin(s, epochId) {
    var after := failPlugin(s, epochId);
    forall i | 0 <= i < |s.epochs|
      ensures s.epochs[i].name == after.epochs[i].name &&
        (activePhase(after.epochs[i].lifecycle.phase) ==> activePhase(s.epochs[i].lifecycle.phase))
    {
      var prior := s.epochs[i];
      assert prior in s.epochs;
      if prior.id == epochId {
        PluginEpochExact(s, prior);
      }
    }
    PluginEpochMapIdentity(s, after);
    PluginEpochMapNames(s, after);
    forall item | item in after.epochs
      ensures core__plugins_alwaysRegistrationOutcomeAgrees(item.lifecycle) &&
        core__plugins_alwaysOneDispose(item.lifecycle) && core__plugins_alwaysCleanedHasNoContributions(item.lifecycle) &&
        core__plugins_alwaysServiceStopsOnce(item.lifecycle) && core__plugins_alwaysConnectorWithdrawalFollowsDisposal(item.lifecycle)
    {
      var i :| 0 <= i < |after.epochs| && after.epochs[i] == item;
      var prior := s.epochs[i];
      assert prior in s.epochs;
      if prior.id == epochId {
        PluginEpochExact(s, prior);
        core__plugins_failRegistration_ensures(prior.lifecycle);
      }
    }
  }
}

lemma EpochsAfterUnloadPlugin(s: PluginServices, epochId: int)
  requires alwaysEpochIdentityUnique(s) && alwaysOneActiveEpochPerName(s) && alwaysEpochOutcomeHonest(s)
  requires canUnloadPlugin(s, epochId)
  ensures alwaysEpochIdentityUnique(unloadPlugin(s, epochId))
  ensures alwaysOneActiveEpochPerName(unloadPlugin(s, epochId))
  ensures alwaysEpochOutcomeHonest(unloadPlugin(s, epochId))
{
  if canUnloadPlugin(s, epochId) {
    var after := unloadPlugin(s, epochId);
    forall i | 0 <= i < |s.epochs|
      ensures s.epochs[i].name == after.epochs[i].name &&
        (activePhase(after.epochs[i].lifecycle.phase) ==> activePhase(s.epochs[i].lifecycle.phase))
    {
      var prior := s.epochs[i];
      assert prior in s.epochs;
      if prior.id == epochId {
        PluginEpochExact(s, prior);
      }
    }
    PluginEpochMapIdentity(s, after);
    PluginEpochMapNames(s, after);
    forall item | item in after.epochs
      ensures core__plugins_alwaysRegistrationOutcomeAgrees(item.lifecycle) &&
        core__plugins_alwaysOneDispose(item.lifecycle) && core__plugins_alwaysCleanedHasNoContributions(item.lifecycle) &&
        core__plugins_alwaysServiceStopsOnce(item.lifecycle) && core__plugins_alwaysConnectorWithdrawalFollowsDisposal(item.lifecycle)
    {
      var i :| 0 <= i < |after.epochs| && after.epochs[i] == item;
      var prior := s.epochs[i];
      assert prior in s.epochs;
      if prior.id == epochId {
        PluginEpochExact(s, prior);
        core__plugins_beginUnload_ensures(prior.lifecycle);
      }
    }
  }
}

lemma EpochsAfterDisposePlugin(s: PluginServices, epochId: int, ok: bool)
  requires alwaysEpochIdentityUnique(s) && alwaysOneActiveEpochPerName(s) && alwaysEpochOutcomeHonest(s)
  requires canDisposePlugin(s, epochId, ok)
  ensures alwaysEpochIdentityUnique(disposePlugin(s, epochId, ok))
  ensures alwaysOneActiveEpochPerName(disposePlugin(s, epochId, ok))
  ensures alwaysEpochOutcomeHonest(disposePlugin(s, epochId, ok))
{
  if canDisposePlugin(s, epochId, ok) {
    var after := disposePlugin(s, epochId, ok);
    PluginEpochMapIdentity(s, after);
    PluginEpochMapNames(s, after);
    forall item | item in after.epochs
      ensures core__plugins_alwaysRegistrationOutcomeAgrees(item.lifecycle) &&
        core__plugins_alwaysOneDispose(item.lifecycle) && core__plugins_alwaysCleanedHasNoContributions(item.lifecycle) &&
        core__plugins_alwaysServiceStopsOnce(item.lifecycle) && core__plugins_alwaysConnectorWithdrawalFollowsDisposal(item.lifecycle)
    {
      var i :| 0 <= i < |after.epochs| && after.epochs[i] == item;
      var prior := s.epochs[i];
      assert prior in s.epochs;
      if prior.id == epochId {
        PluginEpochExact(s, prior);
        core__plugins_finishDispose_ensures(prior.lifecycle, ok);
      }
    }
  }
}

lemma EpochsAfterCleanPlugin(s: PluginServices, epochId: int)
  requires alwaysEpochIdentityUnique(s) && alwaysOneActiveEpochPerName(s) && alwaysEpochOutcomeHonest(s)
  requires canCleanPlugin(s, epochId)
  ensures alwaysEpochIdentityUnique(cleanPlugin(s, epochId))
  ensures alwaysOneActiveEpochPerName(cleanPlugin(s, epochId))
  ensures alwaysEpochOutcomeHonest(cleanPlugin(s, epochId))
{
  if canCleanPlugin(s, epochId) {
    var after := cleanPlugin(s, epochId);
    PluginEpochMapIdentity(s, after);
    PluginEpochMapNames(s, after);
    forall item | item in after.epochs
      ensures core__plugins_alwaysRegistrationOutcomeAgrees(item.lifecycle) &&
        core__plugins_alwaysOneDispose(item.lifecycle) && core__plugins_alwaysCleanedHasNoContributions(item.lifecycle) &&
        core__plugins_alwaysServiceStopsOnce(item.lifecycle) && core__plugins_alwaysConnectorWithdrawalFollowsDisposal(item.lifecycle)
    {
      var i :| 0 <= i < |after.epochs| && after.epochs[i] == item;
      var prior := s.epochs[i];
      assert prior in s.epochs;
      if prior.id == epochId {
        PluginEpochExact(s, prior);
        core__plugins_finishCleanup_ensures(prior.lifecycle);
      }
    }
  }
}

lemma EpochIdLookup(s: PluginServices, x: int)
  requires alwaysEpochIdentityUnique(s)
  ensures (exists e :: e in s.epochs && e.id == x) ==> epoch(s, x) in s.epochs && epoch(s, x).id == x
  ensures !(exists e :: e in s.epochs && e.id == x) ==> epoch(s, x) == absentEpoch
{
  PluginEpochLookup(s, x);
  if e :| e in s.epochs && e.id == x {
    PluginEpochExact(s, e);
  } else {
    ProofLib.FilterNone((e: PluginEpoch) => (e.id == x), s.epochs);
  }
}

lemma EpochMapView(s: PluginServices, after: PluginServices)
  requires alwaysEpochIdentityUnique(s) && alwaysEpochIdentityUnique(after)
  requires |after.epochs| == |s.epochs|
  requires forall i :: 0 <= i < |s.epochs| ==> (after.epochs[i].id == s.epochs[i].id && activePhase(after.epochs[i].lifecycle.phase) == activePhase(s.epochs[i].lifecycle.phase))
  ensures forall x :: epoch(after, x).id == epoch(s, x).id && epochOwnsResources(after, x) == epochOwnsResources(s, x)
  ensures (forall i :: 0 <= i < |s.epochs| ==> (after.epochs[i].lifecycle.phase.Registering? || after.epochs[i].lifecycle.phase.Loaded?) == (s.epochs[i].lifecycle.phase.Registering? || s.epochs[i].lifecycle.phase.Loaded?)) ==> forall x :: epochAdmitsClass(after, x) == epochAdmitsClass(s, x)
{
  forall x ensures epoch(after, x).id == epoch(s, x).id && epochOwnsResources(after, x) == epochOwnsResources(s, x) &&
    ((forall i :: 0 <= i < |s.epochs| ==> (after.epochs[i].lifecycle.phase.Registering? || after.epochs[i].lifecycle.phase.Loaded?) == (s.epochs[i].lifecycle.phase.Registering? || s.epochs[i].lifecycle.phase.Loaded?)) ==> epochAdmitsClass(after, x) == epochAdmitsClass(s, x))
  {
    EpochIdLookup(s, x);
    EpochIdLookup(after, x);
    if e :| e in s.epochs && e.id == x {
      var i :| 0 <= i < |s.epochs| && s.epochs[i] == e;
      assert after.epochs[i] in after.epochs;
      PluginEpochExact(after, after.epochs[i]);
      PluginEpochExact(s, e);
    } else if e :| e in after.epochs && e.id == x {
      var i :| 0 <= i < |after.epochs| && after.epochs[i] == e;
      assert s.epochs[i] in s.epochs;
    }
  }
}

lemma EpochOwnsGrow(s: PluginServices, after: PluginServices)
  requires after.services == s.services && after.retirements == s.retirements
  requires forall x :: epochOwnsResources(s, x) ==> epochOwnsResources(after, x)
  requires alwaysNoOrphanInstance(s) && alwaysRetiredUndeclaredTypeIsUnknown(s) && alwaysRetiredEpochHasNoResources(s) && alwaysLiveInstanceReachable(s)
  ensures alwaysNoOrphanInstance(after) && alwaysRetiredUndeclaredTypeIsUnknown(after) && alwaysRetiredEpochHasNoResources(after) && alwaysLiveInstanceReachable(after)
{
  assert forall x :: retirementSettled(after, x) == retirementSettled(s, x);
}

lemma EpochOwnerFrame(s: PluginServices, after: PluginServices)
  requires after.ownership == s.ownership && after.requestsClosed == s.requestsClosed
  requires forall o :: o in s.ownership ==> epoch(after, o.epochId).id == epoch(s, o.epochId).id
  requires alwaysServiceOwnerEpochExists(s)
  ensures alwaysServiceOwnerEpochExists(after) && alwaysSealedOwnedClassesStable(after)
{
}

lemma RetirementAppendLookup(s: PluginServices, after: PluginServices, added: ServiceRetirement)
  requires after.retirements == s.retirements + [added]
  ensures forall r :: r in s.retirements ==> retirement(after, r.epochId) == retirement(s, r.epochId)
{
  forall r | r in s.retirements ensures retirement(after, r.epochId) == retirement(s, r.epochId)
  {
    var p := (x: ServiceRetirement) => (x.epochId == r.epochId);
    ProofLib.FilterAppend(p, s.retirements, added);
    ProofLib.FilterMember(p, s.retirements, r);
  }
}

lemma CaptureRetirementFrame(s: PluginServices, epochId: int)
  requires epochOwnsResources(s, epochId)
  requires alwaysNoOrphanInstance(s) && alwaysRetiredUndeclaredTypeIsUnknown(s) && alwaysRetiredEpochHasNoResources(s)
  requires alwaysStopObservationsFollowSlots(s) && alwaysLiveInstanceReachable(s)
  ensures alwaysLiveInstanceReachable(captureRetirement(epochId, s))
  ensures alwaysNoOrphanInstance(captureRetirement(epochId, s))
  ensures alwaysRetiredUndeclaredTypeIsUnknown(captureRetirement(epochId, s))
  ensures alwaysRetiredEpochHasNoResources(captureRetirement(epochId, s))
  ensures alwaysStopObservationsFollowSlots(captureRetirement(epochId, s))
{
  var after := captureRetirement(epochId, s);
  var added := ServiceRetirement(epochId, plannedTypes(s, epochId), [], 0, [], false, "");
  assert after.retirements == s.retirements + [added];
  RetirementAppendLookup(s, after, added);
  assert forall x :: epochOwnsResources(after, x) == epochOwnsResources(s, x);
}

lemma EpochMapRules(s: PluginServices, after: PluginServices)
  requires inv(s)
  requires alwaysEpochIdentityUnique(after)
  requires after.services == s.services && after.retirements == s.retirements && after.ownership == s.ownership && after.requestsClosed == s.requestsClosed
  requires |after.epochs| == |s.epochs|
  requires forall i :: 0 <= i < |s.epochs| ==> (after.epochs[i].id == s.epochs[i].id && activePhase(after.epochs[i].lifecycle.phase) == activePhase(s.epochs[i].lifecycle.phase))
  ensures alwaysServiceOwnerEpochExists(after) && alwaysSealedOwnedClassesStable(after)
  ensures alwaysNoOrphanInstance(after) && alwaysRetiredUndeclaredTypeIsUnknown(after) && alwaysRetiredEpochHasNoResources(after) && alwaysLiveInstanceReachable(after)
  ensures (forall i :: 0 <= i < |s.epochs| ==> (after.epochs[i].lifecycle.phase.Registering? || after.epochs[i].lifecycle.phase.Loaded?) == (s.epochs[i].lifecycle.phase.Registering? || s.epochs[i].lifecycle.phase.Loaded?)) ==> alwaysRetirementPerRetiredEpoch(after)
{
  EpochMapView(s, after);
  EpochOwnsGrow(s, after);
  EpochOwnerFrame(s, after);
}

lemma EpochMapPhases(s: PluginServices, after: PluginServices, epochId: int)
  requires alwaysEpochIdentityUnique(s)
  requires |after.epochs| == |s.epochs|
  requires forall i :: 0 <= i < |s.epochs| ==> (after.epochs[i].id == s.epochs[i].id && (s.epochs[i].id != epochId ==> after.epochs[i] == s.epochs[i]))
  requires activePhase(epoch(s, epochId).lifecycle.phase)
  requires forall i :: 0 <= i < |s.epochs| && s.epochs[i].id == epochId ==> activePhase(after.epochs[i].lifecycle.phase)
  ensures forall i :: 0 <= i < |s.epochs| ==> activePhase(after.epochs[i].lifecycle.phase) == activePhase(s.epochs[i].lifecycle.phase)
{
  forall i | 0 <= i < |s.epochs| && s.epochs[i].id == epochId
    ensures activePhase(s.epochs[i].lifecycle.phase)
  {
    assert s.epochs[i] in s.epochs;
    PluginEpochExact(s, s.epochs[i]);
  }
}

lemma beginPlugin_ensures(s: PluginServices, name: string, adapter: bool)
  ensures (inv(s) ==> canBeginPlugin(s, name, adapter) ==> alwaysEpochIdentityUnique(beginPlugin(s, name, adapter)))
  ensures (inv(s) ==> canBeginPlugin(s, name, adapter) ==> alwaysOneActiveEpochPerName(beginPlugin(s, name, adapter)))
  ensures (inv(s) ==> canBeginPlugin(s, name, adapter) ==> alwaysEpochOutcomeHonest(beginPlugin(s, name, adapter)))
  ensures (inv(s) ==> canBeginPlugin(s, name, adapter) ==> alwaysRetirementPerRetiredEpoch(beginPlugin(s, name, adapter)))
  ensures (inv(s) ==> canBeginPlugin(s, name, adapter) ==> alwaysLiveClassOwnerUnique(beginPlugin(s, name, adapter)))
  ensures (inv(s) ==> canBeginPlugin(s, name, adapter) ==> alwaysServiceOwnerEpochExists(beginPlugin(s, name, adapter)))
  ensures (inv(s) ==> canBeginPlugin(s, name, adapter) ==> alwaysChildLifecyclesValid(beginPlugin(s, name, adapter)))
  ensures (inv(s) ==> canBeginPlugin(s, name, adapter) ==> alwaysOwnedClassesMatchServices(beginPlugin(s, name, adapter)))
  ensures (inv(s) ==> canBeginPlugin(s, name, adapter) ==> alwaysInvokingStartHasNoInstance(beginPlugin(s, name, adapter)))
  ensures (inv(s) ==> canBeginPlugin(s, name, adapter) ==> alwaysRetirementFollowsPlan(beginPlugin(s, name, adapter)))
  ensures (inv(s) ==> canBeginPlugin(s, name, adapter) ==> alwaysLiveInstanceReachable(beginPlugin(s, name, adapter)))
  ensures (inv(s) ==> canBeginPlugin(s, name, adapter) ==> alwaysNoOrphanInstance(beginPlugin(s, name, adapter)))
  ensures (inv(s) ==> canBeginPlugin(s, name, adapter) ==> alwaysStopObservationsFollowSlots(beginPlugin(s, name, adapter)))
  ensures (inv(s) ==> canBeginPlugin(s, name, adapter) ==> alwaysRetiredUndeclaredTypeIsUnknown(beginPlugin(s, name, adapter)))
  ensures (inv(s) ==> canBeginPlugin(s, name, adapter) ==> alwaysRetiredEpochHasNoResources(beginPlugin(s, name, adapter)))
  ensures (inv(s) ==> canBeginPlugin(s, name, adapter) ==> alwaysSealedOwnedClassesStable(beginPlugin(s, name, adapter)))
{
  if inv(s) && canBeginPlugin(s, name, adapter) {
    var after := beginPlugin(s, name, adapter);
    EpochsAfterBeginPlugin(s, name, adapter);
    assert after.epochs == s.epochs + [PluginEpoch(s.nextEpoch, name, core__plugins_beginRegistration(core__plugins_initial, adapter))];
    forall x | x != s.nextEpoch ensures epoch(after, x) == epoch(s, x)
    {
      EpochIdLookup(s, x);
      EpochIdLookup(after, x);
      if e :| e in s.epochs && e.id == x {
        assert e in after.epochs;
        PluginEpochExact(after, e);
        PluginEpochExact(s, e);
      } else if e :| e in after.epochs && e.id == x {
        assert e in s.epochs;
      }
    }
    EpochIdLookup(s, s.nextEpoch);
    forall o | o in s.ownership ensures o.epochId != s.nextEpoch {}
    EpochOwnsGrow(s, after);
    EpochOwnerFrame(s, after);
  }
}

lemma joinPlugin_ensures(s: PluginServices, epochId: int)
  ensures (inv(s) ==> canJoinPlugin(s, epochId) ==> alwaysEpochIdentityUnique(joinPlugin(s, epochId)))
  ensures (inv(s) ==> canJoinPlugin(s, epochId) ==> alwaysOneActiveEpochPerName(joinPlugin(s, epochId)))
  ensures (inv(s) ==> canJoinPlugin(s, epochId) ==> alwaysEpochOutcomeHonest(joinPlugin(s, epochId)))
  ensures (inv(s) ==> canJoinPlugin(s, epochId) ==> alwaysRetirementPerRetiredEpoch(joinPlugin(s, epochId)))
  ensures (inv(s) ==> canJoinPlugin(s, epochId) ==> alwaysLiveClassOwnerUnique(joinPlugin(s, epochId)))
  ensures (inv(s) ==> canJoinPlugin(s, epochId) ==> alwaysServiceOwnerEpochExists(joinPlugin(s, epochId)))
  ensures (inv(s) ==> canJoinPlugin(s, epochId) ==> alwaysChildLifecyclesValid(joinPlugin(s, epochId)))
  ensures (inv(s) ==> canJoinPlugin(s, epochId) ==> alwaysOwnedClassesMatchServices(joinPlugin(s, epochId)))
  ensures (inv(s) ==> canJoinPlugin(s, epochId) ==> alwaysInvokingStartHasNoInstance(joinPlugin(s, epochId)))
  ensures (inv(s) ==> canJoinPlugin(s, epochId) ==> alwaysRetirementFollowsPlan(joinPlugin(s, epochId)))
  ensures (inv(s) ==> canJoinPlugin(s, epochId) ==> alwaysLiveInstanceReachable(joinPlugin(s, epochId)))
  ensures (inv(s) ==> canJoinPlugin(s, epochId) ==> alwaysNoOrphanInstance(joinPlugin(s, epochId)))
  ensures (inv(s) ==> canJoinPlugin(s, epochId) ==> alwaysStopObservationsFollowSlots(joinPlugin(s, epochId)))
  ensures (inv(s) ==> canJoinPlugin(s, epochId) ==> alwaysRetiredUndeclaredTypeIsUnknown(joinPlugin(s, epochId)))
  ensures (inv(s) ==> canJoinPlugin(s, epochId) ==> alwaysRetiredEpochHasNoResources(joinPlugin(s, epochId)))
  ensures (inv(s) ==> canJoinPlugin(s, epochId) ==> alwaysSealedOwnedClassesStable(joinPlugin(s, epochId)))
{
  if inv(s) && canJoinPlugin(s, epochId) {
    var after := joinPlugin(s, epochId);
    EpochsAfterJoinPlugin(s, epochId);
    assert forall i :: 0 <= i < |s.epochs| ==> after.epochs[i].lifecycle.phase == s.epochs[i].lifecycle.phase;
    EpochMapRules(s, after);
  }
}

lemma commitPlugin_ensures(s: PluginServices, epochId: int)
  ensures (inv(s) ==> canCommitPlugin(s, epochId) ==> alwaysEpochIdentityUnique(commitPlugin(s, epochId)))
  ensures (inv(s) ==> canCommitPlugin(s, epochId) ==> alwaysOneActiveEpochPerName(commitPlugin(s, epochId)))
  ensures (inv(s) ==> canCommitPlugin(s, epochId) ==> alwaysEpochOutcomeHonest(commitPlugin(s, epochId)))
  ensures (inv(s) ==> canCommitPlugin(s, epochId) ==> alwaysRetirementPerRetiredEpoch(commitPlugin(s, epochId)))
  ensures (inv(s) ==> canCommitPlugin(s, epochId) ==> alwaysLiveClassOwnerUnique(commitPlugin(s, epochId)))
  ensures (inv(s) ==> canCommitPlugin(s, epochId) ==> alwaysServiceOwnerEpochExists(commitPlugin(s, epochId)))
  ensures (inv(s) ==> canCommitPlugin(s, epochId) ==> alwaysChildLifecyclesValid(commitPlugin(s, epochId)))
  ensures (inv(s) ==> canCommitPlugin(s, epochId) ==> alwaysOwnedClassesMatchServices(commitPlugin(s, epochId)))
  ensures (inv(s) ==> canCommitPlugin(s, epochId) ==> alwaysInvokingStartHasNoInstance(commitPlugin(s, epochId)))
  ensures (inv(s) ==> canCommitPlugin(s, epochId) ==> alwaysRetirementFollowsPlan(commitPlugin(s, epochId)))
  ensures (inv(s) ==> canCommitPlugin(s, epochId) ==> alwaysLiveInstanceReachable(commitPlugin(s, epochId)))
  ensures (inv(s) ==> canCommitPlugin(s, epochId) ==> alwaysNoOrphanInstance(commitPlugin(s, epochId)))
  ensures (inv(s) ==> canCommitPlugin(s, epochId) ==> alwaysStopObservationsFollowSlots(commitPlugin(s, epochId)))
  ensures (inv(s) ==> canCommitPlugin(s, epochId) ==> alwaysRetiredUndeclaredTypeIsUnknown(commitPlugin(s, epochId)))
  ensures (inv(s) ==> canCommitPlugin(s, epochId) ==> alwaysRetiredEpochHasNoResources(commitPlugin(s, epochId)))
  ensures (inv(s) ==> canCommitPlugin(s, epochId) ==> alwaysSealedOwnedClassesStable(commitPlugin(s, epochId)))
{
  if inv(s) && canCommitPlugin(s, epochId) {
    var after := commitPlugin(s, epochId);
    EpochsAfterCommitPlugin(s, epochId);
    EpochMapPhases(s, after, epochId);
    forall i | 0 <= i < |s.epochs| && s.epochs[i].id == epochId ensures s.epochs[i].lifecycle.phase.Registering?
    {
      assert s.epochs[i] in s.epochs;
      PluginEpochExact(s, s.epochs[i]);
    }
    EpochMapRules(s, after);
  }
}

lemma disposePlugin_ensures(s: PluginServices, epochId: int, ok: bool)
  ensures (inv(s) ==> canDisposePlugin(s, epochId, ok) ==> alwaysEpochIdentityUnique(disposePlugin(s, epochId, ok)))
  ensures (inv(s) ==> canDisposePlugin(s, epochId, ok) ==> alwaysOneActiveEpochPerName(disposePlugin(s, epochId, ok)))
  ensures (inv(s) ==> canDisposePlugin(s, epochId, ok) ==> alwaysEpochOutcomeHonest(disposePlugin(s, epochId, ok)))
  ensures (inv(s) ==> canDisposePlugin(s, epochId, ok) ==> alwaysRetirementPerRetiredEpoch(disposePlugin(s, epochId, ok)))
  ensures (inv(s) ==> canDisposePlugin(s, epochId, ok) ==> alwaysLiveClassOwnerUnique(disposePlugin(s, epochId, ok)))
  ensures (inv(s) ==> canDisposePlugin(s, epochId, ok) ==> alwaysServiceOwnerEpochExists(disposePlugin(s, epochId, ok)))
  ensures (inv(s) ==> canDisposePlugin(s, epochId, ok) ==> alwaysChildLifecyclesValid(disposePlugin(s, epochId, ok)))
  ensures (inv(s) ==> canDisposePlugin(s, epochId, ok) ==> alwaysOwnedClassesMatchServices(disposePlugin(s, epochId, ok)))
  ensures (inv(s) ==> canDisposePlugin(s, epochId, ok) ==> alwaysInvokingStartHasNoInstance(disposePlugin(s, epochId, ok)))
  ensures (inv(s) ==> canDisposePlugin(s, epochId, ok) ==> alwaysRetirementFollowsPlan(disposePlugin(s, epochId, ok)))
  ensures (inv(s) ==> canDisposePlugin(s, epochId, ok) ==> alwaysLiveInstanceReachable(disposePlugin(s, epochId, ok)))
  ensures (inv(s) ==> canDisposePlugin(s, epochId, ok) ==> alwaysNoOrphanInstance(disposePlugin(s, epochId, ok)))
  ensures (inv(s) ==> canDisposePlugin(s, epochId, ok) ==> alwaysStopObservationsFollowSlots(disposePlugin(s, epochId, ok)))
  ensures (inv(s) ==> canDisposePlugin(s, epochId, ok) ==> alwaysRetiredUndeclaredTypeIsUnknown(disposePlugin(s, epochId, ok)))
  ensures (inv(s) ==> canDisposePlugin(s, epochId, ok) ==> alwaysRetiredEpochHasNoResources(disposePlugin(s, epochId, ok)))
  ensures (inv(s) ==> canDisposePlugin(s, epochId, ok) ==> alwaysSealedOwnedClassesStable(disposePlugin(s, epochId, ok)))
{
  if inv(s) && canDisposePlugin(s, epochId, ok) {
    var after := disposePlugin(s, epochId, ok);
    EpochsAfterDisposePlugin(s, epochId, ok);
    assert forall i :: 0 <= i < |s.epochs| ==> after.epochs[i].lifecycle.phase == s.epochs[i].lifecycle.phase;
    EpochMapRules(s, after);
  }
}

lemma failPlugin_ensures(s: PluginServices, epochId: int)
  ensures (inv(s) ==> canFailPlugin(s, epochId) ==> alwaysEpochIdentityUnique(failPlugin(s, epochId)))
  ensures (inv(s) ==> canFailPlugin(s, epochId) ==> alwaysOneActiveEpochPerName(failPlugin(s, epochId)))
  ensures (inv(s) ==> canFailPlugin(s, epochId) ==> alwaysEpochOutcomeHonest(failPlugin(s, epochId)))
  ensures (inv(s) ==> canFailPlugin(s, epochId) ==> alwaysRetirementPerRetiredEpoch(failPlugin(s, epochId)))
  ensures (inv(s) ==> canFailPlugin(s, epochId) ==> alwaysLiveClassOwnerUnique(failPlugin(s, epochId)))
  ensures (inv(s) ==> canFailPlugin(s, epochId) ==> alwaysServiceOwnerEpochExists(failPlugin(s, epochId)))
  ensures (inv(s) ==> canFailPlugin(s, epochId) ==> alwaysChildLifecyclesValid(failPlugin(s, epochId)))
  ensures (inv(s) ==> canFailPlugin(s, epochId) ==> alwaysOwnedClassesMatchServices(failPlugin(s, epochId)))
  ensures (inv(s) ==> canFailPlugin(s, epochId) ==> alwaysInvokingStartHasNoInstance(failPlugin(s, epochId)))
  ensures (inv(s) ==> canFailPlugin(s, epochId) ==> alwaysRetirementFollowsPlan(failPlugin(s, epochId)))
  ensures (inv(s) ==> canFailPlugin(s, epochId) ==> alwaysLiveInstanceReachable(failPlugin(s, epochId)))
  ensures (inv(s) ==> canFailPlugin(s, epochId) ==> alwaysNoOrphanInstance(failPlugin(s, epochId)))
  ensures (inv(s) ==> canFailPlugin(s, epochId) ==> alwaysStopObservationsFollowSlots(failPlugin(s, epochId)))
  ensures (inv(s) ==> canFailPlugin(s, epochId) ==> alwaysRetiredUndeclaredTypeIsUnknown(failPlugin(s, epochId)))
  ensures (inv(s) ==> canFailPlugin(s, epochId) ==> alwaysRetiredEpochHasNoResources(failPlugin(s, epochId)))
  ensures (inv(s) ==> canFailPlugin(s, epochId) ==> alwaysSealedOwnedClassesStable(failPlugin(s, epochId)))
{
  if inv(s) && canFailPlugin(s, epochId) {
    var after := failPlugin(s, epochId);
    var mid := s.(epochs := after.epochs);
    EpochIdLookup(s, epochId);
    EpochsAfterFailPlugin(s, epochId);
    EpochMapPhases(s, mid, epochId);
    EpochMapRules(s, mid);
    EpochMapView(s, mid);
    CaptureRetirementFrame(mid, epochId);
    forall x | x != epochId ensures epoch(mid, x) == epoch(s, x)
    {
      EpochIdLookup(s, x);
      EpochIdLookup(mid, x);
      if e :| e in s.epochs && e.id == x {
        var i :| 0 <= i < |s.epochs| && s.epochs[i] == e;
        assert mid.epochs[i] == e;
        PluginEpochExact(mid, e);
        PluginEpochExact(s, e);
      } else if e :| e in mid.epochs && e.id == x {
        var i :| 0 <= i < |mid.epochs| && mid.epochs[i] == e;
        assert s.epochs[i] in s.epochs;
      }
    }
    EpochIdLookup(mid, epochId);
    var k :| 0 <= k < |mid.epochs| && mid.epochs[k] == epoch(mid, epochId);
    assert s.epochs[k] in s.epochs;
    CaptureRetirementOnce(s, mid, epochId);
  }
}

lemma unloadPlugin_ensures(s: PluginServices, epochId: int)
  ensures (inv(s) ==> canUnloadPlugin(s, epochId) ==> alwaysEpochIdentityUnique(unloadPlugin(s, epochId)))
  ensures (inv(s) ==> canUnloadPlugin(s, epochId) ==> alwaysOneActiveEpochPerName(unloadPlugin(s, epochId)))
  ensures (inv(s) ==> canUnloadPlugin(s, epochId) ==> alwaysEpochOutcomeHonest(unloadPlugin(s, epochId)))
  ensures (inv(s) ==> canUnloadPlugin(s, epochId) ==> alwaysRetirementPerRetiredEpoch(unloadPlugin(s, epochId)))
  ensures (inv(s) ==> canUnloadPlugin(s, epochId) ==> alwaysLiveClassOwnerUnique(unloadPlugin(s, epochId)))
  ensures (inv(s) ==> canUnloadPlugin(s, epochId) ==> alwaysServiceOwnerEpochExists(unloadPlugin(s, epochId)))
  ensures (inv(s) ==> canUnloadPlugin(s, epochId) ==> alwaysChildLifecyclesValid(unloadPlugin(s, epochId)))
  ensures (inv(s) ==> canUnloadPlugin(s, epochId) ==> alwaysOwnedClassesMatchServices(unloadPlugin(s, epochId)))
  ensures (inv(s) ==> canUnloadPlugin(s, epochId) ==> alwaysInvokingStartHasNoInstance(unloadPlugin(s, epochId)))
  ensures (inv(s) ==> canUnloadPlugin(s, epochId) ==> alwaysRetirementFollowsPlan(unloadPlugin(s, epochId)))
  ensures (inv(s) ==> canUnloadPlugin(s, epochId) ==> alwaysLiveInstanceReachable(unloadPlugin(s, epochId)))
  ensures (inv(s) ==> canUnloadPlugin(s, epochId) ==> alwaysNoOrphanInstance(unloadPlugin(s, epochId)))
  ensures (inv(s) ==> canUnloadPlugin(s, epochId) ==> alwaysStopObservationsFollowSlots(unloadPlugin(s, epochId)))
  ensures (inv(s) ==> canUnloadPlugin(s, epochId) ==> alwaysRetiredUndeclaredTypeIsUnknown(unloadPlugin(s, epochId)))
  ensures (inv(s) ==> canUnloadPlugin(s, epochId) ==> alwaysRetiredEpochHasNoResources(unloadPlugin(s, epochId)))
  ensures (inv(s) ==> canUnloadPlugin(s, epochId) ==> alwaysSealedOwnedClassesStable(unloadPlugin(s, epochId)))
{
  if inv(s) && canUnloadPlugin(s, epochId) {
    var after := unloadPlugin(s, epochId);
    var mid := s.(epochs := after.epochs);
    EpochIdLookup(s, epochId);
    EpochsAfterUnloadPlugin(s, epochId);
    EpochMapPhases(s, mid, epochId);
    EpochMapRules(s, mid);
    EpochMapView(s, mid);
    CaptureRetirementFrame(mid, epochId);
    forall x | x != epochId ensures epoch(mid, x) == epoch(s, x)
    {
      EpochIdLookup(s, x);
      EpochIdLookup(mid, x);
      if e :| e in s.epochs && e.id == x {
        var i :| 0 <= i < |s.epochs| && s.epochs[i] == e;
        assert mid.epochs[i] == e;
        PluginEpochExact(mid, e);
        PluginEpochExact(s, e);
      } else if e :| e in mid.epochs && e.id == x {
        var i :| 0 <= i < |mid.epochs| && mid.epochs[i] == e;
        assert s.epochs[i] in s.epochs;
      }
    }
    EpochIdLookup(mid, epochId);
    var k :| 0 <= k < |mid.epochs| && mid.epochs[k] == epoch(mid, epochId);
    assert s.epochs[k] in s.epochs;
    CaptureRetirementOnce(s, mid, epochId);
  }
}

lemma finishNextPluginDisposal_ensures(s: PluginServices, ok: bool)
  ensures (inv(s) ==> canFinishNextPluginDisposal(s, ok) ==> alwaysEpochIdentityUnique(finishNextPluginDisposal(s, ok)))
  ensures (inv(s) ==> canFinishNextPluginDisposal(s, ok) ==> alwaysOneActiveEpochPerName(finishNextPluginDisposal(s, ok)))
  ensures (inv(s) ==> canFinishNextPluginDisposal(s, ok) ==> alwaysEpochOutcomeHonest(finishNextPluginDisposal(s, ok)))
  ensures (inv(s) ==> canFinishNextPluginDisposal(s, ok) ==> alwaysRetirementPerRetiredEpoch(finishNextPluginDisposal(s, ok)))
  ensures (inv(s) ==> canFinishNextPluginDisposal(s, ok) ==> alwaysLiveClassOwnerUnique(finishNextPluginDisposal(s, ok)))
  ensures (inv(s) ==> canFinishNextPluginDisposal(s, ok) ==> alwaysServiceOwnerEpochExists(finishNextPluginDisposal(s, ok)))
  ensures (inv(s) ==> canFinishNextPluginDisposal(s, ok) ==> alwaysChildLifecyclesValid(finishNextPluginDisposal(s, ok)))
  ensures (inv(s) ==> canFinishNextPluginDisposal(s, ok) ==> alwaysOwnedClassesMatchServices(finishNextPluginDisposal(s, ok)))
  ensures (inv(s) ==> canFinishNextPluginDisposal(s, ok) ==> alwaysInvokingStartHasNoInstance(finishNextPluginDisposal(s, ok)))
  ensures (inv(s) ==> canFinishNextPluginDisposal(s, ok) ==> alwaysRetirementFollowsPlan(finishNextPluginDisposal(s, ok)))
  ensures (inv(s) ==> canFinishNextPluginDisposal(s, ok) ==> alwaysLiveInstanceReachable(finishNextPluginDisposal(s, ok)))
  ensures (inv(s) ==> canFinishNextPluginDisposal(s, ok) ==> alwaysNoOrphanInstance(finishNextPluginDisposal(s, ok)))
  ensures (inv(s) ==> canFinishNextPluginDisposal(s, ok) ==> alwaysStopObservationsFollowSlots(finishNextPluginDisposal(s, ok)))
  ensures (inv(s) ==> canFinishNextPluginDisposal(s, ok) ==> alwaysRetiredUndeclaredTypeIsUnknown(finishNextPluginDisposal(s, ok)))
  ensures (inv(s) ==> canFinishNextPluginDisposal(s, ok) ==> alwaysRetiredEpochHasNoResources(finishNextPluginDisposal(s, ok)))
  ensures (inv(s) ==> canFinishNextPluginDisposal(s, ok) ==> alwaysSealedOwnedClassesStable(finishNextPluginDisposal(s, ok)))
{
  if inv(s) && canFinishNextPluginDisposal(s, ok) {
    disposePlugin_ensures(s, pendingPluginDisposal(s), ok);
  }
}

lemma finishNextRegistration_ensures(s: PluginServices, ok: bool)
  ensures (inv(s) ==> canFinishNextRegistration(s, ok) ==> alwaysEpochIdentityUnique(finishNextRegistration(s, ok)))
  ensures (inv(s) ==> canFinishNextRegistration(s, ok) ==> alwaysOneActiveEpochPerName(finishNextRegistration(s, ok)))
  ensures (inv(s) ==> canFinishNextRegistration(s, ok) ==> alwaysEpochOutcomeHonest(finishNextRegistration(s, ok)))
  ensures (inv(s) ==> canFinishNextRegistration(s, ok) ==> alwaysRetirementPerRetiredEpoch(finishNextRegistration(s, ok)))
  ensures (inv(s) ==> canFinishNextRegistration(s, ok) ==> alwaysLiveClassOwnerUnique(finishNextRegistration(s, ok)))
  ensures (inv(s) ==> canFinishNextRegistration(s, ok) ==> alwaysServiceOwnerEpochExists(finishNextRegistration(s, ok)))
  ensures (inv(s) ==> canFinishNextRegistration(s, ok) ==> alwaysChildLifecyclesValid(finishNextRegistration(s, ok)))
  ensures (inv(s) ==> canFinishNextRegistration(s, ok) ==> alwaysOwnedClassesMatchServices(finishNextRegistration(s, ok)))
  ensures (inv(s) ==> canFinishNextRegistration(s, ok) ==> alwaysInvokingStartHasNoInstance(finishNextRegistration(s, ok)))
  ensures (inv(s) ==> canFinishNextRegistration(s, ok) ==> alwaysRetirementFollowsPlan(finishNextRegistration(s, ok)))
  ensures (inv(s) ==> canFinishNextRegistration(s, ok) ==> alwaysLiveInstanceReachable(finishNextRegistration(s, ok)))
  ensures (inv(s) ==> canFinishNextRegistration(s, ok) ==> alwaysNoOrphanInstance(finishNextRegistration(s, ok)))
  ensures (inv(s) ==> canFinishNextRegistration(s, ok) ==> alwaysStopObservationsFollowSlots(finishNextRegistration(s, ok)))
  ensures (inv(s) ==> canFinishNextRegistration(s, ok) ==> alwaysRetiredUndeclaredTypeIsUnknown(finishNextRegistration(s, ok)))
  ensures (inv(s) ==> canFinishNextRegistration(s, ok) ==> alwaysRetiredEpochHasNoResources(finishNextRegistration(s, ok)))
  ensures (inv(s) ==> canFinishNextRegistration(s, ok) ==> alwaysSealedOwnedClassesStable(finishNextRegistration(s, ok)))
{
  if inv(s) && canFinishNextRegistration(s, ok) {
    if ok { commitPlugin_ensures(s, pendingRegistration(s)); } else { failPlugin_ensures(s, pendingRegistration(s)); }
  }
}

lemma ObjectFound(s: core__serviceInstances_ServiceInstances, instanceId: int)
  ensures core__serviceInstances_serviceObject(s, instanceId) == core__serviceInstances_noObject ||
    (core__serviceInstances_serviceObject(s, instanceId) in s.objects && core__serviceInstances_serviceObject(s, instanceId).id == instanceId)
{
  var matches := ProofLib.Filter((o: core__serviceInstances_ServiceObject) => (o.id == instanceId), s.objects);
  if |matches| > 0 {
    assert matches[0] in matches;
    ProofLib.FilterMember((o: core__serviceInstances_ServiceObject) => (o.id == instanceId), s.objects, matches[0]);
  }
}

lemma ObjectExact(s: core__serviceInstances_ServiceInstances, item: core__serviceInstances_ServiceObject)
  requires core__serviceInstances_alwaysClassAndObjectIdentities(s) && item in s.objects
  ensures core__serviceInstances_serviceObject(s, item.id) == item
{
  var instanceId := item.id;
  var matches := ProofLib.Filter((o: core__serviceInstances_ServiceObject) => (o.id == instanceId), s.objects);
  ProofLib.FilterSamePredicate((o: core__serviceInstances_ServiceObject) => (o.id == instanceId), (other: core__serviceInstances_ServiceObject) => (other.id == item.id), s.objects);
  ProofLib.FilterMember((o: core__serviceInstances_ServiceObject) => (o.id == instanceId), s.objects, item);
  assert |matches| == 1 && matches[0] == item;
}

lemma SettledKept(sv: core__serviceInstances_ServiceInstances, next: core__serviceInstances_ServiceInstances)
  requires core__serviceInstances_alwaysClassAndObjectIdentities(next) && core__serviceInstances_stepStopIdentityRetained(sv, next)
  ensures forall slot :: stopSlotSettled(slot, sv) ==> stopSlotSettled(slot, next)
{
  forall slot | stopSlotSettled(slot, sv) ensures stopSlotSettled(slot, next)
  {
    var o := core__serviceInstances_serviceObject(sv, slot.instanceId);
    ObjectFound(sv, slot.instanceId);
    if slot.observed.AwaitedStopSlot? {
      assert o in sv.objects && !o.stopPhase.StopNotRequested?;
      var later :| later in next.objects && later.id == o.id && later.stopCalls == 1 && (o.stopPhase.StopWaiting? || later.stopPhase == o.stopPhase);
      ObjectExact(next, later);
    }
  }
}

lemma StopFold(g: RetirementGroup, services: core__serviceInstances_ServiceInstances, xs: seq<InstanceSlot>, k: int, b: bool)
  ensures Std.Collections.Seq.FoldLeft((check: SequenceValidation, slot: InstanceSlot) => validateNextStop(check, g, slot, services), SequenceValidation(k, b), xs) ==
    SequenceValidation(k + |xs|, b && forall i :: 0 <= i < |xs| ==> validStopObservation(g, k + i, xs[i], services))
  decreases |xs|
{
  if |xs| > 0 {
    StopFold(g, services, xs[1..], k + 1, b && validStopObservation(g, k, xs[0], services));
    assert (forall i :: 0 <= i < |xs| ==> validStopObservation(g, k + i, xs[i], services)) ==
      (validStopObservation(g, k, xs[0], services) && forall i :: 0 <= i < |xs[1..]| ==> validStopObservation(g, k + 1 + i, xs[1..][i], services)) by {
      if forall i :: 0 <= i < |xs[1..]| ==> validStopObservation(g, k + 1 + i, xs[1..][i], services) {
        forall i | 1 <= i < |xs| ensures validStopObservation(g, k + i, xs[i], services) {
          assert xs[i] == xs[1..][i - 1];
        }
      }
    }
  }
}

lemma StopsValid(g: RetirementGroup, services: core__serviceInstances_ServiceInstances)
  ensures allStopObservationsValid(g, services) == forall i :: 0 <= i < |g.observedStops| ==> validStopObservation(g, i, g.observedStops[i], services)
{
  StopFold(g, services, g.observedStops, 0, true);
}

lemma ChildInv(s: PluginServices)
  ensures alwaysChildLifecyclesValid(s) == core__serviceInstances_inv(s.services)
{
}

lemma ServiceStep(s: PluginServices, after: PluginServices)
  requires inv(s) && after.epochs == s.epochs && after.retirements == s.retirements
  requires core__serviceInstances_inv(after.services) && core__serviceInstances_stepStopIdentityRetained(s.services, after.services)
  ensures alwaysChildLifecyclesValid(after) && alwaysStopObservationsFollowSlots(after) && alwaysRetiredEpochHasNoResources(after)
{
  ChildInv(after);
  SettledKept(s.services, after.services);
  forall r, g | r in after.retirements && g in r.groups ensures allStopObservationsValid(g, after.services)
  {
    StopsValid(g, s.services);
    StopsValid(g, after.services);
  }
  assert forall x :: retirementSettled(after, x) == retirementSettled(s, x) && epochOwnsResources(after, x) == epochOwnsResources(s, x);
}

lemma finishInitialization_ensures(s: PluginServices, ok: bool)
  ensures (inv(s) ==> canFinishInitialization(s, ok) ==> alwaysEpochIdentityUnique(finishInitialization(s, ok)))
  ensures (inv(s) ==> canFinishInitialization(s, ok) ==> alwaysOneActiveEpochPerName(finishInitialization(s, ok)))
  ensures (inv(s) ==> canFinishInitialization(s, ok) ==> alwaysEpochOutcomeHonest(finishInitialization(s, ok)))
  ensures (inv(s) ==> canFinishInitialization(s, ok) ==> alwaysRetirementPerRetiredEpoch(finishInitialization(s, ok)))
  ensures (inv(s) ==> canFinishInitialization(s, ok) ==> alwaysLiveClassOwnerUnique(finishInitialization(s, ok)))
  ensures (inv(s) ==> canFinishInitialization(s, ok) ==> alwaysServiceOwnerEpochExists(finishInitialization(s, ok)))
  ensures (inv(s) ==> canFinishInitialization(s, ok) ==> alwaysChildLifecyclesValid(finishInitialization(s, ok)))
  ensures (inv(s) ==> canFinishInitialization(s, ok) ==> alwaysOwnedClassesMatchServices(finishInitialization(s, ok)))
  ensures (inv(s) ==> canFinishInitialization(s, ok) ==> alwaysInvokingStartHasNoInstance(finishInitialization(s, ok)))
  ensures (inv(s) ==> canFinishInitialization(s, ok) ==> alwaysRetirementFollowsPlan(finishInitialization(s, ok)))
  ensures (inv(s) ==> canFinishInitialization(s, ok) ==> alwaysLiveInstanceReachable(finishInitialization(s, ok)))
  ensures (inv(s) ==> canFinishInitialization(s, ok) ==> alwaysNoOrphanInstance(finishInitialization(s, ok)))
  ensures (inv(s) ==> canFinishInitialization(s, ok) ==> alwaysStopObservationsFollowSlots(finishInitialization(s, ok)))
  ensures (inv(s) ==> canFinishInitialization(s, ok) ==> alwaysRetiredUndeclaredTypeIsUnknown(finishInitialization(s, ok)))
  ensures (inv(s) ==> canFinishInitialization(s, ok) ==> alwaysRetiredEpochHasNoResources(finishInitialization(s, ok)))
  ensures (inv(s) ==> canFinishInitialization(s, ok) ==> alwaysSealedOwnedClassesStable(finishInitialization(s, ok)))
{
  if inv(s) && canFinishInitialization(s, ok) {
    var after := finishInitialization(s, ok);
    core__serviceInstances_finishInitialization_ensures(s.services, ok);
    ServiceStep(s, after);
    ReachFrame(s, after);
  }
}

lemma settleTypeAggregate_ensures(s: PluginServices, callId: int)
  ensures (inv(s) ==> canSettleTypeAggregate(s, callId) ==> alwaysEpochIdentityUnique(settleTypeAggregate(s, callId)))
  ensures (inv(s) ==> canSettleTypeAggregate(s, callId) ==> alwaysOneActiveEpochPerName(settleTypeAggregate(s, callId)))
  ensures (inv(s) ==> canSettleTypeAggregate(s, callId) ==> alwaysEpochOutcomeHonest(settleTypeAggregate(s, callId)))
  ensures (inv(s) ==> canSettleTypeAggregate(s, callId) ==> alwaysRetirementPerRetiredEpoch(settleTypeAggregate(s, callId)))
  ensures (inv(s) ==> canSettleTypeAggregate(s, callId) ==> alwaysLiveClassOwnerUnique(settleTypeAggregate(s, callId)))
  ensures (inv(s) ==> canSettleTypeAggregate(s, callId) ==> alwaysServiceOwnerEpochExists(settleTypeAggregate(s, callId)))
  ensures (inv(s) ==> canSettleTypeAggregate(s, callId) ==> alwaysChildLifecyclesValid(settleTypeAggregate(s, callId)))
  ensures (inv(s) ==> canSettleTypeAggregate(s, callId) ==> alwaysOwnedClassesMatchServices(settleTypeAggregate(s, callId)))
  ensures (inv(s) ==> canSettleTypeAggregate(s, callId) ==> alwaysInvokingStartHasNoInstance(settleTypeAggregate(s, callId)))
  ensures (inv(s) ==> canSettleTypeAggregate(s, callId) ==> alwaysRetirementFollowsPlan(settleTypeAggregate(s, callId)))
  ensures (inv(s) ==> canSettleTypeAggregate(s, callId) ==> alwaysLiveInstanceReachable(settleTypeAggregate(s, callId)))
  ensures (inv(s) ==> canSettleTypeAggregate(s, callId) ==> alwaysNoOrphanInstance(settleTypeAggregate(s, callId)))
  ensures (inv(s) ==> canSettleTypeAggregate(s, callId) ==> alwaysStopObservationsFollowSlots(settleTypeAggregate(s, callId)))
  ensures (inv(s) ==> canSettleTypeAggregate(s, callId) ==> alwaysRetiredUndeclaredTypeIsUnknown(settleTypeAggregate(s, callId)))
  ensures (inv(s) ==> canSettleTypeAggregate(s, callId) ==> alwaysRetiredEpochHasNoResources(settleTypeAggregate(s, callId)))
  ensures (inv(s) ==> canSettleTypeAggregate(s, callId) ==> alwaysSealedOwnedClassesStable(settleTypeAggregate(s, callId)))
{
  if inv(s) && canSettleTypeAggregate(s, callId) {
    var after := settleTypeAggregate(s, callId);
    core__serviceInstances_settleTypeAggregate_ensures(s.services, callId);
    ServiceStep(s, after);
    ReachFrame(s, after);
  }
}

lemma invokeClassStop_ensures(s: PluginServices, instanceId: int)
  ensures (inv(s) ==> canInvokeClassStop(s, instanceId) ==> alwaysEpochIdentityUnique(invokeClassStop(s, instanceId)))
  ensures (inv(s) ==> canInvokeClassStop(s, instanceId) ==> alwaysOneActiveEpochPerName(invokeClassStop(s, instanceId)))
  ensures (inv(s) ==> canInvokeClassStop(s, instanceId) ==> alwaysEpochOutcomeHonest(invokeClassStop(s, instanceId)))
  ensures (inv(s) ==> canInvokeClassStop(s, instanceId) ==> alwaysRetirementPerRetiredEpoch(invokeClassStop(s, instanceId)))
  ensures (inv(s) ==> canInvokeClassStop(s, instanceId) ==> alwaysLiveClassOwnerUnique(invokeClassStop(s, instanceId)))
  ensures (inv(s) ==> canInvokeClassStop(s, instanceId) ==> alwaysServiceOwnerEpochExists(invokeClassStop(s, instanceId)))
  ensures (inv(s) ==> canInvokeClassStop(s, instanceId) ==> alwaysChildLifecyclesValid(invokeClassStop(s, instanceId)))
  ensures (inv(s) ==> canInvokeClassStop(s, instanceId) ==> alwaysOwnedClassesMatchServices(invokeClassStop(s, instanceId)))
  ensures (inv(s) ==> canInvokeClassStop(s, instanceId) ==> alwaysInvokingStartHasNoInstance(invokeClassStop(s, instanceId)))
  ensures (inv(s) ==> canInvokeClassStop(s, instanceId) ==> alwaysRetirementFollowsPlan(invokeClassStop(s, instanceId)))
  ensures (inv(s) ==> canInvokeClassStop(s, instanceId) ==> alwaysLiveInstanceReachable(invokeClassStop(s, instanceId)))
  ensures (inv(s) ==> canInvokeClassStop(s, instanceId) ==> alwaysNoOrphanInstance(invokeClassStop(s, instanceId)))
  ensures (inv(s) ==> canInvokeClassStop(s, instanceId) ==> alwaysStopObservationsFollowSlots(invokeClassStop(s, instanceId)))
  ensures (inv(s) ==> canInvokeClassStop(s, instanceId) ==> alwaysRetiredUndeclaredTypeIsUnknown(invokeClassStop(s, instanceId)))
  ensures (inv(s) ==> canInvokeClassStop(s, instanceId) ==> alwaysRetiredEpochHasNoResources(invokeClassStop(s, instanceId)))
  ensures (inv(s) ==> canInvokeClassStop(s, instanceId) ==> alwaysSealedOwnedClassesStable(invokeClassStop(s, instanceId)))
{
  if inv(s) && canInvokeClassStop(s, instanceId) {
    var after := invokeClassStop(s, instanceId);
    core__serviceInstances_invokeObjectStop_ensures(s.services, instanceId);
    ServiceStep(s, after);
    ReachFrame(s, after);
  }
}

lemma finishClassStop_ensures(s: PluginServices, instanceId: int, ok: bool, errorId: string)
  ensures (inv(s) ==> canFinishClassStop(s, instanceId, ok, errorId) ==> alwaysEpochIdentityUnique(finishClassStop(s, instanceId, ok, errorId)))
  ensures (inv(s) ==> canFinishClassStop(s, instanceId, ok, errorId) ==> alwaysOneActiveEpochPerName(finishClassStop(s, instanceId, ok, errorId)))
  ensures (inv(s) ==> canFinishClassStop(s, instanceId, ok, errorId) ==> alwaysEpochOutcomeHonest(finishClassStop(s, instanceId, ok, errorId)))
  ensures (inv(s) ==> canFinishClassStop(s, instanceId, ok, errorId) ==> alwaysRetirementPerRetiredEpoch(finishClassStop(s, instanceId, ok, errorId)))
  ensures (inv(s) ==> canFinishClassStop(s, instanceId, ok, errorId) ==> alwaysLiveClassOwnerUnique(finishClassStop(s, instanceId, ok, errorId)))
  ensures (inv(s) ==> canFinishClassStop(s, instanceId, ok, errorId) ==> alwaysServiceOwnerEpochExists(finishClassStop(s, instanceId, ok, errorId)))
  ensures (inv(s) ==> canFinishClassStop(s, instanceId, ok, errorId) ==> alwaysChildLifecyclesValid(finishClassStop(s, instanceId, ok, errorId)))
  ensures (inv(s) ==> canFinishClassStop(s, instanceId, ok, errorId) ==> alwaysOwnedClassesMatchServices(finishClassStop(s, instanceId, ok, errorId)))
  ensures (inv(s) ==> canFinishClassStop(s, instanceId, ok, errorId) ==> alwaysInvokingStartHasNoInstance(finishClassStop(s, instanceId, ok, errorId)))
  ensures (inv(s) ==> canFinishClassStop(s, instanceId, ok, errorId) ==> alwaysRetirementFollowsPlan(finishClassStop(s, instanceId, ok, errorId)))
  ensures (inv(s) ==> canFinishClassStop(s, instanceId, ok, errorId) ==> alwaysLiveInstanceReachable(finishClassStop(s, instanceId, ok, errorId)))
  ensures (inv(s) ==> canFinishClassStop(s, instanceId, ok, errorId) ==> alwaysNoOrphanInstance(finishClassStop(s, instanceId, ok, errorId)))
  ensures (inv(s) ==> canFinishClassStop(s, instanceId, ok, errorId) ==> alwaysStopObservationsFollowSlots(finishClassStop(s, instanceId, ok, errorId)))
  ensures (inv(s) ==> canFinishClassStop(s, instanceId, ok, errorId) ==> alwaysRetiredUndeclaredTypeIsUnknown(finishClassStop(s, instanceId, ok, errorId)))
  ensures (inv(s) ==> canFinishClassStop(s, instanceId, ok, errorId) ==> alwaysRetiredEpochHasNoResources(finishClassStop(s, instanceId, ok, errorId)))
  ensures (inv(s) ==> canFinishClassStop(s, instanceId, ok, errorId) ==> alwaysSealedOwnedClassesStable(finishClassStop(s, instanceId, ok, errorId)))
{
  if inv(s) && canFinishClassStop(s, instanceId, ok, errorId) {
    var after := finishClassStop(s, instanceId, ok, errorId);
    core__serviceInstances_settleObjectStop_ensures(s.services, instanceId, ok, errorId);
    ServiceStep(s, after);
    ReachFrame(s, after);
  }
}

lemma DedupTypes(acc: seq<string>, xs: seq<OwnedClass>)
  requires ProofLib.Distinct(acc)
  ensures ProofLib.Distinct(Std.Collections.Seq.FoldLeft((types: seq<string>, owner: OwnedClass) => (if (owner.serviceType in types) then types else (types + [owner.serviceType])), acc, xs))
  decreases |xs|
{
  if |xs| > 0 {
    var next := if xs[0].serviceType in acc then acc else acc + [xs[0].serviceType];
    DedupTypes(next, xs[1..]);
  }
}

lemma ShapedFilters(r: ServiceRetirement)
  ensures retirementShaped(r) == ((((((((r.cursor >= 0) && (r.cursor <= |r.groups|)) && (|r.groups| <= (r.cursor + 1))) && (|r.groups| <= |r.plan|)) && !((exists t :: t in r.plan && !((|ProofLib.Filter((u: string) => (u == t), r.plan)| == 1))))) && groupsFollowPlan(r)) && !((exists g :: g in r.groups && !((groupSlotsPassed(g) && ((g.phase.GroupFinished? || g.phase.GroupSkipped?) == !(isCurrentGroup(r, g)))))))) && (r.exited == ((|r.groups| == (r.cursor + 1)) && (if ((0 <= r.cursor) && (r.cursor < |r.groups|)) then r.groups[r.cursor] else noGroup).phase.GroupFailed?)))
{
}

lemma PlannedFilters(s: PluginServices, epochId: int)
  ensures plannedTypes(s, epochId) == Std.Collections.Seq.FoldLeft((types: seq<string>, owner: OwnedClass) => (if (owner.serviceType in types) then types else (types + [owner.serviceType])), [], ProofLib.Filter((o: OwnedClass) => (o.epochId == epochId), s.ownership))
{
}

lemma CapturedRetirementShaped(s: PluginServices, epochId: int)
  ensures retirementShaped(ServiceRetirement(epochId, plannedTypes(s, epochId), [], 0, [], false, ""))
{
  var r := ServiceRetirement(epochId, plannedTypes(s, epochId), [], 0, [], false, "");
  PlannedFilters(s, epochId);
  DedupTypes([], ProofLib.Filter((o: OwnedClass) => (o.epochId == epochId), s.ownership));
  forall t | t in r.plan ensures |ProofLib.Filter((u: string) => (u == t), r.plan)| == 1
  {
    ProofLib.FilterDistinctCountOne((u: string) => (u == t), r.plan, t);
  }
  ShapedFilters(r);
}

lemma CaptureRetirementOnce(s: PluginServices, mid: PluginServices, epochId: int)
  requires inv(s) && alwaysEpochIdentityUnique(mid) && mid == s.(epochs := mid.epochs)
  requires epochAdmitsClass(s, epochId) && !epochAdmitsClass(mid, epochId) && epoch(mid, epochId).id == epochId
  requires forall x :: x != epochId ==> epoch(mid, x) == epoch(s, x)
  ensures alwaysRetirementPerRetiredEpoch(captureRetirement(epochId, mid)) && alwaysRetirementFollowsPlan(captureRetirement(epochId, mid))
{
  var after := captureRetirement(epochId, mid);
  var added := ServiceRetirement(epochId, plannedTypes(mid, epochId), [], 0, [], false, "");
  assert after.retirements == s.retirements + [added];
  CapturedRetirementShaped(mid, epochId);
  EpochIdLookup(s, epochId);
  PluginEpochIdentityFilters(s);
  forall r | r in after.retirements
    ensures r.epochId > 0 && epoch(after, r.epochId).id == r.epochId && !epochAdmitsClass(after, r.epochId) && |ProofLib.Filter((other: ServiceRetirement) => (other.epochId == r.epochId), after.retirements)| == 1
  {
    var p := (other: ServiceRetirement) => (other.epochId == r.epochId);
    ProofLib.FilterAppend(p, s.retirements, added);
    if r in s.retirements {
      assert r.epochId != epochId;
    } else {
      assert r == added;
      ProofLib.FilterNone(p, s.retirements);
    }
  }
}

lemma PlanFold(r: ServiceRetirement, xs: seq<RetirementGroup>, k: int, b: bool)
  requires 0 <= k && k + |xs| <= |r.plan|
  ensures Std.Collections.Seq.FoldLeft((check: PlanCheck, g: RetirementGroup) => checkGroupPlan(check, r, g), PlanCheck(k, b), xs) ==
    PlanCheck(k + |xs|, b && forall i :: 0 <= i < |xs| ==> r.plan[k + i] == xs[i].serviceType)
  decreases |xs|
{
  if |xs| > 0 {
    var b2 := b && r.plan[k] == xs[0].serviceType;
    assert checkGroupPlan(PlanCheck(k, b), r, xs[0]) == PlanCheck(k + 1, b2);
    PlanFold(r, xs[1..], k + 1, b2);
    var rest := forall i :: 0 <= i < |xs[1..]| ==> r.plan[k + 1 + i] == xs[1..][i].serviceType;
    var whole := forall i :: 0 <= i < |xs| ==> r.plan[k + i] == xs[i].serviceType;
    assert whole == (r.plan[k] == xs[0].serviceType && rest) by {
      if rest {
        forall i | 1 <= i < |xs| ensures r.plan[k + i] == xs[i].serviceType {
          assert xs[i] == xs[1..][i - 1];
        }
      }
    }
    assert (b2 && rest) == (b && whole);
  }
}

lemma GroupsPlan(r: ServiceRetirement)
  requires |r.groups| <= |r.plan|
  ensures groupsFollowPlan(r) == forall i :: 0 <= i < |r.groups| ==> r.plan[i] == r.groups[i].serviceType
{
  PlanFold(r, r.groups, 0, true);
}

lemma GroupsDistinct(r: ServiceRetirement)
  requires retirementShaped(r)
  ensures forall i, j :: 0 <= i < |r.groups| && 0 <= j < |r.groups| && i != j ==> r.groups[i].serviceType != r.groups[j].serviceType
  ensures forall i :: 0 <= i < |r.groups| ==> r.groups[i].serviceType == r.plan[i]
{
  ShapedFilters(r);
  GroupsPlan(r);
  ShapedFilters(r);
  forall i, j | 0 <= i < |r.groups| && 0 <= j < |r.groups| && i != j ensures r.groups[i].serviceType != r.groups[j].serviceType
  {
    if r.groups[i].serviceType == r.groups[j].serviceType {
      assert r.plan[i] in r.plan;
      ProofLib.FilterTwo((u: string) => (u == r.plan[i]), r.plan, i, j);
    }
  }
}

lemma RetirementFound(s: PluginServices, epochId: int)
  ensures retirement(s, epochId) == noRetirement || (retirement(s, epochId) in s.retirements && retirement(s, epochId).epochId == epochId)
{
  var matches := ProofLib.Filter((r: ServiceRetirement) => (r.epochId == epochId), s.retirements);
  if |matches| > 0 {
    assert matches[0] in matches;
    ProofLib.FilterMember((r: ServiceRetirement) => (r.epochId == epochId), s.retirements, matches[0]);
  }
}

lemma RetirementIndex(s: PluginServices, item: ServiceRetirement) returns (k: int)
  requires alwaysRetirementPerRetiredEpoch(s) && item in s.retirements
  ensures 0 <= k < |s.retirements| && s.retirements[k] == item && retirement(s, item.epochId) == item
  ensures forall i :: 0 <= i < |s.retirements| && i != k ==> s.retirements[i].epochId != item.epochId
{
  k :| 0 <= k < |s.retirements| && s.retirements[k] == item;
  var epochId := item.epochId;
  var p := (r: ServiceRetirement) => (r.epochId == epochId);
  ProofLib.FilterSamePredicate(p, (other: ServiceRetirement) => (other.epochId == item.epochId), s.retirements);
  ProofLib.FilterMember(p, s.retirements, item);
  forall i | 0 <= i < |s.retirements| && i != k ensures s.retirements[i].epochId != epochId
  {
    if s.retirements[i].epochId == epochId { ProofLib.FilterTwo(p, s.retirements, i, k); }
  }
}

lemma CurrentAt(s: PluginServices, epochId: int) returns (k: int)
  requires alwaysRetirementPerRetiredEpoch(s) && alwaysRetirementFollowsPlan(s)
  requires !currentGroup(s, epochId).phase.GroupFinished?
  ensures 0 <= k < |s.retirements| && s.retirements[k] == retirement(s, epochId) && s.retirements[k].epochId == epochId
  ensures forall i :: 0 <= i < |s.retirements| && i != k ==> s.retirements[i].epochId != epochId
  ensures 0 <= s.retirements[k].cursor < |s.retirements[k].groups| == s.retirements[k].cursor + 1
  ensures currentGroup(s, epochId) == s.retirements[k].groups[s.retirements[k].cursor]
  ensures retirementShaped(s.retirements[k])
{
  RetirementFound(s, epochId);
  k := RetirementIndex(s, retirement(s, epochId));
}

lemma PutAt(s: PluginServices, epochId: int, g: RetirementGroup, k: int)
  requires 0 <= k < |s.retirements| && s.retirements[k].epochId == epochId
  requires forall i :: 0 <= i < |s.retirements| && i != k ==> s.retirements[i].epochId != epochId
  requires 0 <= s.retirements[k].cursor < |s.retirements[k].groups|
  requires forall i, j :: 0 <= i < |s.retirements[k].groups| && 0 <= j < |s.retirements[k].groups| && i != j ==> s.retirements[k].groups[i].serviceType != s.retirements[k].groups[j].serviceType
  requires g.serviceType == s.retirements[k].groups[s.retirements[k].cursor].serviceType
  ensures putCurrentGroup(g, epochId, s) == s.(retirements := s.retirements[k := s.retirements[k].(groups := s.retirements[k].groups[s.retirements[k].cursor := g])])
{
  var r := s.retirements[k];
  var after := putCurrentGroup(g, epochId, s);
  var wanted := s.retirements[k := r.(groups := r.groups[r.cursor := g])];
  forall i | 0 <= i < |s.retirements| ensures after.retirements[i] == wanted[i]
  {
    if i == k {
      var gs := after.retirements[k].groups;
      forall j | 0 <= j < |gs| ensures gs[j] == r.groups[r.cursor := g][j]
      {
        if j != r.cursor { assert r.groups[j].serviceType != r.groups[r.cursor].serviceType; }
      }
      assert gs == r.groups[r.cursor := g];
    }
  }
  assert after.retirements == wanted;
}

lemma UAt(s: PluginServices, after: PluginServices, k: int, r2: ServiceRetirement)
  requires alwaysRetirementPerRetiredEpoch(s) && after.epochs == s.epochs
  requires 0 <= k < |s.retirements| && after.retirements == s.retirements[k := r2] && r2.epochId == s.retirements[k].epochId
  ensures alwaysRetirementPerRetiredEpoch(after)
{
  forall r | r in after.retirements
    ensures epoch(after, r.epochId).id == r.epochId && !epochAdmitsClass(after, r.epochId) && |ProofLib.Filter((other: ServiceRetirement) => (other.epochId == r.epochId), after.retirements)| == 1
  {
    var i :| 0 <= i < |after.retirements| && after.retirements[i] == r;
    var prior := s.retirements[i];
    assert prior in s.retirements && prior.epochId == r.epochId;
    ProofLib.FilterLengthPointwise((other: ServiceRetirement) => (other.epochId == r.epochId), (other: ServiceRetirement) => (other.epochId == r.epochId), s.retirements, after.retirements);
  }
}

lemma ShapeAt(s: PluginServices, after: PluginServices, k: int, r2: ServiceRetirement)
  requires alwaysRetirementFollowsPlan(s) && retirementShaped(r2)
  requires 0 <= k < |s.retirements| && after.retirements == s.retirements[k := r2]
  ensures alwaysRetirementFollowsPlan(after)
{
  forall r | r in after.retirements ensures retirementShaped(r)
  {
    var i :| 0 <= i < |after.retirements| && after.retirements[i] == r;
    if i != k { assert s.retirements[i] in s.retirements; }
  }
}

lemma SlotsAt(s: PluginServices, after: PluginServices, k: int, r2: ServiceRetirement)
  requires alwaysStopObservationsFollowSlots(s)
  requires 0 <= k < |s.retirements| && after.retirements == s.retirements[k := r2]
  requires forall slot :: stopSlotSettled(slot, s.services) ==> stopSlotSettled(slot, after.services)
  requires forall g :: g in r2.groups ==> (g.instanceCursor >= 0 && g.instanceCursor <= |g.instances| && |g.observedStops| >= g.instanceCursor && |g.observedStops| <= |g.instances| && |g.observedStops| <= g.instanceCursor + 1 && classPhaseFollowsInstances(g) && allStopObservationsValid(g, after.services))
  ensures alwaysStopObservationsFollowSlots(after)
{
  forall r, g | r in after.retirements && g in r.groups && r != r2 ensures allStopObservationsValid(g, after.services)
  {
    var i :| 0 <= i < |after.retirements| && after.retirements[i] == r;
    assert s.retirements[i] in s.retirements;
    StopsValid(g, s.services);
    StopsValid(g, after.services);
  }
  forall r | r in after.retirements && r != r2 ensures r in s.retirements
  {
    var i :| 0 <= i < |after.retirements| && after.retirements[i] == r;
    assert i != k;
  }
}

lemma NoResourcesAt(s: PluginServices, after: PluginServices, k: int, r2: ServiceRetirement)
  requires alwaysRetiredEpochHasNoResources(s) && alwaysRetirementPerRetiredEpoch(s) && after.epochs == s.epochs
  requires 0 <= k < |s.retirements| && after.retirements == s.retirements[k := r2] && r2.epochId == s.retirements[k].epochId
  requires epochOwnsResources(s, r2.epochId)
  requires forall slot :: stopSlotSettled(slot, s.services) ==> stopSlotSettled(slot, after.services)
  ensures alwaysRetiredEpochHasNoResources(after)
{
  UAt(s, after, k, r2);
  forall r | r in after.retirements && !epochOwnsResources(after, r.epochId)
    ensures retirementSettled(after, r.epochId) && forall g :: g in r.groups ==> g.instanceCursor == |g.instances| && forall slot :: slot in g.observedStops ==> stopSlotSettled(slot, after.services)
  {
    var i :| 0 <= i < |after.retirements| && after.retirements[i] == r;
    assert i != k;
    var prior := s.retirements[i];
    assert prior in s.retirements;
    var a := RetirementIndex(after, r);
    var b := RetirementIndex(s, prior);
  }
}

lemma TypeEntryFound(s: core__serviceInstances_ServiceInstances, serviceType: string)
  ensures core__serviceInstances_serviceTypeEntry(s, serviceType) == core__serviceInstances_noTypeEntry ||
    (core__serviceInstances_serviceTypeEntry(s, serviceType) in s.typeEntries && core__serviceInstances_serviceTypeEntry(s, serviceType).serviceType == serviceType)
{
  var matches := ProofLib.Filter((e: core__serviceInstances_TypeEntry) => (e.serviceType == serviceType), s.typeEntries);
  if |matches| > 0 {
    assert matches[0] in matches;
    ProofLib.FilterMember((e: core__serviceInstances_TypeEntry) => (e.serviceType == serviceType), s.typeEntries, matches[0]);
  }
}

lemma TypeAfterPut(entry: core__serviceInstances_TypeEntry, s: core__serviceInstances_ServiceInstances, serviceType: string)
  ensures core__serviceInstances_serviceTypeEntry(core__serviceInstances_putType(entry, s), serviceType) ==
    (if serviceType == entry.serviceType then entry else core__serviceInstances_serviceTypeEntry(s, serviceType))
{
  var after := core__serviceInstances_putType(entry, s);
  var p := (e: core__serviceInstances_TypeEntry) => (e.serviceType == serviceType);
  if exists e :: e in s.typeEntries && (e.serviceType == entry.serviceType) {
    if serviceType == entry.serviceType {
      var e :| e in s.typeEntries && (e.serviceType == entry.serviceType);
      var i :| 0 <= i < |s.typeEntries| && s.typeEntries[i] == e;
      assert after.typeEntries[i] == entry;
      ProofLib.FilterMember(p, after.typeEntries, entry);
      var matches := ProofLib.Filter(p, after.typeEntries);
      assert matches[0] in matches;
      ProofLib.FilterMember(p, after.typeEntries, matches[0]);
    } else {
      ProofLib.FilterPointwise(p, p, (x: core__serviceInstances_TypeEntry, y: core__serviceInstances_TypeEntry) => (x.serviceType == serviceType ==> x == y), s.typeEntries, after.typeEntries);
      var m1 := ProofLib.Filter(p, s.typeEntries);
      var m2 := ProofLib.Filter(p, after.typeEntries);
      if |m1| > 0 {
        assert m1[0] in m1;
        ProofLib.FilterMember(p, s.typeEntries, m1[0]);
      }
    }
  } else {
    ProofLib.FilterAppend(p, s.typeEntries, entry);
    if serviceType == entry.serviceType {
      ProofLib.FilterNone(p, s.typeEntries);
    }
  }
}

lemma PutTypeInv(entry: core__serviceInstances_TypeEntry, s: core__serviceInstances_ServiceInstances)
  requires core__serviceInstances_inv(s)
  requires !entry.status.TypeFailed?
  requires (entry.promiseId == 0) || (exists p :: p in s.loadPromises && ((p.id == entry.promiseId) && (p.serviceType == entry.serviceType)))
  requires (entry.handlerId == 0) || ((entry.handlerId == entry.promiseId) && (exists p :: p in s.loadPromises && ((p.id == entry.handlerId) && p.phase.LoadPending?)))
  requires (entry.latestAggregate == 0) || (exists a :: a in s.aggregates && ((a.id == entry.latestAggregate) && (a.serviceType == entry.serviceType)))
  ensures core__serviceInstances_inv(core__serviceInstances_putType(entry, s))
{
  var after := core__serviceInstances_putType(entry, s);
  forall e | e in after.typeEntries ensures e == entry || e in s.typeEntries {}
  forall e | e in after.typeEntries
    ensures |ProofLib.Filter((other: core__serviceInstances_TypeEntry) => (other.serviceType == e.serviceType), after.typeEntries)| == 1
  {
    var p := (other: core__serviceInstances_TypeEntry) => (other.serviceType == e.serviceType);
    if exists x :: x in s.typeEntries && (x.serviceType == entry.serviceType) {
      ProofLib.FilterLengthPointwise(p, p, s.typeEntries, after.typeEntries);
      if e == entry {
        var x :| x in s.typeEntries && (x.serviceType == entry.serviceType);
        assert |ProofLib.Filter((other: core__serviceInstances_TypeEntry) => (other.serviceType == x.serviceType), s.typeEntries)| == 1;
        ProofLib.FilterSamePredicate(p, (other: core__serviceInstances_TypeEntry) => (other.serviceType == x.serviceType), s.typeEntries);
      } else {
        var i :| 0 <= i < |after.typeEntries| && after.typeEntries[i] == e;
        assert s.typeEntries[i] in s.typeEntries;
      }
    } else {
      ProofLib.FilterAppend(p, s.typeEntries, entry);
      if e == entry {
        ProofLib.FilterNone(p, s.typeEntries);
      } else {
        assert e in s.typeEntries && e.serviceType != entry.serviceType;
      }
    }
  }
  assert forall t :: core__serviceInstances_firstLive(after, t) == core__serviceInstances_firstLive(s, t);
}

lemma ReconcileInv(serviceType: string, s: core__serviceInstances_ServiceInstances)
  requires core__serviceInstances_inv(s)
  ensures core__serviceInstances_inv(core__serviceInstances_reconcileType(serviceType, s))
{
  TypeEntryFound(s, serviceType);
  var entry := core__serviceInstances_serviceTypeEntry(s, serviceType);
  var published := core__serviceInstances_firstLive(s, serviceType) != 0;
  var remain := exists d :: d in s.declarations && (d.serviceType == serviceType);
  var next := entry.(serviceType := serviceType, status := (if published then core__serviceInstances_TypeStatus.TypeRegistered else (if remain then core__serviceInstances_TypeStatus.TypePending else core__serviceInstances_TypeStatus.TypeUnknown)), promiseId := (if (remain || published) then entry.promiseId else 0), handlerId := (if (remain || published) then entry.handlerId else 0));
  PutTypeInv(next, s);
}

lemma OrphanAt(s: PluginServices, after: PluginServices, k: int, c: int, g2: RetirementGroup, r2: ServiceRetirement)
  requires alwaysNoOrphanInstance(s) && after.epochs == s.epochs
  requires |after.services.classes| >= |s.services.classes|
  requires forall i :: 0 <= i < |s.services.classes| ==> after.services.classes[i].live == s.services.classes[i].live && (s.services.classes[i].registered ==> after.services.classes[i].registered)
  requires 0 <= k < |s.retirements| && after.retirements == s.retirements[k := r2] && r2.epochId == s.retirements[k].epochId
  requires 0 <= c < |s.retirements[k].groups| && r2.groups == s.retirements[k].groups[c := g2]
  requires g2.instances == s.retirements[k].groups[c].instances
  requires forall slot :: slot in s.retirements[k].groups[c].observedStops ==> slot in g2.observedStops
  requires |after.services.objects| == |s.services.objects|
  requires forall i :: 0 <= i < |s.services.objects| ==> after.services.objects[i].id == s.services.objects[i].id && after.services.objects[i].stopCalls >= s.services.objects[i].stopCalls
  requires forall p, x :: p in s.services.published && x in p.instances ==> exists q :: q in after.services.published && x in q.instances
  ensures alwaysNoOrphanInstance(after)
{
  forall o | o in after.services.objects
    ensures (o.stopCalls > 0) || ((exists cl :: cl in after.services.classes && cl.live == o.id && cl.registered) && (exists p :: p in after.services.published && o.id in p.instances)) ||
      (exists r :: r in after.retirements && (exists g :: g in r.groups && (missingStopObservedFor(g, o.id) || (epochOwnsResources(after, r.epochId) && (o.id in g.instances)))))
  {
    var i :| 0 <= i < |after.services.objects| && after.services.objects[i] == o;
    var prior := s.services.objects[i];
    assert prior in s.services.objects;
    if (exists cl :: cl in s.services.classes && cl.live == prior.id && cl.registered) && (exists p :: p in s.services.published && prior.id in p.instances) {
      var cl :| cl in s.services.classes && cl.live == prior.id && cl.registered;
      var m :| 0 <= m < |s.services.classes| && s.services.classes[m] == cl;
      assert after.services.classes[m] in after.services.classes;
    } else if prior.stopCalls <= 0 {
      var r, g :| r in s.retirements && g in r.groups && (missingStopObservedFor(g, prior.id) || (epochOwnsResources(s, r.epochId) && (prior.id in g.instances)));
      var j :| 0 <= j < |s.retirements| && s.retirements[j] == r;
      if j == k {
        var m :| 0 <= m < |r.groups| && r.groups[m] == g;
        assert after.retirements[k] == r2;
        assert |r2.groups| == |r.groups|;
        assert r2.groups[m] in r2.groups;
        if m == c {
          if missingStopObservedFor(g, prior.id) {
            var slot :| slot in g.observedStops && slot.instanceId == prior.id && slot.observed.MissingStopSlot?;
            assert slot in g2.observedStops;
          }
        }
      } else {
        assert after.retirements[j] == r;
      }
    }
  }
}

lemma ClassExact(s: core__serviceInstances_ServiceInstances, item: core__serviceInstances_ServiceClassEntry)
  requires core__serviceInstances_alwaysClassAndObjectIdentities(s) && item in s.classes
  ensures core__serviceInstances_serviceClass(s, item.id) == item
{
  var classId := item.id;
  var matches := ProofLib.Filter((c: core__serviceInstances_ServiceClassEntry) => (c.id == classId), s.classes);
  ProofLib.FilterSamePredicate((c: core__serviceInstances_ServiceClassEntry) => (c.id == classId), (other: core__serviceInstances_ServiceClassEntry) => (other.id == item.id), s.classes);
  ProofLib.FilterMember((c: core__serviceInstances_ServiceClassEntry) => (c.id == classId), s.classes, item);
  assert |matches| == 1 && matches[0] == item;
}

lemma PublishedDeclared(s: PluginServices, serviceType: string)
  requires inv(s)
  requires core__serviceInstances_firstLive(s.services, serviceType) != 0
  ensures exists d :: d in s.services.declarations && d.serviceType == serviceType
{
  var sv := s.services;
  var p := (p: core__serviceInstances_ServicePublication) => (p.serviceType == serviceType);
  var matches := ProofLib.Filter(p, sv.published);
  assert matches[0] in matches;
  ProofLib.FilterMember(p, sv.published, matches[0]);
  var pub := matches[0];
  var id := pub.instances[0];
  assert id in pub.instances;
  var cl :| cl in sv.classes && cl.serviceType == pub.serviceType && cl.live == id;
  assert cl.registered;
  var d :| d in sv.declarations && d.classId == cl.id;
  ClassExact(sv, cl);
}

lemma ClassTypeLookup(s: core__serviceInstances_ServiceInstances, next: core__serviceInstances_ServiceInstances, classId: int)
  requires |next.classes| == |s.classes|
  requires forall i :: 0 <= i < |s.classes| ==> next.classes[i].id == s.classes[i].id && next.classes[i].serviceType == s.classes[i].serviceType
  ensures core__serviceInstances_serviceClass(next, classId).serviceType == core__serviceInstances_serviceClass(s, classId).serviceType
  ensures core__serviceInstances_serviceClass(next, classId).id == core__serviceInstances_serviceClass(s, classId).id
{
  var p := (c: core__serviceInstances_ServiceClassEntry) => (c.id == classId);
  ProofLib.FilterPointwise(p, p, (x: core__serviceInstances_ServiceClassEntry, y: core__serviceInstances_ServiceClassEntry) => (x.serviceType == y.serviceType && x.id == y.id), s.classes, next.classes);
}

lemma ClassShape(s: PluginServices, after: PluginServices)
  requires alwaysOwnedClassesMatchServices(s) && after.ownership == s.ownership
  requires |after.services.classes| == |s.services.classes|
  requires forall i :: 0 <= i < |s.services.classes| ==> (after.services.classes[i].id == s.services.classes[i].id && after.services.classes[i].serviceType == s.services.classes[i].serviceType &&
    (after.services.classes[i].live == 0 || after.services.classes[i].registered))
  ensures alwaysOwnedClassesMatchServices(after)
{
  forall o | o in s.ownership ensures core__serviceInstances_serviceClass(after.services, o.classId).id == o.classId && core__serviceInstances_serviceClass(after.services, o.classId).serviceType == o.serviceType
  {
    ClassTypeLookup(s.services, after.services, o.classId);
  }
}

lemma OrphanClassFrame(s: PluginServices, after: PluginServices)
  requires alwaysNoOrphanInstance(s) && after.epochs == s.epochs && after.retirements == s.retirements && after.services.objects == s.services.objects
  requires |after.services.classes| >= |s.services.classes|
  requires forall i :: 0 <= i < |s.services.classes| ==> after.services.classes[i].live == s.services.classes[i].live && (s.services.classes[i].registered ==> after.services.classes[i].registered)
  requires forall p, x :: p in s.services.published && x in p.instances ==> exists q :: q in after.services.published && x in q.instances
  ensures alwaysNoOrphanInstance(after)
{
  forall o | o in after.services.objects && !(o.stopCalls > 0) && (exists cl :: cl in s.services.classes && cl.live == o.id && cl.registered)
    ensures exists cl :: cl in after.services.classes && cl.live == o.id && cl.registered
  {
    var cl :| cl in s.services.classes && cl.live == o.id && cl.registered;
    var i :| 0 <= i < |s.services.classes| && s.services.classes[i] == cl;
    assert after.services.classes[i] in after.services.classes;
  }
  assert forall x :: epochOwnsResources(after, x) == epochOwnsResources(s, x);
}

lemma failClassStart_ensures(s: PluginServices, attemptId: int, errorId: string)
  ensures (inv(s) ==> canFailClassStart(s, attemptId, errorId) ==> alwaysEpochIdentityUnique(failClassStart(s, attemptId, errorId)))
  ensures (inv(s) ==> canFailClassStart(s, attemptId, errorId) ==> alwaysOneActiveEpochPerName(failClassStart(s, attemptId, errorId)))
  ensures (inv(s) ==> canFailClassStart(s, attemptId, errorId) ==> alwaysEpochOutcomeHonest(failClassStart(s, attemptId, errorId)))
  ensures (inv(s) ==> canFailClassStart(s, attemptId, errorId) ==> alwaysRetirementPerRetiredEpoch(failClassStart(s, attemptId, errorId)))
  ensures (inv(s) ==> canFailClassStart(s, attemptId, errorId) ==> alwaysLiveClassOwnerUnique(failClassStart(s, attemptId, errorId)))
  ensures (inv(s) ==> canFailClassStart(s, attemptId, errorId) ==> alwaysServiceOwnerEpochExists(failClassStart(s, attemptId, errorId)))
  ensures (inv(s) ==> canFailClassStart(s, attemptId, errorId) ==> alwaysChildLifecyclesValid(failClassStart(s, attemptId, errorId)))
  ensures (inv(s) ==> canFailClassStart(s, attemptId, errorId) ==> alwaysOwnedClassesMatchServices(failClassStart(s, attemptId, errorId)))
  ensures (inv(s) ==> canFailClassStart(s, attemptId, errorId) ==> alwaysInvokingStartHasNoInstance(failClassStart(s, attemptId, errorId)))
  ensures (inv(s) ==> canFailClassStart(s, attemptId, errorId) ==> alwaysRetirementFollowsPlan(failClassStart(s, attemptId, errorId)))
  ensures (inv(s) ==> canFailClassStart(s, attemptId, errorId) ==> alwaysLiveInstanceReachable(failClassStart(s, attemptId, errorId)))
  ensures (inv(s) ==> canFailClassStart(s, attemptId, errorId) ==> alwaysNoOrphanInstance(failClassStart(s, attemptId, errorId)))
  ensures (inv(s) ==> canFailClassStart(s, attemptId, errorId) ==> alwaysStopObservationsFollowSlots(failClassStart(s, attemptId, errorId)))
  ensures (inv(s) ==> canFailClassStart(s, attemptId, errorId) ==> alwaysRetiredUndeclaredTypeIsUnknown(failClassStart(s, attemptId, errorId)))
  ensures (inv(s) ==> canFailClassStart(s, attemptId, errorId) ==> alwaysRetiredEpochHasNoResources(failClassStart(s, attemptId, errorId)))
  ensures (inv(s) ==> canFailClassStart(s, attemptId, errorId) ==> alwaysSealedOwnedClassesStable(failClassStart(s, attemptId, errorId)))
{
  if inv(s) && canFailClassStart(s, attemptId, errorId) {
    var after := failClassStart(s, attemptId, errorId);
    core__serviceInstances_failStart_ensures(s.services, attemptId, errorId);
    ServiceStep(s, after);
    ISAttemptStep(s.services, after.services, attemptId);
    ClassShape(s, after);
    OrphanClassFrame(s, after);
    ReachFrame(s, after);
  }
}

lemma finishClassObserver_ensures(s: PluginServices, attemptId: int, ok: bool)
  ensures (inv(s) ==> canFinishClassObserver(s, attemptId, ok) ==> alwaysEpochIdentityUnique(finishClassObserver(s, attemptId, ok)))
  ensures (inv(s) ==> canFinishClassObserver(s, attemptId, ok) ==> alwaysOneActiveEpochPerName(finishClassObserver(s, attemptId, ok)))
  ensures (inv(s) ==> canFinishClassObserver(s, attemptId, ok) ==> alwaysEpochOutcomeHonest(finishClassObserver(s, attemptId, ok)))
  ensures (inv(s) ==> canFinishClassObserver(s, attemptId, ok) ==> alwaysRetirementPerRetiredEpoch(finishClassObserver(s, attemptId, ok)))
  ensures (inv(s) ==> canFinishClassObserver(s, attemptId, ok) ==> alwaysLiveClassOwnerUnique(finishClassObserver(s, attemptId, ok)))
  ensures (inv(s) ==> canFinishClassObserver(s, attemptId, ok) ==> alwaysServiceOwnerEpochExists(finishClassObserver(s, attemptId, ok)))
  ensures (inv(s) ==> canFinishClassObserver(s, attemptId, ok) ==> alwaysChildLifecyclesValid(finishClassObserver(s, attemptId, ok)))
  ensures (inv(s) ==> canFinishClassObserver(s, attemptId, ok) ==> alwaysOwnedClassesMatchServices(finishClassObserver(s, attemptId, ok)))
  ensures (inv(s) ==> canFinishClassObserver(s, attemptId, ok) ==> alwaysInvokingStartHasNoInstance(finishClassObserver(s, attemptId, ok)))
  ensures (inv(s) ==> canFinishClassObserver(s, attemptId, ok) ==> alwaysRetirementFollowsPlan(finishClassObserver(s, attemptId, ok)))
  ensures (inv(s) ==> canFinishClassObserver(s, attemptId, ok) ==> alwaysLiveInstanceReachable(finishClassObserver(s, attemptId, ok)))
  ensures (inv(s) ==> canFinishClassObserver(s, attemptId, ok) ==> alwaysNoOrphanInstance(finishClassObserver(s, attemptId, ok)))
  ensures (inv(s) ==> canFinishClassObserver(s, attemptId, ok) ==> alwaysStopObservationsFollowSlots(finishClassObserver(s, attemptId, ok)))
  ensures (inv(s) ==> canFinishClassObserver(s, attemptId, ok) ==> alwaysRetiredUndeclaredTypeIsUnknown(finishClassObserver(s, attemptId, ok)))
  ensures (inv(s) ==> canFinishClassObserver(s, attemptId, ok) ==> alwaysRetiredEpochHasNoResources(finishClassObserver(s, attemptId, ok)))
  ensures (inv(s) ==> canFinishClassObserver(s, attemptId, ok) ==> alwaysSealedOwnedClassesStable(finishClassObserver(s, attemptId, ok)))
{
  if inv(s) && canFinishClassObserver(s, attemptId, ok) {
    var after := finishClassObserver(s, attemptId, ok);
    core__serviceInstances_finishObserver_ensures(s.services, attemptId, ok);
    ServiceStep(s, after);
    ISAttemptStep(s.services, after.services, attemptId);
    ClassShape(s, after);
    OrphanClassFrame(s, after);
    ReachFrame(s, after);
  }
}

lemma finishNextObserver_ensures(s: PluginServices, ok: bool)
  ensures (inv(s) ==> canFinishNextObserver(s, ok) ==> alwaysEpochIdentityUnique(finishNextObserver(s, ok)))
  ensures (inv(s) ==> canFinishNextObserver(s, ok) ==> alwaysOneActiveEpochPerName(finishNextObserver(s, ok)))
  ensures (inv(s) ==> canFinishNextObserver(s, ok) ==> alwaysEpochOutcomeHonest(finishNextObserver(s, ok)))
  ensures (inv(s) ==> canFinishNextObserver(s, ok) ==> alwaysRetirementPerRetiredEpoch(finishNextObserver(s, ok)))
  ensures (inv(s) ==> canFinishNextObserver(s, ok) ==> alwaysLiveClassOwnerUnique(finishNextObserver(s, ok)))
  ensures (inv(s) ==> canFinishNextObserver(s, ok) ==> alwaysServiceOwnerEpochExists(finishNextObserver(s, ok)))
  ensures (inv(s) ==> canFinishNextObserver(s, ok) ==> alwaysChildLifecyclesValid(finishNextObserver(s, ok)))
  ensures (inv(s) ==> canFinishNextObserver(s, ok) ==> alwaysOwnedClassesMatchServices(finishNextObserver(s, ok)))
  ensures (inv(s) ==> canFinishNextObserver(s, ok) ==> alwaysInvokingStartHasNoInstance(finishNextObserver(s, ok)))
  ensures (inv(s) ==> canFinishNextObserver(s, ok) ==> alwaysRetirementFollowsPlan(finishNextObserver(s, ok)))
  ensures (inv(s) ==> canFinishNextObserver(s, ok) ==> alwaysLiveInstanceReachable(finishNextObserver(s, ok)))
  ensures (inv(s) ==> canFinishNextObserver(s, ok) ==> alwaysNoOrphanInstance(finishNextObserver(s, ok)))
  ensures (inv(s) ==> canFinishNextObserver(s, ok) ==> alwaysStopObservationsFollowSlots(finishNextObserver(s, ok)))
  ensures (inv(s) ==> canFinishNextObserver(s, ok) ==> alwaysRetiredUndeclaredTypeIsUnknown(finishNextObserver(s, ok)))
  ensures (inv(s) ==> canFinishNextObserver(s, ok) ==> alwaysRetiredEpochHasNoResources(finishNextObserver(s, ok)))
  ensures (inv(s) ==> canFinishNextObserver(s, ok) ==> alwaysSealedOwnedClassesStable(finishNextObserver(s, ok)))
{
  if inv(s) && canFinishNextObserver(s, ok) {
    var after := finishNextObserver(s, ok);
    core__serviceInstances_finishNextObserver_ensures(s.services, ok);
    ServiceStep(s, after);
    ISAttemptStep(s.services, after.services, core__serviceInstances_nextObservableAttempt(s.services));
    ClassShape(s, after);
    OrphanClassFrame(s, after);
    ReachFrame(s, after);
  }
}

lemma finishNextLateStart_ensures(s: PluginServices)
  ensures (inv(s) ==> canFinishNextLateStart(s) ==> alwaysEpochIdentityUnique(finishNextLateStart(s)))
  ensures (inv(s) ==> canFinishNextLateStart(s) ==> alwaysOneActiveEpochPerName(finishNextLateStart(s)))
  ensures (inv(s) ==> canFinishNextLateStart(s) ==> alwaysEpochOutcomeHonest(finishNextLateStart(s)))
  ensures (inv(s) ==> canFinishNextLateStart(s) ==> alwaysRetirementPerRetiredEpoch(finishNextLateStart(s)))
  ensures (inv(s) ==> canFinishNextLateStart(s) ==> alwaysLiveClassOwnerUnique(finishNextLateStart(s)))
  ensures (inv(s) ==> canFinishNextLateStart(s) ==> alwaysServiceOwnerEpochExists(finishNextLateStart(s)))
  ensures (inv(s) ==> canFinishNextLateStart(s) ==> alwaysChildLifecyclesValid(finishNextLateStart(s)))
  ensures (inv(s) ==> canFinishNextLateStart(s) ==> alwaysOwnedClassesMatchServices(finishNextLateStart(s)))
  ensures (inv(s) ==> canFinishNextLateStart(s) ==> alwaysInvokingStartHasNoInstance(finishNextLateStart(s)))
  ensures (inv(s) ==> canFinishNextLateStart(s) ==> alwaysRetirementFollowsPlan(finishNextLateStart(s)))
  ensures (inv(s) ==> canFinishNextLateStart(s) ==> alwaysLiveInstanceReachable(finishNextLateStart(s)))
  ensures (inv(s) ==> canFinishNextLateStart(s) ==> alwaysNoOrphanInstance(finishNextLateStart(s)))
  ensures (inv(s) ==> canFinishNextLateStart(s) ==> alwaysStopObservationsFollowSlots(finishNextLateStart(s)))
  ensures (inv(s) ==> canFinishNextLateStart(s) ==> alwaysRetiredUndeclaredTypeIsUnknown(finishNextLateStart(s)))
  ensures (inv(s) ==> canFinishNextLateStart(s) ==> alwaysRetiredEpochHasNoResources(finishNextLateStart(s)))
  ensures (inv(s) ==> canFinishNextLateStart(s) ==> alwaysSealedOwnedClassesStable(finishNextLateStart(s)))
{
  if inv(s) && canFinishNextLateStart(s) {
    var after := finishNextLateStart(s);
    core__serviceInstances_finishNextLateStart_ensures(s.services);
    ServiceStep(s, after);
    ISAttemptStep(s.services, after.services, core__serviceInstances_nextRetiredAttempt(s.services));
    ClassShape(s, after);
    OrphanClassFrame(s, after);
    ReachFrame(s, after);
  }
}

lemma finishLateStart_ensures(s: PluginServices, attemptId: int)
  ensures (inv(s) ==> canFinishLateStart(s, attemptId) ==> alwaysEpochIdentityUnique(finishLateStart(s, attemptId)))
  ensures (inv(s) ==> canFinishLateStart(s, attemptId) ==> alwaysOneActiveEpochPerName(finishLateStart(s, attemptId)))
  ensures (inv(s) ==> canFinishLateStart(s, attemptId) ==> alwaysEpochOutcomeHonest(finishLateStart(s, attemptId)))
  ensures (inv(s) ==> canFinishLateStart(s, attemptId) ==> alwaysRetirementPerRetiredEpoch(finishLateStart(s, attemptId)))
  ensures (inv(s) ==> canFinishLateStart(s, attemptId) ==> alwaysLiveClassOwnerUnique(finishLateStart(s, attemptId)))
  ensures (inv(s) ==> canFinishLateStart(s, attemptId) ==> alwaysServiceOwnerEpochExists(finishLateStart(s, attemptId)))
  ensures (inv(s) ==> canFinishLateStart(s, attemptId) ==> alwaysChildLifecyclesValid(finishLateStart(s, attemptId)))
  ensures (inv(s) ==> canFinishLateStart(s, attemptId) ==> alwaysOwnedClassesMatchServices(finishLateStart(s, attemptId)))
  ensures (inv(s) ==> canFinishLateStart(s, attemptId) ==> alwaysInvokingStartHasNoInstance(finishLateStart(s, attemptId)))
  ensures (inv(s) ==> canFinishLateStart(s, attemptId) ==> alwaysRetirementFollowsPlan(finishLateStart(s, attemptId)))
  ensures (inv(s) ==> canFinishLateStart(s, attemptId) ==> alwaysLiveInstanceReachable(finishLateStart(s, attemptId)))
  ensures (inv(s) ==> canFinishLateStart(s, attemptId) ==> alwaysNoOrphanInstance(finishLateStart(s, attemptId)))
  ensures (inv(s) ==> canFinishLateStart(s, attemptId) ==> alwaysStopObservationsFollowSlots(finishLateStart(s, attemptId)))
  ensures (inv(s) ==> canFinishLateStart(s, attemptId) ==> alwaysRetiredUndeclaredTypeIsUnknown(finishLateStart(s, attemptId)))
  ensures (inv(s) ==> canFinishLateStart(s, attemptId) ==> alwaysRetiredEpochHasNoResources(finishLateStart(s, attemptId)))
  ensures (inv(s) ==> canFinishLateStart(s, attemptId) ==> alwaysSealedOwnedClassesStable(finishLateStart(s, attemptId)))
{
  if inv(s) && canFinishLateStart(s, attemptId) {
    var after := finishLateStart(s, attemptId);
    core__serviceInstances_finishLateStart_ensures(s.services, attemptId);
    ServiceStep(s, after);
    ISAttemptStep(s.services, after.services, attemptId);
    ClassShape(s, after);
    OrphanClassFrame(s, after);
    ReachFrame(s, after);
  }
}

lemma ClassFound(s: core__serviceInstances_ServiceInstances, classId: int)
  ensures core__serviceInstances_serviceClass(s, classId) == core__serviceInstances_noClass ||
    (core__serviceInstances_serviceClass(s, classId) in s.classes && core__serviceInstances_serviceClass(s, classId).id == classId)
{
  var matches := ProofLib.Filter((c: core__serviceInstances_ServiceClassEntry) => (c.id == classId), s.classes);
  if |matches| > 0 {
    assert matches[0] in matches;
    ProofLib.FilterMember((c: core__serviceInstances_ServiceClassEntry) => (c.id == classId), s.classes, matches[0]);
  }
}

lemma RegisteredDeclared(s: core__serviceInstances_ServiceInstances, c: core__serviceInstances_ServiceClassEntry)
  requires core__serviceInstances_alwaysDeclarationsMatch(s) && core__serviceInstances_alwaysClassAndObjectIdentities(s) && c in s.classes && c.registered
  ensures exists d :: d in s.declarations && d.serviceType == c.serviceType
{
  var d :| d in s.declarations && d.classId == c.id;
  ClassExact(s, c);
}

lemma UndeclaredFrame(s: PluginServices, after: PluginServices)
  requires alwaysRetiredUndeclaredTypeIsUnknown(s)
  requires after.retirements == s.retirements && after.services.stopped == s.services.stopped
  requires forall t :: !(exists d :: d in after.services.declarations && d.serviceType == t) ==> (!(exists d :: d in s.services.declarations && d.serviceType == t) &&
    (core__serviceInstances_serviceTypeEntry(after.services, t).status.TypeUnknown? || core__serviceInstances_serviceTypeEntry(after.services, t).status == core__serviceInstances_serviceTypeEntry(s.services, t).status))
  ensures alwaysRetiredUndeclaredTypeIsUnknown(after)
{
}

lemma EnsureFold(serviceType: string, s: core__serviceInstances_ServiceInstances, acc: core__serviceInstances_ServiceInstances, ds: seq<core__serviceInstances_ServiceDeclaration>)
  ensures var r := Std.Collections.Seq.FoldLeft((acc: core__serviceInstances_ServiceInstances, d: core__serviceInstances_ServiceDeclaration) => (if ((((d.serviceType == serviceType) && (core__serviceInstances_serviceClass(acc, d.classId).live == 0)) && (core__serviceInstances_serviceClass(acc, d.classId).pending == 0)) && !((core__serviceInstances_serviceClass(acc, d.classId).failed && (|core__serviceInstances_classInstances(s, serviceType)| != 0)))) then core__serviceInstances_beginClassAttempt(d.classId, acc) else acc), acc, ds);
    |r.classes| == |acc.classes| && (forall i :: 0 <= i < |acc.classes| ==> r.classes[i].id == acc.classes[i].id && r.classes[i].serviceType == acc.classes[i].serviceType && r.classes[i].live == acc.classes[i].live && r.classes[i].registered == acc.classes[i].registered) &&
    r.objects == acc.objects && r.declarations == acc.declarations && r.typeEntries == acc.typeEntries && r.published == acc.published && r.stopped == acc.stopped
  decreases |ds|
{
  if |ds| > 0 {
    var f := (acc: core__serviceInstances_ServiceInstances, d: core__serviceInstances_ServiceDeclaration) => (if ((((d.serviceType == serviceType) && (core__serviceInstances_serviceClass(acc, d.classId).live == 0)) && (core__serviceInstances_serviceClass(acc, d.classId).pending == 0)) && !((core__serviceInstances_serviceClass(acc, d.classId).failed && (|core__serviceInstances_classInstances(s, serviceType)| != 0)))) then core__serviceInstances_beginClassAttempt(d.classId, acc) else acc);
    var next := f(acc, ds[0]);
    assert |next.classes| == |acc.classes| && forall i :: 0 <= i < |acc.classes| ==> next.classes[i].id == acc.classes[i].id && next.classes[i].serviceType == acc.classes[i].serviceType && next.classes[i].live == acc.classes[i].live && next.classes[i].registered == acc.classes[i].registered;
    assert Std.Collections.Seq.FoldLeft(f, acc, ds) == Std.Collections.Seq.FoldLeft(f, next, ds[1..]);
    EnsureFold(serviceType, s, next, ds[1..]);
  }
}

lemma AcquireFrame(callId: int, serviceType: string, s: core__serviceInstances_ServiceInstances)
  requires core__serviceInstances_alwaysDeclarationsMatch(s) && core__serviceInstances_alwaysClassAndObjectIdentities(s)
  ensures var r := core__serviceInstances_admittedAcquire(callId, serviceType, s);
    |r.classes| == |s.classes| && (forall i :: 0 <= i < |s.classes| ==> r.classes[i].id == s.classes[i].id && r.classes[i].serviceType == s.classes[i].serviceType && r.classes[i].live == s.classes[i].live && r.classes[i].registered == s.classes[i].registered) &&
    r.objects == s.objects && r.declarations == s.declarations && r.stopped == s.stopped && r.published == s.published &&
    forall t :: core__serviceInstances_serviceTypeEntry(r, t).status == core__serviceInstances_serviceTypeEntry(s, t).status || (exists d :: d in s.declarations && d.serviceType == t)
{
  EnsureFold(serviceType, s, s, s.declarations);
  var absent := ((s.stopped || s.initialization.InitializationFailed?) || (s.initialization.InitializationReady? && !((exists c :: c in s.classes && (c.registered && (c.serviceType == serviceType))))));
  var waiting := ((!(absent) && s.initialization.InitializationPending?) && (core__serviceInstances_firstLive(s, serviceType) == 0));
  var early := ((!(absent) && s.initialization.InitializationPending?) && (core__serviceInstances_firstLive(s, serviceType) != 0));
  if !(absent || waiting || early) {
    var c :| c in s.classes && (c.registered && (c.serviceType == serviceType));
    RegisteredDeclared(s, c);
    var ensured := core__serviceInstances_ensureClasses(serviceType, s);
    var marked := (if ((ensured.nextAttempt != s.nextAttempt) && (core__serviceInstances_firstLive(s, serviceType) == 0)) then core__serviceInstances_setTypeStatus(serviceType, core__serviceInstances_TypeStatus.TypeRegistering, ensured) else ensured);
    forall t ensures core__serviceInstances_serviceTypeEntry(marked, t).status == core__serviceInstances_serviceTypeEntry(s, t).status || t == serviceType
    {
      if marked != ensured {
        TypeAfterPut(core__serviceInstances_serviceTypeEntry(ensured, serviceType).(serviceType := serviceType, status := core__serviceInstances_TypeStatus.TypeRegistering), ensured, t);
      }
    }
    var published := core__serviceInstances_publishTypeAggregate(callId, serviceType, marked);
    forall t ensures core__serviceInstances_serviceTypeEntry(published, t).status == core__serviceInstances_serviceTypeEntry(marked, t).status || t == serviceType
    {
      var base := marked.(aggregates := (marked.aggregates + [core__serviceInstances_TypeAggregate(callId, serviceType, (var s_map := Std.Collections.Seq.Filter((d: core__serviceInstances_ServiceDeclaration) => (d.serviceType == serviceType), marked.declarations); seq(|s_map|, i_map requires 0 <= i_map < |s_map| => var d := s_map[i_map]; core__serviceInstances_capturedAggregateMember(core__serviceInstances_serviceClass(marked, d.classId), (if ((0 <= 0) && (0 < |core__serviceInstances_classInstances(marked, serviceType)|)) then core__serviceInstances_classInstances(marked, serviceType)[0] else 0)))), false, 0)]));
      TypeAfterPut(core__serviceInstances_serviceTypeEntry(marked, serviceType).(serviceType := serviceType, latestAggregate := callId), base, t);
    }
  }
}

lemma StatusMap(s: core__serviceInstances_ServiceInstances, next: core__serviceInstances_ServiceInstances)
  requires |next.typeEntries| == |s.typeEntries|
  requires forall i :: 0 <= i < |s.typeEntries| ==> next.typeEntries[i].serviceType == s.typeEntries[i].serviceType && next.typeEntries[i].status == s.typeEntries[i].status
  ensures forall serviceType :: core__serviceInstances_serviceTypeEntry(next, serviceType).status == core__serviceInstances_serviceTypeEntry(s, serviceType).status
{
  forall serviceType ensures core__serviceInstances_serviceTypeEntry(next, serviceType).status == core__serviceInstances_serviceTypeEntry(s, serviceType).status
  {
    var p := (e: core__serviceInstances_TypeEntry) => (e.serviceType == serviceType);
    ProofLib.FilterPointwise(p, p, (x: core__serviceInstances_TypeEntry, y: core__serviceInstances_TypeEntry) => (x.status == y.status), s.typeEntries, next.typeEntries);
  }
}

lemma ReturnFrame(s: core__serviceInstances_ServiceInstances, attemptId: int, instanceId: int)
  requires core__serviceInstances_inv(s) && forall c :: c in s.classes ==> c.live == 0 || c.registered
  ensures var r := core__serviceInstances_returnInstance(s, attemptId, instanceId);
    |r.classes| == |s.classes| && (forall i :: 0 <= i < |s.classes| ==> (r.classes[i].id == s.classes[i].id && r.classes[i].serviceType == s.classes[i].serviceType && r.classes[i].registered == s.classes[i].registered &&
      (r.classes[i].live == 0 || r.classes[i].registered))) &&
    r.declarations == s.declarations && r.stopped == s.stopped &&
    forall t :: core__serviceInstances_serviceTypeEntry(r, t).status == core__serviceInstances_serviceTypeEntry(s, t).status || (exists d :: d in s.declarations && d.serviceType == t)
{
  var a := core__serviceInstances_serviceAttempt(s, attemptId);
  var c := core__serviceInstances_serviceClass(s, a.classId);
  var late := s.stopped || !c.registered;
  ClassFound(s, a.classId);
  forall i | 0 <= i < |s.classes| && s.classes[i].id == a.classId && !late ensures s.classes[i].registered
  {
    assert s.classes[i] in s.classes;
    ClassExact(s, s.classes[i]);
  }
  if !late {
    RegisteredDeclared(s, c);
    SetStatusOther(c.serviceType, core__serviceInstances_TypeStatus.TypeRegistered);
    var r := core__serviceInstances_returnInstance(s, attemptId, instanceId);
    assert |r.classes| == |s.classes|;
    assert r.declarations == s.declarations;
    assert r.stopped == s.stopped;
    assert forall i :: 0 <= i < |s.classes| ==> r.classes[i].id == s.classes[i].id && r.classes[i].serviceType == s.classes[i].serviceType && r.classes[i].registered == s.classes[i].registered;
    forall i | 0 <= i < |s.classes| ensures (r.classes[i].live == 0 || r.classes[i].registered)
    {
      if s.classes[i].id == a.classId {
        assert s.classes[i] in s.classes;
        ClassExact(s, s.classes[i]);
        assert r.classes[i] == s.classes[i].(live := instanceId);
      }
    }
    assert forall t :: t != c.serviceType ==> core__serviceInstances_serviceTypeEntry(r, t).status == core__serviceInstances_serviceTypeEntry(s, t).status;
  }
}

lemma SetStatusOther(serviceType: string, status: core__serviceInstances_TypeStatus)
  ensures forall x: core__serviceInstances_ServiceInstances, t: string :: t != serviceType ==>
    core__serviceInstances_serviceTypeEntry(core__serviceInstances_setTypeStatus(serviceType, status, x), t) == core__serviceInstances_serviceTypeEntry(x, t)
{
  forall x: core__serviceInstances_ServiceInstances, t: string | t != serviceType
    ensures core__serviceInstances_serviceTypeEntry(core__serviceInstances_setTypeStatus(serviceType, status, x), t) == core__serviceInstances_serviceTypeEntry(x, t)
  {
    TypeAfterPut(core__serviceInstances_serviceTypeEntry(x, serviceType).(serviceType := serviceType, status := status), x, t);
  }
}

lemma PutTypeLookups()
  ensures forall entry: core__serviceInstances_TypeEntry, x: core__serviceInstances_ServiceInstances, t: string ::
    core__serviceInstances_serviceTypeEntry(core__serviceInstances_putType(entry, x), t) == (if t == entry.serviceType then entry else core__serviceInstances_serviceTypeEntry(x, t))
{
  forall entry: core__serviceInstances_TypeEntry, x: core__serviceInstances_ServiceInstances, t: string
    ensures core__serviceInstances_serviceTypeEntry(core__serviceInstances_putType(entry, x), t) == (if t == entry.serviceType then entry else core__serviceInstances_serviceTypeEntry(x, t))
  {
    TypeAfterPut(entry, x, t);
  }
}

lemma ensureServices_ensures(s: PluginServices, callId: int, serviceType: string)
  ensures (inv(s) ==> canEnsureServices(s, callId, serviceType) ==> alwaysEpochIdentityUnique(ensureServices(s, callId, serviceType)))
  ensures (inv(s) ==> canEnsureServices(s, callId, serviceType) ==> alwaysOneActiveEpochPerName(ensureServices(s, callId, serviceType)))
  ensures (inv(s) ==> canEnsureServices(s, callId, serviceType) ==> alwaysEpochOutcomeHonest(ensureServices(s, callId, serviceType)))
  ensures (inv(s) ==> canEnsureServices(s, callId, serviceType) ==> alwaysRetirementPerRetiredEpoch(ensureServices(s, callId, serviceType)))
  ensures (inv(s) ==> canEnsureServices(s, callId, serviceType) ==> alwaysLiveClassOwnerUnique(ensureServices(s, callId, serviceType)))
  ensures (inv(s) ==> canEnsureServices(s, callId, serviceType) ==> alwaysServiceOwnerEpochExists(ensureServices(s, callId, serviceType)))
  ensures (inv(s) ==> canEnsureServices(s, callId, serviceType) ==> alwaysChildLifecyclesValid(ensureServices(s, callId, serviceType)))
  ensures (inv(s) ==> canEnsureServices(s, callId, serviceType) ==> alwaysOwnedClassesMatchServices(ensureServices(s, callId, serviceType)))
  ensures (inv(s) ==> canEnsureServices(s, callId, serviceType) ==> alwaysInvokingStartHasNoInstance(ensureServices(s, callId, serviceType)))
  ensures (inv(s) ==> canEnsureServices(s, callId, serviceType) ==> alwaysRetirementFollowsPlan(ensureServices(s, callId, serviceType)))
  ensures (inv(s) ==> canEnsureServices(s, callId, serviceType) ==> alwaysLiveInstanceReachable(ensureServices(s, callId, serviceType)))
  ensures (inv(s) ==> canEnsureServices(s, callId, serviceType) ==> alwaysNoOrphanInstance(ensureServices(s, callId, serviceType)))
  ensures (inv(s) ==> canEnsureServices(s, callId, serviceType) ==> alwaysStopObservationsFollowSlots(ensureServices(s, callId, serviceType)))
  ensures (inv(s) ==> canEnsureServices(s, callId, serviceType) ==> alwaysRetiredUndeclaredTypeIsUnknown(ensureServices(s, callId, serviceType)))
  ensures (inv(s) ==> canEnsureServices(s, callId, serviceType) ==> alwaysRetiredEpochHasNoResources(ensureServices(s, callId, serviceType)))
  ensures (inv(s) ==> canEnsureServices(s, callId, serviceType) ==> alwaysSealedOwnedClassesStable(ensureServices(s, callId, serviceType)))
{
  if inv(s) && canEnsureServices(s, callId, serviceType) {
    var after := ensureServices(s, callId, serviceType);
    core__serviceInstances_acquireServices_ensures(s.services, callId, serviceType);
    ServiceStep(s, after);
    AcquireFrame(callId, serviceType, s.services);
    ISAcquire(callId, serviceType, s.services);
    ClassShape(s, after);
    OrphanClassFrame(s, after);
    ReachFrame(s, after);
    UndeclaredFrame(s, after);
  }
}

lemma resumeEnsure_ensures(s: PluginServices, callId: int)
  ensures (inv(s) ==> canResumeEnsure(s, callId) ==> alwaysEpochIdentityUnique(resumeEnsure(s, callId)))
  ensures (inv(s) ==> canResumeEnsure(s, callId) ==> alwaysOneActiveEpochPerName(resumeEnsure(s, callId)))
  ensures (inv(s) ==> canResumeEnsure(s, callId) ==> alwaysEpochOutcomeHonest(resumeEnsure(s, callId)))
  ensures (inv(s) ==> canResumeEnsure(s, callId) ==> alwaysRetirementPerRetiredEpoch(resumeEnsure(s, callId)))
  ensures (inv(s) ==> canResumeEnsure(s, callId) ==> alwaysLiveClassOwnerUnique(resumeEnsure(s, callId)))
  ensures (inv(s) ==> canResumeEnsure(s, callId) ==> alwaysServiceOwnerEpochExists(resumeEnsure(s, callId)))
  ensures (inv(s) ==> canResumeEnsure(s, callId) ==> alwaysChildLifecyclesValid(resumeEnsure(s, callId)))
  ensures (inv(s) ==> canResumeEnsure(s, callId) ==> alwaysOwnedClassesMatchServices(resumeEnsure(s, callId)))
  ensures (inv(s) ==> canResumeEnsure(s, callId) ==> alwaysInvokingStartHasNoInstance(resumeEnsure(s, callId)))
  ensures (inv(s) ==> canResumeEnsure(s, callId) ==> alwaysRetirementFollowsPlan(resumeEnsure(s, callId)))
  ensures (inv(s) ==> canResumeEnsure(s, callId) ==> alwaysLiveInstanceReachable(resumeEnsure(s, callId)))
  ensures (inv(s) ==> canResumeEnsure(s, callId) ==> alwaysNoOrphanInstance(resumeEnsure(s, callId)))
  ensures (inv(s) ==> canResumeEnsure(s, callId) ==> alwaysStopObservationsFollowSlots(resumeEnsure(s, callId)))
  ensures (inv(s) ==> canResumeEnsure(s, callId) ==> alwaysRetiredUndeclaredTypeIsUnknown(resumeEnsure(s, callId)))
  ensures (inv(s) ==> canResumeEnsure(s, callId) ==> alwaysRetiredEpochHasNoResources(resumeEnsure(s, callId)))
  ensures (inv(s) ==> canResumeEnsure(s, callId) ==> alwaysSealedOwnedClassesStable(resumeEnsure(s, callId)))
{
  if inv(s) && canResumeEnsure(s, callId) {
    var after := resumeEnsure(s, callId);
    core__serviceInstances_resumeAcquire_ensures(s.services, callId);
    ServiceStep(s, after);
    var trimmed := s.services.(calls := ProofLib.Filter((other: core__serviceInstances_Acquire) => (other.id != callId), s.services.calls));
    ResumeIs(s.services, callId);
    assert core__serviceInstances_alwaysDeclarationsMatch(trimmed) && core__serviceInstances_alwaysClassAndObjectIdentities(trimmed);
    var serviceType := core__serviceInstances_acquireCall(s.services, callId).serviceType;
    AcquireFrame(callId, serviceType, trimmed);
    ISAcquire(callId, serviceType, trimmed);
    assert after.services == core__serviceInstances_admittedAcquire(callId, serviceType, trimmed);
    ClassShape(s, after);
    OrphanClassFrame(s, after);
    ReachFrame(s, after);
    UndeclaredFrame(s, after);
  }
}

lemma clearTypeAggregate_ensures(s: PluginServices, callId: int)
  ensures (inv(s) ==> canClearTypeAggregate(s, callId) ==> alwaysEpochIdentityUnique(clearTypeAggregate(s, callId)))
  ensures (inv(s) ==> canClearTypeAggregate(s, callId) ==> alwaysOneActiveEpochPerName(clearTypeAggregate(s, callId)))
  ensures (inv(s) ==> canClearTypeAggregate(s, callId) ==> alwaysEpochOutcomeHonest(clearTypeAggregate(s, callId)))
  ensures (inv(s) ==> canClearTypeAggregate(s, callId) ==> alwaysRetirementPerRetiredEpoch(clearTypeAggregate(s, callId)))
  ensures (inv(s) ==> canClearTypeAggregate(s, callId) ==> alwaysLiveClassOwnerUnique(clearTypeAggregate(s, callId)))
  ensures (inv(s) ==> canClearTypeAggregate(s, callId) ==> alwaysServiceOwnerEpochExists(clearTypeAggregate(s, callId)))
  ensures (inv(s) ==> canClearTypeAggregate(s, callId) ==> alwaysChildLifecyclesValid(clearTypeAggregate(s, callId)))
  ensures (inv(s) ==> canClearTypeAggregate(s, callId) ==> alwaysOwnedClassesMatchServices(clearTypeAggregate(s, callId)))
  ensures (inv(s) ==> canClearTypeAggregate(s, callId) ==> alwaysInvokingStartHasNoInstance(clearTypeAggregate(s, callId)))
  ensures (inv(s) ==> canClearTypeAggregate(s, callId) ==> alwaysRetirementFollowsPlan(clearTypeAggregate(s, callId)))
  ensures (inv(s) ==> canClearTypeAggregate(s, callId) ==> alwaysLiveInstanceReachable(clearTypeAggregate(s, callId)))
  ensures (inv(s) ==> canClearTypeAggregate(s, callId) ==> alwaysNoOrphanInstance(clearTypeAggregate(s, callId)))
  ensures (inv(s) ==> canClearTypeAggregate(s, callId) ==> alwaysStopObservationsFollowSlots(clearTypeAggregate(s, callId)))
  ensures (inv(s) ==> canClearTypeAggregate(s, callId) ==> alwaysRetiredUndeclaredTypeIsUnknown(clearTypeAggregate(s, callId)))
  ensures (inv(s) ==> canClearTypeAggregate(s, callId) ==> alwaysRetiredEpochHasNoResources(clearTypeAggregate(s, callId)))
  ensures (inv(s) ==> canClearTypeAggregate(s, callId) ==> alwaysSealedOwnedClassesStable(clearTypeAggregate(s, callId)))
{
  if inv(s) && canClearTypeAggregate(s, callId) {
    var after := clearTypeAggregate(s, callId);
    core__serviceInstances_clearTypeAggregate_ensures(s.services, callId);
    ServiceStep(s, after);
    ReachFrame(s, after);
    StatusMap(s.services, after.services);
    UndeclaredFrame(s, after);
  }
}

lemma settleEnsure_ensures(s: PluginServices, callId: int)
  ensures (inv(s) ==> canSettleEnsure(s, callId) ==> alwaysEpochIdentityUnique(settleEnsure(s, callId)))
  ensures (inv(s) ==> canSettleEnsure(s, callId) ==> alwaysOneActiveEpochPerName(settleEnsure(s, callId)))
  ensures (inv(s) ==> canSettleEnsure(s, callId) ==> alwaysEpochOutcomeHonest(settleEnsure(s, callId)))
  ensures (inv(s) ==> canSettleEnsure(s, callId) ==> alwaysRetirementPerRetiredEpoch(settleEnsure(s, callId)))
  ensures (inv(s) ==> canSettleEnsure(s, callId) ==> alwaysLiveClassOwnerUnique(settleEnsure(s, callId)))
  ensures (inv(s) ==> canSettleEnsure(s, callId) ==> alwaysServiceOwnerEpochExists(settleEnsure(s, callId)))
  ensures (inv(s) ==> canSettleEnsure(s, callId) ==> alwaysChildLifecyclesValid(settleEnsure(s, callId)))
  ensures (inv(s) ==> canSettleEnsure(s, callId) ==> alwaysOwnedClassesMatchServices(settleEnsure(s, callId)))
  ensures (inv(s) ==> canSettleEnsure(s, callId) ==> alwaysInvokingStartHasNoInstance(settleEnsure(s, callId)))
  ensures (inv(s) ==> canSettleEnsure(s, callId) ==> alwaysRetirementFollowsPlan(settleEnsure(s, callId)))
  ensures (inv(s) ==> canSettleEnsure(s, callId) ==> alwaysLiveInstanceReachable(settleEnsure(s, callId)))
  ensures (inv(s) ==> canSettleEnsure(s, callId) ==> alwaysNoOrphanInstance(settleEnsure(s, callId)))
  ensures (inv(s) ==> canSettleEnsure(s, callId) ==> alwaysStopObservationsFollowSlots(settleEnsure(s, callId)))
  ensures (inv(s) ==> canSettleEnsure(s, callId) ==> alwaysRetiredUndeclaredTypeIsUnknown(settleEnsure(s, callId)))
  ensures (inv(s) ==> canSettleEnsure(s, callId) ==> alwaysRetiredEpochHasNoResources(settleEnsure(s, callId)))
  ensures (inv(s) ==> canSettleEnsure(s, callId) ==> alwaysSealedOwnedClassesStable(settleEnsure(s, callId)))
{
  if inv(s) && canSettleEnsure(s, callId) {
    var after := settleEnsure(s, callId);
    core__serviceInstances_settleAcquire_ensures(s.services, callId);
    ServiceStep(s, after);
    ReachFrame(s, after);
    PutTypeLookups();
    var serviceType := core__serviceInstances_acquireCall(s.services, callId).serviceType;
    if core__serviceInstances_firstLive(s.services, serviceType) != 0 { PublishedDeclared(s, serviceType); }
    UndeclaredFrame(s, after);
  }
}

lemma finishClassStart_ensures(s: PluginServices, attemptId: int, instanceId: int)
  ensures (inv(s) ==> canFinishClassStart(s, attemptId, instanceId) ==> alwaysEpochIdentityUnique(finishClassStart(s, attemptId, instanceId)))
  ensures (inv(s) ==> canFinishClassStart(s, attemptId, instanceId) ==> alwaysOneActiveEpochPerName(finishClassStart(s, attemptId, instanceId)))
  ensures (inv(s) ==> canFinishClassStart(s, attemptId, instanceId) ==> alwaysEpochOutcomeHonest(finishClassStart(s, attemptId, instanceId)))
  ensures (inv(s) ==> canFinishClassStart(s, attemptId, instanceId) ==> alwaysRetirementPerRetiredEpoch(finishClassStart(s, attemptId, instanceId)))
  ensures (inv(s) ==> canFinishClassStart(s, attemptId, instanceId) ==> alwaysLiveClassOwnerUnique(finishClassStart(s, attemptId, instanceId)))
  ensures (inv(s) ==> canFinishClassStart(s, attemptId, instanceId) ==> alwaysServiceOwnerEpochExists(finishClassStart(s, attemptId, instanceId)))
  ensures (inv(s) ==> canFinishClassStart(s, attemptId, instanceId) ==> alwaysChildLifecyclesValid(finishClassStart(s, attemptId, instanceId)))
  ensures (inv(s) ==> canFinishClassStart(s, attemptId, instanceId) ==> alwaysOwnedClassesMatchServices(finishClassStart(s, attemptId, instanceId)))
  ensures (inv(s) ==> canFinishClassStart(s, attemptId, instanceId) ==> alwaysInvokingStartHasNoInstance(finishClassStart(s, attemptId, instanceId)))
  ensures (inv(s) ==> canFinishClassStart(s, attemptId, instanceId) ==> alwaysRetirementFollowsPlan(finishClassStart(s, attemptId, instanceId)))
  ensures (inv(s) ==> canFinishClassStart(s, attemptId, instanceId) ==> alwaysLiveInstanceReachable(finishClassStart(s, attemptId, instanceId)))
  ensures (inv(s) ==> canFinishClassStart(s, attemptId, instanceId) ==> alwaysNoOrphanInstance(finishClassStart(s, attemptId, instanceId)))
  ensures (inv(s) ==> canFinishClassStart(s, attemptId, instanceId) ==> alwaysStopObservationsFollowSlots(finishClassStart(s, attemptId, instanceId)))
  ensures (inv(s) ==> canFinishClassStart(s, attemptId, instanceId) ==> alwaysRetiredUndeclaredTypeIsUnknown(finishClassStart(s, attemptId, instanceId)))
  ensures (inv(s) ==> canFinishClassStart(s, attemptId, instanceId) ==> alwaysRetiredEpochHasNoResources(finishClassStart(s, attemptId, instanceId)))
  ensures (inv(s) ==> canFinishClassStart(s, attemptId, instanceId) ==> alwaysSealedOwnedClassesStable(finishClassStart(s, attemptId, instanceId)))
{
  if inv(s) && canFinishClassStart(s, attemptId, instanceId) {
    var after := finishClassStart(s, attemptId, instanceId);
    core__serviceInstances_returnInstance_ensures(s.services, attemptId, instanceId);
    ServiceStep(s, after);
    ReturnFrame(s.services, attemptId, instanceId);
    ReturnIS(s.services, attemptId, instanceId);
    ReturnReach(s, after, attemptId, instanceId);
    OrphanReturn(s, after, attemptId, instanceId);
    ClassShape(s, after);
    UndeclaredFrame(s, after);
  }
}

lemma resolveNextStart_ensures(s: PluginServices, ok: bool, instanceId: int, errorId: string)
  ensures (inv(s) ==> canResolveNextStart(s, ok, instanceId, errorId) ==> alwaysEpochIdentityUnique(resolveNextStart(s, ok, instanceId, errorId)))
  ensures (inv(s) ==> canResolveNextStart(s, ok, instanceId, errorId) ==> alwaysOneActiveEpochPerName(resolveNextStart(s, ok, instanceId, errorId)))
  ensures (inv(s) ==> canResolveNextStart(s, ok, instanceId, errorId) ==> alwaysEpochOutcomeHonest(resolveNextStart(s, ok, instanceId, errorId)))
  ensures (inv(s) ==> canResolveNextStart(s, ok, instanceId, errorId) ==> alwaysRetirementPerRetiredEpoch(resolveNextStart(s, ok, instanceId, errorId)))
  ensures (inv(s) ==> canResolveNextStart(s, ok, instanceId, errorId) ==> alwaysLiveClassOwnerUnique(resolveNextStart(s, ok, instanceId, errorId)))
  ensures (inv(s) ==> canResolveNextStart(s, ok, instanceId, errorId) ==> alwaysServiceOwnerEpochExists(resolveNextStart(s, ok, instanceId, errorId)))
  ensures (inv(s) ==> canResolveNextStart(s, ok, instanceId, errorId) ==> alwaysChildLifecyclesValid(resolveNextStart(s, ok, instanceId, errorId)))
  ensures (inv(s) ==> canResolveNextStart(s, ok, instanceId, errorId) ==> alwaysOwnedClassesMatchServices(resolveNextStart(s, ok, instanceId, errorId)))
  ensures (inv(s) ==> canResolveNextStart(s, ok, instanceId, errorId) ==> alwaysInvokingStartHasNoInstance(resolveNextStart(s, ok, instanceId, errorId)))
  ensures (inv(s) ==> canResolveNextStart(s, ok, instanceId, errorId) ==> alwaysRetirementFollowsPlan(resolveNextStart(s, ok, instanceId, errorId)))
  ensures (inv(s) ==> canResolveNextStart(s, ok, instanceId, errorId) ==> alwaysLiveInstanceReachable(resolveNextStart(s, ok, instanceId, errorId)))
  ensures (inv(s) ==> canResolveNextStart(s, ok, instanceId, errorId) ==> alwaysNoOrphanInstance(resolveNextStart(s, ok, instanceId, errorId)))
  ensures (inv(s) ==> canResolveNextStart(s, ok, instanceId, errorId) ==> alwaysStopObservationsFollowSlots(resolveNextStart(s, ok, instanceId, errorId)))
  ensures (inv(s) ==> canResolveNextStart(s, ok, instanceId, errorId) ==> alwaysRetiredUndeclaredTypeIsUnknown(resolveNextStart(s, ok, instanceId, errorId)))
  ensures (inv(s) ==> canResolveNextStart(s, ok, instanceId, errorId) ==> alwaysRetiredEpochHasNoResources(resolveNextStart(s, ok, instanceId, errorId)))
  ensures (inv(s) ==> canResolveNextStart(s, ok, instanceId, errorId) ==> alwaysSealedOwnedClassesStable(resolveNextStart(s, ok, instanceId, errorId)))
{
  if inv(s) && canResolveNextStart(s, ok, instanceId, errorId) {
    var after := resolveNextStart(s, ok, instanceId, errorId);
    core__serviceInstances_resolveNextStart_ensures(s.services, ok, instanceId, errorId);
    ServiceStep(s, after);
    var attemptId := core__serviceInstances_nextInvokingAttempt(s.services);
    if ok {
      ReturnFrame(s.services, attemptId, instanceId);
      ReturnIS(s.services, attemptId, instanceId);
      ReturnReach(s, after, attemptId, instanceId);
      OrphanReturn(s, after, attemptId, instanceId);
      ClassShape(s, after);
      UndeclaredFrame(s, after);
    } else {
      ISAttemptStep(s.services, after.services, attemptId);
      ClassShape(s, after);
      OrphanClassFrame(s, after);
      ReachFrame(s, after);
    }
  }
}

lemma ResumeIs(s: core__serviceInstances_ServiceInstances, callId: int)
  ensures core__serviceInstances_resumeAcquire(s, callId) == core__serviceInstances_admittedAcquire(callId, core__serviceInstances_acquireCall(s, callId).serviceType, s.(calls := ProofLib.Filter((other: core__serviceInstances_Acquire) => (other.id != callId), s.calls)))
{
}

lemma RegisterClassFacts(s: core__serviceInstances_ServiceInstances, classId: int, serviceType: string)
  requires core__serviceInstances_inv(s) && core__serviceInstances_canRegisterClass(s, classId, serviceType)
  requires forall c :: c in s.classes ==> c.live == 0 || c.registered
  ensures var r := core__serviceInstances_registerClass(s, classId, serviceType);
    |r.classes| >= |s.classes| && (forall i :: 0 <= i < |s.classes| ==> r.classes[i].id == s.classes[i].id && r.classes[i].pending == s.classes[i].pending && r.classes[i].live == s.classes[i].live && r.classes[i].serviceType == s.classes[i].serviceType && (s.classes[i].registered ==> r.classes[i].registered)) &&
    r.attempts == s.attempts &&
    (forall i :: |s.classes| <= i < |r.classes| ==> r.classes[i].live == 0) && r.published == s.published &&
    (forall c :: c in r.classes ==> c.live == 0 || c.registered) &&
    core__serviceInstances_serviceClass(r, classId).id == classId && core__serviceInstances_serviceClass(r, classId).serviceType == serviceType &&
    (forall x :: x != classId ==> core__serviceInstances_serviceClass(r, x).id == core__serviceInstances_serviceClass(s, x).id && core__serviceInstances_serviceClass(r, x).serviceType == core__serviceInstances_serviceClass(s, x).serviceType) &&
    r.objects == s.objects && r.stopped == s.stopped && r.declarations == s.declarations + [core__serviceInstances_ServiceDeclaration(classId, serviceType)] &&
    (forall t :: t != serviceType ==> core__serviceInstances_serviceTypeEntry(r, t).status == core__serviceInstances_serviceTypeEntry(s, t).status)
{
  PutTypeLookups();
  ClassFound(s, classId);
  var r := core__serviceInstances_registerClass(s, classId, serviceType);
  if core__serviceInstances_serviceClass(s, classId).id == 0 {
    var added := core__serviceInstances_ServiceClassEntry(classId, serviceType, true, 0, 0, 0, false);
    assert r.classes == s.classes + [added];
    forall x ensures core__serviceInstances_serviceClass(r, x) == (if x == classId then added else core__serviceInstances_serviceClass(s, x))
    {
      var p := (c: core__serviceInstances_ServiceClassEntry) => (c.id == x);
      ProofLib.FilterAppend(p, s.classes, added);
      if x == classId {
        ProofLib.FilterNone(p, s.classes);
      }
    }
  } else {
    forall x ensures core__serviceInstances_serviceClass(r, x).id == core__serviceInstances_serviceClass(s, x).id && core__serviceInstances_serviceClass(r, x).serviceType == core__serviceInstances_serviceClass(s, x).serviceType
    {
      ClassTypeLookup(s, r, x);
    }
  }
}

lemma LiveOwnersFilters(s: PluginServices)
  ensures alwaysLiveClassOwnerUnique(s) == !((exists o :: o in s.liveOwners && !(((o in s.ownership) && (|ProofLib.Filter((other: OwnedClass) => (other.classId == o.classId), s.liveOwners)| == 1)))))
{
}

lemma RegisterOwnedIs(s: PluginServices, epochId: int, classId: int, serviceType: string)
  ensures registerOwnedClass(s, epochId, classId, serviceType).liveOwners == ProofLib.Filter((o: OwnedClass) => (o.classId != classId), s.liveOwners) + [OwnedClass(epochId, classId, serviceType)]
{
}

lemma LiveOwnersAfterRegister(s: PluginServices, after: PluginServices, captured: OwnedClass)
  requires alwaysLiveClassOwnerUnique(s)
  requires after.ownership == s.ownership + [captured]
  requires after.liveOwners == ProofLib.Filter((o: OwnedClass) => (o.classId != captured.classId), s.liveOwners) + [captured]
  ensures alwaysLiveClassOwnerUnique(after)
{
  LiveOwnersFilters(s);
  LiveOwnersFilters(after);
  var q := (o: OwnedClass) => (o.classId != captured.classId);
  var kept := ProofLib.Filter(q, s.liveOwners);
  forall o | o in after.liveOwners
    ensures o in after.ownership && |ProofLib.Filter((other: OwnedClass) => (other.classId == o.classId), after.liveOwners)| == 1
  {
    var b := (other: OwnedClass) => (other.classId == o.classId);
    ProofLib.FilterAppend(b, kept, captured);
    if o == captured {
      forall i | 0 <= i < |kept| ensures !b(kept[i])
      {
        assert kept[i] in kept;
        ProofLib.FilterMember(q, s.liveOwners, kept[i]);
      }
      ProofLib.FilterNone(b, kept);
    } else {
      assert o in kept;
      ProofLib.FilterMember(q, s.liveOwners, o);
      ProofLib.FilterOfFilterLength(q, b, b, s.liveOwners);
      ProofLib.FilterMember(b, kept, o);
    }
  }
}

lemma registerOwnedClass_ensures(s: PluginServices, epochId: int, classId: int, serviceType: string)
  ensures (inv(s) ==> canRegisterOwnedClass(s, epochId, classId, serviceType) ==> alwaysEpochIdentityUnique(registerOwnedClass(s, epochId, classId, serviceType)))
  ensures (inv(s) ==> canRegisterOwnedClass(s, epochId, classId, serviceType) ==> alwaysOneActiveEpochPerName(registerOwnedClass(s, epochId, classId, serviceType)))
  ensures (inv(s) ==> canRegisterOwnedClass(s, epochId, classId, serviceType) ==> alwaysEpochOutcomeHonest(registerOwnedClass(s, epochId, classId, serviceType)))
  ensures (inv(s) ==> canRegisterOwnedClass(s, epochId, classId, serviceType) ==> alwaysRetirementPerRetiredEpoch(registerOwnedClass(s, epochId, classId, serviceType)))
  ensures (inv(s) ==> canRegisterOwnedClass(s, epochId, classId, serviceType) ==> alwaysLiveClassOwnerUnique(registerOwnedClass(s, epochId, classId, serviceType)))
  ensures (inv(s) ==> canRegisterOwnedClass(s, epochId, classId, serviceType) ==> alwaysServiceOwnerEpochExists(registerOwnedClass(s, epochId, classId, serviceType)))
  ensures (inv(s) ==> canRegisterOwnedClass(s, epochId, classId, serviceType) ==> alwaysChildLifecyclesValid(registerOwnedClass(s, epochId, classId, serviceType)))
  ensures (inv(s) ==> canRegisterOwnedClass(s, epochId, classId, serviceType) ==> alwaysOwnedClassesMatchServices(registerOwnedClass(s, epochId, classId, serviceType)))
  ensures (inv(s) ==> canRegisterOwnedClass(s, epochId, classId, serviceType) ==> alwaysInvokingStartHasNoInstance(registerOwnedClass(s, epochId, classId, serviceType)))
  ensures (inv(s) ==> canRegisterOwnedClass(s, epochId, classId, serviceType) ==> alwaysRetirementFollowsPlan(registerOwnedClass(s, epochId, classId, serviceType)))
  ensures (inv(s) ==> canRegisterOwnedClass(s, epochId, classId, serviceType) ==> alwaysLiveInstanceReachable(registerOwnedClass(s, epochId, classId, serviceType)))
  ensures (inv(s) ==> canRegisterOwnedClass(s, epochId, classId, serviceType) ==> alwaysNoOrphanInstance(registerOwnedClass(s, epochId, classId, serviceType)))
  ensures (inv(s) ==> canRegisterOwnedClass(s, epochId, classId, serviceType) ==> alwaysStopObservationsFollowSlots(registerOwnedClass(s, epochId, classId, serviceType)))
  ensures (inv(s) ==> canRegisterOwnedClass(s, epochId, classId, serviceType) ==> alwaysRetiredUndeclaredTypeIsUnknown(registerOwnedClass(s, epochId, classId, serviceType)))
  ensures (inv(s) ==> canRegisterOwnedClass(s, epochId, classId, serviceType) ==> alwaysRetiredEpochHasNoResources(registerOwnedClass(s, epochId, classId, serviceType)))
  ensures (inv(s) ==> canRegisterOwnedClass(s, epochId, classId, serviceType) ==> alwaysSealedOwnedClassesStable(registerOwnedClass(s, epochId, classId, serviceType)))
{
  if inv(s) && canRegisterOwnedClass(s, epochId, classId, serviceType) {
    var after := registerOwnedClass(s, epochId, classId, serviceType);
    var captured := OwnedClass(epochId, classId, serviceType);
    core__serviceInstances_registerClass_ensures(s.services, classId, serviceType);
    ServiceStep(s, after);
    RegisterClassFacts(s.services, classId, serviceType);
    ISClassFrame(s.services, after.services);
    ClassFound(s.services, classId);
    forall o | o in after.ownership
      ensures core__serviceInstances_serviceClass(after.services, o.classId).id == o.classId && core__serviceInstances_serviceClass(after.services, o.classId).serviceType == o.serviceType
    {
      if o != captured {
        assert o in s.ownership;
      }
    }
    RegisterOwnedIs(s, epochId, classId, serviceType);
    LiveOwnersAfterRegister(s, after, captured);
    OrphanClassFrame(s, after);
    ReachFrame(s, after);
    UndeclaredFrame(s, after);
  }
}

lemma StopIdsFold(acc: core__serviceInstances_ServiceInstances, ids: seq<int>)
  ensures var r := Std.Collections.Seq.FoldLeft((acc: core__serviceInstances_ServiceInstances, id: int) => core__serviceInstances_stopObjectOnce(id, acc), acc, ids);
    r == acc.(objects := r.objects) && |r.objects| == |acc.objects| &&
    forall i :: 0 <= i < |acc.objects| ==> (r.objects[i].id == acc.objects[i].id &&
      (!acc.objects[i].stopPhase.StopNotRequested? ==> r.objects[i] == acc.objects[i]) &&
      (acc.objects[i].stopCalls > 0 ==> r.objects[i].stopCalls > 0) &&
      (acc.objects[i].id in ids ==> !r.objects[i].stopPhase.StopNotRequested?))
  decreases |ids|
{
  if |ids| > 0 {
    var f := (acc: core__serviceInstances_ServiceInstances, id: int) => core__serviceInstances_stopObjectOnce(id, acc);
    var next := core__serviceInstances_stopObjectOnce(ids[0], acc);
    assert Std.Collections.Seq.FoldLeft(f, acc, ids) == Std.Collections.Seq.FoldLeft(f, next, ids[1..]);
    StopIdsFold(next, ids[1..]);
    forall i | 0 <= i < |acc.objects| && acc.objects[i].id in ids && acc.objects[i].id != ids[0] ensures acc.objects[i].id in ids[1..]
    {
    }
  }
}

lemma StopTypesFold(acc: core__serviceInstances_ServiceInstances, ps: seq<core__serviceInstances_ServicePublication>)
  ensures var r := Std.Collections.Seq.FoldLeft((acc: core__serviceInstances_ServiceInstances, p: core__serviceInstances_ServicePublication) => core__serviceInstances_stopPublishedType(p, acc), acc, ps);
    r == acc.(objects := r.objects) && |r.objects| == |acc.objects| &&
    forall i :: 0 <= i < |acc.objects| ==> (r.objects[i].id == acc.objects[i].id &&
      (!acc.objects[i].stopPhase.StopNotRequested? ==> r.objects[i] == acc.objects[i]) &&
      (acc.objects[i].stopCalls > 0 ==> r.objects[i].stopCalls > 0) &&
      ((exists p :: p in ps && acc.objects[i].id in p.instances) ==> !r.objects[i].stopPhase.StopNotRequested?))
  decreases |ps|
{
  if |ps| > 0 {
    var f := (acc: core__serviceInstances_ServiceInstances, p: core__serviceInstances_ServicePublication) => core__serviceInstances_stopPublishedType(p, acc);
    var next := core__serviceInstances_stopPublishedType(ps[0], acc);
    assert Std.Collections.Seq.FoldLeft(f, acc, ps) == Std.Collections.Seq.FoldLeft(f, next, ps[1..]);
    StopIdsFold(acc, ps[0].instances);
    StopTypesFold(next, ps[1..]);
    forall i | 0 <= i < |acc.objects| && (exists p :: p in ps && acc.objects[i].id in p.instances) && !(acc.objects[i].id in ps[0].instances)
      ensures exists p :: p in ps[1..] && next.objects[i].id in p.instances
    {
      var p :| p in ps && acc.objects[i].id in p.instances;
      assert p != ps[0];
      assert p in ps[1..];
    }
  }
}
lemma stopServices_ensures(s: PluginServices)
  ensures (inv(s) ==> canStopServices(s) ==> alwaysEpochIdentityUnique(stopServices(s)))
  ensures (inv(s) ==> canStopServices(s) ==> alwaysOneActiveEpochPerName(stopServices(s)))
  ensures (inv(s) ==> canStopServices(s) ==> alwaysEpochOutcomeHonest(stopServices(s)))
  ensures (inv(s) ==> canStopServices(s) ==> alwaysRetirementPerRetiredEpoch(stopServices(s)))
  ensures (inv(s) ==> canStopServices(s) ==> alwaysLiveClassOwnerUnique(stopServices(s)))
  ensures (inv(s) ==> canStopServices(s) ==> alwaysServiceOwnerEpochExists(stopServices(s)))
  ensures (inv(s) ==> canStopServices(s) ==> alwaysChildLifecyclesValid(stopServices(s)))
  ensures (inv(s) ==> canStopServices(s) ==> alwaysOwnedClassesMatchServices(stopServices(s)))
  ensures (inv(s) ==> canStopServices(s) ==> alwaysInvokingStartHasNoInstance(stopServices(s)))
  ensures (inv(s) ==> canStopServices(s) ==> alwaysRetirementFollowsPlan(stopServices(s)))
  ensures (inv(s) ==> canStopServices(s) ==> alwaysLiveInstanceReachable(stopServices(s)))
  ensures (inv(s) ==> canStopServices(s) ==> alwaysNoOrphanInstance(stopServices(s)))
  ensures (inv(s) ==> canStopServices(s) ==> alwaysStopObservationsFollowSlots(stopServices(s)))
  ensures (inv(s) ==> canStopServices(s) ==> alwaysRetiredUndeclaredTypeIsUnknown(stopServices(s)))
  ensures (inv(s) ==> canStopServices(s) ==> alwaysRetiredEpochHasNoResources(stopServices(s)))
  ensures (inv(s) ==> canStopServices(s) ==> alwaysSealedOwnedClassesStable(stopServices(s)))
{
  if inv(s) && canStopServices(s) {
    var after := stopServices(s);
    core__serviceInstances_stopRuntime_ensures(s.services);
    ServiceStep(s, after);
    StopTypesFold(s.services, s.services.published);
    ClassShape(s, after);
    var mid := Std.Collections.Seq.FoldLeft((acc: core__serviceInstances_ServiceInstances, p: core__serviceInstances_ServicePublication) => core__serviceInstances_stopPublishedType(p, acc), s.services, s.services.published);
    assert after.services.objects == mid.objects;
    StopOrphans(s, after);
  }
}

lemma OwnsOpen(s: PluginServices, k: int)
  requires inv(s) && 0 <= k < |s.retirements|
  requires |s.retirements[k].groups| == s.retirements[k].cursor + 1 && !s.retirements[k].exited
  ensures epochOwnsResources(s, s.retirements[k].epochId)
{
  var r := s.retirements[k];
  assert r in s.retirements && retirementShaped(r);
  var i := RetirementIndex(s, r);
}

lemma ShapeReplaceCurrent(r: ServiceRetirement, r2: ServiceRetirement, g2: RetirementGroup)
  requires retirementShaped(r) && 0 <= r.cursor && |r.groups| == r.cursor + 1
  requires r2.plan == r.plan && r2.cursor == r.cursor && r2.groups == r.groups[r.cursor := g2]
  requires g2.serviceType == r.groups[r.cursor].serviceType && groupSlotsPassed(g2) && !(g2.phase.GroupFinished? || g2.phase.GroupSkipped?)
  requires r2.exited == g2.phase.GroupFailed?
  ensures retirementShaped(r2)
{
  ShapedFilters(r);
  GroupsPlan(r);
  GroupsPlan(r2);
  GroupsDistinct(r);
  ShapedFilters(r);
  ShapedFilters(r2);
  forall g | g in r2.groups ensures groupSlotsPassed(g) && ((g.phase.GroupFinished? || g.phase.GroupSkipped?) == !(isCurrentGroup(r2, g)))
  {
    var j :| 0 <= j < |r2.groups| && r2.groups[j] == g;
    if j != r.cursor {
      assert r.groups[j] in r.groups && g == r.groups[j];
      assert g.serviceType != r.groups[r.cursor].serviceType;
    }
  }
}

lemma UndeclaredAt(s: PluginServices, after: PluginServices, k: int, c: int, g2: RetirementGroup, r2: ServiceRetirement)
  requires alwaysRetiredUndeclaredTypeIsUnknown(s)
  requires after.services.stopped == s.services.stopped && after.services.declarations == s.services.declarations
  requires 0 <= k < |s.retirements| && after.retirements == s.retirements[k := r2]
  requires 0 <= c < |s.retirements[k].groups| && r2.groups == s.retirements[k].groups[c := g2]
  requires g2.serviceType == s.retirements[k].groups[c].serviceType
  requires !g2.phase.GroupWaiting? && (g2.phase.GroupSkipped? == s.retirements[k].groups[c].phase.GroupSkipped?)
  requires forall t :: t != g2.serviceType ==> core__serviceInstances_serviceTypeEntry(after.services, t).status == core__serviceInstances_serviceTypeEntry(s.services, t).status
  requires (exists d :: d in s.services.declarations && d.serviceType == g2.serviceType) || core__serviceInstances_serviceTypeEntry(after.services, g2.serviceType).status.TypeUnknown? ||
    (core__serviceInstances_serviceTypeEntry(after.services, g2.serviceType).status == core__serviceInstances_serviceTypeEntry(s.services, g2.serviceType).status && !s.retirements[k].groups[c].phase.GroupWaiting?)
  ensures alwaysRetiredUndeclaredTypeIsUnknown(after)
{
  var gc := s.retirements[k].groups[c];
  if !after.services.stopped {
    forall rr, gg | rr in after.retirements && gg in rr.groups && !gg.phase.GroupWaiting? && !gg.phase.GroupSkipped? &&
      !(exists d :: d in after.services.declarations && d.serviceType == gg.serviceType) &&
      !(exists other :: other in after.retirements && (exists pending :: pending in other.groups && pending.serviceType == gg.serviceType && pending.phase.GroupWaiting?))
      ensures core__serviceInstances_serviceTypeEntry(after.services, gg.serviceType).status.TypeUnknown?
    {
      var t := gg.serviceType;
      var i :| 0 <= i < |after.retirements| && after.retirements[i] == rr;
      var j :| 0 <= j < |rr.groups| && rr.groups[j] == gg;
      var prior := if i == k && j == c then gc else s.retirements[i].groups[j];
      assert prior in s.retirements[i].groups && s.retirements[i] in s.retirements;
      forall other, pending | other in s.retirements && pending in other.groups && pending.serviceType == t && pending.phase.GroupWaiting? && pending != gc
        ensures false
      {
        var i2 :| 0 <= i2 < |s.retirements| && s.retirements[i2] == other;
        var j2 :| 0 <= j2 < |other.groups| && other.groups[j2] == pending;
        if i2 == k {
          if j2 == c { assert pending == gc; }
          assert r2.groups[j2] == pending && after.retirements[k] == r2;
        } else {
          assert after.retirements[i2] == other;
        }
      }
      if t != g2.serviceType {
        if i == k && j == c { assert gg == g2; }
        assert prior == gg;
      } else if !(core__serviceInstances_serviceTypeEntry(after.services, t).status.TypeUnknown?) {
        assert !gc.phase.GroupWaiting?;
        if i == k && j == c { assert gg == g2; } else { assert prior == gg; }
      }
    }
  }
}

lemma requestOwnedStops_ensures(s: PluginServices, epochId: int)
  ensures (inv(s) ==> canRequestOwnedStops(s, epochId) ==> alwaysEpochIdentityUnique(requestOwnedStops(s, epochId)))
  ensures (inv(s) ==> canRequestOwnedStops(s, epochId) ==> alwaysOneActiveEpochPerName(requestOwnedStops(s, epochId)))
  ensures (inv(s) ==> canRequestOwnedStops(s, epochId) ==> alwaysEpochOutcomeHonest(requestOwnedStops(s, epochId)))
  ensures (inv(s) ==> canRequestOwnedStops(s, epochId) ==> alwaysRetirementPerRetiredEpoch(requestOwnedStops(s, epochId)))
  ensures (inv(s) ==> canRequestOwnedStops(s, epochId) ==> alwaysLiveClassOwnerUnique(requestOwnedStops(s, epochId)))
  ensures (inv(s) ==> canRequestOwnedStops(s, epochId) ==> alwaysServiceOwnerEpochExists(requestOwnedStops(s, epochId)))
  ensures (inv(s) ==> canRequestOwnedStops(s, epochId) ==> alwaysChildLifecyclesValid(requestOwnedStops(s, epochId)))
  ensures (inv(s) ==> canRequestOwnedStops(s, epochId) ==> alwaysOwnedClassesMatchServices(requestOwnedStops(s, epochId)))
  ensures (inv(s) ==> canRequestOwnedStops(s, epochId) ==> alwaysInvokingStartHasNoInstance(requestOwnedStops(s, epochId)))
  ensures (inv(s) ==> canRequestOwnedStops(s, epochId) ==> alwaysRetirementFollowsPlan(requestOwnedStops(s, epochId)))
  ensures (inv(s) ==> canRequestOwnedStops(s, epochId) ==> alwaysLiveInstanceReachable(requestOwnedStops(s, epochId)))
  ensures (inv(s) ==> canRequestOwnedStops(s, epochId) ==> alwaysNoOrphanInstance(requestOwnedStops(s, epochId)))
  ensures (inv(s) ==> canRequestOwnedStops(s, epochId) ==> alwaysStopObservationsFollowSlots(requestOwnedStops(s, epochId)))
  ensures (inv(s) ==> canRequestOwnedStops(s, epochId) ==> alwaysRetiredUndeclaredTypeIsUnknown(requestOwnedStops(s, epochId)))
  ensures (inv(s) ==> canRequestOwnedStops(s, epochId) ==> alwaysRetiredEpochHasNoResources(requestOwnedStops(s, epochId)))
  ensures (inv(s) ==> canRequestOwnedStops(s, epochId) ==> alwaysSealedOwnedClassesStable(requestOwnedStops(s, epochId)))
{
  if inv(s) && canRequestOwnedStops(s, epochId) {
    var k := CurrentAt(s, epochId);
    var r := s.retirements[k];
    var g := r.groups[r.cursor];
    var g2 := g.(phase := (if (|g.instances| == 0) then RetirementGroupPhase.GroupStoppingClasses else RetirementGroupPhase.GroupStoppingInstances));
    var s1 := s.(services := core__serviceInstances_reconcileType(g.serviceType, s.services));
    GroupsDistinct(r);
    PutAt(s1, epochId, g2, k);
    var r2 := r.(groups := r.groups[r.cursor := g2]);
    var after := requestOwnedStops(s, epochId);
    assert after == s1.(retirements := s.retirements[k := r2]);
    assert r.groups[r.cursor] in r.groups;
    ReconcileInv(g.serviceType, s.services);
    ChildInv(after);
    UAt(s, after, k, r2);
    ShapeReplaceCurrent(r, r2, g2);
    ShapeAt(s, after, k, r2);
    StopsValid(g, s.services);
    StopsValid(g2, after.services);
    assert |g.observedStops| == 0;
    assert forall slot :: stopSlotSettled(slot, s.services) ==> stopSlotSettled(slot, after.services);
    SlotsAtGroup(s, after, k, r.cursor, g2, r2);
    OwnsOpen(s, k);
    NoResourcesAt(s, after, k, r2);
    OrphanAt(s, after, k, r.cursor, g2, r2);
    StepSameObjects(s.services, after.services);
    ReachAt(s, after, k, r.cursor, g2, r2);
    PutTypeLookups();
    if !(exists d :: d in s.services.declarations && d.serviceType == g.serviceType) && core__serviceInstances_firstLive(s.services, g.serviceType) != 0 {
      PublishedDeclared(s, g.serviceType);
    }
    UndeclaredAt(s, after, k, r.cursor, g2, r2);
    ClassShape(s, after);
  }
}

lemma SlotsAtGroup(s: PluginServices, after: PluginServices, k: int, c: int, g2: RetirementGroup, r2: ServiceRetirement)
  requires alwaysStopObservationsFollowSlots(s)
  requires 0 <= k < |s.retirements| && after.retirements == s.retirements[k := r2]
  requires 0 <= c < |s.retirements[k].groups| && r2.groups == s.retirements[k].groups[c := g2]
  requires forall slot :: stopSlotSettled(slot, s.services) ==> stopSlotSettled(slot, after.services)
  requires g2.instanceCursor >= 0 && g2.instanceCursor <= |g2.instances| && |g2.observedStops| >= g2.instanceCursor && |g2.observedStops| <= |g2.instances| && |g2.observedStops| <= g2.instanceCursor + 1
  requires classPhaseFollowsInstances(g2)
  requires forall i :: 0 <= i < |g2.observedStops| ==> validStopObservation(g2, i, g2.observedStops[i], after.services)
  ensures alwaysStopObservationsFollowSlots(after)
{
  var r := s.retirements[k];
  assert r in s.retirements;
  forall g | g in r2.groups
    ensures g.instanceCursor >= 0 && g.instanceCursor <= |g.instances| && |g.observedStops| >= g.instanceCursor && |g.observedStops| <= |g.instances| && |g.observedStops| <= g.instanceCursor + 1 && classPhaseFollowsInstances(g) && allStopObservationsValid(g, after.services)
  {
    StopsValid(g, after.services);
    if g != g2 {
      var j :| 0 <= j < |r2.groups| && r2.groups[j] == g;
      assert j != c && g == r.groups[j] && g in r.groups;
      StopsValid(g, s.services);
    }
  }
  SlotsAt(s, after, k, r2);
}

lemma ClassFailedLookup(s: core__serviceInstances_ServiceInstances, next: core__serviceInstances_ServiceInstances)
  requires |next.classes| == |s.classes|
  requires forall i :: 0 <= i < |s.classes| ==> next.classes[i] == s.classes[i].(failed := next.classes[i].failed)
  ensures forall x :: core__serviceInstances_serviceClass(next, x) == core__serviceInstances_serviceClass(s, x).(failed := core__serviceInstances_serviceClass(next, x).failed)
  ensures forall c :: c in next.classes ==> exists i :: 0 <= i < |s.classes| && next.classes[i] == c && s.classes[i] in s.classes
  ensures forall c :: c in s.classes ==> exists i :: 0 <= i < |s.classes| && s.classes[i] == c && next.classes[i] in next.classes
{
  forall x ensures core__serviceInstances_serviceClass(next, x) == core__serviceInstances_serviceClass(s, x).(failed := core__serviceInstances_serviceClass(next, x).failed)
  {
    var p := (c: core__serviceInstances_ServiceClassEntry) => (c.id == x);
    ProofLib.FilterPointwise(p, p, (a: core__serviceInstances_ServiceClassEntry, b: core__serviceInstances_ServiceClassEntry) => (b == a.(failed := b.failed)), s.classes, next.classes);
  }
  forall c | c in next.classes ensures exists i :: 0 <= i < |s.classes| && next.classes[i] == c && s.classes[i] in s.classes
  {
    var i :| 0 <= i < |next.classes| && next.classes[i] == c;
  }
  forall c | c in s.classes ensures exists i :: 0 <= i < |s.classes| && s.classes[i] == c && next.classes[i] in next.classes
  {
    var i :| 0 <= i < |s.classes| && s.classes[i] == c;
  }
}

lemma ClassFailedIdentities(s: core__serviceInstances_ServiceInstances, next: core__serviceInstances_ServiceInstances)
  requires core__serviceInstances_alwaysClassAndObjectIdentities(s)
  requires next == s.(classes := next.classes) && |next.classes| == |s.classes|
  requires forall i :: 0 <= i < |s.classes| ==> next.classes[i] == s.classes[i].(failed := next.classes[i].failed)
  ensures core__serviceInstances_alwaysClassAndObjectIdentities(next)
{
  forall c | c in next.classes ensures c.id > 0 && c.generation >= 0 && c.pending >= 0 && |ProofLib.Filter((other: core__serviceInstances_ServiceClassEntry) => (other.id == c.id), next.classes)| == 1
  {
    var i :| 0 <= i < |next.classes| && next.classes[i] == c;
    assert s.classes[i] in s.classes;
    ProofLib.FilterLengthPointwise((other: core__serviceInstances_ServiceClassEntry) => (other.id == c.id), (other: core__serviceInstances_ServiceClassEntry) => (other.id == c.id), s.classes, next.classes);
  }
}

lemma ClassFailedFrame(s: core__serviceInstances_ServiceInstances, next: core__serviceInstances_ServiceInstances)
  requires core__serviceInstances_inv(s)
  requires next == s.(classes := next.classes) && |next.classes| == |s.classes|
  requires forall i :: 0 <= i < |s.classes| ==> next.classes[i] == s.classes[i].(failed := next.classes[i].failed)
  ensures core__serviceInstances_inv(next)
{
  ClassFailedLookup(s, next);
  ClassFailedIdentities(s, next);
  assert core__serviceInstances_alwaysPendingAttemptsOwned(next);
  assert core__serviceInstances_alwaysDeclarationsMatch(next);
  assert core__serviceInstances_alwaysClassOwnsKnownObjects(next);
  assert core__serviceInstances_alwaysStoppedHasNoPublication(next);
  assert core__serviceInstances_alwaysPublicationIdentitiesValid(next);
  assert core__serviceInstances_alwaysAttemptGeneration(next);
}
lemma claimInstanceStop_ensures(s: PluginServices, epochId: int)
  ensures (inv(s) ==> canClaimInstanceStop(s, epochId) ==> alwaysEpochIdentityUnique(claimInstanceStop(s, epochId)))
  ensures (inv(s) ==> canClaimInstanceStop(s, epochId) ==> alwaysOneActiveEpochPerName(claimInstanceStop(s, epochId)))
  ensures (inv(s) ==> canClaimInstanceStop(s, epochId) ==> alwaysEpochOutcomeHonest(claimInstanceStop(s, epochId)))
  ensures (inv(s) ==> canClaimInstanceStop(s, epochId) ==> alwaysRetirementPerRetiredEpoch(claimInstanceStop(s, epochId)))
  ensures (inv(s) ==> canClaimInstanceStop(s, epochId) ==> alwaysLiveClassOwnerUnique(claimInstanceStop(s, epochId)))
  ensures (inv(s) ==> canClaimInstanceStop(s, epochId) ==> alwaysServiceOwnerEpochExists(claimInstanceStop(s, epochId)))
  ensures (inv(s) ==> canClaimInstanceStop(s, epochId) ==> alwaysChildLifecyclesValid(claimInstanceStop(s, epochId)))
  ensures (inv(s) ==> canClaimInstanceStop(s, epochId) ==> alwaysOwnedClassesMatchServices(claimInstanceStop(s, epochId)))
  ensures (inv(s) ==> canClaimInstanceStop(s, epochId) ==> alwaysInvokingStartHasNoInstance(claimInstanceStop(s, epochId)))
  ensures (inv(s) ==> canClaimInstanceStop(s, epochId) ==> alwaysRetirementFollowsPlan(claimInstanceStop(s, epochId)))
  ensures (inv(s) ==> canClaimInstanceStop(s, epochId) ==> alwaysLiveInstanceReachable(claimInstanceStop(s, epochId)))
  ensures (inv(s) ==> canClaimInstanceStop(s, epochId) ==> alwaysNoOrphanInstance(claimInstanceStop(s, epochId)))
  ensures (inv(s) ==> canClaimInstanceStop(s, epochId) ==> alwaysStopObservationsFollowSlots(claimInstanceStop(s, epochId)))
  ensures (inv(s) ==> canClaimInstanceStop(s, epochId) ==> alwaysRetiredUndeclaredTypeIsUnknown(claimInstanceStop(s, epochId)))
  ensures (inv(s) ==> canClaimInstanceStop(s, epochId) ==> alwaysRetiredEpochHasNoResources(claimInstanceStop(s, epochId)))
  ensures (inv(s) ==> canClaimInstanceStop(s, epochId) ==> alwaysSealedOwnedClassesStable(claimInstanceStop(s, epochId)))
{
  if inv(s) && canClaimInstanceStop(s, epochId) {
    ClaimKeepsEpochs(s, epochId);
    ClaimKeepsRetirements(s, epochId);
    ClaimKeepsServices(s, epochId);
    ClaimKeepsInstances(s, epochId);
  }
}

lemma skipMissingStop_ensures(s: PluginServices, epochId: int)
  ensures (inv(s) ==> canSkipMissingStop(s, epochId) ==> alwaysEpochIdentityUnique(skipMissingStop(s, epochId)))
  ensures (inv(s) ==> canSkipMissingStop(s, epochId) ==> alwaysOneActiveEpochPerName(skipMissingStop(s, epochId)))
  ensures (inv(s) ==> canSkipMissingStop(s, epochId) ==> alwaysEpochOutcomeHonest(skipMissingStop(s, epochId)))
  ensures (inv(s) ==> canSkipMissingStop(s, epochId) ==> alwaysRetirementPerRetiredEpoch(skipMissingStop(s, epochId)))
  ensures (inv(s) ==> canSkipMissingStop(s, epochId) ==> alwaysLiveClassOwnerUnique(skipMissingStop(s, epochId)))
  ensures (inv(s) ==> canSkipMissingStop(s, epochId) ==> alwaysServiceOwnerEpochExists(skipMissingStop(s, epochId)))
  ensures (inv(s) ==> canSkipMissingStop(s, epochId) ==> alwaysChildLifecyclesValid(skipMissingStop(s, epochId)))
  ensures (inv(s) ==> canSkipMissingStop(s, epochId) ==> alwaysOwnedClassesMatchServices(skipMissingStop(s, epochId)))
  ensures (inv(s) ==> canSkipMissingStop(s, epochId) ==> alwaysInvokingStartHasNoInstance(skipMissingStop(s, epochId)))
  ensures (inv(s) ==> canSkipMissingStop(s, epochId) ==> alwaysRetirementFollowsPlan(skipMissingStop(s, epochId)))
  ensures (inv(s) ==> canSkipMissingStop(s, epochId) ==> alwaysLiveInstanceReachable(skipMissingStop(s, epochId)))
  ensures (inv(s) ==> canSkipMissingStop(s, epochId) ==> alwaysNoOrphanInstance(skipMissingStop(s, epochId)))
  ensures (inv(s) ==> canSkipMissingStop(s, epochId) ==> alwaysStopObservationsFollowSlots(skipMissingStop(s, epochId)))
  ensures (inv(s) ==> canSkipMissingStop(s, epochId) ==> alwaysRetiredUndeclaredTypeIsUnknown(skipMissingStop(s, epochId)))
  ensures (inv(s) ==> canSkipMissingStop(s, epochId) ==> alwaysRetiredEpochHasNoResources(skipMissingStop(s, epochId)))
  ensures (inv(s) ==> canSkipMissingStop(s, epochId) ==> alwaysSealedOwnedClassesStable(skipMissingStop(s, epochId)))
{
  if inv(s) && canSkipMissingStop(s, epochId) {
    var k := CurrentAt(s, epochId);
    var r := s.retirements[k];
    var g := r.groups[r.cursor];
    assert g in r.groups && r in s.retirements;
    var id := currentInstance(s, epochId);
    var added := observedInstanceSlot(id, InstanceStopObservation.MissingStopSlot);
    var g2 := advanceInstanceSlot(g.(observedStops := g.observedStops + [added]));
    var r2 := r.(groups := r.groups[r.cursor := g2]);
    var after := skipMissingStop(s, epochId);
    assert after == s.(retirements := s.retirements[k := r2]) by {
      GroupsDistinct(r);
      PutAt(s, epochId, g2, k);
    }
    assert 0 <= g.instanceCursor < |g.instances|;
    PluginAppendObservedInstanceSlot(g, g2, s.services, after.services, added);
    UAt(s, after, k, r2);
    assert alwaysRetirementFollowsPlan(after) by {
      ShapeReplaceCurrent(r, r2, g2);
      ShapeAt(s, after, k, r2);
    }
    assert alwaysStopObservationsFollowSlots(after) by {
      SlotsAtGroup(s, after, k, r.cursor, g2, r2);
    }
    OwnsOpen(s, k);
    assert alwaysRetiredEpochHasNoResources(after) by {
      NoResourcesAt(s, after, k, r2);
    }
    assert alwaysNoOrphanInstance(after) by {
      OrphanAt(s, after, k, r.cursor, g2, r2);
    }
    StepSameObjects(s.services, after.services);
    assert alwaysLiveInstanceReachable(after) by {
      ReachAt(s, after, k, r.cursor, g2, r2);
    }
    assert alwaysRetiredUndeclaredTypeIsUnknown(after) by {
      UndeclaredAt(s, after, k, r.cursor, g2, r2);
    }
    ClassShape(s, after);
  }
}

lemma PluginAppendObservedInstanceSlot(g: RetirementGroup, after: RetirementGroup, services: core__serviceInstances_ServiceInstances, next: core__serviceInstances_ServiceInstances, added: InstanceSlot)
  requires g.phase.GroupStoppingInstances? && 0 <= g.instanceCursor < |g.instances|
  requires |g.observedStops| == g.instanceCursor && allStopObservationsValid(g, services)
  requires after.instances == g.instances && after.observedStops == g.observedStops + [added]
  requires added.instanceId == g.instances[g.instanceCursor]
  requires (added.observed.MissingStopSlot? && after.instanceCursor == g.instanceCursor + 1 && after.phase == (if after.instanceCursor == |g.instances| then RetirementGroupPhase.GroupStoppingClasses else RetirementGroupPhase.GroupStoppingInstances)) ||
    (added.observed.AwaitedStopSlot? && after.instanceCursor == g.instanceCursor && after.phase.GroupStoppingInstances?)
  requires forall slot :: stopSlotSettled(slot, services) ==> stopSlotSettled(slot, next)
  ensures 0 <= after.instanceCursor <= |after.instances|
  ensures after.instanceCursor <= |after.observedStops| <= |after.instances|
  ensures |after.observedStops| <= after.instanceCursor + 1
  ensures classPhaseFollowsInstances(after)
  ensures forall i :: 0 <= i < |after.observedStops| ==> validStopObservation(after, i, after.observedStops[i], next)
{
  StopsValid(g, services);
  forall i | 0 <= i < |after.observedStops|
    ensures validStopObservation(after, i, after.observedStops[i], next)
  {
    if i < |g.observedStops| {
      assert i < g.instanceCursor;
      assert after.observedStops[i] == g.observedStops[i];
      assert validStopObservation(g, i, g.observedStops[i], services);
      assert stopSlotSettled(g.observedStops[i], services);
      assert stopSlotSettled(after.observedStops[i], next);
      assert i < after.instanceCursor;
    } else {
      assert i == g.instanceCursor;
      assert after.observedStops[i] == added;
      if added.observed.MissingStopSlot? {
        assert i < after.instanceCursor;
        assert stopSlotSettled(added, next);
      } else {
        assert i == after.instanceCursor;
        assert after.phase.GroupStoppingInstances? && added.observed.AwaitedStopSlot?;
      }
    }
  }
}

lemma observeInstanceStop_ensures(s: PluginServices, epochId: int)
  ensures (inv(s) ==> canObserveInstanceStop(s, epochId) ==> alwaysEpochIdentityUnique(observeInstanceStop(s, epochId)))
  ensures (inv(s) ==> canObserveInstanceStop(s, epochId) ==> alwaysOneActiveEpochPerName(observeInstanceStop(s, epochId)))
  ensures (inv(s) ==> canObserveInstanceStop(s, epochId) ==> alwaysEpochOutcomeHonest(observeInstanceStop(s, epochId)))
  ensures (inv(s) ==> canObserveInstanceStop(s, epochId) ==> alwaysRetirementPerRetiredEpoch(observeInstanceStop(s, epochId)))
  ensures (inv(s) ==> canObserveInstanceStop(s, epochId) ==> alwaysLiveClassOwnerUnique(observeInstanceStop(s, epochId)))
  ensures (inv(s) ==> canObserveInstanceStop(s, epochId) ==> alwaysServiceOwnerEpochExists(observeInstanceStop(s, epochId)))
  ensures (inv(s) ==> canObserveInstanceStop(s, epochId) ==> alwaysChildLifecyclesValid(observeInstanceStop(s, epochId)))
  ensures (inv(s) ==> canObserveInstanceStop(s, epochId) ==> alwaysOwnedClassesMatchServices(observeInstanceStop(s, epochId)))
  ensures (inv(s) ==> canObserveInstanceStop(s, epochId) ==> alwaysInvokingStartHasNoInstance(observeInstanceStop(s, epochId)))
  ensures (inv(s) ==> canObserveInstanceStop(s, epochId) ==> alwaysRetirementFollowsPlan(observeInstanceStop(s, epochId)))
  ensures (inv(s) ==> canObserveInstanceStop(s, epochId) ==> alwaysLiveInstanceReachable(observeInstanceStop(s, epochId)))
  ensures (inv(s) ==> canObserveInstanceStop(s, epochId) ==> alwaysNoOrphanInstance(observeInstanceStop(s, epochId)))
  ensures (inv(s) ==> canObserveInstanceStop(s, epochId) ==> alwaysStopObservationsFollowSlots(observeInstanceStop(s, epochId)))
  ensures (inv(s) ==> canObserveInstanceStop(s, epochId) ==> alwaysRetiredUndeclaredTypeIsUnknown(observeInstanceStop(s, epochId)))
  ensures (inv(s) ==> canObserveInstanceStop(s, epochId) ==> alwaysRetiredEpochHasNoResources(observeInstanceStop(s, epochId)))
  ensures (inv(s) ==> canObserveInstanceStop(s, epochId) ==> alwaysSealedOwnedClassesStable(observeInstanceStop(s, epochId)))
{
  if inv(s) && canObserveInstanceStop(s, epochId) {
    var k := CurrentAt(s, epochId);
    var r := s.retirements[k];
    var g := r.groups[r.cursor];
    assert g in r.groups && r in s.retirements;
    var o := core__serviceInstances_serviceObject(s.services, currentInstance(s, epochId));
    var counted := s.(retirements := s.retirements[k := r.(failures := (if o.stopPhase.StopFailed? then r.failures + [o.errorId] else r.failures))]);
    var rc := counted.retirements[k];
    assert counted == s.(retirements := (var s_map := s.retirements; seq(|s_map|, i_map requires 0 <= i_map < |s_map| => var x := s_map[i_map]; (if ((x.epochId == epochId) && o.stopPhase.StopFailed?) then x.(failures := (x.failures + [o.errorId])) else x))));
    var g2 := advanceInstanceSlot(g);
    GroupsDistinct(r);
    PutAt(counted, epochId, g2, k);
    var r2 := rc.(groups := r.groups[r.cursor := g2]);
    var after := observeInstanceStop(s, epochId);
    assert after == s.(retirements := s.retirements[k := r2]);
    StopsValid(g2, after.services);
    UAt(s, after, k, r2);
    ShapeReplaceCurrent(r, r2, g2);
    ShapeAt(s, after, k, r2);
    StopsValid(g, s.services);
    SlotsAtGroup(s, after, k, r.cursor, g2, r2);
    OwnsOpen(s, k);
    NoResourcesAt(s, after, k, r2);
    OrphanAt(s, after, k, r.cursor, g2, r2);
    StepSameObjects(s.services, after.services);
    ReachAt(s, after, k, r.cursor, g2, r2);
    UndeclaredAt(s, after, k, r.cursor, g2, r2);
    ClassShape(s, after);
  }
}

lemma PluginClearRetiredFailureKeepsRules(s: PluginServices, classId: int)
  requires inv(s)
  ensures inv(clearRetiredClassFailure(classId, s))
{
  var after := clearRetiredClassFailure(classId, s);
  assert after == s.(services := after.services);
  assert after.services == s.services.(classes := after.services.classes);
  forall i | 0 <= i < |s.services.classes|
    ensures after.services.classes[i] == s.services.classes[i].(failed := after.services.classes[i].failed)
  {}
  ChildInv(s);
  ClassFailedFrame(s.services, after.services);
  ClassFailedLookup(s.services, after.services);
  ISClassFrame(s.services, after.services);
  ChildInv(after);
  StepSameObjects(s.services, after.services);
  ServiceStep(s, after);
  ClassShape(s, after);
  OrphanClassFrame(s, after);
  ReachFrame(s, after);
  UndeclaredFrame(s, after);
}

lemma PluginClassSlotCompletionKeepsRules(s: PluginServices, epochId: int)
  requires inv(s) && currentGroup(s, epochId).phase.GroupStoppingClasses? && currentClassHook(s, epochId).id != 0 && (currentGroup(s, epochId).hook.HookReady? || currentGroup(s, epochId).hook.HookFinished?)
  ensures inv(finishClassSlot(s, epochId))
{
  if inv(s) && currentGroup(s, epochId).phase.GroupStoppingClasses? && currentClassHook(s, epochId).id != 0 && (currentGroup(s, epochId).hook.HookReady? || currentGroup(s, epochId).hook.HookFinished?) {
    var k := CurrentAt(s, epochId);
    var r := s.retirements[k];
    var g := r.groups[r.cursor];
    assert g in r.groups && r in s.retirements;
    var c := currentClassHook(s, epochId);
    var cleared := if g.hook.HookReady? then clearRetiredClassFailure(c.id, s) else s;
    var s1 := cleared.(liveOwners := ProofLib.Filter((o: OwnedClass) => ((o.classId != c.id) || (o.epochId != epochId)), cleared.liveOwners));
    var g2 := g.(classCursor := (g.classCursor + 1), hook := ClassHookPhase.HookReady);
    GroupsDistinct(r);
    PutAt(s1, epochId, g2, k);
    var r2 := r.(groups := r.groups[r.cursor := g2]);
    var after := finishClassSlot(s, epochId);
    FinishSlotIs(s, epochId);
    assert after == s1.(retirements := s.retirements[k := r2]);
    ClassFailedFrame(s.services, after.services);
    ISClassFrame(s.services, after.services);
    ChildInv(after);
    LiveOwnersSubset(s, after, (o: OwnedClass) => ((o.classId != c.id) || (o.epochId != epochId)));
    StopsValid(g2, after.services);
    UAt(s, after, k, r2);
    ShapeReplaceCurrent(r, r2, g2);
    ShapeAt(s, after, k, r2);
    StopsValid(g, s.services);
    SlotsAtGroup(s, after, k, r.cursor, g2, r2);
    OwnsOpen(s, k);
    NoResourcesAt(s, after, k, r2);
    OrphanAt(s, after, k, r.cursor, g2, r2);
    StepSameObjects(s.services, after.services);
    ReachAt(s, after, k, r.cursor, g2, r2);
    UndeclaredAt(s, after, k, r.cursor, g2, r2);
    ClassShape(s, after);
  }
}

lemma PluginClassHookReadFailureKeepsRules(s: PluginServices, epochId: int, errorId: string)
  requires inv(s) && currentGroup(s, epochId).phase.GroupStoppingClasses? && currentClassHook(s, epochId).id != 0 && (currentGroup(s, epochId).hook.HookReady? || currentGroup(s, epochId).hook.HookPending?)
  ensures inv(finishClassHook(s, epochId, false, errorId))
{
  var k := CurrentAt(s, epochId);
  var r := s.retirements[k];
  var g := r.groups[r.cursor];
  assert g in r.groups && r in s.retirements;
  var after := finishClassHook(s, epochId, false, errorId);
  var marked := s.(retirements := s.retirements[k := r.(exited := true, hookError := errorId)]);
  assert marked == s.(retirements := (var s_map := s.retirements; seq(|s_map|, i_map requires 0 <= i_map < |s_map| => var x := s_map[i_map]; (if (x.epochId == epochId) then x.(exited := true, hookError := errorId) else x))));
  var g2 := g.(hook := ClassHookPhase.HookFailed, phase := RetirementGroupPhase.GroupFailed);
  GroupsDistinct(r);
  PutAt(marked, epochId, g2, k);
  var r2 := r.(exited := true, hookError := errorId, groups := r.groups[r.cursor := g2]);
  assert after == s.(retirements := s.retirements[k := r2]);
  StopsValid(g2, after.services);
  UAt(s, after, k, r2);
  ShapeReplaceCurrent(r, r2, g2);
  ShapeAt(s, after, k, r2);
  StopsValid(g, s.services);
  SlotsAtGroup(s, after, k, r.cursor, g2, r2);
  OwnsOpen(s, k);
  NoResourcesAt(s, after, k, r2);
  OrphanAt(s, after, k, r.cursor, g2, r2);
  StepSameObjects(s.services, after.services);
  ReachAt(s, after, k, r.cursor, g2, r2);
  UndeclaredAt(s, after, k, r.cursor, g2, r2);
  ClassShape(s, after);
}

lemma observeClassHook_ensures(s: PluginServices, epochId: int, hookObservation: ClassHookObservation)
  ensures (inv(s) ==> canObserveClassHook(s, epochId, hookObservation) ==> alwaysEpochIdentityUnique(observeClassHook(s, epochId, hookObservation)))
  ensures (inv(s) ==> canObserveClassHook(s, epochId, hookObservation) ==> alwaysOneActiveEpochPerName(observeClassHook(s, epochId, hookObservation)))
  ensures (inv(s) ==> canObserveClassHook(s, epochId, hookObservation) ==> alwaysEpochOutcomeHonest(observeClassHook(s, epochId, hookObservation)))
  ensures (inv(s) ==> canObserveClassHook(s, epochId, hookObservation) ==> alwaysRetirementPerRetiredEpoch(observeClassHook(s, epochId, hookObservation)))
  ensures (inv(s) ==> canObserveClassHook(s, epochId, hookObservation) ==> alwaysLiveClassOwnerUnique(observeClassHook(s, epochId, hookObservation)))
  ensures (inv(s) ==> canObserveClassHook(s, epochId, hookObservation) ==> alwaysServiceOwnerEpochExists(observeClassHook(s, epochId, hookObservation)))
  ensures (inv(s) ==> canObserveClassHook(s, epochId, hookObservation) ==> alwaysChildLifecyclesValid(observeClassHook(s, epochId, hookObservation)))
  ensures (inv(s) ==> canObserveClassHook(s, epochId, hookObservation) ==> alwaysOwnedClassesMatchServices(observeClassHook(s, epochId, hookObservation)))
  ensures (inv(s) ==> canObserveClassHook(s, epochId, hookObservation) ==> alwaysInvokingStartHasNoInstance(observeClassHook(s, epochId, hookObservation)))
  ensures (inv(s) ==> canObserveClassHook(s, epochId, hookObservation) ==> alwaysRetirementFollowsPlan(observeClassHook(s, epochId, hookObservation)))
  ensures (inv(s) ==> canObserveClassHook(s, epochId, hookObservation) ==> alwaysLiveInstanceReachable(observeClassHook(s, epochId, hookObservation)))
  ensures (inv(s) ==> canObserveClassHook(s, epochId, hookObservation) ==> alwaysNoOrphanInstance(observeClassHook(s, epochId, hookObservation)))
  ensures (inv(s) ==> canObserveClassHook(s, epochId, hookObservation) ==> alwaysStopObservationsFollowSlots(observeClassHook(s, epochId, hookObservation)))
  ensures (inv(s) ==> canObserveClassHook(s, epochId, hookObservation) ==> alwaysRetiredUndeclaredTypeIsUnknown(observeClassHook(s, epochId, hookObservation)))
  ensures (inv(s) ==> canObserveClassHook(s, epochId, hookObservation) ==> alwaysRetiredEpochHasNoResources(observeClassHook(s, epochId, hookObservation)))
  ensures (inv(s) ==> canObserveClassHook(s, epochId, hookObservation) ==> alwaysSealedOwnedClassesStable(observeClassHook(s, epochId, hookObservation)))
{
  if inv(s) && canObserveClassHook(s, epochId, hookObservation) {
    var cleared := clearRetiredClassFailure(currentClassHook(s, epochId).id, s);
    PluginClearRetiredFailureKeepsRules(s, currentClassHook(s, epochId).id);
    assert currentGroup(cleared, epochId) == currentGroup(s, epochId);
    assert currentClassHook(cleared, epochId) == currentClassHook(s, epochId);
    if hookObservation.Callable? {
      var k := CurrentAt(s, epochId);
      var r := s.retirements[k];
      var g := r.groups[r.cursor];
      assert g in r.groups && r in s.retirements;
      var s1 := clearRetiredClassFailure(currentClassHook(s, epochId).id, s);
      var g2 := g.(hook := ClassHookPhase.HookPending);
      GroupsDistinct(r);
      PutAt(s1, epochId, g2, k);
      var r2 := r.(groups := r.groups[r.cursor := g2]);
      var after := observeClassHook(s, epochId, hookObservation);
      assert after == s1.(retirements := s.retirements[k := r2]);
      ClassFailedFrame(s.services, after.services);
      ISClassFrame(s.services, after.services);
      ChildInv(after);
      StopsValid(g2, after.services);
      UAt(s, after, k, r2);
      ShapeReplaceCurrent(r, r2, g2);
      ShapeAt(s, after, k, r2);
      StopsValid(g, s.services);
      SlotsAtGroup(s, after, k, r.cursor, g2, r2);
      OwnsOpen(s, k);
      NoResourcesAt(s, after, k, r2);
      OrphanAt(s, after, k, r.cursor, g2, r2);
      StepSameObjects(s.services, after.services);
      ReachAt(s, after, k, r.cursor, g2, r2);
      UndeclaredAt(s, after, k, r.cursor, g2, r2);
      ClassShape(s, after);
    } else if hookObservation.Missing? {
      PluginClassSlotCompletionKeepsRules(cleared, epochId);
    } else {
      PluginClassHookReadFailureKeepsRules(cleared, epochId, hookObservation.errorId);
    }
  }
}

lemma observeNextClassHook_ensures(s: PluginServices, hookObservation: ClassHookObservation)
  ensures (inv(s) ==> canObserveNextClassHook(s, hookObservation) ==> alwaysEpochIdentityUnique(observeNextClassHook(s, hookObservation)))
  ensures (inv(s) ==> canObserveNextClassHook(s, hookObservation) ==> alwaysOneActiveEpochPerName(observeNextClassHook(s, hookObservation)))
  ensures (inv(s) ==> canObserveNextClassHook(s, hookObservation) ==> alwaysEpochOutcomeHonest(observeNextClassHook(s, hookObservation)))
  ensures (inv(s) ==> canObserveNextClassHook(s, hookObservation) ==> alwaysRetirementPerRetiredEpoch(observeNextClassHook(s, hookObservation)))
  ensures (inv(s) ==> canObserveNextClassHook(s, hookObservation) ==> alwaysLiveClassOwnerUnique(observeNextClassHook(s, hookObservation)))
  ensures (inv(s) ==> canObserveNextClassHook(s, hookObservation) ==> alwaysServiceOwnerEpochExists(observeNextClassHook(s, hookObservation)))
  ensures (inv(s) ==> canObserveNextClassHook(s, hookObservation) ==> alwaysChildLifecyclesValid(observeNextClassHook(s, hookObservation)))
  ensures (inv(s) ==> canObserveNextClassHook(s, hookObservation) ==> alwaysOwnedClassesMatchServices(observeNextClassHook(s, hookObservation)))
  ensures (inv(s) ==> canObserveNextClassHook(s, hookObservation) ==> alwaysInvokingStartHasNoInstance(observeNextClassHook(s, hookObservation)))
  ensures (inv(s) ==> canObserveNextClassHook(s, hookObservation) ==> alwaysRetirementFollowsPlan(observeNextClassHook(s, hookObservation)))
  ensures (inv(s) ==> canObserveNextClassHook(s, hookObservation) ==> alwaysLiveInstanceReachable(observeNextClassHook(s, hookObservation)))
  ensures (inv(s) ==> canObserveNextClassHook(s, hookObservation) ==> alwaysNoOrphanInstance(observeNextClassHook(s, hookObservation)))
  ensures (inv(s) ==> canObserveNextClassHook(s, hookObservation) ==> alwaysStopObservationsFollowSlots(observeNextClassHook(s, hookObservation)))
  ensures (inv(s) ==> canObserveNextClassHook(s, hookObservation) ==> alwaysRetiredUndeclaredTypeIsUnknown(observeNextClassHook(s, hookObservation)))
  ensures (inv(s) ==> canObserveNextClassHook(s, hookObservation) ==> alwaysRetiredEpochHasNoResources(observeNextClassHook(s, hookObservation)))
  ensures (inv(s) ==> canObserveNextClassHook(s, hookObservation) ==> alwaysSealedOwnedClassesStable(observeNextClassHook(s, hookObservation)))
{
  if inv(s) && canObserveNextClassHook(s, hookObservation) {
    observeClassHook_ensures(s, readyClassHookEpoch(s, hookObservation), hookObservation);
  }
}

lemma finishClassHook_ensures(s: PluginServices, epochId: int, ok: bool, errorId: string)
  ensures (inv(s) ==> canFinishClassHook(s, epochId, ok, errorId) ==> alwaysEpochIdentityUnique(finishClassHook(s, epochId, ok, errorId)))
  ensures (inv(s) ==> canFinishClassHook(s, epochId, ok, errorId) ==> alwaysOneActiveEpochPerName(finishClassHook(s, epochId, ok, errorId)))
  ensures (inv(s) ==> canFinishClassHook(s, epochId, ok, errorId) ==> alwaysEpochOutcomeHonest(finishClassHook(s, epochId, ok, errorId)))
  ensures (inv(s) ==> canFinishClassHook(s, epochId, ok, errorId) ==> alwaysRetirementPerRetiredEpoch(finishClassHook(s, epochId, ok, errorId)))
  ensures (inv(s) ==> canFinishClassHook(s, epochId, ok, errorId) ==> alwaysLiveClassOwnerUnique(finishClassHook(s, epochId, ok, errorId)))
  ensures (inv(s) ==> canFinishClassHook(s, epochId, ok, errorId) ==> alwaysServiceOwnerEpochExists(finishClassHook(s, epochId, ok, errorId)))
  ensures (inv(s) ==> canFinishClassHook(s, epochId, ok, errorId) ==> alwaysChildLifecyclesValid(finishClassHook(s, epochId, ok, errorId)))
  ensures (inv(s) ==> canFinishClassHook(s, epochId, ok, errorId) ==> alwaysOwnedClassesMatchServices(finishClassHook(s, epochId, ok, errorId)))
  ensures (inv(s) ==> canFinishClassHook(s, epochId, ok, errorId) ==> alwaysInvokingStartHasNoInstance(finishClassHook(s, epochId, ok, errorId)))
  ensures (inv(s) ==> canFinishClassHook(s, epochId, ok, errorId) ==> alwaysRetirementFollowsPlan(finishClassHook(s, epochId, ok, errorId)))
  ensures (inv(s) ==> canFinishClassHook(s, epochId, ok, errorId) ==> alwaysLiveInstanceReachable(finishClassHook(s, epochId, ok, errorId)))
  ensures (inv(s) ==> canFinishClassHook(s, epochId, ok, errorId) ==> alwaysNoOrphanInstance(finishClassHook(s, epochId, ok, errorId)))
  ensures (inv(s) ==> canFinishClassHook(s, epochId, ok, errorId) ==> alwaysStopObservationsFollowSlots(finishClassHook(s, epochId, ok, errorId)))
  ensures (inv(s) ==> canFinishClassHook(s, epochId, ok, errorId) ==> alwaysRetiredUndeclaredTypeIsUnknown(finishClassHook(s, epochId, ok, errorId)))
  ensures (inv(s) ==> canFinishClassHook(s, epochId, ok, errorId) ==> alwaysRetiredEpochHasNoResources(finishClassHook(s, epochId, ok, errorId)))
  ensures (inv(s) ==> canFinishClassHook(s, epochId, ok, errorId) ==> alwaysSealedOwnedClassesStable(finishClassHook(s, epochId, ok, errorId)))
{
  if inv(s) && canFinishClassHook(s, epochId, ok, errorId) {
    var k := CurrentAt(s, epochId);
    var r := s.retirements[k];
    var g := r.groups[r.cursor];
    assert g in r.groups && r in s.retirements;
    var after := finishClassHook(s, epochId, ok, errorId);
    if ok {
      var g2 := g.(hook := ClassHookPhase.HookFinished);
      GroupsDistinct(r);
      PutAt(s, epochId, g2, k);
      var r2 := r.(groups := r.groups[r.cursor := g2]);
      assert after == s.(retirements := s.retirements[k := r2]);
      StopsValid(g2, after.services);
      UAt(s, after, k, r2);
      ShapeReplaceCurrent(r, r2, g2);
      ShapeAt(s, after, k, r2);
      StopsValid(g, s.services);
      SlotsAtGroup(s, after, k, r.cursor, g2, r2);
      OwnsOpen(s, k);
      NoResourcesAt(s, after, k, r2);
      OrphanAt(s, after, k, r.cursor, g2, r2);
      StepSameObjects(s.services, after.services);
      ReachAt(s, after, k, r.cursor, g2, r2);
      UndeclaredAt(s, after, k, r.cursor, g2, r2);
      ClassShape(s, after);
    } else {
      var marked := s.(retirements := s.retirements[k := r.(exited := true, hookError := errorId)]);
      assert marked == s.(retirements := (var s_map := s.retirements; seq(|s_map|, i_map requires 0 <= i_map < |s_map| => var x := s_map[i_map]; (if (x.epochId == epochId) then x.(exited := true, hookError := errorId) else x))));
      var g2 := g.(hook := ClassHookPhase.HookFailed, phase := RetirementGroupPhase.GroupFailed);
      GroupsDistinct(r);
      PutAt(marked, epochId, g2, k);
      var r2 := r.(exited := true, hookError := errorId, groups := r.groups[r.cursor := g2]);
      assert after == s.(retirements := s.retirements[k := r2]);
      StopsValid(g2, after.services);
      UAt(s, after, k, r2);
      ShapeReplaceCurrent(r, r2, g2);
      ShapeAt(s, after, k, r2);
      StopsValid(g, s.services);
      SlotsAtGroup(s, after, k, r.cursor, g2, r2);
      OwnsOpen(s, k);
      NoResourcesAt(s, after, k, r2);
      OrphanAt(s, after, k, r.cursor, g2, r2);
      StepSameObjects(s.services, after.services);
      ReachAt(s, after, k, r.cursor, g2, r2);
      UndeclaredAt(s, after, k, r.cursor, g2, r2);
      ClassShape(s, after);
    }
  }
}

lemma finishClassSlot_ensures(s: PluginServices, epochId: int)
  ensures (inv(s) ==> canFinishClassSlot(s, epochId) ==> alwaysEpochIdentityUnique(finishClassSlot(s, epochId)))
  ensures (inv(s) ==> canFinishClassSlot(s, epochId) ==> alwaysOneActiveEpochPerName(finishClassSlot(s, epochId)))
  ensures (inv(s) ==> canFinishClassSlot(s, epochId) ==> alwaysEpochOutcomeHonest(finishClassSlot(s, epochId)))
  ensures (inv(s) ==> canFinishClassSlot(s, epochId) ==> alwaysRetirementPerRetiredEpoch(finishClassSlot(s, epochId)))
  ensures (inv(s) ==> canFinishClassSlot(s, epochId) ==> alwaysLiveClassOwnerUnique(finishClassSlot(s, epochId)))
  ensures (inv(s) ==> canFinishClassSlot(s, epochId) ==> alwaysServiceOwnerEpochExists(finishClassSlot(s, epochId)))
  ensures (inv(s) ==> canFinishClassSlot(s, epochId) ==> alwaysChildLifecyclesValid(finishClassSlot(s, epochId)))
  ensures (inv(s) ==> canFinishClassSlot(s, epochId) ==> alwaysOwnedClassesMatchServices(finishClassSlot(s, epochId)))
  ensures (inv(s) ==> canFinishClassSlot(s, epochId) ==> alwaysInvokingStartHasNoInstance(finishClassSlot(s, epochId)))
  ensures (inv(s) ==> canFinishClassSlot(s, epochId) ==> alwaysRetirementFollowsPlan(finishClassSlot(s, epochId)))
  ensures (inv(s) ==> canFinishClassSlot(s, epochId) ==> alwaysLiveInstanceReachable(finishClassSlot(s, epochId)))
  ensures (inv(s) ==> canFinishClassSlot(s, epochId) ==> alwaysNoOrphanInstance(finishClassSlot(s, epochId)))
  ensures (inv(s) ==> canFinishClassSlot(s, epochId) ==> alwaysStopObservationsFollowSlots(finishClassSlot(s, epochId)))
  ensures (inv(s) ==> canFinishClassSlot(s, epochId) ==> alwaysRetiredUndeclaredTypeIsUnknown(finishClassSlot(s, epochId)))
  ensures (inv(s) ==> canFinishClassSlot(s, epochId) ==> alwaysRetiredEpochHasNoResources(finishClassSlot(s, epochId)))
  ensures (inv(s) ==> canFinishClassSlot(s, epochId) ==> alwaysSealedOwnedClassesStable(finishClassSlot(s, epochId)))
{
  if inv(s) && canFinishClassSlot(s, epochId) {
    PluginClassSlotCompletionKeepsRules(s, epochId);
  }
}

lemma FinishSlotIs(s: PluginServices, epochId: int)
  ensures finishClassSlot(s, epochId) == (var c := currentClassHook(s, epochId); var g := currentGroup(s, epochId); var cleared := if g.hook.HookReady? then clearRetiredClassFailure(c.id, s) else s;
    putCurrentGroup(g.(classCursor := (g.classCursor + 1), hook := ClassHookPhase.HookReady), epochId, cleared.(liveOwners := ProofLib.Filter((o: OwnedClass) => ((o.classId != c.id) || (o.epochId != epochId)), cleared.liveOwners))))
{
}

lemma LiveOwnersSubset(s: PluginServices, after: PluginServices, keep: OwnedClass -> bool)
  requires alwaysLiveClassOwnerUnique(s) && after.ownership == s.ownership
  requires after.liveOwners == ProofLib.Filter(keep, s.liveOwners)
  ensures alwaysLiveClassOwnerUnique(after)
{
  LiveOwnersFilters(s);
  LiveOwnersFilters(after);
  forall o | o in after.liveOwners
    ensures o in after.ownership && |ProofLib.Filter((other: OwnedClass) => (other.classId == o.classId), after.liveOwners)| == 1
  {
    var b := (other: OwnedClass) => (other.classId == o.classId);
    ProofLib.FilterMember(keep, s.liveOwners, o);
    ProofLib.FilterOfFilterLength(keep, b, b, s.liveOwners);
    ProofLib.FilterMember(b, after.liveOwners, o);
  }
}

lemma ShapeCloseCurrent(r: ServiceRetirement, r2: ServiceRetirement, g2: RetirementGroup)
  requires retirementShaped(r) && 0 <= r.cursor && |r.groups| == r.cursor + 1 && !r.exited
  requires r2.plan == r.plan && r2.cursor == r.cursor + 1 && r2.groups == r.groups[r.cursor := g2] && !r2.exited
  requires g2.serviceType == r.groups[r.cursor].serviceType && g2.phase.GroupFinished? && g2.instanceCursor == |g2.instances|
  ensures retirementShaped(r2)
{
  ShapedFilters(r);
  GroupsPlan(r);
  GroupsPlan(r2);
  GroupsDistinct(r);
  ShapedFilters(r);
  ShapedFilters(r2);
  forall g | g in r2.groups ensures groupSlotsPassed(g) && ((g.phase.GroupFinished? || g.phase.GroupSkipped?) == !(isCurrentGroup(r2, g)))
  {
    var j :| 0 <= j < |r2.groups| && r2.groups[j] == g;
    if j != r.cursor {
      assert r.groups[j] in r.groups && g == r.groups[j];
      assert g.serviceType != r.groups[r.cursor].serviceType;
    }
  }
}

lemma finishRetirementGroup_ensures(s: PluginServices, epochId: int)
  ensures (inv(s) ==> canFinishRetirementGroup(s, epochId) ==> alwaysEpochIdentityUnique(finishRetirementGroup(s, epochId)))
  ensures (inv(s) ==> canFinishRetirementGroup(s, epochId) ==> alwaysOneActiveEpochPerName(finishRetirementGroup(s, epochId)))
  ensures (inv(s) ==> canFinishRetirementGroup(s, epochId) ==> alwaysEpochOutcomeHonest(finishRetirementGroup(s, epochId)))
  ensures (inv(s) ==> canFinishRetirementGroup(s, epochId) ==> alwaysRetirementPerRetiredEpoch(finishRetirementGroup(s, epochId)))
  ensures (inv(s) ==> canFinishRetirementGroup(s, epochId) ==> alwaysLiveClassOwnerUnique(finishRetirementGroup(s, epochId)))
  ensures (inv(s) ==> canFinishRetirementGroup(s, epochId) ==> alwaysServiceOwnerEpochExists(finishRetirementGroup(s, epochId)))
  ensures (inv(s) ==> canFinishRetirementGroup(s, epochId) ==> alwaysChildLifecyclesValid(finishRetirementGroup(s, epochId)))
  ensures (inv(s) ==> canFinishRetirementGroup(s, epochId) ==> alwaysOwnedClassesMatchServices(finishRetirementGroup(s, epochId)))
  ensures (inv(s) ==> canFinishRetirementGroup(s, epochId) ==> alwaysInvokingStartHasNoInstance(finishRetirementGroup(s, epochId)))
  ensures (inv(s) ==> canFinishRetirementGroup(s, epochId) ==> alwaysRetirementFollowsPlan(finishRetirementGroup(s, epochId)))
  ensures (inv(s) ==> canFinishRetirementGroup(s, epochId) ==> alwaysLiveInstanceReachable(finishRetirementGroup(s, epochId)))
  ensures (inv(s) ==> canFinishRetirementGroup(s, epochId) ==> alwaysNoOrphanInstance(finishRetirementGroup(s, epochId)))
  ensures (inv(s) ==> canFinishRetirementGroup(s, epochId) ==> alwaysStopObservationsFollowSlots(finishRetirementGroup(s, epochId)))
  ensures (inv(s) ==> canFinishRetirementGroup(s, epochId) ==> alwaysRetiredUndeclaredTypeIsUnknown(finishRetirementGroup(s, epochId)))
  ensures (inv(s) ==> canFinishRetirementGroup(s, epochId) ==> alwaysRetiredEpochHasNoResources(finishRetirementGroup(s, epochId)))
  ensures (inv(s) ==> canFinishRetirementGroup(s, epochId) ==> alwaysSealedOwnedClassesStable(finishRetirementGroup(s, epochId)))
{
  if inv(s) && canFinishRetirementGroup(s, epochId) {
    var k := CurrentAt(s, epochId);
    var r := s.retirements[k];
    var g := r.groups[r.cursor];
    assert g in r.groups && r in s.retirements;
    var g2 := g.(phase := RetirementGroupPhase.GroupFinished);
    GroupsDistinct(r);
    PutAt(s, epochId, g2, k);
    var r2 := r.(groups := r.groups[r.cursor := g2], cursor := r.cursor + 1);
    var after := finishRetirementGroup(s, epochId);
    assert after == s.(retirements := s.retirements[k := r2]);
    StopsValid(g2, after.services);
    UAt(s, after, k, r2);
    ShapeCloseCurrent(r, r2, g2);
    ShapeAt(s, after, k, r2);
    StopsValid(g, s.services);
    SlotsAtGroup(s, after, k, r.cursor, g2, r2);
    OwnsOpen(s, k);
    NoResourcesAt(s, after, k, r2);
    OrphanAt(s, after, k, r.cursor, g2, r2);
    StepSameObjects(s.services, after.services);
    ReachAt(s, after, k, r.cursor, g2, r2);
    UndeclaredAt(s, after, k, r.cursor, g2, r2);
    ClassShape(s, after);
  }
}

lemma SettledGroupsDone(s: PluginServices, r: ServiceRetirement)
  requires inv(s) && r in s.retirements && (r.exited || r.cursor == |r.plan|)
  ensures forall g :: g in r.groups ==> (g.instanceCursor == |g.instances| && |g.observedStops| == |g.instances| &&
    forall i :: 0 <= i < |g.observedStops| ==> g.observedStops[i].instanceId == g.instances[i] && stopSlotSettled(g.observedStops[i], s.services))
{
  assert retirementShaped(r);
  GroupsDistinct(r);
  forall g | g in r.groups
    ensures g.instanceCursor == |g.instances| && |g.observedStops| == |g.instances| &&
      forall i :: 0 <= i < |g.observedStops| ==> g.observedStops[i].instanceId == g.instances[i] && stopSlotSettled(g.observedStops[i], s.services)
  {
    StopsValid(g, s.services);
    assert groupSlotsPassed(g);
    var j :| 0 <= j < |r.groups| && r.groups[j] == g;
    if !r.exited {
      assert !isCurrentGroup(r, g);
    } else if j == r.cursor {
      assert g.phase.GroupFailed?;
    } else {
      assert !isCurrentGroup(r, g);
    }
    forall i | 0 <= i < |g.observedStops| ensures g.observedStops[i].instanceId == g.instances[i] && stopSlotSettled(g.observedStops[i], s.services)
    {
      assert validStopObservation(g, i, g.observedStops[i], s.services);
    }
  }
}

lemma CleanedEpochView(s: PluginServices, after: PluginServices, epochId: int)
  requires inv(s) && alwaysEpochIdentityUnique(after) && after == s.(epochs := after.epochs)
  requires |after.epochs| == |s.epochs|
  requires forall i :: 0 <= i < |s.epochs| ==> (after.epochs[i].id == s.epochs[i].id && (s.epochs[i].id != epochId ==> after.epochs[i] == s.epochs[i]) &&
    (s.epochs[i].id == epochId ==> !activePhase(after.epochs[i].lifecycle.phase) && !(after.epochs[i].lifecycle.phase.Registering? || after.epochs[i].lifecycle.phase.Loaded?) && !(s.epochs[i].lifecycle.phase.Registering? || s.epochs[i].lifecycle.phase.Loaded?)))
  ensures forall x :: epoch(after, x).id == epoch(s, x).id && epochAdmitsClass(after, x) == epochAdmitsClass(s, x)
  ensures forall x :: x != epochId ==> epochOwnsResources(after, x) == epochOwnsResources(s, x)
  ensures !epochOwnsResources(after, epochId)
{
  forall x ensures epoch(after, x).id == epoch(s, x).id && epochAdmitsClass(after, x) == epochAdmitsClass(s, x) &&
    (x != epochId ==> epochOwnsResources(after, x) == epochOwnsResources(s, x)) && (x == epochId ==> !epochOwnsResources(after, x))
  {
    EpochIdLookup(s, x);
    EpochIdLookup(after, x);
    if e :| e in s.epochs && e.id == x {
      var i :| 0 <= i < |s.epochs| && s.epochs[i] == e;
      assert after.epochs[i] in after.epochs;
      PluginEpochExact(after, after.epochs[i]);
      PluginEpochExact(s, e);
    } else if e :| e in after.epochs && e.id == x {
      var i :| 0 <= i < |after.epochs| && after.epochs[i] == e;
      assert s.epochs[i] in s.epochs;
    }
  }
}

lemma cleanPlugin_ensures(s: PluginServices, epochId: int)
  ensures (inv(s) ==> canCleanPlugin(s, epochId) ==> alwaysEpochIdentityUnique(cleanPlugin(s, epochId)))
  ensures (inv(s) ==> canCleanPlugin(s, epochId) ==> alwaysOneActiveEpochPerName(cleanPlugin(s, epochId)))
  ensures (inv(s) ==> canCleanPlugin(s, epochId) ==> alwaysEpochOutcomeHonest(cleanPlugin(s, epochId)))
  ensures (inv(s) ==> canCleanPlugin(s, epochId) ==> alwaysRetirementPerRetiredEpoch(cleanPlugin(s, epochId)))
  ensures (inv(s) ==> canCleanPlugin(s, epochId) ==> alwaysLiveClassOwnerUnique(cleanPlugin(s, epochId)))
  ensures (inv(s) ==> canCleanPlugin(s, epochId) ==> alwaysServiceOwnerEpochExists(cleanPlugin(s, epochId)))
  ensures (inv(s) ==> canCleanPlugin(s, epochId) ==> alwaysChildLifecyclesValid(cleanPlugin(s, epochId)))
  ensures (inv(s) ==> canCleanPlugin(s, epochId) ==> alwaysOwnedClassesMatchServices(cleanPlugin(s, epochId)))
  ensures (inv(s) ==> canCleanPlugin(s, epochId) ==> alwaysInvokingStartHasNoInstance(cleanPlugin(s, epochId)))
  ensures (inv(s) ==> canCleanPlugin(s, epochId) ==> alwaysRetirementFollowsPlan(cleanPlugin(s, epochId)))
  ensures (inv(s) ==> canCleanPlugin(s, epochId) ==> alwaysLiveInstanceReachable(cleanPlugin(s, epochId)))
  ensures (inv(s) ==> canCleanPlugin(s, epochId) ==> alwaysNoOrphanInstance(cleanPlugin(s, epochId)))
  ensures (inv(s) ==> canCleanPlugin(s, epochId) ==> alwaysStopObservationsFollowSlots(cleanPlugin(s, epochId)))
  ensures (inv(s) ==> canCleanPlugin(s, epochId) ==> alwaysRetiredUndeclaredTypeIsUnknown(cleanPlugin(s, epochId)))
  ensures (inv(s) ==> canCleanPlugin(s, epochId) ==> alwaysRetiredEpochHasNoResources(cleanPlugin(s, epochId)))
  ensures (inv(s) ==> canCleanPlugin(s, epochId) ==> alwaysSealedOwnedClassesStable(cleanPlugin(s, epochId)))
{
  if inv(s) && canCleanPlugin(s, epochId) {
    var after := cleanPlugin(s, epochId);
    EpochsAfterCleanPlugin(s, epochId);
    forall i | 0 <= i < |s.epochs| && s.epochs[i].id == epochId
      ensures s.epochs[i] == epoch(s, epochId)
    {
      assert s.epochs[i] in s.epochs;
      PluginEpochExact(s, s.epochs[i]);
    }
    CleanedEpochView(s, after, epochId);
    EpochOwnerFrame(s, after);
    forall r | r in after.retirements
      ensures epoch(after, r.epochId).id == r.epochId && !epochAdmitsClass(after, r.epochId)
    {
    }
    RetirementFound(s, epochId);
    var k := RetirementIndex(s, retirement(s, epochId));
    var done := s.retirements[k];
    SettledGroupsDone(s, done);
    forall r | r in after.retirements && !epochOwnsResources(after, r.epochId)
      ensures retirementSettled(after, r.epochId) && forall g :: g in r.groups ==> g.instanceCursor == |g.instances| && forall slot :: slot in g.observedStops ==> stopSlotSettled(slot, after.services)
    {
      var i := RetirementIndex(s, r);
      if r.epochId == epochId {
        assert r == done;
        forall g, slot | g in r.groups && slot in g.observedStops ensures stopSlotSettled(slot, after.services)
        {
          var m :| 0 <= m < |g.observedStops| && g.observedStops[m] == slot;
        }
      }
    }
    forall cl | cl in after.services.classes && cl.live != 0 && cl.registered && !(core__serviceInstances_serviceObject(after.services, cl.live).stopCalls > 0) && !(cl.live in core__serviceInstances_publishedInstances(after.services, cl.serviceType))
      ensures exists r :: r in after.retirements && (exists g :: g in r.groups && (missingStopObservedFor(g, cl.live) || (epochOwnsResources(after, r.epochId) && (cl.live in g.instances))))
    {
      var r, g :| r in s.retirements && g in r.groups && (missingStopObservedFor(g, cl.live) || (epochOwnsResources(s, r.epochId) && (cl.live in g.instances)));
      if !missingStopObservedFor(g, cl.live) && r.epochId == epochId {
        var i := RetirementIndex(s, r);
        assert r == done;
        var m :| 0 <= m < |g.instances| && g.instances[m] == cl.live;
        var slot := g.observedStops[m];
        assert slot in g.observedStops && stopSlotSettled(slot, s.services);
        if slot.observed.AwaitedStopSlot? {
          ObjectFound(s.services, cl.live);
          assert false;
        }
      }
    }
    forall o | o in after.services.objects && o.stopCalls <= 0 && !((exists cl :: cl in after.services.classes && cl.live == o.id && cl.registered) && (exists p :: p in after.services.published && o.id in p.instances))
      ensures exists r :: r in after.retirements && (exists g :: g in r.groups && (missingStopObservedFor(g, o.id) || (epochOwnsResources(after, r.epochId) && (o.id in g.instances))))
    {
      var r, g :| r in s.retirements && g in r.groups && (missingStopObservedFor(g, o.id) || (epochOwnsResources(s, r.epochId) && (o.id in g.instances)));
      if !missingStopObservedFor(g, o.id) && r.epochId == epochId {
        var i := RetirementIndex(s, r);
        assert r == done;
        var m :| 0 <= m < |g.instances| && g.instances[m] == o.id;
        var slot := g.observedStops[m];
        assert slot in g.observedStops && stopSlotSettled(slot, s.services);
        if slot.observed.AwaitedStopSlot? {
          ObjectExact(s.services, o);
          assert false;
        }
      }
    }
  }
}

lemma WithdrawClassIs(classId: int, s: core__serviceInstances_ServiceInstances)
  ensures core__serviceInstances_withdrawClass(classId, s).declarations == ProofLib.Filter((d: core__serviceInstances_ServiceDeclaration) => (d.classId != classId), s.declarations)
{
}

lemma WithdrawFold(acc: core__serviceInstances_ServiceInstances, xs: seq<RetireClass>)
  ensures var w := Std.Collections.Seq.FoldLeft((acc: core__serviceInstances_ServiceInstances, c: RetireClass) => core__serviceInstances_withdrawClass(c.id, acc), acc, xs);
    w == acc.(declarations := w.declarations, classes := w.classes) && |w.classes| == |acc.classes| &&
    (forall i :: 0 <= i < |acc.classes| ==> w.classes[i] == (if (exists c :: c in xs && c.id == acc.classes[i].id) then acc.classes[i].(registered := false, live := 0) else acc.classes[i])) &&
    (forall d :: d in w.declarations <==> d in acc.declarations && !(exists c :: c in xs && c.id == d.classId))
  decreases |xs|
{
  if |xs| > 0 {
    var f := (acc: core__serviceInstances_ServiceInstances, c: RetireClass) => core__serviceInstances_withdrawClass(c.id, acc);
    var next := core__serviceInstances_withdrawClass(xs[0].id, acc);
    assert Std.Collections.Seq.FoldLeft(f, acc, xs) == Std.Collections.Seq.FoldLeft(f, next, xs[1..]);
    WithdrawFold(next, xs[1..]);
    WithdrawClassIs(xs[0].id, acc);
    forall d: core__serviceInstances_ServiceDeclaration ensures d in next.declarations <==> d in acc.declarations && d.classId != xs[0].id
    {
      ProofLib.FilterMember((d: core__serviceInstances_ServiceDeclaration) => (d.classId != xs[0].id), acc.declarations, d);
    }
    forall i | 0 <= i < |acc.classes| ensures (exists c :: c in xs && c.id == acc.classes[i].id) == (xs[0].id == acc.classes[i].id || exists c :: c in xs[1..] && c.id == acc.classes[i].id)
    {
      if exists c :: c in xs && c.id == acc.classes[i].id {
        var c :| c in xs && c.id == acc.classes[i].id;
        if c != xs[0] { assert c in xs[1..]; }
      }
    }
    forall d: core__serviceInstances_ServiceDeclaration ensures (exists c :: c in xs && c.id == d.classId) == (xs[0].id == d.classId || exists c :: c in xs[1..] && c.id == d.classId)
    {
      if exists c :: c in xs && c.id == d.classId {
        var c :| c in xs && c.id == d.classId;
        if c != xs[0] { assert c in xs[1..]; }
      }
    }
  }
}

lemma WithdrawnLookup(acc: core__serviceInstances_ServiceInstances, w: core__serviceInstances_ServiceInstances, xs: seq<RetireClass>, x: int)
  requires |w.classes| == |acc.classes|
  requires forall i :: 0 <= i < |acc.classes| ==> w.classes[i] == (if (exists c :: c in xs && c.id == acc.classes[i].id) then acc.classes[i].(registered := false, live := 0) else acc.classes[i])
  ensures core__serviceInstances_serviceClass(w, x) == (if (exists c :: c in xs && c.id == x) then core__serviceInstances_serviceClass(acc, x).(registered := false, live := 0) else core__serviceInstances_serviceClass(acc, x))
{
  var p := (c: core__serviceInstances_ServiceClassEntry) => (c.id == x);
  ProofLib.FilterPointwise(p, p, (a: core__serviceInstances_ServiceClassEntry, b: core__serviceInstances_ServiceClassEntry) => (a.id == x ==> b == (if (exists c :: c in xs && c.id == x) then a.(registered := false, live := 0) else a)), acc.classes, w.classes);
}

lemma CaptureFold(services: core__serviceInstances_ServiceInstances, acc: CapturedInstances, xs: seq<RetireClass>)
  requires forall id :: id in acc.seen ==> core__serviceInstances_serviceClass(services, id).live == 0 || core__serviceInstances_serviceClass(services, id).live in acc.instances
  ensures var r := Std.Collections.Seq.FoldLeft((capture: CapturedInstances, c: RetireClass) => captureClassInstance(capture, c.id, services), acc, xs);
    (forall id :: id in r.seen ==> core__serviceInstances_serviceClass(services, id).live == 0 || core__serviceInstances_serviceClass(services, id).live in r.instances) &&
    (forall c :: c in xs ==> c.id in r.seen)
  decreases |xs|
{
  if |xs| > 0 {
    var f := (capture: CapturedInstances, c: RetireClass) => captureClassInstance(capture, c.id, services);
    var next := captureClassInstance(acc, xs[0].id, services);
    assert Std.Collections.Seq.FoldLeft(f, acc, xs) == Std.Collections.Seq.FoldLeft(f, next, xs[1..]);
    CaptureIs(acc, xs[0].id, services);
    ProofLib.FilterMember((set_x: int) => !((set_x in acc.seen)), [xs[0].id], xs[0].id);
    forall id | id in next.seen ensures id in acc.seen || id == xs[0].id
    {
      if id !in acc.seen {
        ProofLib.FilterMember((set_x: int) => !((set_x in acc.seen)), [xs[0].id], id);
      }
    }
    CaptureFold(services, next, xs[1..]);
    CaptureSeenGrows(services, next, xs[1..]);
  }
}

lemma CaptureIs(capture: CapturedInstances, classId: int, services: core__serviceInstances_ServiceInstances)
  ensures captureClassInstance(capture, classId, services) == CapturedInstances((capture.seen + ProofLib.Filter((set_x: int) => !((set_x in capture.seen)), [classId])), (if ((core__serviceInstances_serviceClass(services, classId).live != 0) && !((classId in capture.seen))) then (capture.instances + [core__serviceInstances_serviceClass(services, classId).live]) else capture.instances))
{
}

lemma CaptureSeenGrows(services: core__serviceInstances_ServiceInstances, acc: CapturedInstances, xs: seq<RetireClass>)
  ensures var r := Std.Collections.Seq.FoldLeft((capture: CapturedInstances, c: RetireClass) => captureClassInstance(capture, c.id, services), acc, xs);
    forall id :: id in acc.seen ==> id in r.seen
  decreases |xs|
{
  if |xs| > 0 {
    var f := (capture: CapturedInstances, c: RetireClass) => captureClassInstance(capture, c.id, services);
    var next := captureClassInstance(acc, xs[0].id, services);
    assert Std.Collections.Seq.FoldLeft(f, acc, xs) == Std.Collections.Seq.FoldLeft(f, next, xs[1..]);
    CaptureIs(acc, xs[0].id, services);
    assert forall id :: id in acc.seen ==> id in next.seen;
    CaptureSeenGrows(services, next, xs[1..]);
  }
}

lemma FilterNarrow<T>(p: T -> bool, q: T -> bool, xs: seq<T>)
  requires forall x :: p(x) ==> q(x)
  ensures ProofLib.Filter(p, ProofLib.Filter(q, xs)) == ProofLib.Filter(p, xs)
  decreases |xs|
{
  if |xs| == 0 {
    ProofLib.FilterNil(q, xs);
    ProofLib.FilterNil(p, xs);
    ProofLib.FilterNil(p, ProofLib.Filter(q, xs));
  } else {
    var ys := ProofLib.Filter(q, xs[1..]);
    ProofLib.FilterCons(q, xs);
    ProofLib.FilterCons(p, xs);
    FilterNarrow(p, q, xs[1..]);
    if q(xs[0]) {
      var zs := [xs[0]] + ys;
      assert ProofLib.Filter(q, xs) == zs;
      ProofLib.FilterCons(p, zs);
      assert zs[0] == xs[0] && zs[1..] == ys;
      assert ProofLib.Filter(p, zs) == (if p(xs[0]) then [xs[0]] else []) + ProofLib.Filter(p, ys);
      assert ProofLib.Filter(p, ys) == ProofLib.Filter(p, xs[1..]);
      assert ProofLib.Filter(p, xs) == (if p(xs[0]) then [xs[0]] else []) + ProofLib.Filter(p, xs[1..]);
    } else {
      assert ProofLib.Filter(q, xs) == ys;
      assert !p(xs[0]);
    }
  }
}
lemma RemovePublishedIs(serviceType: string, removed: seq<int>, s: core__serviceInstances_ServiceInstances)
  ensures core__serviceInstances_removePublishedInstances(serviceType, removed, s) == core__serviceInstances_replacePublication(serviceType, ProofLib.Filter((id: int) => !((id in removed)), core__serviceInstances_publishedInstances(s, serviceType)), s)
{
}

lemma ReplacePubIs(serviceType: string, instances: seq<int>, s: core__serviceInstances_ServiceInstances)
  ensures core__serviceInstances_replacePublication(serviceType, instances, s) == s.(published := (if (|instances| == 0) then ProofLib.Filter((p: core__serviceInstances_ServicePublication) => (p.serviceType != serviceType), s.published) else (if (exists p :: p in s.published && (p.serviceType == serviceType)) then (var s_map := s.published; seq(|s_map|, i_map requires 0 <= i_map < |s_map| => var p := s_map[i_map]; (if (p.serviceType == serviceType) then core__serviceInstances_ServicePublication(serviceType, instances) else p))) else (s.published + [core__serviceInstances_ServicePublication(serviceType, instances)]))))
{
}

lemma PubLookupReplace(serviceType: string, instances: seq<int>, s: core__serviceInstances_ServiceInstances, t: string)
  ensures core__serviceInstances_publishedInstances(core__serviceInstances_replacePublication(serviceType, instances, s), t) == (if t == serviceType then instances else core__serviceInstances_publishedInstances(s, t))
{
  ReplacePubIs(serviceType, instances, s);
  var after := core__serviceInstances_replacePublication(serviceType, instances, s);
  var entry := core__serviceInstances_ServicePublication(serviceType, instances);
  var pt := (p: core__serviceInstances_ServicePublication) => (p.serviceType == t);
  var q := (p: core__serviceInstances_ServicePublication) => (p.serviceType != serviceType);
  if |instances| == 0 {
    if t == serviceType {
      ProofLib.FilterNone(pt, after.published);
      forall i | 0 <= i < |after.published| ensures !pt(after.published[i])
      {
        assert after.published[i] in after.published;
        ProofLib.FilterMember(q, s.published, after.published[i]);
      }
    } else {
      FilterNarrow(pt, q, s.published);
    }
  } else if exists p :: p in s.published && (p.serviceType == serviceType) {
    if t == serviceType {
      var p :| p in s.published && (p.serviceType == serviceType);
      var i :| 0 <= i < |s.published| && s.published[i] == p;
      assert after.published[i] == entry;
      ProofLib.FilterMember(pt, after.published, entry);
      var m := ProofLib.Filter(pt, after.published);
      assert m[0] in m;
      ProofLib.FilterMember(pt, after.published, m[0]);
    } else {
      ProofLib.FilterPointwise(pt, pt, (a: core__serviceInstances_ServicePublication, b: core__serviceInstances_ServicePublication) => (a.serviceType == t ==> a == b), s.published, after.published);
      var m1 := ProofLib.Filter(pt, s.published);
      if |m1| > 0 {
        assert m1[0] in m1;
        ProofLib.FilterMember(pt, s.published, m1[0]);
      }
    }
  } else {
    ProofLib.FilterAppend(pt, s.published, entry);
    if t == serviceType { ProofLib.FilterNone(pt, s.published); }
  }
}

lemma PubFound(s: core__serviceInstances_ServiceInstances, serviceType: string)
  ensures |core__serviceInstances_publishedInstances(s, serviceType)| > 0 ==> exists q :: q in s.published && q.serviceType == serviceType && q.instances == core__serviceInstances_publishedInstances(s, serviceType)
{
  var m := ProofLib.Filter((p: core__serviceInstances_ServicePublication) => (p.serviceType == serviceType), s.published);
  if |m| > 0 {
    assert m[0] in m;
    ProofLib.FilterMember((p: core__serviceInstances_ServicePublication) => (p.serviceType == serviceType), s.published, m[0]);
  }
}

lemma WithdrawClassesInv(s: core__serviceInstances_ServiceInstances, w: core__serviceInstances_ServiceInstances, xs: seq<RetireClass>, serviceType: string)
  requires core__serviceInstances_inv(s)
  requires forall c :: c in xs ==> core__serviceInstances_serviceClass(s, c.id).serviceType == serviceType
  requires w == s.(declarations := w.declarations, classes := w.classes) && |w.classes| == |s.classes|
  requires forall i :: 0 <= i < |s.classes| ==> w.classes[i] == (if (exists c :: c in xs && c.id == s.classes[i].id) then s.classes[i].(registered := false, live := 0) else s.classes[i])
  requires forall d :: d in w.declarations <==> d in s.declarations && !(exists c :: c in xs && c.id == d.classId)
  ensures core__serviceInstances_alwaysClassAndObjectIdentities(w) && core__serviceInstances_alwaysPendingAttemptsOwned(w) && core__serviceInstances_alwaysDeclarationsMatch(w)
  ensures core__serviceInstances_alwaysClassOwnsKnownObjects(w) && core__serviceInstances_alwaysAttemptGeneration(w) && core__serviceInstances_alwaysCapturedAttemptsExist(w)
  ensures forall c :: c in w.classes ==> exists i :: 0 <= i < |s.classes| && w.classes[i] == c
  ensures forall c :: c in s.classes && !(exists x :: x in xs && x.id == c.id) ==> c in w.classes
  ensures forall c :: c in s.classes && (exists x :: x in xs && x.id == c.id) ==> c.serviceType == serviceType
{
  forall x ensures core__serviceInstances_serviceClass(w, x) == (if (exists c :: c in xs && c.id == x) then core__serviceInstances_serviceClass(s, x).(registered := false, live := 0) else core__serviceInstances_serviceClass(s, x))
  {
    WithdrawnLookup(s, w, xs, x);
  }
  forall c | c in w.classes ensures exists i :: 0 <= i < |s.classes| && w.classes[i] == c
  {
    var i :| 0 <= i < |w.classes| && w.classes[i] == c;
  }
  forall c | c in s.classes && !(exists x :: x in xs && x.id == c.id) ensures c in w.classes
  {
    var i :| 0 <= i < |s.classes| && s.classes[i] == c;
    assert w.classes[i] == c;
  }
  forall c | c in s.classes && (exists x :: x in xs && x.id == c.id) ensures c.serviceType == serviceType
  {
    ClassExact(s, c);
  }
  forall c | c in w.classes ensures |ProofLib.Filter((other: core__serviceInstances_ServiceClassEntry) => (other.id == c.id), w.classes)| == 1
  {
    var i :| 0 <= i < |w.classes| && w.classes[i] == c;
    assert s.classes[i] in s.classes;
    ProofLib.FilterLengthPointwise((other: core__serviceInstances_ServiceClassEntry) => (other.id == c.id), (other: core__serviceInstances_ServiceClassEntry) => (other.id == c.id), s.classes, w.classes);
  }
  forall c | c in w.classes ensures c.registered == (exists d :: d in w.declarations && d.classId == c.id)
  {
    var i :| 0 <= i < |w.classes| && w.classes[i] == c;
    var c0 := s.classes[i];
    assert c0 in s.classes;
    if c.registered {
      var d :| d in s.declarations && d.classId == c0.id;
      assert d in w.declarations;
    }
  }
}

lemma WithdrawPublishedInv(s: core__serviceInstances_ServiceInstances, w: core__serviceInstances_ServiceInstances, xs: seq<RetireClass>, serviceType: string, captured: seq<int>)
  requires core__serviceInstances_inv(s)
  requires w == s.(declarations := w.declarations, classes := w.classes) && |w.classes| == |s.classes|
  requires forall i :: 0 <= i < |s.classes| ==> w.classes[i] == (if (exists c :: c in xs && c.id == s.classes[i].id) then s.classes[i].(registered := false, live := 0) else s.classes[i])
  requires forall c :: c in s.classes && !(exists x :: x in xs && x.id == c.id) ==> c in w.classes
  requires forall c :: c in s.classes && (exists x :: x in xs && x.id == c.id) ==> c.serviceType == serviceType && (c.live == 0 || c.live in captured)
  ensures var w2 := core__serviceInstances_removePublishedInstances(serviceType, captured, w);
    core__serviceInstances_alwaysPublicationIdentitiesValid(w2) && core__serviceInstances_alwaysFailedTypeHasNoPublication(w2) && core__serviceInstances_alwaysStoppedHasNoPublication(w2)
{
  var insts := ProofLib.Filter((id: int) => !((id in captured)), core__serviceInstances_publishedInstances(s, serviceType));
  RemovePublishedIs(serviceType, captured, w);
  var w2 := core__serviceInstances_replacePublication(serviceType, insts, w);
  ReplacePubIs(serviceType, insts, w);
  var entry := core__serviceInstances_ServicePublication(serviceType, insts);
  forall t ensures core__serviceInstances_publishedInstances(w2, t) == (if t == serviceType then insts else core__serviceInstances_publishedInstances(s, t))
  {
    PubLookupReplace(serviceType, insts, w, t);
  }
  PubFound(s, serviceType);
  forall id | id in insts ensures id in core__serviceInstances_publishedInstances(s, serviceType) && id !in captured
  {
    ProofLib.FilterMember((id: int) => !((id in captured)), core__serviceInstances_publishedInstances(s, serviceType), id);
  }
  forall p | p in w2.published
    ensures (p in s.published && p.serviceType != serviceType) || (p == entry && |insts| > 0)
  {
    if |insts| == 0 {
      ProofLib.FilterMember((q: core__serviceInstances_ServicePublication) => (q.serviceType != serviceType), s.published, p);
    }
  }
  forall p | p in w2.published
    ensures |ProofLib.Filter((other: core__serviceInstances_ServicePublication) => (other.serviceType == p.serviceType), w2.published)| == 1
  {
    var b := (other: core__serviceInstances_ServicePublication) => (other.serviceType == p.serviceType);
    if |insts| == 0 {
      FilterNarrow(b, (q: core__serviceInstances_ServicePublication) => (q.serviceType != serviceType), s.published);
    } else if exists q :: q in s.published && (q.serviceType == serviceType) {
      ProofLib.FilterLengthPointwise(b, b, s.published, w2.published);
      var q :| q in s.published && (q.serviceType == serviceType);
      if p == entry {
        ProofLib.FilterSamePredicate(b, (other: core__serviceInstances_ServicePublication) => (other.serviceType == q.serviceType), s.published);
      }
    } else {
      ProofLib.FilterAppend(b, s.published, entry);
      if p == entry { ProofLib.FilterNone(b, s.published); }
    }
  }
  forall p, id | p in w2.published && id in p.instances
    ensures id > 0 && exists c :: c in w2.classes && c.serviceType == p.serviceType && c.live == id
  {
    var q := if p == entry then (var q :| q in s.published && q.serviceType == serviceType && q.instances == core__serviceInstances_publishedInstances(s, serviceType); q) else p;
    assert q in s.published && id in q.instances;
    var c :| c in s.classes && c.serviceType == q.serviceType && c.live == id;
    assert c in w.classes;
  }
  forall e | e in w2.typeEntries && e.status.TypeFailed? ensures core__serviceInstances_firstLive(w2, e.serviceType) == 0
  {
    assert e in s.typeEntries && core__serviceInstances_firstLive(s, e.serviceType) == 0;
    if e.serviceType == serviceType && |insts| > 0 {
      assert insts[0] in insts;
      var q :| q in s.published && q.serviceType == serviceType && q.instances == core__serviceInstances_publishedInstances(s, serviceType);
      assert q.instances[0] in q.instances;
      assert false;
    }
  }
  if w2.stopped {
    ProofLib.FilterNil((p: core__serviceInstances_ServicePublication) => (p.serviceType == serviceType), s.published);
    ProofLib.FilterNil((id: int) => !((id in captured)), core__serviceInstances_publishedInstances(s, serviceType));
    ProofLib.FilterNil((q: core__serviceInstances_ServicePublication) => (q.serviceType != serviceType), s.published);
    forall c | c in w2.classes ensures c.live == 0
    {
      var i :| 0 <= i < |w.classes| && w.classes[i] == c;
      assert s.classes[i] in s.classes;
    }
  }
  assert core__serviceInstances_alwaysPublicationIdentitiesValid(w2);
}

lemma WithdrawInv(s: core__serviceInstances_ServiceInstances, xs: seq<RetireClass>, serviceType: string, captured: seq<int>)
  requires core__serviceInstances_inv(s)
  requires forall c :: c in xs ==> core__serviceInstances_serviceClass(s, c.id).serviceType == serviceType
  requires forall c :: c in xs ==> core__serviceInstances_serviceClass(s, c.id).live == 0 || core__serviceInstances_serviceClass(s, c.id).live in captured
  ensures core__serviceInstances_inv(core__serviceInstances_removePublishedInstances(serviceType, captured, Std.Collections.Seq.FoldLeft((acc: core__serviceInstances_ServiceInstances, c: RetireClass) => core__serviceInstances_withdrawClass(c.id, acc), s, xs)))
{
  var w := Std.Collections.Seq.FoldLeft((acc: core__serviceInstances_ServiceInstances, c: RetireClass) => core__serviceInstances_withdrawClass(c.id, acc), s, xs);
  WithdrawFold(s, xs);
  WithdrawClassesInv(s, w, xs, serviceType);
  forall c | c in s.classes && (exists x :: x in xs && x.id == c.id) ensures c.live == 0 || c.live in captured
  {
    var x :| x in xs && x.id == c.id;
    ClassExact(s, c);
  }
  WithdrawPublishedInv(s, w, xs, serviceType, captured);
  RemovePublishedIs(serviceType, captured, w);
}

lemma PluginRetirementClassesView(s: PluginServices, epochId: int, serviceType: string)
  ensures retirementClassesForType(s, epochId, serviceType) ==
    Std.Collections.Seq.FoldLeft((classes: seq<RetireClass>, captured: RetireClass) => appendRetirementClass(classes, captured), [],
      (var s_map := ProofLib.Filter((o: OwnedClass) => ((o.epochId == epochId) && (o.serviceType == serviceType)), s.ownership);
       seq(|s_map|, i_map requires 0 <= i_map < |s_map| => var o := s_map[i_map]; RetireClass(o.classId))))
{}

lemma PluginRetirementClassHasReceipt(s: PluginServices, epochId: int, serviceType: string, c: RetireClass)
  requires c in retirementClassesForType(s, epochId, serviceType)
  ensures exists owner :: owner in s.ownership && owner.epochId == epochId && owner.serviceType == serviceType && owner.classId == c.id
{
  hide *;
  reveal appendRetirementClass();
  PluginRetirementClassesView(s, epochId, serviceType);
  var selected := (o: OwnedClass) => ((o.epochId == epochId) && (o.serviceType == serviceType));
  var owners := ProofLib.Filter(selected, s.ownership);
  var candidates := seq(|owners|, i_map requires 0 <= i_map < |owners| => var o := owners[i_map]; RetireClass(o.classId));
  var append := (classes: seq<RetireClass>, captured: RetireClass) => appendRetirementClass(classes, captured);
  ProofLib.FoldLeftDedupMember(append, [], candidates, c);
  assert c in candidates;
  var i :| 0 <= i < |candidates| && candidates[i] == c;
  var owner := owners[i];
  ProofLib.FilterMember(selected, s.ownership, owner);
}

lemma PluginRetirementClassUniquenessView(s: PluginServices, epochId: int, serviceType: string)
  ensures lawRetirementClassIdentitiesUnique(s, epochId, serviceType) ==
    (var classes := retirementClassesForType(s, epochId, serviceType);
     !(exists c :: c in classes && !(|ProofLib.Filter((other: RetireClass) => (other.id == c.id), classes)| == 1)))
{}

lemma lawRetirementClassIdentitiesUnique_ensures(s: PluginServices, epochId: int, serviceType: string)
  ensures (lawRetirementClassIdentitiesUnique(s, epochId, serviceType) == true)
{
  hide *;
  reveal appendRetirementClass();
  PluginRetirementClassesView(s, epochId, serviceType);
  PluginRetirementClassUniquenessView(s, epochId, serviceType);
  var owners := ProofLib.Filter((o: OwnedClass) => ((o.epochId == epochId) && (o.serviceType == serviceType)), s.ownership);
  var candidates := seq(|owners|, i_map requires 0 <= i_map < |owners| => var o := owners[i_map]; RetireClass(o.classId));
  var append := (classes: seq<RetireClass>, captured: RetireClass) => appendRetirementClass(classes, captured);
  ProofLib.FoldLeftDedupDistinct(append, [], candidates);
  var classes := retirementClassesForType(s, epochId, serviceType);
  forall c | c in classes
    ensures |ProofLib.Filter((other: RetireClass) => (other.id == c.id), classes)| == 1
  {
    assert forall other: RetireClass :: (other.id == c.id) == (other == c);
    ProofLib.FilterDistinctCountOne((other: RetireClass) => (other.id == c.id), classes, c);
  }
}

lemma WithdrawIs(s: PluginServices, epochId: int)
  ensures withdrawNextType(s, epochId) == (
  var local_5 := retirement(s, epochId);
  var local_6 := (if ((0 <= local_5.cursor) && (local_5.cursor < |local_5.plan|)) then local_5.plan[local_5.cursor] else "");
  var local_7 := !((exists d :: d in s.services.declarations && (d.serviceType == local_6)));
  var local_8 := retirementClassesForType(s, epochId, local_6);
  var local_9 := seq(|local_8|, i_map requires 0 <= i_map < |local_8| => var c := local_8[i_map]; core__serviceInstances_serviceClass(s.services, c.id));
  var local_10 := RetirementGroup(local_6, (if local_7 then [] else local_8), (if local_7 then [] else (var s_map := ProofLib.Filter((c: core__serviceInstances_ServiceClassEntry) => (c.pending != 0), local_9); seq(|s_map|, i_map requires 0 <= i_map < |s_map| => var c := s_map[i_map]; c.pending))), (if local_7 then 0 else core__serviceInstances_serviceTypeEntry(s.services, local_6).latestAggregate), (if local_7 then [] else captureOwnedInstances(local_8, s.services)), [], (if local_7 then RetirementGroupPhase.GroupSkipped else RetirementGroupPhase.GroupWaiting), 0, 0, ClassHookPhase.HookReady);
  var local_11 := (if local_7 then s.services else Std.Collections.Seq.FoldLeft((acc: core__serviceInstances_ServiceInstances, c: RetireClass) => core__serviceInstances_withdrawClass(c.id, acc), s.services, local_8));
  var local_12 := (if local_7 then local_11 else core__serviceInstances_removePublishedInstances(local_6, local_10.instances, local_11));
  s.(services := local_12, retirements := (var s_map := s.retirements; seq(|s_map|, i_map requires 0 <= i_map < |s_map| => var x := s_map[i_map]; (if (x.epochId == epochId) then x.(groups := (x.groups + [local_10]), cursor := (x.cursor + (if local_7 then 1 else 0))) else x))))
  )
{
}

lemma ShapeAppend(r: ServiceRetirement, r2: ServiceRetirement, group: RetirementGroup, skip: bool)
  requires retirementShaped(r) && r.cursor == |r.groups| && r.cursor < |r.plan| && !r.exited
  requires group.serviceType == r.plan[r.cursor] && group.instanceCursor == 0
  requires group.phase == (if skip then RetirementGroupPhase.GroupSkipped else RetirementGroupPhase.GroupWaiting) && (skip ==> |group.instances| == 0)
  requires r2 == r.(groups := r.groups + [group], cursor := r.cursor + (if skip then 1 else 0))
  ensures retirementShaped(r2)
{
  ShapedFilters(r);
  GroupsPlan(r);
  GroupsPlan(r2);
  GroupsDistinct(r);
  ShapedFilters(r);
  ShapedFilters(r2);
  forall g | g in r2.groups ensures groupSlotsPassed(g) && ((g.phase.GroupFinished? || g.phase.GroupSkipped?) == !(isCurrentGroup(r2, g)))
  {
    var j :| 0 <= j < |r2.groups| && r2.groups[j] == g;
    if j < |r.groups| {
      assert r.groups[j] in r.groups && g == r.groups[j];
      if !skip && g.serviceType == group.serviceType {
        assert r.plan[r.cursor] in r.plan;
        ProofLib.FilterTwo((u: string) => (u == r.plan[r.cursor]), r.plan, j, r.cursor);
      }
    }
  }
}

lemma withdrawNextType_ensures(s: PluginServices, epochId: int)
  ensures (inv(s) ==> canWithdrawNextType(s, epochId) ==> alwaysEpochIdentityUnique(withdrawNextType(s, epochId)))
  ensures (inv(s) ==> canWithdrawNextType(s, epochId) ==> alwaysOneActiveEpochPerName(withdrawNextType(s, epochId)))
  ensures (inv(s) ==> canWithdrawNextType(s, epochId) ==> alwaysEpochOutcomeHonest(withdrawNextType(s, epochId)))
  ensures (inv(s) ==> canWithdrawNextType(s, epochId) ==> alwaysRetirementPerRetiredEpoch(withdrawNextType(s, epochId)))
  ensures (inv(s) ==> canWithdrawNextType(s, epochId) ==> alwaysLiveClassOwnerUnique(withdrawNextType(s, epochId)))
  ensures (inv(s) ==> canWithdrawNextType(s, epochId) ==> alwaysServiceOwnerEpochExists(withdrawNextType(s, epochId)))
  ensures (inv(s) ==> canWithdrawNextType(s, epochId) ==> alwaysChildLifecyclesValid(withdrawNextType(s, epochId)))
  ensures (inv(s) ==> canWithdrawNextType(s, epochId) ==> alwaysOwnedClassesMatchServices(withdrawNextType(s, epochId)))
  ensures (inv(s) ==> canWithdrawNextType(s, epochId) ==> alwaysInvokingStartHasNoInstance(withdrawNextType(s, epochId)))
  ensures (inv(s) ==> canWithdrawNextType(s, epochId) ==> alwaysRetirementFollowsPlan(withdrawNextType(s, epochId)))
  ensures (inv(s) ==> canWithdrawNextType(s, epochId) ==> alwaysLiveInstanceReachable(withdrawNextType(s, epochId)))
  ensures (inv(s) ==> canWithdrawNextType(s, epochId) ==> alwaysNoOrphanInstance(withdrawNextType(s, epochId)))
  ensures (inv(s) ==> canWithdrawNextType(s, epochId) ==> alwaysStopObservationsFollowSlots(withdrawNextType(s, epochId)))
  ensures (inv(s) ==> canWithdrawNextType(s, epochId) ==> alwaysRetiredUndeclaredTypeIsUnknown(withdrawNextType(s, epochId)))
  ensures (inv(s) ==> canWithdrawNextType(s, epochId) ==> alwaysRetiredEpochHasNoResources(withdrawNextType(s, epochId)))
  ensures (inv(s) ==> canWithdrawNextType(s, epochId) ==> alwaysSealedOwnedClassesStable(withdrawNextType(s, epochId)))
{
  if inv(s) && canWithdrawNextType(s, epochId) {
    WithdrawIs(s, epochId);
    var r := retirement(s, epochId);
    RetirementFound(s, epochId);
    var k := RetirementIndex(s, r);
    var t := r.plan[r.cursor];
    var skip := !((exists d :: d in s.services.declarations && (d.serviceType == t)));
    var classes := retirementClassesForType(s, epochId, t);
    var captured := captureOwnedInstances(classes, s.services);
    var after := withdrawNextType(s, epochId);
    var group := after.retirements[k].groups[|r.groups|];
    var r2 := r.(groups := r.groups + [group], cursor := r.cursor + (if skip then 1 else 0));
    assert after.retirements == s.retirements[k := r2];
    assert group.serviceType == t && group.observedStops == [] && group.instanceCursor == 0;
    assert group.instances == (if skip then [] else captured);
    forall c | c in classes ensures exists o :: o in s.ownership && o.classId == c.id && o.serviceType == t
    {
      PluginRetirementClassHasReceipt(s, epochId, t, c);
    }
    forall c | c in classes ensures core__serviceInstances_serviceClass(s.services, c.id).serviceType == t
    {
      var o :| o in s.ownership && o.classId == c.id && o.serviceType == t;
    }
    CaptureFold(s.services, noCapturedInstances, classes);
    var w := Std.Collections.Seq.FoldLeft((acc: core__serviceInstances_ServiceInstances, c: RetireClass) => core__serviceInstances_withdrawClass(c.id, acc), s.services, classes);
    WithdrawFold(s.services, classes);
    if !skip {
      WithdrawInv(s.services, classes, t, captured);
      RemovePublishedIs(t, captured, w);
      assert after.services == core__serviceInstances_removePublishedInstances(t, captured, w);
      assert after.services == w.(published := after.services.published);
    } else {
      assert after.services == s.services;
    }
    ChildInv(after);
    assert forall slot :: stopSlotSettled(slot, s.services) ==> stopSlotSettled(slot, after.services);
    if !skip {
      ISClassFrame(s.services, after.services);
      PubReplaceAll();
      RemovePublishedIs(t, captured, w);
      forall x | x in core__serviceInstances_publishedInstances(s.services, t) && x !in captured ensures x in core__serviceInstances_publishedInstances(after.services, t)
      {
        ProofLib.FilterMember((id: int) => !((id in captured)), core__serviceInstances_publishedInstances(s.services, t), x);
      }
    }
    UAt(s, after, k, r2);
    ShapeAppend(r, r2, group, skip);
    ShapeAt(s, after, k, r2);
    assert r in s.retirements;
    forall g | g in r2.groups
      ensures g.instanceCursor >= 0 && g.instanceCursor <= |g.instances| && |g.observedStops| >= g.instanceCursor && |g.observedStops| <= |g.instances| && |g.observedStops| <= g.instanceCursor + 1 && allStopObservationsValid(g, after.services)
    {
      StopsValid(g, after.services);
      if g != group {
        assert g in r.groups;
        StopsValid(g, s.services);
      }
    }
    SlotsAt(s, after, k, r2);
    EpochIdLookup(s, epochId);
    NoResourcesAt(s, after, k, r2);
    ClassShape(s, after);
    forall c | c in classes ensures core__serviceInstances_serviceClass(s.services, c.id).live == 0 || core__serviceInstances_serviceClass(s.services, c.id).live in captured
    {
    }
    PubSame();
    forall u, x | x in core__serviceInstances_publishedInstances(s.services, u) && u != t
      ensures x in core__serviceInstances_publishedInstances(after.services, u)
    {
      if !skip {
        assert core__serviceInstances_publishedInstances(w, u) == core__serviceInstances_publishedInstances(s.services, u);
      }
    }
    forall x | x in core__serviceInstances_publishedInstances(s.services, t) && !(!skip && x in captured)
      ensures x in core__serviceInstances_publishedInstances(after.services, t)
    {
    }
    WithdrawCover(s, after, k, r2, group, classes, t, captured, skip);
    forall d | d in s.services.declarations && d.serviceType != t ensures d in after.services.declarations
    {
      if !skip && exists x :: x in classes && x.id == d.classId {
        var x :| x in classes && x.id == d.classId;
        assert false;
      }
    }
    assert after.services.stopped == s.services.stopped && after.services.typeEntries == s.services.typeEntries;
    WithdrawUndeclared(s, after, k, r2, group, t, skip);
  }
}

lemma finishNextClassHook_ensures(s: PluginServices, ok: bool, errorId: string)
  ensures (inv(s) ==> canFinishNextClassHook(s, ok, errorId) ==> alwaysEpochIdentityUnique(finishNextClassHook(s, ok, errorId)))
  ensures (inv(s) ==> canFinishNextClassHook(s, ok, errorId) ==> alwaysOneActiveEpochPerName(finishNextClassHook(s, ok, errorId)))
  ensures (inv(s) ==> canFinishNextClassHook(s, ok, errorId) ==> alwaysEpochOutcomeHonest(finishNextClassHook(s, ok, errorId)))
  ensures (inv(s) ==> canFinishNextClassHook(s, ok, errorId) ==> alwaysRetirementPerRetiredEpoch(finishNextClassHook(s, ok, errorId)))
  ensures (inv(s) ==> canFinishNextClassHook(s, ok, errorId) ==> alwaysLiveClassOwnerUnique(finishNextClassHook(s, ok, errorId)))
  ensures (inv(s) ==> canFinishNextClassHook(s, ok, errorId) ==> alwaysServiceOwnerEpochExists(finishNextClassHook(s, ok, errorId)))
  ensures (inv(s) ==> canFinishNextClassHook(s, ok, errorId) ==> alwaysChildLifecyclesValid(finishNextClassHook(s, ok, errorId)))
  ensures (inv(s) ==> canFinishNextClassHook(s, ok, errorId) ==> alwaysOwnedClassesMatchServices(finishNextClassHook(s, ok, errorId)))
  ensures (inv(s) ==> canFinishNextClassHook(s, ok, errorId) ==> alwaysInvokingStartHasNoInstance(finishNextClassHook(s, ok, errorId)))
  ensures (inv(s) ==> canFinishNextClassHook(s, ok, errorId) ==> alwaysRetirementFollowsPlan(finishNextClassHook(s, ok, errorId)))
  ensures (inv(s) ==> canFinishNextClassHook(s, ok, errorId) ==> alwaysLiveInstanceReachable(finishNextClassHook(s, ok, errorId)))
  ensures (inv(s) ==> canFinishNextClassHook(s, ok, errorId) ==> alwaysNoOrphanInstance(finishNextClassHook(s, ok, errorId)))
  ensures (inv(s) ==> canFinishNextClassHook(s, ok, errorId) ==> alwaysStopObservationsFollowSlots(finishNextClassHook(s, ok, errorId)))
  ensures (inv(s) ==> canFinishNextClassHook(s, ok, errorId) ==> alwaysRetiredUndeclaredTypeIsUnknown(finishNextClassHook(s, ok, errorId)))
  ensures (inv(s) ==> canFinishNextClassHook(s, ok, errorId) ==> alwaysRetiredEpochHasNoResources(finishNextClassHook(s, ok, errorId)))
  ensures (inv(s) ==> canFinishNextClassHook(s, ok, errorId) ==> alwaysSealedOwnedClassesStable(finishNextClassHook(s, ok, errorId)))
{
  if inv(s) && canFinishNextClassHook(s, ok, errorId) {
    finishClassHook_ensures(s, pendingClassHookEpoch(s), ok, errorId);
  }
}

lemma advanceRetirement_ensures(s: PluginServices)
  ensures (inv(s) ==> canAdvanceRetirement(s) ==> alwaysEpochIdentityUnique(advanceRetirement(s)))
  ensures (inv(s) ==> canAdvanceRetirement(s) ==> alwaysOneActiveEpochPerName(advanceRetirement(s)))
  ensures (inv(s) ==> canAdvanceRetirement(s) ==> alwaysEpochOutcomeHonest(advanceRetirement(s)))
  ensures (inv(s) ==> canAdvanceRetirement(s) ==> alwaysRetirementPerRetiredEpoch(advanceRetirement(s)))
  ensures (inv(s) ==> canAdvanceRetirement(s) ==> alwaysLiveClassOwnerUnique(advanceRetirement(s)))
  ensures (inv(s) ==> canAdvanceRetirement(s) ==> alwaysServiceOwnerEpochExists(advanceRetirement(s)))
  ensures (inv(s) ==> canAdvanceRetirement(s) ==> alwaysChildLifecyclesValid(advanceRetirement(s)))
  ensures (inv(s) ==> canAdvanceRetirement(s) ==> alwaysOwnedClassesMatchServices(advanceRetirement(s)))
  ensures (inv(s) ==> canAdvanceRetirement(s) ==> alwaysInvokingStartHasNoInstance(advanceRetirement(s)))
  ensures (inv(s) ==> canAdvanceRetirement(s) ==> alwaysRetirementFollowsPlan(advanceRetirement(s)))
  ensures (inv(s) ==> canAdvanceRetirement(s) ==> alwaysLiveInstanceReachable(advanceRetirement(s)))
  ensures (inv(s) ==> canAdvanceRetirement(s) ==> alwaysNoOrphanInstance(advanceRetirement(s)))
  ensures (inv(s) ==> canAdvanceRetirement(s) ==> alwaysStopObservationsFollowSlots(advanceRetirement(s)))
  ensures (inv(s) ==> canAdvanceRetirement(s) ==> alwaysRetiredUndeclaredTypeIsUnknown(advanceRetirement(s)))
  ensures (inv(s) ==> canAdvanceRetirement(s) ==> alwaysRetiredEpochHasNoResources(advanceRetirement(s)))
  ensures (inv(s) ==> canAdvanceRetirement(s) ==> alwaysSealedOwnedClassesStable(advanceRetirement(s)))
{
  if inv(s) && canAdvanceRetirement(s) {
    var epochId := automaticRetirement(s);
    if canWithdrawNextType(s, epochId) { withdrawNextType_ensures(s, epochId); }
    else if canRequestOwnedStops(s, epochId) { requestOwnedStops_ensures(s, epochId); }
    else if canClaimInstanceStop(s, epochId) { claimInstanceStop_ensures(s, epochId); }
    else if canObserveInstanceStop(s, epochId) { observeInstanceStop_ensures(s, epochId); }
    else if canFinishClassSlot(s, epochId) { finishClassSlot_ensures(s, epochId); }
    else if canFinishRetirementGroup(s, epochId) { finishRetirementGroup_ensures(s, epochId); }
    else if canCleanPlugin(s, epochId) { cleanPlugin_ensures(s, epochId); }
  }
}

lemma AttemptClassFound(s: core__serviceInstances_ServiceInstances, a: core__serviceInstances_ServiceAttempt) returns (i: int)
  requires core__serviceInstances_alwaysAttemptGeneration(s) && core__serviceInstances_alwaysClassAndObjectIdentities(s) && a in s.attempts
  ensures 0 <= i < |s.classes| && s.classes[i].id == a.classId && core__serviceInstances_serviceClass(s, a.classId) == s.classes[i]
{
  ClassFound(s, a.classId);
  var c := core__serviceInstances_serviceClass(s, a.classId);
  i :| 0 <= i < |s.classes| && s.classes[i] == c;
}

lemma ISClassFrame(s: core__serviceInstances_ServiceInstances, next: core__serviceInstances_ServiceInstances)
  requires core__serviceInstances_inv(s) && core__serviceInstances_alwaysClassAndObjectIdentities(next)
  requires !s.stopped ==> forall a :: a in s.attempts && a.phase.StartInvoking? ==> core__serviceInstances_serviceClass(s, a.classId).pending == a.id && core__serviceInstances_serviceClass(s, a.classId).live == 0
  requires next.attempts == s.attempts && next.stopped == s.stopped && |next.classes| >= |s.classes|
  requires forall i :: 0 <= i < |s.classes| ==> next.classes[i].id == s.classes[i].id && next.classes[i].pending == s.classes[i].pending && (s.classes[i].live == 0 ==> next.classes[i].live == 0)
  ensures !next.stopped ==> forall a :: a in next.attempts && a.phase.StartInvoking? ==> core__serviceInstances_serviceClass(next, a.classId).pending == a.id && core__serviceInstances_serviceClass(next, a.classId).live == 0
{
  forall a | a in next.attempts && a.phase.StartInvoking? && !next.stopped
    ensures core__serviceInstances_serviceClass(next, a.classId).pending == a.id && core__serviceInstances_serviceClass(next, a.classId).live == 0
  {
    var i := AttemptClassFound(s, a);
    assert next.classes[i] in next.classes;
    ClassExact(next, next.classes[i]);
  }
}

lemma ISAttemptStep(s: core__serviceInstances_ServiceInstances, next: core__serviceInstances_ServiceInstances, gone: int)
  requires core__serviceInstances_inv(s) && core__serviceInstances_alwaysClassAndObjectIdentities(next)
  requires !s.stopped ==> forall a :: a in s.attempts && a.phase.StartInvoking? ==> core__serviceInstances_serviceClass(s, a.classId).pending == a.id && core__serviceInstances_serviceClass(s, a.classId).live == 0
  requires next.stopped == s.stopped && |next.attempts| == |s.attempts| && |next.classes| == |s.classes|
  requires forall j :: 0 <= j < |s.attempts| ==> (next.attempts[j].id == s.attempts[j].id && next.attempts[j].classId == s.attempts[j].classId &&
    (next.attempts[j].phase.StartInvoking? ==> s.attempts[j].phase.StartInvoking? && s.attempts[j].id != gone))
  requires forall i :: 0 <= i < |s.classes| ==> next.classes[i].id == s.classes[i].id && (s.classes[i].pending == gone || (next.classes[i].pending == s.classes[i].pending && next.classes[i].live == s.classes[i].live))
  ensures !next.stopped ==> forall a :: a in next.attempts && a.phase.StartInvoking? ==> core__serviceInstances_serviceClass(next, a.classId).pending == a.id && core__serviceInstances_serviceClass(next, a.classId).live == 0
{
  forall a | a in next.attempts && a.phase.StartInvoking? && !next.stopped
    ensures core__serviceInstances_serviceClass(next, a.classId).pending == a.id && core__serviceInstances_serviceClass(next, a.classId).live == 0
  {
    var j :| 0 <= j < |next.attempts| && next.attempts[j] == a;
    var a0 := s.attempts[j];
    assert a0 in s.attempts;
    var i := AttemptClassFound(s, a0);
    assert next.classes[i] in next.classes;
    ClassExact(next, next.classes[i]);
  }
}

lemma ClassMapLookup(s: core__serviceInstances_ServiceInstances, next: core__serviceInstances_ServiceInstances, x: int)
  requires |next.classes| == |s.classes|
  requires forall i :: 0 <= i < |s.classes| ==> next.classes[i].id == s.classes[i].id && (s.classes[i].id != x ==> next.classes[i] == s.classes[i])
  ensures forall y :: y != x ==> core__serviceInstances_serviceClass(next, y) == core__serviceInstances_serviceClass(s, y)
{
  forall y | y != x ensures core__serviceInstances_serviceClass(next, y) == core__serviceInstances_serviceClass(s, y)
  {
    var p := (c: core__serviceInstances_ServiceClassEntry) => (c.id == y);
    ProofLib.FilterPointwise(p, p, (a: core__serviceInstances_ServiceClassEntry, b: core__serviceInstances_ServiceClassEntry) => (a.id == y ==> a == b), s.classes, next.classes);
    var m := ProofLib.Filter(p, s.classes);
    if |m| > 0 {
      assert m[0] in m;
      ProofLib.FilterMember(p, s.classes, m[0]);
    }
  }
}

lemma ISEnsureFold(serviceType: string, s: core__serviceInstances_ServiceInstances, acc: core__serviceInstances_ServiceInstances, ds: seq<core__serviceInstances_ServiceDeclaration>)
  requires core__serviceInstances_alwaysClassAndObjectIdentities(acc) && acc.nextAttempt > 0
  requires forall a :: a in acc.attempts ==> a.id > 0
  requires forall d :: d in ds ==> exists c :: c in acc.classes && c.id == d.classId
  requires !acc.stopped ==> forall a :: a in acc.attempts && a.phase.StartInvoking? ==> core__serviceInstances_serviceClass(acc, a.classId).pending == a.id && core__serviceInstances_serviceClass(acc, a.classId).live == 0
  ensures var r := Std.Collections.Seq.FoldLeft((acc: core__serviceInstances_ServiceInstances, d: core__serviceInstances_ServiceDeclaration) => (if ((((d.serviceType == serviceType) && (core__serviceInstances_serviceClass(acc, d.classId).live == 0)) && (core__serviceInstances_serviceClass(acc, d.classId).pending == 0)) && !((core__serviceInstances_serviceClass(acc, d.classId).failed && (|core__serviceInstances_classInstances(s, serviceType)| != 0)))) then core__serviceInstances_beginClassAttempt(d.classId, acc) else acc), acc, ds);
    (!r.stopped ==> forall a :: a in r.attempts && a.phase.StartInvoking? ==> core__serviceInstances_serviceClass(r, a.classId).pending == a.id && core__serviceInstances_serviceClass(r, a.classId).live == 0)
  decreases |ds|
{
  if |ds| > 0 {
    var f := (acc: core__serviceInstances_ServiceInstances, d: core__serviceInstances_ServiceDeclaration) => (if ((((d.serviceType == serviceType) && (core__serviceInstances_serviceClass(acc, d.classId).live == 0)) && (core__serviceInstances_serviceClass(acc, d.classId).pending == 0)) && !((core__serviceInstances_serviceClass(acc, d.classId).failed && (|core__serviceInstances_classInstances(s, serviceType)| != 0)))) then core__serviceInstances_beginClassAttempt(d.classId, acc) else acc);
    var next := f(acc, ds[0]);
    assert Std.Collections.Seq.FoldLeft(f, acc, ds) == Std.Collections.Seq.FoldLeft(f, next, ds[1..]);
    var classId := ds[0].classId;
    if next != acc {
      assert next == core__serviceInstances_beginClassAttempt(classId, acc);
      var c0 :| c0 in acc.classes && c0.id == classId;
      ClassExact(acc, c0);
      var k :| 0 <= k < |acc.classes| && acc.classes[k] == c0;
      forall c | c in next.classes ensures c.id > 0 && c.generation >= 0 && c.pending >= 0 && |ProofLib.Filter((other: core__serviceInstances_ServiceClassEntry) => (other.id == c.id), next.classes)| == 1
      {
        var i :| 0 <= i < |next.classes| && next.classes[i] == c;
        assert acc.classes[i] in acc.classes;
        ProofLib.FilterLengthPointwise((other: core__serviceInstances_ServiceClassEntry) => (other.id == c.id), (other: core__serviceInstances_ServiceClassEntry) => (other.id == c.id), acc.classes, next.classes);
      }
      assert next.classes[k] in next.classes;
      ClassExact(next, next.classes[k]);
      ClassMapLookup(acc, next, classId);
      forall d | d in ds[1..] ensures exists c :: c in next.classes && c.id == d.classId
      {
        var c :| c in acc.classes && c.id == d.classId;
        var i :| 0 <= i < |acc.classes| && acc.classes[i] == c;
        assert next.classes[i] in next.classes;
      }
      forall a | a in next.attempts && a.phase.StartInvoking? && !next.stopped
        ensures core__serviceInstances_serviceClass(next, a.classId).pending == a.id && core__serviceInstances_serviceClass(next, a.classId).live == 0
      {
        if a !in acc.attempts {
          assert a.id == acc.nextAttempt && a.classId == classId;
        } else if a.classId == classId {
          assert false;
        }
      }
    }
    ISEnsureFold(serviceType, s, next, ds[1..]);
  }
}

lemma ISAcquire(callId: int, serviceType: string, s: core__serviceInstances_ServiceInstances)
  requires core__serviceInstances_alwaysClassAndObjectIdentities(s) && core__serviceInstances_alwaysAttemptGeneration(s) && core__serviceInstances_alwaysDeclarationsMatch(s)
  requires !s.stopped ==> forall a :: a in s.attempts && a.phase.StartInvoking? ==> core__serviceInstances_serviceClass(s, a.classId).pending == a.id && core__serviceInstances_serviceClass(s, a.classId).live == 0
  ensures var r := core__serviceInstances_admittedAcquire(callId, serviceType, s);
    !r.stopped ==> forall a :: a in r.attempts && a.phase.StartInvoking? ==> core__serviceInstances_serviceClass(r, a.classId).pending == a.id && core__serviceInstances_serviceClass(r, a.classId).live == 0
{
  forall d | d in s.declarations ensures exists c :: c in s.classes && c.id == d.classId
  {
    ClassFound(s, d.classId);
  }
  ISEnsureFold(serviceType, s, s, s.declarations);
  EnsureFold(serviceType, s, s, s.declarations);
  SetStatusOther(serviceType, core__serviceInstances_TypeStatus.TypeRegistering);
}

lemma AttemptFound(s: core__serviceInstances_ServiceInstances, attemptId: int)
  ensures core__serviceInstances_serviceAttempt(s, attemptId) == core__serviceInstances_noAttempt ||
    (core__serviceInstances_serviceAttempt(s, attemptId) in s.attempts && core__serviceInstances_serviceAttempt(s, attemptId).id == attemptId)
{
  var m := ProofLib.Filter((a: core__serviceInstances_ServiceAttempt) => (a.id == attemptId), s.attempts);
  if |m| > 0 {
    assert m[0] in m;
    ProofLib.FilterMember((a: core__serviceInstances_ServiceAttempt) => (a.id == attemptId), s.attempts, m[0]);
  }
}

lemma ReturnIS(s: core__serviceInstances_ServiceInstances, attemptId: int, instanceId: int)
  requires core__serviceInstances_inv(s) && core__serviceInstances_canReturnInstance(s, attemptId, instanceId)
  requires core__serviceInstances_alwaysClassAndObjectIdentities(core__serviceInstances_returnInstance(s, attemptId, instanceId))
  requires !s.stopped ==> forall a :: a in s.attempts && a.phase.StartInvoking? ==> core__serviceInstances_serviceClass(s, a.classId).pending == a.id && core__serviceInstances_serviceClass(s, a.classId).live == 0
  ensures var r := core__serviceInstances_returnInstance(s, attemptId, instanceId);
    !r.stopped ==> forall a :: a in r.attempts && a.phase.StartInvoking? ==> core__serviceInstances_serviceClass(r, a.classId).pending == a.id && core__serviceInstances_serviceClass(r, a.classId).live == 0
{
  var r := core__serviceInstances_returnInstance(s, attemptId, instanceId);
  AttemptFound(s, attemptId);
  var a := core__serviceInstances_serviceAttempt(s, attemptId);
  forall i | 0 <= i < |s.classes| && s.classes[i].id == a.classId && !s.stopped
    ensures s.classes[i].pending == attemptId
  {
    assert s.classes[i] in s.classes;
    ClassExact(s, s.classes[i]);
  }
  ISAttemptStep(s, r, attemptId);
}

lemma OrphanReturn(s: PluginServices, after: PluginServices, attemptId: int, instanceId: int)
  requires alwaysNoOrphanInstance(s) && alwaysInvokingStartHasNoInstance(s) && core__serviceInstances_inv(s.services) && core__serviceInstances_canReturnInstance(s.services, attemptId, instanceId)
  requires after == s.(services := core__serviceInstances_returnInstance(s.services, attemptId, instanceId))
  requires alwaysLiveInstanceReachable(after) && core__serviceInstances_alwaysClassAndObjectIdentities(after.services)
  ensures alwaysNoOrphanInstance(after)
{
  var sv := s.services;
  AttemptFound(sv, attemptId);
  var a := core__serviceInstances_serviceAttempt(sv, attemptId);
  var c := core__serviceInstances_serviceClass(sv, a.classId);
  var late := sv.stopped || !c.registered;
  ClassFound(sv, a.classId);
  forall i | 0 <= i < |sv.classes| && sv.classes[i].id == a.classId
    ensures sv.classes[i] == c
  {
    assert sv.classes[i] in sv.classes;
    ClassExact(sv, sv.classes[i]);
  }
  assert !late ==> c.live == 0;
  var r := after.services;
  assert |r.classes| == |sv.classes|;
  forall i | 0 <= i < |sv.classes| ensures r.classes[i] == (if sv.classes[i].id == a.classId && !late then sv.classes[i].(live := instanceId) else sv.classes[i])
  {
  }
  assert forall o :: o in r.objects && o.id != instanceId ==> o in sv.objects;
  assert late ==> forall o :: o in r.objects && o.id == instanceId ==> o.stopCalls > 0;
  forall o | o in r.objects
    ensures (o.stopCalls > 0) || (exists cl :: cl in r.classes && cl.live == o.id && cl.registered) ||
      (exists rr :: rr in after.retirements && (exists g :: g in rr.groups && (missingStopObservedFor(g, o.id) || (epochOwnsResources(after, rr.epochId) && (o.id in g.instances)))))
  {
    if o.id == instanceId {
      if !late {
        var i :| 0 <= i < |sv.classes| && sv.classes[i] == c;
        assert r.classes[i] in r.classes;
      }
    } else {
      assert o in sv.objects;
      if exists cl :: cl in sv.classes && cl.live == o.id && cl.registered {
        var cl :| cl in sv.classes && cl.live == o.id && cl.registered;
        var i :| 0 <= i < |sv.classes| && sv.classes[i] == cl;
        assert r.classes[i] in r.classes;
      }
    }
  }
  OrphanFromReach(after);
}

lemma StopCallsKept(s: core__serviceInstances_ServiceInstances, next: core__serviceInstances_ServiceInstances)
  requires core__serviceInstances_alwaysObjectStopOnce(s) && core__serviceInstances_alwaysClassAndObjectIdentities(next) && core__serviceInstances_stepStopIdentityRetained(s, next)
  ensures forall id :: core__serviceInstances_serviceObject(s, id).stopCalls > 0 ==> core__serviceInstances_serviceObject(next, id).stopCalls > 0
{
  forall id | core__serviceInstances_serviceObject(s, id).stopCalls > 0 ensures core__serviceInstances_serviceObject(next, id).stopCalls > 0
  {
    ObjectFound(s, id);
    var o := core__serviceInstances_serviceObject(s, id);
    var later :| later in next.objects && later.id == o.id && later.stopCalls == 1 && (o.stopPhase.StopWaiting? || later.stopPhase == o.stopPhase);
    ObjectExact(next, later);
  }
}

lemma ReachFrame(s: PluginServices, after: PluginServices)
  requires alwaysLiveInstanceReachable(s) && core__serviceInstances_alwaysObjectStopOnce(s.services) && after.epochs == s.epochs && after.retirements == s.retirements
  requires core__serviceInstances_alwaysClassAndObjectIdentities(after.services) && core__serviceInstances_stepStopIdentityRetained(s.services, after.services)
  requires |after.services.classes| >= |s.services.classes|
  requires forall i :: 0 <= i < |after.services.classes| ==> (after.services.classes[i].live == 0 || !after.services.classes[i].registered ||
    (i < |s.services.classes| && after.services.classes[i].live == s.services.classes[i].live && s.services.classes[i].registered && after.services.classes[i].serviceType == s.services.classes[i].serviceType))
  requires forall t :: core__serviceInstances_publishedInstances(after.services, t) == core__serviceInstances_publishedInstances(s.services, t)
  ensures alwaysLiveInstanceReachable(after)
{
  StopCallsKept(s.services, after.services);
  forall c | c in after.services.classes && c.live != 0 && c.registered
    ensures core__serviceInstances_serviceObject(after.services, c.live).stopCalls > 0 || (c.live in core__serviceInstances_publishedInstances(after.services, c.serviceType)) ||
      (exists r :: r in after.retirements && (exists g :: g in r.groups && (missingStopObservedFor(g, c.live) || (epochOwnsResources(after, r.epochId) && (c.live in g.instances)))))
  {
    var i :| 0 <= i < |after.services.classes| && after.services.classes[i] == c;
    assert s.services.classes[i] in s.services.classes;
  }
}

lemma ReachAt(s: PluginServices, after: PluginServices, k: int, c: int, g2: RetirementGroup, r2: ServiceRetirement)
  requires alwaysLiveInstanceReachable(s) && core__serviceInstances_alwaysObjectStopOnce(s.services) && after.epochs == s.epochs
  requires core__serviceInstances_alwaysClassAndObjectIdentities(after.services) && core__serviceInstances_stepStopIdentityRetained(s.services, after.services)
  requires |after.services.classes| == |s.services.classes|
  requires forall i :: 0 <= i < |s.services.classes| ==> after.services.classes[i].live == s.services.classes[i].live && after.services.classes[i].registered == s.services.classes[i].registered && after.services.classes[i].serviceType == s.services.classes[i].serviceType
  requires forall t :: core__serviceInstances_publishedInstances(after.services, t) == core__serviceInstances_publishedInstances(s.services, t)
  requires 0 <= k < |s.retirements| && after.retirements == s.retirements[k := r2] && r2.epochId == s.retirements[k].epochId
  requires 0 <= c < |s.retirements[k].groups| && r2.groups == s.retirements[k].groups[c := g2]
  requires g2.instances == s.retirements[k].groups[c].instances
  requires forall slot :: slot in s.retirements[k].groups[c].observedStops ==> slot in g2.observedStops
  ensures alwaysLiveInstanceReachable(after)
{
  StopCallsKept(s.services, after.services);
  forall cl | cl in after.services.classes && cl.live != 0 && cl.registered
    ensures core__serviceInstances_serviceObject(after.services, cl.live).stopCalls > 0 || (cl.live in core__serviceInstances_publishedInstances(after.services, cl.serviceType)) ||
      (exists r :: r in after.retirements && (exists g :: g in r.groups && (missingStopObservedFor(g, cl.live) || (epochOwnsResources(after, r.epochId) && (cl.live in g.instances)))))
  {
    var i :| 0 <= i < |after.services.classes| && after.services.classes[i] == cl;
    var c0 := s.services.classes[i];
    assert c0 in s.services.classes;
    if !(core__serviceInstances_serviceObject(s.services, c0.live).stopCalls > 0) && !(c0.live in core__serviceInstances_publishedInstances(s.services, c0.serviceType)) {
      var r, g :| r in s.retirements && g in r.groups && (missingStopObservedFor(g, c0.live) || (epochOwnsResources(s, r.epochId) && (c0.live in g.instances)));
      var j :| 0 <= j < |s.retirements| && s.retirements[j] == r;
      if j == k {
        var m :| 0 <= m < |r.groups| && r.groups[m] == g;
        assert after.retirements[k] == r2 && |r2.groups| == |r.groups| && r2.groups[m] in r2.groups;
        if m == c && missingStopObservedFor(g, c0.live) {
          var slot :| slot in g.observedStops && slot.instanceId == c0.live && slot.observed.MissingStopSlot?;
          assert slot in g2.observedStops;
        }
      } else {
        assert after.retirements[j] == r;
      }
    }
  }
}

lemma StepSameObjects(s: core__serviceInstances_ServiceInstances, next: core__serviceInstances_ServiceInstances)
  requires core__serviceInstances_alwaysObjectStopOnce(s) && next.objects == s.objects
  ensures core__serviceInstances_stepStopIdentityRetained(s, next)
{
}

lemma PubReplaceAll()
  ensures forall serviceType: string, instances: seq<int>, x: core__serviceInstances_ServiceInstances, t: string ::
    core__serviceInstances_publishedInstances(core__serviceInstances_replacePublication(serviceType, instances, x), t) == (if t == serviceType then instances else core__serviceInstances_publishedInstances(x, t))
{
  forall serviceType: string, instances: seq<int>, x: core__serviceInstances_ServiceInstances, t: string
    ensures core__serviceInstances_publishedInstances(core__serviceInstances_replacePublication(serviceType, instances, x), t) == (if t == serviceType then instances else core__serviceInstances_publishedInstances(x, t))
  {
    PubLookupReplace(serviceType, instances, x, t);
  }
}

lemma ClassInstancesMember(s: core__serviceInstances_ServiceInstances, serviceType: string, d: core__serviceInstances_ServiceDeclaration)
  requires d in s.declarations && d.serviceType == serviceType && core__serviceInstances_serviceClass(s, d.classId).live != 0
  ensures core__serviceInstances_serviceClass(s, d.classId).live in core__serviceInstances_classInstances(s, serviceType)
{
  var p := (d: core__serviceInstances_ServiceDeclaration) => ((d.serviceType == serviceType) && (core__serviceInstances_serviceClass(s, d.classId).live != 0));
  ProofLib.FilterMember(p, s.declarations, d);
  var m := ProofLib.Filter(p, s.declarations);
  var j :| 0 <= j < |m| && m[j] == d;
  ClassInstancesIs(s, serviceType);
  assert core__serviceInstances_classInstances(s, serviceType)[j] == core__serviceInstances_serviceClass(s, d.classId).live;
}

lemma ClassInstancesIs(s: core__serviceInstances_ServiceInstances, serviceType: string)
  ensures core__serviceInstances_classInstances(s, serviceType) == (var s_map := ProofLib.Filter((d: core__serviceInstances_ServiceDeclaration) => ((d.serviceType == serviceType) && (core__serviceInstances_serviceClass(s, d.classId).live != 0)), s.declarations); seq(|s_map|, i_map requires 0 <= i_map < |s_map| => var d := s_map[i_map]; core__serviceInstances_serviceClass(s, d.classId).live))
{
}

lemma ClassInstancesAll()
  ensures forall x: core__serviceInstances_ServiceInstances, serviceType: string, d: core__serviceInstances_ServiceDeclaration ::
    d in x.declarations && d.serviceType == serviceType && core__serviceInstances_serviceClass(x, d.classId).live != 0 ==> core__serviceInstances_serviceClass(x, d.classId).live in core__serviceInstances_classInstances(x, serviceType)
{
  forall x: core__serviceInstances_ServiceInstances, serviceType: string, d: core__serviceInstances_ServiceDeclaration | d in x.declarations && d.serviceType == serviceType && core__serviceInstances_serviceClass(x, d.classId).live != 0
    ensures core__serviceInstances_serviceClass(x, d.classId).live in core__serviceInstances_classInstances(x, serviceType)
  {
    ClassInstancesMember(x, serviceType, d);
  }
}

lemma ReturnAdded(s: core__serviceInstances_ServiceInstances, attemptId: int, instanceId: int) returns (added: core__serviceInstances_ServiceInstances)
  ensures var a := core__serviceInstances_serviceAttempt(s, attemptId);
    var c := core__serviceInstances_serviceClass(s, a.classId);
    var late := (s.stopped || !(c.registered));
    core__serviceInstances_returnInstance(s, attemptId, instanceId) == (if late then core__serviceInstances_stopObjectOnce(instanceId, added) else core__serviceInstances_setTypeStatus(c.serviceType, core__serviceInstances_TypeStatus.TypeRegistered, core__serviceInstances_replacePublication(c.serviceType, core__serviceInstances_classInstances(added, c.serviceType), added))) &&
    added.published == s.published && added.declarations == s.declarations && |added.classes| == |s.classes| &&
    forall i :: 0 <= i < |s.classes| ==> added.classes[i] == (if ((s.classes[i].id == a.classId) && !(late)) then s.classes[i].(live := instanceId) else s.classes[i])
{
  var a := core__serviceInstances_serviceAttempt(s, attemptId);
  var late := (s.stopped || !(core__serviceInstances_serviceClass(s, a.classId).registered));
  added := (var local_18 := a; var local_20 := late; s.(objects := (if (core__serviceInstances_serviceObject(s, instanceId).id == 0) then (s.objects + [core__serviceInstances_ServiceObject(instanceId, core__serviceInstances_StopPhase.StopNotRequested, 0, false, "")]) else s.objects), attempts := (var s_map := s.attempts; seq(|s_map|, i_map requires 0 <= i_map < |s_map| => var x := s_map[i_map]; (if (x.id == attemptId) then x.(instance := instanceId, phase := (if local_20 then core__serviceInstances_AttemptPhase.StartLateStop else core__serviceInstances_AttemptPhase.StartObserver)) else x))), classes := (var s_map := s.classes; seq(|s_map|, i_map requires 0 <= i_map < |s_map| => var c := s_map[i_map]; (if ((c.id == local_18.classId) && !(local_20)) then c.(live := instanceId) else c)))));
}

lemma ReturnReach(s: PluginServices, after: PluginServices, attemptId: int, instanceId: int)
  requires alwaysLiveInstanceReachable(s) && core__serviceInstances_inv(s.services) && core__serviceInstances_canReturnInstance(s.services, attemptId, instanceId)
  requires after == s.(services := core__serviceInstances_returnInstance(s.services, attemptId, instanceId))
  requires core__serviceInstances_alwaysClassAndObjectIdentities(after.services) && core__serviceInstances_stepStopIdentityRetained(s.services, after.services)
  ensures alwaysLiveInstanceReachable(after)
{
  var sv := s.services;
  var r := after.services;
  AttemptFound(sv, attemptId);
  var a := core__serviceInstances_serviceAttempt(sv, attemptId);
  var c := core__serviceInstances_serviceClass(sv, a.classId);
  var late := sv.stopped || !c.registered;
  var added := ReturnAdded(sv, attemptId, instanceId);
  ClassFound(sv, a.classId);
  StopCallsKept(sv, r);
  PubReplaceAll();
  ClassInstancesAll();
  forall i | 0 <= i < |sv.classes| && sv.classes[i].id == a.classId
    ensures sv.classes[i] == c
  {
    assert sv.classes[i] in sv.classes;
    ClassExact(sv, sv.classes[i]);
  }
  assert r.classes == added.classes && |r.classes| == |sv.classes|;
  PubSame();
  forall t | late || t != c.serviceType ensures core__serviceInstances_publishedInstances(r, t) == core__serviceInstances_publishedInstances(sv, t)
  {
    if late {
      assert r.published == sv.published;
    } else {
      var rp := core__serviceInstances_replacePublication(c.serviceType, core__serviceInstances_classInstances(added, c.serviceType), added);
      assert r.published == rp.published;
      assert core__serviceInstances_publishedInstances(rp, t) == core__serviceInstances_publishedInstances(added, t);
    }
  }
  forall cl | cl in r.classes && cl.live != 0 && cl.registered
    ensures core__serviceInstances_serviceObject(r, cl.live).stopCalls > 0 || (cl.live in core__serviceInstances_publishedInstances(r, cl.serviceType)) ||
      (exists rr :: rr in after.retirements && (exists g :: g in rr.groups && (missingStopObservedFor(g, cl.live) || (epochOwnsResources(after, rr.epochId) && (cl.live in g.instances)))))
  {
    var i :| 0 <= i < |r.classes| && r.classes[i] == cl;
    var c0 := sv.classes[i];
    assert c0 in sv.classes;
    if !late && cl.serviceType == c.serviceType {
      var d :| d in sv.declarations && d.classId == c0.id;
      ClassExact(sv, c0);
      ClassExact(r, cl);
      assert core__serviceInstances_serviceClass(added, d.classId) == cl;
      assert cl.live in core__serviceInstances_classInstances(added, c.serviceType);
      assert core__serviceInstances_publishedInstances(r, c.serviceType) == core__serviceInstances_publishedInstances(core__serviceInstances_replacePublication(c.serviceType, core__serviceInstances_classInstances(added, c.serviceType), added), c.serviceType);
    }
  }
}

lemma PubSame()
  ensures forall x: core__serviceInstances_ServiceInstances, y: core__serviceInstances_ServiceInstances, t: string :: x.published == y.published ==> core__serviceInstances_publishedInstances(x, t) == core__serviceInstances_publishedInstances(y, t)
{
}

lemma WithdrawCover(s: PluginServices, after: PluginServices, k: int, r2: ServiceRetirement, group: RetirementGroup, xs: seq<RetireClass>, t: string, captured: seq<int>, skip: bool)
  requires alwaysNoOrphanInstance(s) && alwaysLiveInstanceReachable(s)
  requires core__serviceInstances_alwaysClassAndObjectIdentities(s.services) && core__serviceInstances_alwaysDeclarationsMatch(s.services)
  requires after.epochs == s.epochs && after.services.objects == s.services.objects
  requires 0 <= k < |s.retirements| && after.retirements == s.retirements[k := r2] && r2.groups == s.retirements[k].groups + [group] && epochOwnsResources(after, r2.epochId)
  requires group.instances == (if skip then [] else captured)
  requires |after.services.classes| == |s.services.classes|
  requires forall i :: 0 <= i < |s.services.classes| ==> after.services.classes[i] == (if (!skip && exists c :: c in xs && c.id == s.services.classes[i].id) then s.services.classes[i].(registered := false, live := 0) else s.services.classes[i])
  requires forall c :: c in xs ==> core__serviceInstances_serviceClass(s.services, c.id).serviceType == t && (core__serviceInstances_serviceClass(s.services, c.id).live == 0 || core__serviceInstances_serviceClass(s.services, c.id).live in captured)
  requires skip ==> !(exists d :: d in s.services.declarations && d.serviceType == t)
  requires forall u, x :: x in core__serviceInstances_publishedInstances(s.services, u) && u != t ==> x in core__serviceInstances_publishedInstances(after.services, u)
  requires forall x :: x in core__serviceInstances_publishedInstances(s.services, t) && !(!skip && x in captured) ==> x in core__serviceInstances_publishedInstances(after.services, t)
  requires core__serviceInstances_alwaysClassAndObjectIdentities(after.services)
  ensures alwaysNoOrphanInstance(after) && alwaysLiveInstanceReachable(after)
{
  assert after.retirements[k] == r2 && group in r2.groups;
  ObjSame();
  forall cl | cl in after.services.classes && cl.live != 0 && cl.registered
    ensures core__serviceInstances_serviceObject(after.services, cl.live).stopCalls > 0 || (cl.live in core__serviceInstances_publishedInstances(after.services, cl.serviceType)) ||
      (exists rr :: rr in after.retirements && (exists g :: g in rr.groups && (missingStopObservedFor(g, cl.live) || (epochOwnsResources(after, rr.epochId) && (cl.live in g.instances)))))
  {
    var i :| 0 <= i < |after.services.classes| && after.services.classes[i] == cl;
    var c0 := s.services.classes[i];
    assert c0 in s.services.classes && c0 == cl;
    if core__serviceInstances_serviceObject(s.services, c0.live).stopCalls > 0 {
      assert core__serviceInstances_serviceObject(after.services, cl.live).stopCalls > 0;
    } else if c0.live in core__serviceInstances_publishedInstances(s.services, c0.serviceType) {
      if !skip && c0.serviceType == t && c0.live in captured {
        assert r2 in after.retirements && group in r2.groups && epochOwnsResources(after, r2.epochId) && cl.live in group.instances;
      } else {
        if c0.serviceType == t {
          assert c0.live in core__serviceInstances_publishedInstances(s.services, t);
        }
        assert cl.live in core__serviceInstances_publishedInstances(after.services, cl.serviceType);
      }
    } else {
      var rr, g :| rr in s.retirements && g in rr.groups && (missingStopObservedFor(g, c0.live) || (epochOwnsResources(s, rr.epochId) && (c0.live in g.instances)));
      var j :| 0 <= j < |s.retirements| && s.retirements[j] == rr;
      if j == k {
        assert r2 in after.retirements && g in r2.groups;
        assert missingStopObservedFor(g, cl.live) || (epochOwnsResources(after, r2.epochId) && (cl.live in g.instances));
      } else {
        assert after.retirements[j] == rr;
        assert epoch(after, rr.epochId) == epoch(s, rr.epochId);
        assert missingStopObservedFor(g, cl.live) || (epochOwnsResources(after, rr.epochId) && (cl.live in g.instances));
      }
    }
  }
  forall o | o in after.services.objects
    ensures (o.stopCalls > 0) || (exists cl :: cl in after.services.classes && cl.live == o.id && cl.registered) ||
      (exists rr :: rr in after.retirements && (exists g :: g in rr.groups && (missingStopObservedFor(g, o.id) || (epochOwnsResources(after, rr.epochId) && (o.id in g.instances)))))
  {
    if exists cl :: cl in s.services.classes && cl.live == o.id && cl.registered {
      var cl :| cl in s.services.classes && cl.live == o.id && cl.registered;
      var i :| 0 <= i < |s.services.classes| && s.services.classes[i] == cl;
      if !skip && exists x :: x in xs && x.id == cl.id {
        var x :| x in xs && x.id == cl.id;
        ClassExact(s.services, cl);
        assert o.id in group.instances;
      } else if skip && exists x :: x in xs && x.id == cl.id {
        assert after.services.classes[i] == cl;
      } else {
        assert after.services.classes[i] == cl;
      }
    } else if o.stopCalls <= 0 {
      var rr, g :| rr in s.retirements && g in rr.groups && (missingStopObservedFor(g, o.id) || (epochOwnsResources(s, rr.epochId) && (o.id in g.instances)));
      var j :| 0 <= j < |s.retirements| && s.retirements[j] == rr;
      if j == k { assert g in r2.groups; } else { assert after.retirements[j] == rr; }
    }
  }
  OrphanFromReach(after);
}

lemma StopOrphans(s: PluginServices, after: PluginServices)
  requires alwaysNoOrphanInstance(s) && alwaysLiveInstanceReachable(s)
  requires core__serviceInstances_alwaysClassAndObjectIdentities(s.services) && core__serviceInstances_alwaysObjectStopOnce(after.services)
  requires after.epochs == s.epochs && after.retirements == s.retirements
  requires |after.services.objects| == |s.services.objects|
  requires forall i :: 0 <= i < |s.services.objects| ==> (after.services.objects[i].id == s.services.objects[i].id &&
    (s.services.objects[i].stopCalls > 0 ==> after.services.objects[i].stopCalls > 0) &&
    ((exists p :: p in s.services.published && s.services.objects[i].id in p.instances) ==> !after.services.objects[i].stopPhase.StopNotRequested?))
  ensures alwaysNoOrphanInstance(after)
{
  forall o | o in after.services.objects
    ensures (o.stopCalls > 0) || (exists cl :: cl in after.services.classes && cl.live == o.id && cl.registered) ||
      (exists rr :: rr in after.retirements && (exists g :: g in rr.groups && (missingStopObservedFor(g, o.id) || (epochOwnsResources(after, rr.epochId) && (o.id in g.instances)))))
  {
    var i :| 0 <= i < |after.services.objects| && after.services.objects[i] == o;
    var o0 := s.services.objects[i];
    assert o0 in s.services.objects;
    if exists cl :: cl in s.services.classes && cl.live == o0.id && cl.registered {
      var cl :| cl in s.services.classes && cl.live == o0.id && cl.registered;
      ObjectExact(s.services, o0);
      if o0.id in core__serviceInstances_publishedInstances(s.services, cl.serviceType) {
        PubFound(s.services, cl.serviceType);
        var q :| q in s.services.published && q.serviceType == cl.serviceType && q.instances == core__serviceInstances_publishedInstances(s.services, cl.serviceType);
        assert !o.stopPhase.StopNotRequested?;
      }
    }
  }
}

lemma WithdrawUndeclared(s: PluginServices, after: PluginServices, k: int, r2: ServiceRetirement, group: RetirementGroup, t: string, skip: bool)
  requires alwaysRetiredUndeclaredTypeIsUnknown(s)
  requires after.services.stopped == s.services.stopped && after.services.typeEntries == s.services.typeEntries
  requires forall d :: d in s.services.declarations && d.serviceType != t ==> d in after.services.declarations
  requires skip ==> after.services.declarations == s.services.declarations
  requires 0 <= k < |s.retirements| && after.retirements == s.retirements[k := r2] && r2.groups == s.retirements[k].groups + [group]
  requires group.serviceType == t && group.phase == (if skip then RetirementGroupPhase.GroupSkipped else RetirementGroupPhase.GroupWaiting)
  ensures alwaysRetiredUndeclaredTypeIsUnknown(after)
{
  var r := s.retirements[k];
  if !after.services.stopped {
    forall rr, gg | rr in after.retirements && gg in rr.groups && !gg.phase.GroupWaiting? && !gg.phase.GroupSkipped? &&
      !(exists d :: d in after.services.declarations && d.serviceType == gg.serviceType) &&
      !(exists other :: other in after.retirements && (exists pending :: pending in other.groups && pending.serviceType == gg.serviceType && pending.phase.GroupWaiting?))
      ensures core__serviceInstances_serviceTypeEntry(after.services, gg.serviceType).status.TypeUnknown?
    {
      var i :| 0 <= i < |after.retirements| && after.retirements[i] == rr;
      assert gg != group;
      if i == k { assert gg in r.groups; } else { assert s.retirements[i] == rr; }
      assert s.retirements[i] in s.retirements;
      if !skip {
        assert after.retirements[k] == r2 && group in r2.groups;
        assert gg.serviceType != t;
      }
      forall other, pending | other in s.retirements && pending in other.groups && pending.serviceType == gg.serviceType && pending.phase.GroupWaiting?
        ensures false
      {
        var i2 :| 0 <= i2 < |s.retirements| && s.retirements[i2] == other;
        if i2 == k { assert pending in r2.groups; } else { assert after.retirements[i2] == other; }
      }
    }
  }
}

lemma ObjSame()
  ensures forall x: core__serviceInstances_ServiceInstances, y: core__serviceInstances_ServiceInstances, id: int :: x.objects == y.objects ==> core__serviceInstances_serviceObject(x, id) == core__serviceInstances_serviceObject(y, id)
{
}

lemma lawDisposalKeepsOtherCapturedOwners_ensures(s: PluginServices, epochId: int, otherId: int, ok: bool, publication: ConnectorPublication)
  ensures (lawDisposalKeepsOtherCapturedOwners(s, epochId, otherId, ok, publication) == true)
{
  if alwaysEpochIdentityUnique(s) && epochId != otherId {
    var after := disposePlugin(s, epochId, ok);
    PluginEpochMapIdentity(s, after);
    EpochIdLookup(s, otherId);
    EpochIdLookup(after, otherId);
    if e :| e in s.epochs && e.id == otherId {
      var i :| 0 <= i < |s.epochs| && s.epochs[i] == e;
      assert after.epochs[i] == e;
      PluginEpochExact(s, e);
      PluginEpochExact(after, e);
    } else if e :| e in after.epochs && e.id == otherId {
      var i :| 0 <= i < |after.epochs| && after.epochs[i] == e;
      assert s.epochs[i] in s.epochs;
    }
  }
}

lemma lawDisposeContinuationBlocksItsCapturedOwner_ensures(s: PluginServices, epochId: int, ok: bool, publication: ConnectorPublication)
  ensures (lawDisposeContinuationBlocksItsCapturedOwner(s, epochId, ok, publication) == true)
{
  if alwaysEpochIdentityUnique(s) && epochId > 0 && canDisposePlugin(s, epochId, ok) {
    var after := disposePlugin(s, epochId, ok);
    PluginEpochMapIdentity(s, after);
    EpochIdLookup(s, epochId);
    EpochIdLookup(after, epochId);
    if e :| e in s.epochs && e.id == epochId {
      var i :| 0 <= i < |s.epochs| && s.epochs[i] == e;
      assert after.epochs[i] in after.epochs;
    }
  }
}

lemma OrphanFromReach(s: PluginServices)
  requires alwaysLiveInstanceReachable(s) && core__serviceInstances_alwaysClassAndObjectIdentities(s.services)
  requires forall o :: o in s.services.objects ==> ((o.stopCalls > 0) || (exists cl :: cl in s.services.classes && cl.live == o.id && cl.registered) ||
    (exists rr :: rr in s.retirements && (exists g :: g in rr.groups && (missingStopObservedFor(g, o.id) || (epochOwnsResources(s, rr.epochId) && (o.id in g.instances))))))
  ensures alwaysNoOrphanInstance(s)
{
  forall o | o in s.services.objects && !(o.stopCalls > 0) && (exists cl :: cl in s.services.classes && cl.live == o.id && cl.registered) &&
    !(exists rr :: rr in s.retirements && (exists g :: g in rr.groups && (missingStopObservedFor(g, o.id) || (epochOwnsResources(s, rr.epochId) && (o.id in g.instances)))))
    ensures exists p :: p in s.services.published && o.id in p.instances
  {
    var cl :| cl in s.services.classes && cl.live == o.id && cl.registered;
    ObjectExact(s.services, o);
    PubFound(s.services, cl.serviceType);
  }
}

lemma ClaimSetup(s: PluginServices, epochId: int) returns (k: int, r2: ServiceRetirement, g2: RetirementGroup)
  requires inv(s) && canClaimInstanceStop(s, epochId)
  ensures 0 <= k < |s.retirements| && s.retirements[k].epochId == epochId
  ensures 0 <= s.retirements[k].cursor < |s.retirements[k].groups| == s.retirements[k].cursor + 1 && retirementShaped(s.retirements[k])
  ensures currentGroup(s, epochId) == s.retirements[k].groups[s.retirements[k].cursor]
  ensures g2 == s.retirements[k].groups[s.retirements[k].cursor].(observedStops := (s.retirements[k].groups[s.retirements[k].cursor].observedStops + [observedInstanceSlot(currentInstance(s, epochId), InstanceStopObservation.AwaitedStopSlot)]))
  ensures r2 == s.retirements[k].(groups := s.retirements[k].groups[s.retirements[k].cursor := g2])
  ensures claimInstanceStop(s, epochId) == s.(services := core__serviceInstances_requestObjectStop(s.services, currentInstance(s, epochId)), retirements := s.retirements[k := r2])
{
  k := CurrentAt(s, epochId);
  var r := s.retirements[k];
  var g := r.groups[r.cursor];
  assert g in r.groups && r in s.retirements;
  var id := currentInstance(s, epochId);
  g2 := g.(observedStops := (g.observedStops + [observedInstanceSlot(id, InstanceStopObservation.AwaitedStopSlot)]));
  var s1 := s.(services := core__serviceInstances_stopObjectOnce(id, s.services));
  GroupsDistinct(r);
  PutAt(s1, epochId, g2, k);
  r2 := r.(groups := r.groups[r.cursor := g2]);
  var after := claimInstanceStop(s, epochId);
  assert after == s1.(retirements := s.retirements[k := r2]);
  ObjectFound(s.services, id);
  core__serviceInstances_requestObjectStop_ensures(s.services, id);
  assert after.services == core__serviceInstances_requestObjectStop(s.services, id);
}

lemma ClaimKeepsEpochs(s: PluginServices, epochId: int)
  requires inv(s) && canClaimInstanceStop(s, epochId)
  ensures alwaysEpochIdentityUnique(claimInstanceStop(s, epochId)) && alwaysOneActiveEpochPerName(claimInstanceStop(s, epochId)) && alwaysEpochOutcomeHonest(claimInstanceStop(s, epochId))
  ensures alwaysLiveClassOwnerUnique(claimInstanceStop(s, epochId)) && alwaysInvokingStartHasNoInstance(claimInstanceStop(s, epochId))
  ensures alwaysServiceOwnerEpochExists(claimInstanceStop(s, epochId)) && alwaysSealedOwnedClassesStable(claimInstanceStop(s, epochId))
{
  var k, r2, g2 := ClaimSetup(s, epochId);
  var id := currentInstance(s, epochId);
  ObjectFound(s.services, id);
  core__serviceInstances_requestObjectStop_ensures(s.services, id);
}

lemma ClaimKeepsRetirements(s: PluginServices, epochId: int)
  requires inv(s) && canClaimInstanceStop(s, epochId)
  ensures alwaysRetirementPerRetiredEpoch(claimInstanceStop(s, epochId)) && alwaysRetirementFollowsPlan(claimInstanceStop(s, epochId)) && alwaysRetiredEpochHasNoResources(claimInstanceStop(s, epochId))
{
  var k, r2, g2 := ClaimSetup(s, epochId);
  var r := s.retirements[k];
  var after := claimInstanceStop(s, epochId);
  var id := currentInstance(s, epochId);
  ObjectFound(s.services, id);
  core__serviceInstances_requestObjectStop_ensures(s.services, id);
  SettledKept(s.services, after.services);
  UAt(s, after, k, r2);
  ShapeReplaceCurrent(r, r2, g2);
  ShapeAt(s, after, k, r2);
  OwnsOpen(s, k);
  NoResourcesAt(s, after, k, r2);
}

lemma ClaimKeepsServices(s: PluginServices, epochId: int)
  requires inv(s) && canClaimInstanceStop(s, epochId)
  ensures alwaysChildLifecyclesValid(claimInstanceStop(s, epochId)) && alwaysOwnedClassesMatchServices(claimInstanceStop(s, epochId)) && alwaysStopObservationsFollowSlots(claimInstanceStop(s, epochId))
{
  var k, r2, g2 := ClaimSetup(s, epochId);
  var r := s.retirements[k];
  var g := r.groups[r.cursor];
  assert g in r.groups && r in s.retirements;
  var after := claimInstanceStop(s, epochId);
  var id := currentInstance(s, epochId);
  ObjectFound(s.services, id);
  core__serviceInstances_requestObjectStop_ensures(s.services, id);
  ChildInv(after);
  SettledKept(s.services, after.services);
  StopsValid(g2, after.services);
  StopsValid(g, s.services);
  SlotsAtGroup(s, after, k, r.cursor, g2, r2);
  ClassShape(s, after);
}

lemma ClaimKeepsInstances(s: PluginServices, epochId: int)
  requires inv(s) && canClaimInstanceStop(s, epochId)
  ensures alwaysNoOrphanInstance(claimInstanceStop(s, epochId)) && alwaysLiveInstanceReachable(claimInstanceStop(s, epochId)) && alwaysRetiredUndeclaredTypeIsUnknown(claimInstanceStop(s, epochId))
{
  var k, r2, g2 := ClaimSetup(s, epochId);
  var r := s.retirements[k];
  var after := claimInstanceStop(s, epochId);
  var id := currentInstance(s, epochId);
  ObjectFound(s.services, id);
  core__serviceInstances_requestObjectStop_ensures(s.services, id);
  OrphanAt(s, after, k, r.cursor, g2, r2);
  ReachAt(s, after, k, r.cursor, g2, r2);
  UndeclaredAt(s, after, k, r.cursor, g2, r2);
}
