lemma WorkIdentityFilters(s: ProviderState)
  ensures alwaysExecutionIdentitiesUnique(s) == (s.nextId > 0 && (forall w :: w in s.works ==> w.id > 0 && w.id < s.nextId && |ProofLib.Filter((x: ProviderWork) => (x.id == w.id), s.works)| == 1))
{}

lemma CallerIdentityFilters(s: ProviderState)
  ensures alwaysCallersOwnExistingWork(s) == (forall c :: c in s.callers ==> c.id > 0 && |ProofLib.Filter((x: ProviderCaller) => (x.id == c.id), s.callers)| == 1 && (exists w :: w in s.works && w.id == c.workId))
{}

lemma ProviderWorkLookup(s: ProviderState, workId: int)
  ensures providerWork(s, workId) == (var matches := ProofLib.Filter((w: ProviderWork) => (w.id == workId), s.works); if |matches| > 0 then matches[0] else absentWork)
{}

lemma FindProviderWork(s: ProviderState, workId: int)
  requires alwaysExecutionIdentitiesUnique(s)
  ensures providerWork(s, workId).id != 0 ==> providerWork(s, workId) in s.works && providerWork(s, workId).id == workId
  ensures forall w :: w in s.works && w.id == workId ==> w == providerWork(s, workId)
{
  ProviderWorkLookup(s, workId); WorkIdentityFilters(s);
  var matches := ProofLib.Filter((w: ProviderWork) => (w.id == workId), s.works);
  if |matches| > 0 {
    var selected := matches[0];
    ProofLib.FilterMember((w: ProviderWork) => (w.id == workId), s.works, selected);
    ProofLib.FilterSamePredicate((w: ProviderWork) => (w.id == workId), (x: ProviderWork) => (x.id == selected.id), s.works);
    assert |matches| == 1;
    forall w | w in s.works && w.id == workId ensures w == selected
    { ProofLib.FilterMember((w: ProviderWork) => (w.id == workId), s.works, w); }
  } else {
    forall w | w in s.works && w.id == workId ensures w == providerWork(s, workId)
    { ProofLib.FilterMember((w: ProviderWork) => (w.id == workId), s.works, w); }
  }
}

lemma ProviderProgress(s: ProviderState)
  requires alwaysExecutionIdentitiesUnique(s) && alwaysCallersOwnExistingWork(s) && alwaysCreatedWorkHasStarted(s)
  ensures alwaysProviderDeadlockFree(s)
{
  if exists w :: w in s.works && !w.phase.WorkCleaned? {
    var w :| w in s.works && !w.phase.WorkCleaned?;
    FindProviderWork(s, w.id);
    assert providerWork(s, w.id) == w;
    assert canInvokeWork(s, w.id) || canSettleWork(s, w.id) || canCleanWork(s, w.id);
  } else if |s.callers| > 0 {
    var c := s.callers[0];
    assert c in s.callers;
    CallerIdentityFilters(s);
    assert exists w :: w in s.works && w.id == c.workId;
    var w :| w in s.works && w.id == c.workId;
    FindProviderWork(s, c.workId);
    assert providerWork(s, c.workId) == w && w.phase.WorkCleaned?;
    assert canReceiveResult(s, c.id);
  }
}

lemma MapProviderWorks(s: ProviderState, after: ProviderState)
  requires alwaysExecutionIdentitiesUnique(s)
  requires |after.works| == |s.works| && after.nextId == s.nextId
  requires forall i :: 0 <= i < |s.works| ==> after.works[i].id == s.works[i].id
  ensures alwaysExecutionIdentitiesUnique(after)
  ensures forall w :: w in s.works ==> exists a :: a in after.works && a.id == w.id
{
  WorkIdentityFilters(s); WorkIdentityFilters(after);
  forall w | w in after.works
    ensures w.id > 0 && w.id < after.nextId && |ProofLib.Filter((x: ProviderWork) => (x.id == w.id), after.works)| == 1
  {
    var i :| 0 <= i < |after.works| && after.works[i] == w;
    ProofLib.FilterLengthPointwise((x: ProviderWork) => (x.id == w.id), (x: ProviderWork) => (x.id == w.id), s.works, after.works);
  }
  forall w | w in s.works ensures exists a :: a in after.works && a.id == w.id
  {
    var i :| 0 <= i < |s.works| && s.works[i] == w;
    assert after.works[i] in after.works;
  }
}

lemma KeepProviderCallers(s: ProviderState, after: ProviderState)
  requires alwaysCallersOwnExistingWork(s)
  requires s.callers == after.callers
  requires forall w :: w in s.works ==> exists a :: a in after.works && a.id == w.id
  ensures alwaysCallersOwnExistingWork(after)
{
  CallerIdentityFilters(s); CallerIdentityFilters(after);
  forall c | c in after.callers ensures exists a :: a in after.works && a.id == c.workId
  { var w :| w in s.works && w.id == c.workId; }
}

lemma MapProviderAbort(s: ProviderState, after: ProviderState)
  requires |after.works| == |s.works|
  requires forall i :: 0 <= i < |s.works| ==> after.works[i].id == s.works[i].id && (!s.works[i].invoked && !s.works[i].cause.NoAbort? ==> !after.works[i].invoked)
  ensures stepAbortedWorkCannotStart(s, after)
{
  forall w | w in s.works && !w.invoked && !w.cause.NoAbort?
    ensures exists a :: a in after.works && a.id == w.id && !a.invoked
  {
    var i :| 0 <= i < |s.works| && s.works[i] == w;
    assert after.works[i] in after.works;
  }
}

lemma MapProviderLifecycle(s: ProviderState, after: ProviderState)
  requires alwaysUnwantedWorkAborted(s) && alwaysWaiterAbortHasNoCallers(s)
  requires alwaysStopReachesEveryExecution(s) && alwaysCleanedWorkIsInactive(s) && alwaysCreatedWorkHasStarted(s)
  requires s.callers == after.callers && s.stopping == after.stopping
  requires |s.works| == |after.works|
  requires forall i :: 0 <= i < |s.works| ==>
    (s.works[i].id == after.works[i].id && s.works[i].cause == after.works[i].cause &&
      (after.works[i].phase.Working? ==> s.works[i].phase.Working?) &&
      !after.works[i].phase.Dormant? &&
      (after.works[i].phase.WorkCleaned? ==> !after.works[i].active))
  ensures alwaysUnwantedWorkAborted(after) && alwaysWaiterAbortHasNoCallers(after)
  ensures alwaysStopReachesEveryExecution(after) && alwaysCleanedWorkIsInactive(after) && alwaysCreatedWorkHasStarted(after)
{
  forall w | w in after.works
    ensures (!w.phase.Dormant? &&
      (w.phase.WorkCleaned? ==> !w.active) &&
      (after.stopping && w.phase.Working? ==> !w.cause.NoAbort?) &&
      (w.phase.Working? && w.cause.NoAbort? ==> (exists c :: c in after.callers && c.workId == w.id)) &&
      (w.cause.LastWaiter? ==> !(exists c :: c in after.callers && c.workId == w.id)))
  {
    var i :| 0 <= i < |after.works| && after.works[i] == w;
    var prior := s.works[i];
    assert prior in s.works;
  }
}

lemma MapProviderKeepsKey(s: ProviderState, after: ProviderState)
  requires alwaysKeyedWorkCanBeJoined(s) && alwaysExecutionIdentitiesUnique(s) && alwaysExecutionIdentitiesUnique(after)
  requires after.keyedId == 0 || after.keyedId == s.keyedId
  requires |s.works| == |after.works|
  requires forall i :: 0 <= i < |s.works| && s.works[i].id == after.keyedId ==>
    (after.works[i].id == s.works[i].id && !after.works[i].phase.WorkCleaned? && after.works[i].active && after.works[i].cause.NoAbort?)
  ensures alwaysKeyedWorkCanBeJoined(after)
{
  if after.keyedId != 0 {
    FindProviderWork(s, s.keyedId);
    var w := providerWork(s, s.keyedId);
    var i :| 0 <= i < |s.works| && s.works[i] == w;
    assert after.works[i] in after.works;
    FindProviderWork(after, after.keyedId);
    assert providerWork(after, after.keyedId) == after.works[i];
  }
}

lemma ProviderCallersFilter(s: ProviderState, after: ProviderState, caller: int)
  requires alwaysCallersOwnExistingWork(s)
  requires after.callers == ProofLib.Filter((c: ProviderCaller) => (c.id != caller), s.callers)
  requires forall w :: w in s.works ==> exists a :: a in after.works && a.id == w.id
  ensures alwaysCallersOwnExistingWork(after)
  ensures forall c :: c in after.callers ==> c in s.callers && c.id != caller
{
  CallerIdentityFilters(s); CallerIdentityFilters(after);
  forall c | c in after.callers
    ensures c in s.callers && c.id != caller && c.id > 0 && |ProofLib.Filter((x: ProviderCaller) => (x.id == c.id), after.callers)| == 1 && (exists w :: w in after.works && w.id == c.workId)
  {
    ProofLib.FilterMember((c: ProviderCaller) => (c.id != caller), s.callers, c);
    ProofLib.FilterOfFilterShorter((c: ProviderCaller) => (c.id != caller), (x: ProviderCaller) => (x.id == c.id), s.callers);
    ProofLib.FilterMember((x: ProviderCaller) => (x.id == c.id), after.callers, c);
    var w :| w in s.works && w.id == c.workId;
  }
}

lemma invokeWork_ensures(s: ProviderState, workId: int)
  ensures (inv(s) ==> canInvokeWork(s, workId) ==> alwaysExecutionIdentitiesUnique(invokeWork(s, workId)))
  ensures (inv(s) ==> canInvokeWork(s, workId) ==> alwaysCallersOwnExistingWork(invokeWork(s, workId)))
  ensures (inv(s) ==> canInvokeWork(s, workId) ==> alwaysKeyedWorkCanBeJoined(invokeWork(s, workId)))
  ensures (inv(s) ==> canInvokeWork(s, workId) ==> alwaysUnwantedWorkAborted(invokeWork(s, workId)))
  ensures (inv(s) ==> canInvokeWork(s, workId) ==> alwaysWaiterAbortHasNoCallers(invokeWork(s, workId)))
  ensures (inv(s) ==> canInvokeWork(s, workId) ==> alwaysStopReachesEveryExecution(invokeWork(s, workId)))
  ensures (inv(s) ==> canInvokeWork(s, workId) ==> alwaysCleanedWorkIsInactive(invokeWork(s, workId)))
  ensures (inv(s) ==> canInvokeWork(s, workId) ==> alwaysCreatedWorkHasStarted(invokeWork(s, workId)))
  ensures (inv(s) ==> canInvokeWork(s, workId) ==> alwaysProviderDeadlockFree(invokeWork(s, workId)))
  ensures (inv(s) ==> canInvokeWork(s, workId) ==> stepAbortedWorkCannotStart(s, invokeWork(s, workId)))
{
  if inv(s) && canInvokeWork(s, workId) {
    var after := invokeWork(s, workId);
    FindProviderWork(s, workId);
    MapProviderWorks(s, after); KeepProviderCallers(s, after);
    MapProviderAbort(s, after);
    assert forall i :: 0 <= i < |s.works| && s.works[i].id == after.keyedId ==>
      (after.works[i].id == s.works[i].id && !after.works[i].phase.WorkCleaned? && after.works[i].active && after.works[i].cause.NoAbort?) by {
      forall i | 0 <= i < |s.works| && s.works[i].id == after.keyedId
        ensures after.works[i].id == s.works[i].id && !after.works[i].phase.WorkCleaned? && after.works[i].active && after.works[i].cause.NoAbort?
      {
        var prior := s.works[i];
        assert prior in s.works && prior.id > 0;
        assert prior.id == s.keyedId;
        FindProviderWork(s, prior.id);
        assert prior == providerWork(s, s.keyedId);
      }
    }
    MapProviderKeepsKey(s, after);
    MapProviderLifecycle(s, after);
    ProviderProgress(after);
  }
}

lemma settleWork_ensures(s: ProviderState, workId: int)
  ensures (inv(s) ==> canSettleWork(s, workId) ==> alwaysExecutionIdentitiesUnique(settleWork(s, workId)))
  ensures (inv(s) ==> canSettleWork(s, workId) ==> alwaysCallersOwnExistingWork(settleWork(s, workId)))
  ensures (inv(s) ==> canSettleWork(s, workId) ==> alwaysKeyedWorkCanBeJoined(settleWork(s, workId)))
  ensures (inv(s) ==> canSettleWork(s, workId) ==> alwaysUnwantedWorkAborted(settleWork(s, workId)))
  ensures (inv(s) ==> canSettleWork(s, workId) ==> alwaysWaiterAbortHasNoCallers(settleWork(s, workId)))
  ensures (inv(s) ==> canSettleWork(s, workId) ==> alwaysStopReachesEveryExecution(settleWork(s, workId)))
  ensures (inv(s) ==> canSettleWork(s, workId) ==> alwaysCleanedWorkIsInactive(settleWork(s, workId)))
  ensures (inv(s) ==> canSettleWork(s, workId) ==> alwaysCreatedWorkHasStarted(settleWork(s, workId)))
  ensures (inv(s) ==> canSettleWork(s, workId) ==> alwaysProviderDeadlockFree(settleWork(s, workId)))
  ensures (inv(s) ==> canSettleWork(s, workId) ==> stepAbortedWorkCannotStart(s, settleWork(s, workId)))
{
  if inv(s) && canSettleWork(s, workId) {
    var after := settleWork(s, workId);
    FindProviderWork(s, workId);
    MapProviderWorks(s, after); KeepProviderCallers(s, after);
    MapProviderAbort(s, after);
    assert forall i :: 0 <= i < |s.works| && s.works[i].id == after.keyedId ==>
      (after.works[i].id == s.works[i].id && !after.works[i].phase.WorkCleaned? && after.works[i].active && after.works[i].cause.NoAbort?) by {
      forall i | 0 <= i < |s.works| && s.works[i].id == after.keyedId
        ensures after.works[i].id == s.works[i].id && !after.works[i].phase.WorkCleaned? && after.works[i].active && after.works[i].cause.NoAbort?
      {
        var prior := s.works[i];
        assert prior in s.works && prior.id > 0;
        assert prior.id == s.keyedId;
        FindProviderWork(s, prior.id);
        assert prior == providerWork(s, s.keyedId);
      }
    }
    MapProviderKeepsKey(s, after);
    MapProviderLifecycle(s, after);
    ProviderProgress(after);
  }
}

lemma cleanWork_ensures(s: ProviderState, workId: int)
  ensures (inv(s) ==> canCleanWork(s, workId) ==> alwaysExecutionIdentitiesUnique(cleanWork(s, workId)))
  ensures (inv(s) ==> canCleanWork(s, workId) ==> alwaysCallersOwnExistingWork(cleanWork(s, workId)))
  ensures (inv(s) ==> canCleanWork(s, workId) ==> alwaysKeyedWorkCanBeJoined(cleanWork(s, workId)))
  ensures (inv(s) ==> canCleanWork(s, workId) ==> alwaysUnwantedWorkAborted(cleanWork(s, workId)))
  ensures (inv(s) ==> canCleanWork(s, workId) ==> alwaysWaiterAbortHasNoCallers(cleanWork(s, workId)))
  ensures (inv(s) ==> canCleanWork(s, workId) ==> alwaysStopReachesEveryExecution(cleanWork(s, workId)))
  ensures (inv(s) ==> canCleanWork(s, workId) ==> alwaysCleanedWorkIsInactive(cleanWork(s, workId)))
  ensures (inv(s) ==> canCleanWork(s, workId) ==> alwaysCreatedWorkHasStarted(cleanWork(s, workId)))
  ensures (inv(s) ==> canCleanWork(s, workId) ==> alwaysProviderDeadlockFree(cleanWork(s, workId)))
  ensures (inv(s) ==> canCleanWork(s, workId) ==> stepAbortedWorkCannotStart(s, cleanWork(s, workId)))
{
  if inv(s) && canCleanWork(s, workId) {
    var after := cleanWork(s, workId);
    FindProviderWork(s, workId);
    MapProviderWorks(s, after); KeepProviderCallers(s, after);
    MapProviderAbort(s, after);
    assert forall i :: 0 <= i < |s.works| && s.works[i].id == after.keyedId ==>
      (after.works[i].id == s.works[i].id && !after.works[i].phase.WorkCleaned? && after.works[i].active && after.works[i].cause.NoAbort?) by {
      forall i | 0 <= i < |s.works| && s.works[i].id == after.keyedId
        ensures after.works[i].id == s.works[i].id && !after.works[i].phase.WorkCleaned? && after.works[i].active && after.works[i].cause.NoAbort?
      {
        var prior := s.works[i];
        assert prior in s.works && prior.id > 0;
        assert prior.id == s.keyedId && prior.id != workId;
        FindProviderWork(s, prior.id);
        assert prior == providerWork(s, s.keyedId);
      }
    }
    MapProviderKeepsKey(s, after);
    MapProviderLifecycle(s, after);
    ProviderProgress(after);
  }
}

lemma stopProviders_ensures(s: ProviderState)
  ensures (inv(s) ==> canStopProviders(s) ==> alwaysExecutionIdentitiesUnique(stopProviders(s)))
  ensures (inv(s) ==> canStopProviders(s) ==> alwaysCallersOwnExistingWork(stopProviders(s)))
  ensures (inv(s) ==> canStopProviders(s) ==> alwaysKeyedWorkCanBeJoined(stopProviders(s)))
  ensures (inv(s) ==> canStopProviders(s) ==> alwaysUnwantedWorkAborted(stopProviders(s)))
  ensures (inv(s) ==> canStopProviders(s) ==> alwaysWaiterAbortHasNoCallers(stopProviders(s)))
  ensures (inv(s) ==> canStopProviders(s) ==> alwaysStopReachesEveryExecution(stopProviders(s)))
  ensures (inv(s) ==> canStopProviders(s) ==> alwaysCleanedWorkIsInactive(stopProviders(s)))
  ensures (inv(s) ==> canStopProviders(s) ==> alwaysCreatedWorkHasStarted(stopProviders(s)))
  ensures (inv(s) ==> canStopProviders(s) ==> alwaysProviderDeadlockFree(stopProviders(s)))
  ensures (inv(s) ==> canStopProviders(s) ==> stepAbortedWorkCannotStart(s, stopProviders(s)))
{
  if inv(s) && canStopProviders(s) {
    var after := stopProviders(s);
    MapProviderWorks(s, after); KeepProviderCallers(s, after);
    MapProviderAbort(s, after); ProviderProgress(after);
  }
}

lemma invokeNextWork_ensures(s: ProviderState)
  ensures (inv(s) ==> canInvokeNextWork(s) ==> alwaysExecutionIdentitiesUnique(invokeNextWork(s)))
  ensures (inv(s) ==> canInvokeNextWork(s) ==> alwaysCallersOwnExistingWork(invokeNextWork(s)))
  ensures (inv(s) ==> canInvokeNextWork(s) ==> alwaysKeyedWorkCanBeJoined(invokeNextWork(s)))
  ensures (inv(s) ==> canInvokeNextWork(s) ==> alwaysUnwantedWorkAborted(invokeNextWork(s)))
  ensures (inv(s) ==> canInvokeNextWork(s) ==> alwaysWaiterAbortHasNoCallers(invokeNextWork(s)))
  ensures (inv(s) ==> canInvokeNextWork(s) ==> alwaysStopReachesEveryExecution(invokeNextWork(s)))
  ensures (inv(s) ==> canInvokeNextWork(s) ==> alwaysCleanedWorkIsInactive(invokeNextWork(s)))
  ensures (inv(s) ==> canInvokeNextWork(s) ==> alwaysCreatedWorkHasStarted(invokeNextWork(s)))
  ensures (inv(s) ==> canInvokeNextWork(s) ==> alwaysProviderDeadlockFree(invokeNextWork(s)))
  ensures (inv(s) ==> canInvokeNextWork(s) ==> stepAbortedWorkCannotStart(s, invokeNextWork(s)))
{
  if inv(s) && canInvokeNextWork(s) { invokeWork_ensures(s, nextInvokableWork(s).id); }
}

lemma settleNextWork_ensures(s: ProviderState)
  ensures (inv(s) ==> canSettleNextWork(s) ==> alwaysExecutionIdentitiesUnique(settleNextWork(s)))
  ensures (inv(s) ==> canSettleNextWork(s) ==> alwaysCallersOwnExistingWork(settleNextWork(s)))
  ensures (inv(s) ==> canSettleNextWork(s) ==> alwaysKeyedWorkCanBeJoined(settleNextWork(s)))
  ensures (inv(s) ==> canSettleNextWork(s) ==> alwaysUnwantedWorkAborted(settleNextWork(s)))
  ensures (inv(s) ==> canSettleNextWork(s) ==> alwaysWaiterAbortHasNoCallers(settleNextWork(s)))
  ensures (inv(s) ==> canSettleNextWork(s) ==> alwaysStopReachesEveryExecution(settleNextWork(s)))
  ensures (inv(s) ==> canSettleNextWork(s) ==> alwaysCleanedWorkIsInactive(settleNextWork(s)))
  ensures (inv(s) ==> canSettleNextWork(s) ==> alwaysCreatedWorkHasStarted(settleNextWork(s)))
  ensures (inv(s) ==> canSettleNextWork(s) ==> alwaysProviderDeadlockFree(settleNextWork(s)))
  ensures (inv(s) ==> canSettleNextWork(s) ==> stepAbortedWorkCannotStart(s, settleNextWork(s)))
{
  if inv(s) && canSettleNextWork(s) { settleWork_ensures(s, nextSettleableWork(s).id); }
}

lemma cleanNextWork_ensures(s: ProviderState)
  ensures (inv(s) ==> canCleanNextWork(s) ==> alwaysExecutionIdentitiesUnique(cleanNextWork(s)))
  ensures (inv(s) ==> canCleanNextWork(s) ==> alwaysCallersOwnExistingWork(cleanNextWork(s)))
  ensures (inv(s) ==> canCleanNextWork(s) ==> alwaysKeyedWorkCanBeJoined(cleanNextWork(s)))
  ensures (inv(s) ==> canCleanNextWork(s) ==> alwaysUnwantedWorkAborted(cleanNextWork(s)))
  ensures (inv(s) ==> canCleanNextWork(s) ==> alwaysWaiterAbortHasNoCallers(cleanNextWork(s)))
  ensures (inv(s) ==> canCleanNextWork(s) ==> alwaysStopReachesEveryExecution(cleanNextWork(s)))
  ensures (inv(s) ==> canCleanNextWork(s) ==> alwaysCleanedWorkIsInactive(cleanNextWork(s)))
  ensures (inv(s) ==> canCleanNextWork(s) ==> alwaysCreatedWorkHasStarted(cleanNextWork(s)))
  ensures (inv(s) ==> canCleanNextWork(s) ==> alwaysProviderDeadlockFree(cleanNextWork(s)))
  ensures (inv(s) ==> canCleanNextWork(s) ==> stepAbortedWorkCannotStart(s, cleanNextWork(s)))
{
  if inv(s) && canCleanNextWork(s) { cleanWork_ensures(s, nextCleanableWork(s).id); }
}


lemma ProviderCallerProjection(s: ProviderState, caller: int)
  ensures callerFor(s, caller) == (var choices := ProofLib.Filter((c: ProviderCaller) => (c.id == caller), s.callers); if |choices| > 0 then choices[0] else ProviderCaller(0, 0))
{}

lemma ProviderCallerLookup(s: ProviderState, caller: int, captured: ProviderCaller)
  requires alwaysCallersOwnExistingWork(s) && captured in s.callers && captured.id == caller
  ensures ProofLib.Filter((c: ProviderCaller) => (c.id == caller), s.callers) == [captured]
  ensures callerFor(s, caller) == captured
{
  CallerIdentityFilters(s);
  ProviderCallerProjection(s, caller);
  ProofLib.FilterMember((c: ProviderCaller) => (c.id == caller), s.callers, captured);
  ProofLib.FilterSamePredicate((c: ProviderCaller) => (c.id == caller), (x: ProviderCaller) => (x.id == captured.id), s.callers);
  var selected := ProofLib.Filter((c: ProviderCaller) => (c.id == caller), s.callers);
  assert |selected| == 1 && captured in selected;
  assert selected[0] == captured;
}

lemma ProviderWaitersFilter(s: ProviderState, workId: int)
  ensures waiters(s, workId) == |ProofLib.Filter((c: ProviderCaller) => (c.workId == workId), s.callers)|
{}

lemma ProviderCallerRemoved(s: ProviderState, after: ProviderState, captured: ProviderCaller)
  requires alwaysCallersOwnExistingWork(s) && captured in s.callers
  requires after.callers == ProofLib.Filter((c: ProviderCaller) => (c.id != captured.id), s.callers)
  ensures forall c :: c in s.callers && c != captured ==> c in after.callers
  ensures forall c :: c in after.callers ==> c in s.callers && c != captured
  ensures waiters(s, captured.workId) == 1 <==> !(exists c :: c in after.callers && c.workId == captured.workId)
{
  ProviderCallerLookup(s, captured.id, captured);
  forall c | c in s.callers && c != captured ensures c in after.callers
  {
    if c.id == captured.id {
      ProofLib.FilterMember((c: ProviderCaller) => (c.id == captured.id), s.callers, c);
      assert c in [captured];
    }
    ProofLib.FilterMember((c: ProviderCaller) => (c.id != captured.id), s.callers, c);
  }
  forall c | c in after.callers ensures c in s.callers && c != captured
  { ProofLib.FilterMember((c: ProviderCaller) => (c.id != captured.id), s.callers, c); }
  ProviderWaitersFilter(s, captured.workId);
  var p := (c: ProviderCaller) => (c.workId == captured.workId);
  var i :| 0 <= i < |s.callers| && s.callers[i] == captured;
  ProofLib.FilterMember(p, s.callers, captured);
  if exists c :: c in after.callers && c.workId == captured.workId {
    var c :| c in after.callers && c.workId == captured.workId;
    var j :| 0 <= j < |s.callers| && s.callers[j] == c;
    ProofLib.FilterTwo(p, s.callers, i, j);
  } else {
    forall j | 0 <= j < |s.callers| && i != j ensures !p(s.callers[j])
    {
      var c := s.callers[j];
      if c == captured {
        ProofLib.FilterTwo((a: ProviderCaller) => (a.id == captured.id), s.callers, i, j);
        assert |ProofLib.Filter((a: ProviderCaller) => (a.id == captured.id), s.callers)| == 1;
      }
      assert c in after.callers;
    }
    ProofLib.FilterOne(p, s.callers, i);
  }
}

lemma receiveResult_ensures(s: ProviderState, caller: int)
  ensures (inv(s) ==> canReceiveResult(s, caller) ==> alwaysExecutionIdentitiesUnique(receiveResult(s, caller)))
  ensures (inv(s) ==> canReceiveResult(s, caller) ==> alwaysCallersOwnExistingWork(receiveResult(s, caller)))
  ensures (inv(s) ==> canReceiveResult(s, caller) ==> alwaysKeyedWorkCanBeJoined(receiveResult(s, caller)))
  ensures (inv(s) ==> canReceiveResult(s, caller) ==> alwaysUnwantedWorkAborted(receiveResult(s, caller)))
  ensures (inv(s) ==> canReceiveResult(s, caller) ==> alwaysWaiterAbortHasNoCallers(receiveResult(s, caller)))
  ensures (inv(s) ==> canReceiveResult(s, caller) ==> alwaysStopReachesEveryExecution(receiveResult(s, caller)))
  ensures (inv(s) ==> canReceiveResult(s, caller) ==> alwaysCleanedWorkIsInactive(receiveResult(s, caller)))
  ensures (inv(s) ==> canReceiveResult(s, caller) ==> alwaysCreatedWorkHasStarted(receiveResult(s, caller)))
  ensures (inv(s) ==> canReceiveResult(s, caller) ==> alwaysProviderDeadlockFree(receiveResult(s, caller)))
  ensures (inv(s) ==> canReceiveResult(s, caller) ==> stepAbortedWorkCannotStart(s, receiveResult(s, caller)))
{
  if inv(s) && canReceiveResult(s, caller) {
    var captured :| captured in s.callers && captured.id == caller && providerWork(s, captured.workId).phase.WorkCleaned?;
    var after := receiveResult(s, caller);
    assert after.callers == ProofLib.Filter((c: ProviderCaller) => (c.id != caller), s.callers);
    ProviderCallerRemoved(s, after, captured);
    ProviderCallersFilter(s, after, caller);
    FindProviderWork(s, captured.workId);
    forall w | w in after.works && w.phase.Working? && w.cause.NoAbort?
      ensures exists c :: c in after.callers && c.workId == w.id
    {
      var c :| c in s.callers && c.workId == w.id;
      if c == captured { assert providerWork(s, w.id) == w; }
      assert c in after.callers;
    }
    ProviderProgress(after);
  }
}

lemma detachCancelled_ensures(s: ProviderState, caller: int)
  ensures (inv(s) ==> canDetachCancelled(s, caller) ==> alwaysExecutionIdentitiesUnique(detachCancelled(s, caller)))
  ensures (inv(s) ==> canDetachCancelled(s, caller) ==> alwaysCallersOwnExistingWork(detachCancelled(s, caller)))
  ensures (inv(s) ==> canDetachCancelled(s, caller) ==> alwaysKeyedWorkCanBeJoined(detachCancelled(s, caller)))
  ensures (inv(s) ==> canDetachCancelled(s, caller) ==> alwaysUnwantedWorkAborted(detachCancelled(s, caller)))
  ensures (inv(s) ==> canDetachCancelled(s, caller) ==> alwaysWaiterAbortHasNoCallers(detachCancelled(s, caller)))
  ensures (inv(s) ==> canDetachCancelled(s, caller) ==> alwaysStopReachesEveryExecution(detachCancelled(s, caller)))
  ensures (inv(s) ==> canDetachCancelled(s, caller) ==> alwaysCleanedWorkIsInactive(detachCancelled(s, caller)))
  ensures (inv(s) ==> canDetachCancelled(s, caller) ==> alwaysCreatedWorkHasStarted(detachCancelled(s, caller)))
  ensures (inv(s) ==> canDetachCancelled(s, caller) ==> alwaysProviderDeadlockFree(detachCancelled(s, caller)))
  ensures (inv(s) ==> canDetachCancelled(s, caller) ==> stepAbortedWorkCannotStart(s, detachCancelled(s, caller)))
{
  if inv(s) && canDetachCancelled(s, caller) {
    var captured :| captured in s.callers && captured.id == caller;
    ProviderCallerLookup(s, caller, captured);
    var workId := captured.workId;
    var finalWaiter := waiters(s, workId) == 1;
    var after := detachCancelled(s, caller);
    assert after.callers == ProofLib.Filter((c: ProviderCaller) => (c.id != caller), s.callers);
    ProviderCallerRemoved(s, after, captured);
    MapProviderWorks(s, after);
    ProviderCallersFilter(s, after, caller);
    MapProviderAbort(s, after);
    forall a | a in after.works
      ensures (!a.phase.Dormant? &&
        (a.phase.WorkCleaned? ==> !a.active) &&
        (after.stopping && a.phase.Working? ==> !a.cause.NoAbort?))
    {
      var i :| 0 <= i < |after.works| && after.works[i] == a;
      var w := s.works[i];
      assert w in s.works && w.phase == a.phase && w.active == a.active;
    }
    forall a | a in after.works && a.phase.Working? && a.cause.NoAbort?
      ensures exists c :: c in after.callers && c.workId == a.id
    {
      var i :| 0 <= i < |after.works| && after.works[i] == a;
      var w := s.works[i];
      assert w in s.works && w.id == a.id && w.cause.NoAbort?;
      var c :| c in s.callers && c.workId == w.id;
      if c == captured {
        assert !finalWaiter;
        var retained :| retained in after.callers && retained.workId == workId;
      } else {
        assert c in after.callers;
      }
    }
    forall a | a in after.works && a.cause.LastWaiter?
      ensures !(exists c :: c in after.callers && c.workId == a.id)
    {
      var i :| 0 <= i < |after.works| && after.works[i] == a;
      var w := s.works[i];
      if !w.cause.LastWaiter? { assert w.id == workId && finalWaiter; }
      else {
        forall c | c in after.callers ensures c.workId != a.id { assert c in s.callers; }
      }
    }
    if after.keyedId != 0 {
      FindProviderWork(s, s.keyedId);
      var w := providerWork(s, s.keyedId);
      var i :| 0 <= i < |s.works| && s.works[i] == w;
      assert after.works[i] in after.works && after.works[i] == w;
      FindProviderWork(after, after.keyedId);
      assert providerWork(after, after.keyedId) == w;
    }
    ProviderProgress(after);
  }
}

lemma attach_ensures(s: ProviderState, caller: int, keyed: bool)
  ensures (inv(s) ==> canAttach(s, caller, keyed) ==> alwaysExecutionIdentitiesUnique(attach(s, caller, keyed)))
  ensures (inv(s) ==> canAttach(s, caller, keyed) ==> alwaysCallersOwnExistingWork(attach(s, caller, keyed)))
  ensures (inv(s) ==> canAttach(s, caller, keyed) ==> alwaysKeyedWorkCanBeJoined(attach(s, caller, keyed)))
  ensures (inv(s) ==> canAttach(s, caller, keyed) ==> alwaysUnwantedWorkAborted(attach(s, caller, keyed)))
  ensures (inv(s) ==> canAttach(s, caller, keyed) ==> alwaysWaiterAbortHasNoCallers(attach(s, caller, keyed)))
  ensures (inv(s) ==> canAttach(s, caller, keyed) ==> alwaysStopReachesEveryExecution(attach(s, caller, keyed)))
  ensures (inv(s) ==> canAttach(s, caller, keyed) ==> alwaysCleanedWorkIsInactive(attach(s, caller, keyed)))
  ensures (inv(s) ==> canAttach(s, caller, keyed) ==> alwaysCreatedWorkHasStarted(attach(s, caller, keyed)))
  ensures (inv(s) ==> canAttach(s, caller, keyed) ==> alwaysProviderDeadlockFree(attach(s, caller, keyed)))
  ensures (inv(s) ==> canAttach(s, caller, keyed) ==> stepAbortedWorkCannotStart(s, attach(s, caller, keyed)))
{
  if inv(s) && canAttach(s, caller, keyed) {
    var after := attach(s, caller, keyed);
    var shared := keyed && s.keyedId != 0 && !providerWork(s, s.keyedId).phase.WorkCleaned? && providerWork(s, s.keyedId).cause.NoAbort?;
    var workId := if shared then s.keyedId else s.nextId;
    var captured := ProviderCaller(caller, workId);
    assert after.callers == s.callers + [captured];
    WorkIdentityFilters(s); WorkIdentityFilters(after);
    var created := ProviderWork(workId, WorkPhase.Working, AbortCause.NoAbort, true, false);
    if shared {
      FindProviderWork(s, workId);
      assert providerWork(s, workId) in after.works && providerWork(s, workId).id == workId;
    } else {
      assert after.works == s.works + [created];
      assert created in after.works;
    }
    CallersAfterAttach(s, after, captured);
    if !shared {
      assert after.works == s.works + [created];
      forall w | w in after.works
        ensures w.id > 0 && w.id < after.nextId && |ProofLib.Filter((x: ProviderWork) => (x.id == w.id), after.works)| == 1
      {
        ProofLib.FilterAppend((x: ProviderWork) => (x.id == w.id), s.works, created);
        if w == created { ProofLib.FilterNone((x: ProviderWork) => (x.id == w.id), s.works); }
        else { assert w in s.works; }
      }
    }
    if after.keyedId != 0 {
      FindProviderWork(after, after.keyedId);
      if shared || !keyed {
        FindProviderWork(s, s.keyedId);
        var current := providerWork(s, s.keyedId);
        assert current in after.works;
        assert providerWork(after, after.keyedId) == current;
      } else {
        assert after.keyedId == workId && created in after.works && created.id == after.keyedId;
        assert providerWork(after, after.keyedId) == created;
      }
    }
    forall w | w in after.works && w.cause.LastWaiter?
      ensures !(exists c :: c in after.callers && c.workId == w.id)
    {
      assert w in s.works;
      if w.id == workId {
        if shared { FindProviderWork(s, workId); assert w == providerWork(s, workId); }
        else { assert w.id < s.nextId; }
      }
      forall c | c in after.callers ensures c.workId != w.id { assert c in s.callers || c == captured; }
    }
    ProviderProgress(after);
  }
}

lemma CallersAfterAttach(s: ProviderState, after: ProviderState, captured: ProviderCaller)
  requires alwaysCallersOwnExistingWork(s)
  requires captured.id > 0 && !(exists c :: c in s.callers && c.id == captured.id)
  requires after.callers == s.callers + [captured]
  requires exists w :: w in after.works && w.id == captured.workId
  requires forall w :: w in s.works ==> w in after.works
  ensures alwaysCallersOwnExistingWork(after)
{
  CallerIdentityFilters(s); CallerIdentityFilters(after);
  forall c | c in after.callers
    ensures c.id > 0 && |ProofLib.Filter((x: ProviderCaller) => (x.id == c.id), after.callers)| == 1 && (exists w :: w in after.works && w.id == c.workId)
  {
    ProofLib.FilterAppend((x: ProviderCaller) => (x.id == c.id), s.callers, captured);
    if c == captured { ProofLib.FilterNone((x: ProviderCaller) => (x.id == c.id), s.callers); }
    else {
      assert c in s.callers;
      var w :| w in s.works && w.id == c.workId;
    }
  }
}

lemma runNextCallback_ensures(s: ProviderState)
  ensures (inv(s) ==> canRunNextCallback(s) ==> alwaysExecutionIdentitiesUnique(runNextCallback(s)))
  ensures (inv(s) ==> canRunNextCallback(s) ==> alwaysCallersOwnExistingWork(runNextCallback(s)))
  ensures (inv(s) ==> canRunNextCallback(s) ==> alwaysKeyedWorkCanBeJoined(runNextCallback(s)))
  ensures (inv(s) ==> canRunNextCallback(s) ==> alwaysUnwantedWorkAborted(runNextCallback(s)))
  ensures (inv(s) ==> canRunNextCallback(s) ==> alwaysWaiterAbortHasNoCallers(runNextCallback(s)))
  ensures (inv(s) ==> canRunNextCallback(s) ==> alwaysStopReachesEveryExecution(runNextCallback(s)))
  ensures (inv(s) ==> canRunNextCallback(s) ==> alwaysCleanedWorkIsInactive(runNextCallback(s)))
  ensures (inv(s) ==> canRunNextCallback(s) ==> alwaysCreatedWorkHasStarted(runNextCallback(s)))
  ensures (inv(s) ==> canRunNextCallback(s) ==> alwaysProviderDeadlockFree(runNextCallback(s)))
  ensures (inv(s) ==> canRunNextCallback(s) ==> stepAbortedWorkCannotStart(s, runNextCallback(s)))
{
  if inv(s) && canRunNextCallback(s) {
    var caller := nextCallbackCaller(s).id;
    if canDetachCancelled(s, caller) { detachCancelled_ensures(s, caller); }
    else { receiveResult_ensures(s, caller); }
  }
}
