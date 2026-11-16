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
        core__plugins_alwaysServiceStopsOnce(item.lifecycle)
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
        core__plugins_alwaysServiceStopsOnce(item.lifecycle)
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
        core__plugins_alwaysServiceStopsOnce(item.lifecycle)
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
        core__plugins_alwaysServiceStopsOnce(item.lifecycle)
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
        core__plugins_alwaysServiceStopsOnce(item.lifecycle)
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
        core__plugins_alwaysServiceStopsOnce(item.lifecycle)
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
