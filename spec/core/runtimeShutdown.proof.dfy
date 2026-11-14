lemma ShutdownWorkFilters(s: Shutdown)
  ensures alwaysPendingWorkIdentitiesUnique(s) == (forall w :: w in s.pending ==> w.id > 0 && w.id in s.usedWorkIds && |ProofLib.Filter((other: RetirementWork) => (other.id == w.id), s.pending)| == 1)
{}

lemma ShutdownAttemptFilters(s: Shutdown)
  ensures alwaysAttemptIdentityUnique(s) == (s.nextAttempt > 0 && (forall a :: a in s.attempts ==> a.id > 0 && a.id < s.nextAttempt && |ProofLib.Filter((other: StopAttempt) => (other.id == a.id), s.attempts)| == 1))
{}

lemma ShutdownCallerFilters(s: Shutdown)
  ensures alwaysPublishedStopOwnership(s) == (((exists a :: a in s.attempts && (a.phase.StoppingServices? || a.phase.StopSucceeded?)) ==> s.runtimeStopped) && ((s.runtimeStopped || s.activeAttempt != 0 || !s.strictPhase.NoStrictStop?) ==> s.admissionClosed) && (forall c :: c in s.callers ==> c.id > 0 && |ProofLib.Filter((other: StopCaller) => (other.id == c.id), s.callers)| == 1 && (c.strict ==> !s.strictPhase.NoStrictStop?)))
{}

lemma AppendShutdownWork(s: Shutdown, after: Shutdown, workId: int, kind: RetirementKind)
  requires alwaysPendingWorkIdentitiesUnique(s)
  requires workId > 0 && workId !in s.usedWorkIds
  requires after.pending == s.pending + [RetirementWork(workId, kind, false)] && after.usedWorkIds == s.usedWorkIds + [workId]
  ensures alwaysPendingWorkIdentitiesUnique(after)
{
  ShutdownWorkFilters(s); ShutdownWorkFilters(after);
  forall w | w in after.pending
    ensures w.id > 0 && w.id in after.usedWorkIds && |ProofLib.Filter((other: RetirementWork) => (other.id == w.id), after.pending)| == 1
  {
    ProofLib.FilterAppend((other: RetirementWork) => (other.id == w.id), s.pending, RetirementWork(workId, kind, false));
    if w.id == workId { ProofLib.FilterNone((other: RetirementWork) => (other.id == w.id), s.pending); }
    else { assert w in s.pending; }
  }
}

lemma MapShutdownWork(s: Shutdown, after: Shutdown)
  requires alwaysPendingWorkIdentitiesUnique(s)
  requires |after.pending| == |s.pending| && after.usedWorkIds == s.usedWorkIds
  requires forall i :: 0 <= i < |s.pending| ==> after.pending[i].id == s.pending[i].id
  ensures alwaysPendingWorkIdentitiesUnique(after)
{
  ShutdownWorkFilters(s); ShutdownWorkFilters(after);
  forall w | w in after.pending
    ensures w.id > 0 && w.id in after.usedWorkIds && |ProofLib.Filter((other: RetirementWork) => (other.id == w.id), after.pending)| == 1
  {
    var i :| 0 <= i < |after.pending| && after.pending[i] == w;
    ProofLib.FilterLengthPointwise((other: RetirementWork) => (other.id == w.id), (other: RetirementWork) => (other.id == w.id), s.pending, after.pending);
  }
}

lemma RemoveShutdownWork(s: Shutdown, workId: int, teardownFailed: bool)
  ensures completeOwnedWork(s, workId, teardownFailed).pending == ProofLib.Filter((w: RetirementWork) => (w.id != workId), s.pending)
{}

lemma AppendShutdownAttempt(s: Shutdown, after: Shutdown, added: StopAttempt)
  requires alwaysAttemptIdentityUnique(s)
  requires added.id == s.nextAttempt && after.nextAttempt == s.nextAttempt + 1 && after.attempts == s.attempts + [added]
  ensures alwaysAttemptIdentityUnique(after)
{
  ShutdownAttemptFilters(s); ShutdownAttemptFilters(after);
  forall a | a in after.attempts
    ensures a.id > 0 && a.id < after.nextAttempt && |ProofLib.Filter((other: StopAttempt) => (other.id == a.id), after.attempts)| == 1
  {
    ProofLib.FilterAppend((other: StopAttempt) => (other.id == a.id), s.attempts, added);
    if a.id == added.id { ProofLib.FilterNone((other: StopAttempt) => (other.id == a.id), s.attempts); }
    else { assert a in s.attempts; }
  }
}

lemma MapShutdownAttempts(s: Shutdown, after: Shutdown)
  requires alwaysAttemptIdentityUnique(s)
  requires |after.attempts| == |s.attempts| && after.nextAttempt == s.nextAttempt
  requires forall i :: 0 <= i < |s.attempts| ==> after.attempts[i].id == s.attempts[i].id
  ensures alwaysAttemptIdentityUnique(after)
  ensures forall a :: a in s.attempts ==> exists b :: b in after.attempts && b.id == a.id
{
  ShutdownAttemptFilters(s); ShutdownAttemptFilters(after);
  forall a | a in after.attempts
    ensures a.id > 0 && a.id < after.nextAttempt && |ProofLib.Filter((other: StopAttempt) => (other.id == a.id), after.attempts)| == 1
  {
    var i :| 0 <= i < |after.attempts| && after.attempts[i] == a;
    ProofLib.FilterLengthPointwise((other: StopAttempt) => (other.id == a.id), (other: StopAttempt) => (other.id == a.id), s.attempts, after.attempts);
  }
  forall a | a in s.attempts ensures exists b :: b in after.attempts && b.id == a.id
  {
    var i :| 0 <= i < |s.attempts| && s.attempts[i] == a;
    assert after.attempts[i] in after.attempts;
  }
}

lemma ShutdownAttemptLookup(s: Shutdown, attemptId: int)
  ensures stopAttempt(s, attemptId) == (var matches := ProofLib.Filter((a: StopAttempt) => (a.id == attemptId), s.attempts); if |matches| > 0 then matches[0] else missingAttempt)
{}

lemma FindShutdownAttempt(s: Shutdown, attemptId: int)
  requires alwaysAttemptIdentityUnique(s)
  ensures (exists a :: a in s.attempts && a.id == attemptId) ==> stopAttempt(s, attemptId) in s.attempts && stopAttempt(s, attemptId).id == attemptId
  ensures forall a :: a in s.attempts && a.id == attemptId ==> a == stopAttempt(s, attemptId)
  ensures stopAttempt(s, attemptId).phase.StopFailed? ==> stopAttempt(s, attemptId) in s.attempts
{
  ShutdownAttemptLookup(s, attemptId); ShutdownAttemptFilters(s);
  var matches := ProofLib.Filter((a: StopAttempt) => (a.id == attemptId), s.attempts);
  if |matches| > 0 {
    var selected := matches[0];
    ProofLib.FilterMember((a: StopAttempt) => (a.id == attemptId), s.attempts, selected);
    ProofLib.FilterSamePredicate((a: StopAttempt) => (a.id == attemptId), (other: StopAttempt) => (other.id == selected.id), s.attempts);
    assert |matches| == 1;
    assert stopAttempt(s, attemptId) == selected && selected in s.attempts;
    forall a | a in s.attempts && a.id == attemptId ensures a == selected
    { ProofLib.FilterMember((a: StopAttempt) => (a.id == attemptId), s.attempts, a); }
  } else {
    forall a | a in s.attempts && a.id == attemptId ensures a == stopAttempt(s, attemptId)
    { ProofLib.FilterMember((a: StopAttempt) => (a.id == attemptId), s.attempts, a); }
  }
}

lemma AppendShutdownCaller(s: Shutdown, after: Shutdown, added: StopCaller)
  requires alwaysPublishedStopOwnership(s)
  requires added.id > 0 && !(exists c :: c in s.callers && c.id == added.id) && after.callers == s.callers + [added]
  ensures forall c :: c in after.callers ==> c.id > 0 && |ProofLib.Filter((other: StopCaller) => (other.id == c.id), after.callers)| == 1
{
  ShutdownCallerFilters(s);
  forall c | c in after.callers ensures c.id > 0 && |ProofLib.Filter((other: StopCaller) => (other.id == c.id), after.callers)| == 1
  {
    ProofLib.FilterAppend((other: StopCaller) => (other.id == c.id), s.callers, added);
    if c.id == added.id { ProofLib.FilterNone((other: StopCaller) => (other.id == c.id), s.callers); }
    else { assert c in s.callers; }
  }
}

lemma MapShutdownCallers(s: Shutdown, after: Shutdown)
  requires alwaysPublishedStopOwnership(s)
  requires |after.callers| == |s.callers|
  requires forall i :: 0 <= i < |s.callers| ==> after.callers[i].id == s.callers[i].id
  ensures forall c :: c in after.callers ==> c.id > 0 && |ProofLib.Filter((other: StopCaller) => (other.id == c.id), after.callers)| == 1
{
  ShutdownCallerFilters(s);
  forall c | c in after.callers ensures c.id > 0 && |ProofLib.Filter((other: StopCaller) => (other.id == c.id), after.callers)| == 1
  {
    var i :| 0 <= i < |after.callers| && after.callers[i] == c;
    ProofLib.FilterLengthPointwise((other: StopCaller) => (other.id == c.id), (other: StopCaller) => (other.id == c.id), s.callers, after.callers);
  }
}

lemma BeginStopRecords(s: Shutdown, fast: bool)
  requires inv(s)
  ensures alwaysAttemptIdentityUnique(beginStopOperation(fast, s))
  ensures alwaysPendingWorkIdentitiesUnique(beginStopOperation(fast, s))
  ensures alwaysOneActiveAttempt(beginStopOperation(fast, s))
  ensures alwaysAttemptFailureHonest(beginStopOperation(fast, s))
  ensures alwaysWaitingCallerHasOwner(beginStopOperation(fast, s))
  ensures alwaysStrictBaseOwnership(beginStopOperation(fast, s))
{
  if s.activeAttempt == 0 && !s.runtimeStopped {
    var after := beginStopOperation(fast, s);
    AppendShutdownAttempt(s, after, StopAttempt(s.nextAttempt, StopAttemptPhase.DrainingRooms, fast));
    MapShutdownWork(s, after);
    forall c | c in s.callers && !c.strict && c.resultKind.FailedCall?
      ensures stopAttempt(after, c.attempt).phase.StopFailed?
    {
      FindShutdownAttempt(s, c.attempt);
      ShutdownAttemptLookup(s, c.attempt);
      var a := stopAttempt(s, c.attempt);
      assert a.phase.StopFailed? && a in s.attempts;
      assert a in after.attempts;
      FindShutdownAttempt(after, c.attempt);
    }
  }
}

lemma admitOwnedWork_ensures(s: Shutdown, workId: int, kind: RetirementKind)
  ensures (inv(s) ==> canAdmitOwnedWork(s, workId, kind) ==> alwaysOneActiveAttempt(admitOwnedWork(s, workId, kind)))
  ensures (inv(s) ==> canAdmitOwnedWork(s, workId, kind) ==> alwaysPreparationOnce(admitOwnedWork(s, workId, kind)))
  ensures (inv(s) ==> canAdmitOwnedWork(s, workId, kind) ==> alwaysClosedIngressAbortsTurns(admitOwnedWork(s, workId, kind)))
  ensures (inv(s) ==> canAdmitOwnedWork(s, workId, kind) ==> alwaysAttemptIdentityUnique(admitOwnedWork(s, workId, kind)))
  ensures (inv(s) ==> canAdmitOwnedWork(s, workId, kind) ==> alwaysPublishedStopOwnership(admitOwnedWork(s, workId, kind)))
  ensures (inv(s) ==> canAdmitOwnedWork(s, workId, kind) ==> alwaysStrictBaseOwnership(admitOwnedWork(s, workId, kind)))
  ensures (inv(s) ==> canAdmitOwnedWork(s, workId, kind) ==> alwaysAttemptFailureHonest(admitOwnedWork(s, workId, kind)))
  ensures (inv(s) ==> canAdmitOwnedWork(s, workId, kind) ==> alwaysPendingWorkIdentitiesUnique(admitOwnedWork(s, workId, kind)))
  ensures (inv(s) ==> canAdmitOwnedWork(s, workId, kind) ==> alwaysStrictSuccessQuiescent(admitOwnedWork(s, workId, kind)))
  ensures (inv(s) ==> canAdmitOwnedWork(s, workId, kind) ==> alwaysWaitingCallerHasOwner(admitOwnedWork(s, workId, kind)))
  ensures (inv(s) ==> canAdmitOwnedWork(s, workId, kind) ==> alwaysStrictCallerAgreement(admitOwnedWork(s, workId, kind)))
  ensures (inv(s) ==> canAdmitOwnedWork(s, workId, kind) ==> alwaysShutdownDeadlockFree(admitOwnedWork(s, workId, kind)))
  ensures (inv(s) ==> canAdmitOwnedWork(s, workId, kind) ==> stepRetirementFailurePersists(s, admitOwnedWork(s, workId, kind)))
{
  if inv(s) && canAdmitOwnedWork(s, workId, kind) { AppendShutdownWork(s, admitOwnedWork(s, workId, kind), workId, kind); }
}

lemma spawnRetirementChild_ensures(s: Shutdown, parentId: int, workId: int, kind: RetirementKind)
  ensures (inv(s) ==> canSpawnRetirementChild(s, parentId, workId, kind) ==> alwaysOneActiveAttempt(spawnRetirementChild(s, parentId, workId, kind)))
  ensures (inv(s) ==> canSpawnRetirementChild(s, parentId, workId, kind) ==> alwaysPreparationOnce(spawnRetirementChild(s, parentId, workId, kind)))
  ensures (inv(s) ==> canSpawnRetirementChild(s, parentId, workId, kind) ==> alwaysClosedIngressAbortsTurns(spawnRetirementChild(s, parentId, workId, kind)))
  ensures (inv(s) ==> canSpawnRetirementChild(s, parentId, workId, kind) ==> alwaysAttemptIdentityUnique(spawnRetirementChild(s, parentId, workId, kind)))
  ensures (inv(s) ==> canSpawnRetirementChild(s, parentId, workId, kind) ==> alwaysPublishedStopOwnership(spawnRetirementChild(s, parentId, workId, kind)))
  ensures (inv(s) ==> canSpawnRetirementChild(s, parentId, workId, kind) ==> alwaysStrictBaseOwnership(spawnRetirementChild(s, parentId, workId, kind)))
  ensures (inv(s) ==> canSpawnRetirementChild(s, parentId, workId, kind) ==> alwaysAttemptFailureHonest(spawnRetirementChild(s, parentId, workId, kind)))
  ensures (inv(s) ==> canSpawnRetirementChild(s, parentId, workId, kind) ==> alwaysPendingWorkIdentitiesUnique(spawnRetirementChild(s, parentId, workId, kind)))
  ensures (inv(s) ==> canSpawnRetirementChild(s, parentId, workId, kind) ==> alwaysStrictSuccessQuiescent(spawnRetirementChild(s, parentId, workId, kind)))
  ensures (inv(s) ==> canSpawnRetirementChild(s, parentId, workId, kind) ==> alwaysWaitingCallerHasOwner(spawnRetirementChild(s, parentId, workId, kind)))
  ensures (inv(s) ==> canSpawnRetirementChild(s, parentId, workId, kind) ==> alwaysStrictCallerAgreement(spawnRetirementChild(s, parentId, workId, kind)))
  ensures (inv(s) ==> canSpawnRetirementChild(s, parentId, workId, kind) ==> alwaysShutdownDeadlockFree(spawnRetirementChild(s, parentId, workId, kind)))
  ensures (inv(s) ==> canSpawnRetirementChild(s, parentId, workId, kind) ==> stepRetirementFailurePersists(s, spawnRetirementChild(s, parentId, workId, kind)))
{
  if inv(s) && canSpawnRetirementChild(s, parentId, workId, kind) { AppendShutdownWork(s, spawnRetirementChild(s, parentId, workId, kind), workId, kind); }
}

lemma completeOwnedWork_ensures(s: Shutdown, workId: int, teardownFailed: bool)
  ensures (inv(s) ==> canCompleteOwnedWork(s, workId, teardownFailed) ==> alwaysOneActiveAttempt(completeOwnedWork(s, workId, teardownFailed)))
  ensures (inv(s) ==> canCompleteOwnedWork(s, workId, teardownFailed) ==> alwaysPreparationOnce(completeOwnedWork(s, workId, teardownFailed)))
  ensures (inv(s) ==> canCompleteOwnedWork(s, workId, teardownFailed) ==> alwaysClosedIngressAbortsTurns(completeOwnedWork(s, workId, teardownFailed)))
  ensures (inv(s) ==> canCompleteOwnedWork(s, workId, teardownFailed) ==> alwaysAttemptIdentityUnique(completeOwnedWork(s, workId, teardownFailed)))
  ensures (inv(s) ==> canCompleteOwnedWork(s, workId, teardownFailed) ==> alwaysPublishedStopOwnership(completeOwnedWork(s, workId, teardownFailed)))
  ensures (inv(s) ==> canCompleteOwnedWork(s, workId, teardownFailed) ==> alwaysStrictBaseOwnership(completeOwnedWork(s, workId, teardownFailed)))
  ensures (inv(s) ==> canCompleteOwnedWork(s, workId, teardownFailed) ==> alwaysAttemptFailureHonest(completeOwnedWork(s, workId, teardownFailed)))
  ensures (inv(s) ==> canCompleteOwnedWork(s, workId, teardownFailed) ==> alwaysPendingWorkIdentitiesUnique(completeOwnedWork(s, workId, teardownFailed)))
  ensures (inv(s) ==> canCompleteOwnedWork(s, workId, teardownFailed) ==> alwaysStrictSuccessQuiescent(completeOwnedWork(s, workId, teardownFailed)))
  ensures (inv(s) ==> canCompleteOwnedWork(s, workId, teardownFailed) ==> alwaysWaitingCallerHasOwner(completeOwnedWork(s, workId, teardownFailed)))
  ensures (inv(s) ==> canCompleteOwnedWork(s, workId, teardownFailed) ==> alwaysStrictCallerAgreement(completeOwnedWork(s, workId, teardownFailed)))
  ensures (inv(s) ==> canCompleteOwnedWork(s, workId, teardownFailed) ==> alwaysShutdownDeadlockFree(completeOwnedWork(s, workId, teardownFailed)))
  ensures (inv(s) ==> canCompleteOwnedWork(s, workId, teardownFailed) ==> stepRetirementFailurePersists(s, completeOwnedWork(s, workId, teardownFailed)))
{
  if inv(s) && canCompleteOwnedWork(s, workId, teardownFailed) {
    var after := completeOwnedWork(s, workId, teardownFailed);
    RemoveShutdownWork(s, workId, teardownFailed);
    ShutdownWorkFilters(s); ShutdownWorkFilters(after);
    ProofLib.FilterSubset((w: RetirementWork) => (w.id != workId), s.pending);
    forall w | w in after.pending
      ensures w.id > 0 && w.id in after.usedWorkIds && |ProofLib.Filter((other: RetirementWork) => (other.id == w.id), after.pending)| == 1
    {
      assert w in s.pending;
      ProofLib.FilterOfFilterShorter((w: RetirementWork) => (w.id != workId), (other: RetirementWork) => (other.id == w.id), s.pending);
      ProofLib.FilterMember((other: RetirementWork) => (other.id == w.id), after.pending, w);
    }
    ShutdownProgress(after);
  }
}

lemma callStop_ensures(s: Shutdown, caller: int, fast: bool)
  ensures (inv(s) ==> canCallStop(s, caller, fast) ==> alwaysOneActiveAttempt(callStop(s, caller, fast)))
  ensures (inv(s) ==> canCallStop(s, caller, fast) ==> alwaysPreparationOnce(callStop(s, caller, fast)))
  ensures (inv(s) ==> canCallStop(s, caller, fast) ==> alwaysClosedIngressAbortsTurns(callStop(s, caller, fast)))
  ensures (inv(s) ==> canCallStop(s, caller, fast) ==> alwaysAttemptIdentityUnique(callStop(s, caller, fast)))
  ensures (inv(s) ==> canCallStop(s, caller, fast) ==> alwaysPublishedStopOwnership(callStop(s, caller, fast)))
  ensures (inv(s) ==> canCallStop(s, caller, fast) ==> alwaysStrictBaseOwnership(callStop(s, caller, fast)))
  ensures (inv(s) ==> canCallStop(s, caller, fast) ==> alwaysAttemptFailureHonest(callStop(s, caller, fast)))
  ensures (inv(s) ==> canCallStop(s, caller, fast) ==> alwaysPendingWorkIdentitiesUnique(callStop(s, caller, fast)))
  ensures (inv(s) ==> canCallStop(s, caller, fast) ==> alwaysStrictSuccessQuiescent(callStop(s, caller, fast)))
  ensures (inv(s) ==> canCallStop(s, caller, fast) ==> alwaysWaitingCallerHasOwner(callStop(s, caller, fast)))
  ensures (inv(s) ==> canCallStop(s, caller, fast) ==> alwaysStrictCallerAgreement(callStop(s, caller, fast)))
  ensures (inv(s) ==> canCallStop(s, caller, fast) ==> alwaysShutdownDeadlockFree(callStop(s, caller, fast)))
  ensures (inv(s) ==> canCallStop(s, caller, fast) ==> stepRetirementFailurePersists(s, callStop(s, caller, fast)))
{
  if inv(s) && canCallStop(s, caller, fast) {
    BeginStopRecords(s, fast);
    var after := callStop(s, caller, fast);
    ShutdownCallerFilters(after);
    AppendShutdownCaller(s, after, after.callers[|s.callers|]);
  }
}

lemma callStrictStop_ensures(s: Shutdown, caller: int, fast: bool)
  ensures (inv(s) ==> canCallStrictStop(s, caller, fast) ==> alwaysOneActiveAttempt(callStrictStop(s, caller, fast)))
  ensures (inv(s) ==> canCallStrictStop(s, caller, fast) ==> alwaysPreparationOnce(callStrictStop(s, caller, fast)))
  ensures (inv(s) ==> canCallStrictStop(s, caller, fast) ==> alwaysClosedIngressAbortsTurns(callStrictStop(s, caller, fast)))
  ensures (inv(s) ==> canCallStrictStop(s, caller, fast) ==> alwaysAttemptIdentityUnique(callStrictStop(s, caller, fast)))
  ensures (inv(s) ==> canCallStrictStop(s, caller, fast) ==> alwaysPublishedStopOwnership(callStrictStop(s, caller, fast)))
  ensures (inv(s) ==> canCallStrictStop(s, caller, fast) ==> alwaysStrictBaseOwnership(callStrictStop(s, caller, fast)))
  ensures (inv(s) ==> canCallStrictStop(s, caller, fast) ==> alwaysAttemptFailureHonest(callStrictStop(s, caller, fast)))
  ensures (inv(s) ==> canCallStrictStop(s, caller, fast) ==> alwaysPendingWorkIdentitiesUnique(callStrictStop(s, caller, fast)))
  ensures (inv(s) ==> canCallStrictStop(s, caller, fast) ==> alwaysStrictSuccessQuiescent(callStrictStop(s, caller, fast)))
  ensures (inv(s) ==> canCallStrictStop(s, caller, fast) ==> alwaysWaitingCallerHasOwner(callStrictStop(s, caller, fast)))
  ensures (inv(s) ==> canCallStrictStop(s, caller, fast) ==> alwaysStrictCallerAgreement(callStrictStop(s, caller, fast)))
  ensures (inv(s) ==> canCallStrictStop(s, caller, fast) ==> alwaysShutdownDeadlockFree(callStrictStop(s, caller, fast)))
  ensures (inv(s) ==> canCallStrictStop(s, caller, fast) ==> stepRetirementFailurePersists(s, callStrictStop(s, caller, fast)))
{
  if inv(s) && canCallStrictStop(s, caller, fast) {
    if s.strictPhase.NoStrictStop? { BeginStopRecords(s, fast); }
    var after := callStrictStop(s, caller, fast);
    ShutdownCallerFilters(after);
    AppendShutdownCaller(s, after, after.callers[|s.callers|]);
    ShutdownProgress(after);
  }
}

lemma observeStopAttempt_ensures(s: Shutdown, caller: int)
  ensures (inv(s) ==> canObserveStopAttempt(s, caller) ==> alwaysOneActiveAttempt(observeStopAttempt(s, caller)))
  ensures (inv(s) ==> canObserveStopAttempt(s, caller) ==> alwaysPreparationOnce(observeStopAttempt(s, caller)))
  ensures (inv(s) ==> canObserveStopAttempt(s, caller) ==> alwaysClosedIngressAbortsTurns(observeStopAttempt(s, caller)))
  ensures (inv(s) ==> canObserveStopAttempt(s, caller) ==> alwaysAttemptIdentityUnique(observeStopAttempt(s, caller)))
  ensures (inv(s) ==> canObserveStopAttempt(s, caller) ==> alwaysPublishedStopOwnership(observeStopAttempt(s, caller)))
  ensures (inv(s) ==> canObserveStopAttempt(s, caller) ==> alwaysStrictBaseOwnership(observeStopAttempt(s, caller)))
  ensures (inv(s) ==> canObserveStopAttempt(s, caller) ==> alwaysAttemptFailureHonest(observeStopAttempt(s, caller)))
  ensures (inv(s) ==> canObserveStopAttempt(s, caller) ==> alwaysPendingWorkIdentitiesUnique(observeStopAttempt(s, caller)))
  ensures (inv(s) ==> canObserveStopAttempt(s, caller) ==> alwaysStrictSuccessQuiescent(observeStopAttempt(s, caller)))
  ensures (inv(s) ==> canObserveStopAttempt(s, caller) ==> alwaysWaitingCallerHasOwner(observeStopAttempt(s, caller)))
  ensures (inv(s) ==> canObserveStopAttempt(s, caller) ==> alwaysStrictCallerAgreement(observeStopAttempt(s, caller)))
  ensures (inv(s) ==> canObserveStopAttempt(s, caller) ==> alwaysShutdownDeadlockFree(observeStopAttempt(s, caller)))
  ensures (inv(s) ==> canObserveStopAttempt(s, caller) ==> stepRetirementFailurePersists(s, observeStopAttempt(s, caller)))
{
  if inv(s) && canObserveStopAttempt(s, caller) {
    var after := observeStopAttempt(s, caller);
    ShutdownCallerFilters(after); MapShutdownCallers(s, after);
    var chosen :| chosen in s.callers && chosen.id == caller && !chosen.strict && chosen.resultKind.WaitingCall? &&
      (stopAttempt(s, chosen.attempt).phase.StopSucceeded? || stopAttempt(s, chosen.attempt).phase.StopFailed?);
    ShutdownCallerById(s, chosen);
    forall c | c in after.callers && !c.strict && c.resultKind.FailedCall?
      ensures stopAttempt(after, c.attempt).phase.StopFailed?
    {
      var i :| 0 <= i < |after.callers| && after.callers[i] == c;
      var prior := s.callers[i];
      assert prior in s.callers;
      if prior.id == caller { assert prior == chosen; }
    }
    ShutdownProgress(after);
  }
}

lemma observeStrictResult_ensures(s: Shutdown, caller: int)
  ensures (inv(s) ==> canObserveStrictResult(s, caller) ==> alwaysOneActiveAttempt(observeStrictResult(s, caller)))
  ensures (inv(s) ==> canObserveStrictResult(s, caller) ==> alwaysPreparationOnce(observeStrictResult(s, caller)))
  ensures (inv(s) ==> canObserveStrictResult(s, caller) ==> alwaysClosedIngressAbortsTurns(observeStrictResult(s, caller)))
  ensures (inv(s) ==> canObserveStrictResult(s, caller) ==> alwaysAttemptIdentityUnique(observeStrictResult(s, caller)))
  ensures (inv(s) ==> canObserveStrictResult(s, caller) ==> alwaysPublishedStopOwnership(observeStrictResult(s, caller)))
  ensures (inv(s) ==> canObserveStrictResult(s, caller) ==> alwaysStrictBaseOwnership(observeStrictResult(s, caller)))
  ensures (inv(s) ==> canObserveStrictResult(s, caller) ==> alwaysAttemptFailureHonest(observeStrictResult(s, caller)))
  ensures (inv(s) ==> canObserveStrictResult(s, caller) ==> alwaysPendingWorkIdentitiesUnique(observeStrictResult(s, caller)))
  ensures (inv(s) ==> canObserveStrictResult(s, caller) ==> alwaysStrictSuccessQuiescent(observeStrictResult(s, caller)))
  ensures (inv(s) ==> canObserveStrictResult(s, caller) ==> alwaysWaitingCallerHasOwner(observeStrictResult(s, caller)))
  ensures (inv(s) ==> canObserveStrictResult(s, caller) ==> alwaysStrictCallerAgreement(observeStrictResult(s, caller)))
  ensures (inv(s) ==> canObserveStrictResult(s, caller) ==> alwaysShutdownDeadlockFree(observeStrictResult(s, caller)))
  ensures (inv(s) ==> canObserveStrictResult(s, caller) ==> stepRetirementFailurePersists(s, observeStrictResult(s, caller)))
{
  if inv(s) && canObserveStrictResult(s, caller) {
    var after := observeStrictResult(s, caller);
    ShutdownCallerFilters(after); MapShutdownCallers(s, after);
    var chosen :| chosen in s.callers && chosen.id == caller && chosen.strict && chosen.resultKind.WaitingCall?;
    ShutdownCallerById(s, chosen);
    forall c | c in after.callers && !c.strict && c.resultKind.FailedCall?
      ensures stopAttempt(after, c.attempt).phase.StopFailed?
    {
      var i :| 0 <= i < |after.callers| && after.callers[i] == c;
      var prior := s.callers[i];
      assert prior in s.callers;
      if prior.id == caller { assert prior == chosen; }
    }
    ShutdownProgress(after);
  }
}

lemma RetainFailedShutdownAttempt(s: Shutdown, after: Shutdown)
  requires alwaysAttemptIdentityUnique(s) && alwaysAttemptIdentityUnique(after)
  requires forall a :: a in s.attempts && a.phase.StopFailed? ==> a in after.attempts
  ensures forall c :: c in s.callers && !c.strict && c.resultKind.FailedCall? && stopAttempt(s, c.attempt).phase.StopFailed? ==> stopAttempt(after, c.attempt).phase.StopFailed?
{
  forall c | c in s.callers && !c.strict && c.resultKind.FailedCall? && stopAttempt(s, c.attempt).phase.StopFailed?
    ensures stopAttempt(after, c.attempt).phase.StopFailed?
  {
    ShutdownAttemptLookup(s, c.attempt);
    var matches := ProofLib.Filter((a: StopAttempt) => (a.id == c.attempt), s.attempts);
    assert |matches| > 0;
    var failed := matches[0];
    ProofLib.FilterMember((a: StopAttempt) => (a.id == c.attempt), s.attempts, failed);
    assert failed in after.attempts;
    FindShutdownAttempt(after, c.attempt);
  }
}

lemma finishRoomDrain_ensures(s: Shutdown, attemptId: int)
  ensures (inv(s) ==> canFinishRoomDrain(s, attemptId) ==> alwaysOneActiveAttempt(finishRoomDrain(s, attemptId)))
  ensures (inv(s) ==> canFinishRoomDrain(s, attemptId) ==> alwaysPreparationOnce(finishRoomDrain(s, attemptId)))
  ensures (inv(s) ==> canFinishRoomDrain(s, attemptId) ==> alwaysClosedIngressAbortsTurns(finishRoomDrain(s, attemptId)))
  ensures (inv(s) ==> canFinishRoomDrain(s, attemptId) ==> alwaysAttemptIdentityUnique(finishRoomDrain(s, attemptId)))
  ensures (inv(s) ==> canFinishRoomDrain(s, attemptId) ==> alwaysPublishedStopOwnership(finishRoomDrain(s, attemptId)))
  ensures (inv(s) ==> canFinishRoomDrain(s, attemptId) ==> alwaysStrictBaseOwnership(finishRoomDrain(s, attemptId)))
  ensures (inv(s) ==> canFinishRoomDrain(s, attemptId) ==> alwaysAttemptFailureHonest(finishRoomDrain(s, attemptId)))
  ensures (inv(s) ==> canFinishRoomDrain(s, attemptId) ==> alwaysPendingWorkIdentitiesUnique(finishRoomDrain(s, attemptId)))
  ensures (inv(s) ==> canFinishRoomDrain(s, attemptId) ==> alwaysStrictSuccessQuiescent(finishRoomDrain(s, attemptId)))
  ensures (inv(s) ==> canFinishRoomDrain(s, attemptId) ==> alwaysWaitingCallerHasOwner(finishRoomDrain(s, attemptId)))
  ensures (inv(s) ==> canFinishRoomDrain(s, attemptId) ==> alwaysStrictCallerAgreement(finishRoomDrain(s, attemptId)))
  ensures (inv(s) ==> canFinishRoomDrain(s, attemptId) ==> alwaysShutdownDeadlockFree(finishRoomDrain(s, attemptId)))
  ensures (inv(s) ==> canFinishRoomDrain(s, attemptId) ==> stepRetirementFailurePersists(s, finishRoomDrain(s, attemptId)))
{
  if inv(s) && canFinishRoomDrain(s, attemptId) {
    var after := finishRoomDrain(s, attemptId);
    FindShutdownAttempt(s, attemptId);
    MapShutdownAttempts(s, after);
    forall a | a in s.attempts && a.phase.StopFailed? ensures a in after.attempts
    {
      if a.id == attemptId { assert a == stopAttempt(s, attemptId); }
      var i :| 0 <= i < |s.attempts| && s.attempts[i] == a;
      assert after.attempts[i] == a;
    }
    RetainFailedShutdownAttempt(s, after);
    forall a | a in after.attempts ensures attemptInFlight(a) <==> a.id == after.activeAttempt
    {
      var i :| 0 <= i < |after.attempts| && after.attempts[i] == a;
      assert s.attempts[i] in s.attempts;
    }
    ShutdownProgress(after);
  }
}

lemma beginServiceStop_ensures(s: Shutdown, attemptId: int, startWaitTimedOut: bool)
  ensures (inv(s) ==> canBeginServiceStop(s, attemptId, startWaitTimedOut) ==> alwaysOneActiveAttempt(beginServiceStop(s, attemptId, startWaitTimedOut)))
  ensures (inv(s) ==> canBeginServiceStop(s, attemptId, startWaitTimedOut) ==> alwaysPreparationOnce(beginServiceStop(s, attemptId, startWaitTimedOut)))
  ensures (inv(s) ==> canBeginServiceStop(s, attemptId, startWaitTimedOut) ==> alwaysClosedIngressAbortsTurns(beginServiceStop(s, attemptId, startWaitTimedOut)))
  ensures (inv(s) ==> canBeginServiceStop(s, attemptId, startWaitTimedOut) ==> alwaysAttemptIdentityUnique(beginServiceStop(s, attemptId, startWaitTimedOut)))
  ensures (inv(s) ==> canBeginServiceStop(s, attemptId, startWaitTimedOut) ==> alwaysPublishedStopOwnership(beginServiceStop(s, attemptId, startWaitTimedOut)))
  ensures (inv(s) ==> canBeginServiceStop(s, attemptId, startWaitTimedOut) ==> alwaysStrictBaseOwnership(beginServiceStop(s, attemptId, startWaitTimedOut)))
  ensures (inv(s) ==> canBeginServiceStop(s, attemptId, startWaitTimedOut) ==> alwaysAttemptFailureHonest(beginServiceStop(s, attemptId, startWaitTimedOut)))
  ensures (inv(s) ==> canBeginServiceStop(s, attemptId, startWaitTimedOut) ==> alwaysPendingWorkIdentitiesUnique(beginServiceStop(s, attemptId, startWaitTimedOut)))
  ensures (inv(s) ==> canBeginServiceStop(s, attemptId, startWaitTimedOut) ==> alwaysStrictSuccessQuiescent(beginServiceStop(s, attemptId, startWaitTimedOut)))
  ensures (inv(s) ==> canBeginServiceStop(s, attemptId, startWaitTimedOut) ==> alwaysWaitingCallerHasOwner(beginServiceStop(s, attemptId, startWaitTimedOut)))
  ensures (inv(s) ==> canBeginServiceStop(s, attemptId, startWaitTimedOut) ==> alwaysStrictCallerAgreement(beginServiceStop(s, attemptId, startWaitTimedOut)))
  ensures (inv(s) ==> canBeginServiceStop(s, attemptId, startWaitTimedOut) ==> alwaysShutdownDeadlockFree(beginServiceStop(s, attemptId, startWaitTimedOut)))
  ensures (inv(s) ==> canBeginServiceStop(s, attemptId, startWaitTimedOut) ==> stepRetirementFailurePersists(s, beginServiceStop(s, attemptId, startWaitTimedOut)))
{
  if inv(s) && canBeginServiceStop(s, attemptId, startWaitTimedOut) {
    var after := beginServiceStop(s, attemptId, startWaitTimedOut);
    FindShutdownAttempt(s, attemptId);
    MapShutdownAttempts(s, after);
    forall a | a in s.attempts && a.phase.StopFailed? ensures a in after.attempts
    {
      if a.id == attemptId { assert a == stopAttempt(s, attemptId); }
      var i :| 0 <= i < |s.attempts| && s.attempts[i] == a;
      assert after.attempts[i] == a;
    }
    RetainFailedShutdownAttempt(s, after);
    forall a | a in after.attempts ensures attemptInFlight(a) <==> a.id == after.activeAttempt
    {
      var i :| 0 <= i < |after.attempts| && after.attempts[i] == a;
      assert s.attempts[i] in s.attempts;
    }
    assert s.activeAttempt == attemptId && s.activeAttempt != 0;
    assert s.admissionClosed;
    assert after.admissionClosed == s.admissionClosed && after.callers == s.callers && after.runtimeStopped && after.strictPhase == s.strictPhase;
    ShutdownCallerFilters(s); ShutdownCallerFilters(after);
    assert alwaysPublishedStopOwnership(after);
    ShutdownProgress(after);
  }
}

lemma finishStopAttempt_ensures(s: Shutdown, attemptId: int, serviceWaitTimedOut: bool)
  ensures (inv(s) ==> canFinishStopAttempt(s, attemptId, serviceWaitTimedOut) ==> alwaysOneActiveAttempt(finishStopAttempt(s, attemptId, serviceWaitTimedOut)))
  ensures (inv(s) ==> canFinishStopAttempt(s, attemptId, serviceWaitTimedOut) ==> alwaysPreparationOnce(finishStopAttempt(s, attemptId, serviceWaitTimedOut)))
  ensures (inv(s) ==> canFinishStopAttempt(s, attemptId, serviceWaitTimedOut) ==> alwaysClosedIngressAbortsTurns(finishStopAttempt(s, attemptId, serviceWaitTimedOut)))
  ensures (inv(s) ==> canFinishStopAttempt(s, attemptId, serviceWaitTimedOut) ==> alwaysAttemptIdentityUnique(finishStopAttempt(s, attemptId, serviceWaitTimedOut)))
  ensures (inv(s) ==> canFinishStopAttempt(s, attemptId, serviceWaitTimedOut) ==> alwaysPublishedStopOwnership(finishStopAttempt(s, attemptId, serviceWaitTimedOut)))
  ensures (inv(s) ==> canFinishStopAttempt(s, attemptId, serviceWaitTimedOut) ==> alwaysStrictBaseOwnership(finishStopAttempt(s, attemptId, serviceWaitTimedOut)))
  ensures (inv(s) ==> canFinishStopAttempt(s, attemptId, serviceWaitTimedOut) ==> alwaysAttemptFailureHonest(finishStopAttempt(s, attemptId, serviceWaitTimedOut)))
  ensures (inv(s) ==> canFinishStopAttempt(s, attemptId, serviceWaitTimedOut) ==> alwaysPendingWorkIdentitiesUnique(finishStopAttempt(s, attemptId, serviceWaitTimedOut)))
  ensures (inv(s) ==> canFinishStopAttempt(s, attemptId, serviceWaitTimedOut) ==> alwaysStrictSuccessQuiescent(finishStopAttempt(s, attemptId, serviceWaitTimedOut)))
  ensures (inv(s) ==> canFinishStopAttempt(s, attemptId, serviceWaitTimedOut) ==> alwaysWaitingCallerHasOwner(finishStopAttempt(s, attemptId, serviceWaitTimedOut)))
  ensures (inv(s) ==> canFinishStopAttempt(s, attemptId, serviceWaitTimedOut) ==> alwaysStrictCallerAgreement(finishStopAttempt(s, attemptId, serviceWaitTimedOut)))
  ensures (inv(s) ==> canFinishStopAttempt(s, attemptId, serviceWaitTimedOut) ==> alwaysShutdownDeadlockFree(finishStopAttempt(s, attemptId, serviceWaitTimedOut)))
  ensures (inv(s) ==> canFinishStopAttempt(s, attemptId, serviceWaitTimedOut) ==> stepRetirementFailurePersists(s, finishStopAttempt(s, attemptId, serviceWaitTimedOut)))
{
  if inv(s) && canFinishStopAttempt(s, attemptId, serviceWaitTimedOut) {
    var after := finishStopAttempt(s, attemptId, serviceWaitTimedOut);
    FindShutdownAttempt(s, attemptId);
    MapShutdownAttempts(s, after);
    forall a | a in s.attempts && a.phase.StopFailed? ensures a in after.attempts
    {
      if a.id == attemptId { assert a == stopAttempt(s, attemptId); }
      var i :| 0 <= i < |s.attempts| && s.attempts[i] == a;
      assert after.attempts[i] == a;
    }
    RetainFailedShutdownAttempt(s, after);
    forall a | a in after.attempts ensures attemptInFlight(a) <==> a.id == after.activeAttempt
    {
      var i :| 0 <= i < |after.attempts| && after.attempts[i] == a;
      assert s.attempts[i] in s.attempts;
    }
    ShutdownProgress(after);
  }
}

lemma timeoutRoomDrain_ensures(s: Shutdown, attemptId: int)
  ensures (inv(s) ==> canTimeoutRoomDrain(s, attemptId) ==> alwaysOneActiveAttempt(timeoutRoomDrain(s, attemptId)))
  ensures (inv(s) ==> canTimeoutRoomDrain(s, attemptId) ==> alwaysPreparationOnce(timeoutRoomDrain(s, attemptId)))
  ensures (inv(s) ==> canTimeoutRoomDrain(s, attemptId) ==> alwaysClosedIngressAbortsTurns(timeoutRoomDrain(s, attemptId)))
  ensures (inv(s) ==> canTimeoutRoomDrain(s, attemptId) ==> alwaysAttemptIdentityUnique(timeoutRoomDrain(s, attemptId)))
  ensures (inv(s) ==> canTimeoutRoomDrain(s, attemptId) ==> alwaysPublishedStopOwnership(timeoutRoomDrain(s, attemptId)))
  ensures (inv(s) ==> canTimeoutRoomDrain(s, attemptId) ==> alwaysStrictBaseOwnership(timeoutRoomDrain(s, attemptId)))
  ensures (inv(s) ==> canTimeoutRoomDrain(s, attemptId) ==> alwaysAttemptFailureHonest(timeoutRoomDrain(s, attemptId)))
  ensures (inv(s) ==> canTimeoutRoomDrain(s, attemptId) ==> alwaysPendingWorkIdentitiesUnique(timeoutRoomDrain(s, attemptId)))
  ensures (inv(s) ==> canTimeoutRoomDrain(s, attemptId) ==> alwaysStrictSuccessQuiescent(timeoutRoomDrain(s, attemptId)))
  ensures (inv(s) ==> canTimeoutRoomDrain(s, attemptId) ==> alwaysWaitingCallerHasOwner(timeoutRoomDrain(s, attemptId)))
  ensures (inv(s) ==> canTimeoutRoomDrain(s, attemptId) ==> alwaysStrictCallerAgreement(timeoutRoomDrain(s, attemptId)))
  ensures (inv(s) ==> canTimeoutRoomDrain(s, attemptId) ==> alwaysShutdownDeadlockFree(timeoutRoomDrain(s, attemptId)))
  ensures (inv(s) ==> canTimeoutRoomDrain(s, attemptId) ==> stepRetirementFailurePersists(s, timeoutRoomDrain(s, attemptId)))
{
  if inv(s) && canTimeoutRoomDrain(s, attemptId) {
    var after := timeoutRoomDrain(s, attemptId);
    FindShutdownAttempt(s, attemptId);
    MapShutdownAttempts(s, after);
    forall a | a in s.attempts && a.phase.StopFailed? ensures a in after.attempts
    {
      if a.id == attemptId { assert a == stopAttempt(s, attemptId); }
      var i :| 0 <= i < |s.attempts| && s.attempts[i] == a;
      assert after.attempts[i] == a;
    }
    RetainFailedShutdownAttempt(s, after);
    forall a | a in after.attempts ensures attemptInFlight(a) <==> a.id == after.activeAttempt
    {
      var i :| 0 <= i < |after.attempts| && after.attempts[i] == a;
      assert s.attempts[i] in s.attempts;
    }
  }
}


lemma ShutdownCallerById(s: Shutdown, chosen: StopCaller)
  requires alwaysPublishedStopOwnership(s) && chosen in s.callers
  ensures forall c :: c in s.callers && c.id == chosen.id ==> c == chosen
{
  ShutdownCallerFilters(s);
  var selected := ProofLib.Filter((other: StopCaller) => (other.id == chosen.id), s.callers);
  ProofLib.FilterMember((other: StopCaller) => (other.id == chosen.id), s.callers, chosen);
  forall c | c in s.callers && c.id == chosen.id ensures c == chosen
  { ProofLib.FilterMember((other: StopCaller) => (other.id == chosen.id), s.callers, c); }
}

lemma ShutdownProgress(s: Shutdown)
  requires alwaysOneActiveAttempt(s) && alwaysAttemptIdentityUnique(s)
  requires alwaysWaitingCallerHasOwner(s) && alwaysStrictBaseOwnership(s)
  requires alwaysPublishedStopOwnership(s)
  ensures alwaysShutdownDeadlockFree(s)
{
  if |s.pending| > 0 {
    var w := s.pending[0];
    assert w in s.pending && canCompleteOwnedWork(s, w.id, false);
  } else if s.activeAttempt != 0 {
    FindShutdownAttempt(s, s.activeAttempt);
    var a := stopAttempt(s, s.activeAttempt);
    assert a in s.attempts && a.id == s.activeAttempt && attemptInFlight(a);
    assert canFinishRoomDrain(s, s.activeAttempt) || canBeginServiceStop(s, s.activeAttempt, true) || canFinishStopAttempt(s, s.activeAttempt, true);
  } else if s.strictPhase.StrictAwaitingAttempt? {
    FindShutdownAttempt(s, s.strictAttempt);
    var a := stopAttempt(s, s.strictAttempt);
    assert a in s.attempts && a.id == s.strictAttempt && a.id > 0;
    assert !attemptInFlight(a) && canObserveStrictBase(s);
  } else if s.strictPhase.StrictDraining? {
    assert canFinishStrictDrain(s);
  } else if exists c :: c in s.callers && c.resultKind.WaitingCall? {
    var c :| c in s.callers && c.resultKind.WaitingCall?;
    if c.strict {
      assert !s.strictPhase.NoStrictStop?;
      assert canObserveStrictResult(s, c.id);
    } else {
      FindShutdownAttempt(s, c.attempt);
      var a := stopAttempt(s, c.attempt);
      assert a in s.attempts && a.id == c.attempt && a.id > 0;
      assert !attemptInFlight(a) && canObserveStopAttempt(s, c.id);
    }
  }
}

lemma finishActiveRoomDrain_ensures(s: Shutdown)
  ensures (inv(s) ==> canFinishActiveRoomDrain(s) ==> alwaysOneActiveAttempt(finishActiveRoomDrain(s)))
  ensures (inv(s) ==> canFinishActiveRoomDrain(s) ==> alwaysPreparationOnce(finishActiveRoomDrain(s)))
  ensures (inv(s) ==> canFinishActiveRoomDrain(s) ==> alwaysClosedIngressAbortsTurns(finishActiveRoomDrain(s)))
  ensures (inv(s) ==> canFinishActiveRoomDrain(s) ==> alwaysAttemptIdentityUnique(finishActiveRoomDrain(s)))
  ensures (inv(s) ==> canFinishActiveRoomDrain(s) ==> alwaysPublishedStopOwnership(finishActiveRoomDrain(s)))
  ensures (inv(s) ==> canFinishActiveRoomDrain(s) ==> alwaysStrictBaseOwnership(finishActiveRoomDrain(s)))
  ensures (inv(s) ==> canFinishActiveRoomDrain(s) ==> alwaysAttemptFailureHonest(finishActiveRoomDrain(s)))
  ensures (inv(s) ==> canFinishActiveRoomDrain(s) ==> alwaysPendingWorkIdentitiesUnique(finishActiveRoomDrain(s)))
  ensures (inv(s) ==> canFinishActiveRoomDrain(s) ==> alwaysStrictSuccessQuiescent(finishActiveRoomDrain(s)))
  ensures (inv(s) ==> canFinishActiveRoomDrain(s) ==> alwaysWaitingCallerHasOwner(finishActiveRoomDrain(s)))
  ensures (inv(s) ==> canFinishActiveRoomDrain(s) ==> alwaysStrictCallerAgreement(finishActiveRoomDrain(s)))
  ensures (inv(s) ==> canFinishActiveRoomDrain(s) ==> alwaysShutdownDeadlockFree(finishActiveRoomDrain(s)))
  ensures (inv(s) ==> canFinishActiveRoomDrain(s) ==> stepRetirementFailurePersists(s, finishActiveRoomDrain(s)))
{
  if inv(s) && canFinishActiveRoomDrain(s) { finishRoomDrain_ensures(s, s.activeAttempt); }
}

lemma beginActiveServiceStop_ensures(s: Shutdown, startWaitTimedOut: bool)
  ensures (inv(s) ==> canBeginActiveServiceStop(s, startWaitTimedOut) ==> alwaysOneActiveAttempt(beginActiveServiceStop(s, startWaitTimedOut)))
  ensures (inv(s) ==> canBeginActiveServiceStop(s, startWaitTimedOut) ==> alwaysPreparationOnce(beginActiveServiceStop(s, startWaitTimedOut)))
  ensures (inv(s) ==> canBeginActiveServiceStop(s, startWaitTimedOut) ==> alwaysClosedIngressAbortsTurns(beginActiveServiceStop(s, startWaitTimedOut)))
  ensures (inv(s) ==> canBeginActiveServiceStop(s, startWaitTimedOut) ==> alwaysAttemptIdentityUnique(beginActiveServiceStop(s, startWaitTimedOut)))
  ensures (inv(s) ==> canBeginActiveServiceStop(s, startWaitTimedOut) ==> alwaysPublishedStopOwnership(beginActiveServiceStop(s, startWaitTimedOut)))
  ensures (inv(s) ==> canBeginActiveServiceStop(s, startWaitTimedOut) ==> alwaysStrictBaseOwnership(beginActiveServiceStop(s, startWaitTimedOut)))
  ensures (inv(s) ==> canBeginActiveServiceStop(s, startWaitTimedOut) ==> alwaysAttemptFailureHonest(beginActiveServiceStop(s, startWaitTimedOut)))
  ensures (inv(s) ==> canBeginActiveServiceStop(s, startWaitTimedOut) ==> alwaysPendingWorkIdentitiesUnique(beginActiveServiceStop(s, startWaitTimedOut)))
  ensures (inv(s) ==> canBeginActiveServiceStop(s, startWaitTimedOut) ==> alwaysStrictSuccessQuiescent(beginActiveServiceStop(s, startWaitTimedOut)))
  ensures (inv(s) ==> canBeginActiveServiceStop(s, startWaitTimedOut) ==> alwaysWaitingCallerHasOwner(beginActiveServiceStop(s, startWaitTimedOut)))
  ensures (inv(s) ==> canBeginActiveServiceStop(s, startWaitTimedOut) ==> alwaysStrictCallerAgreement(beginActiveServiceStop(s, startWaitTimedOut)))
  ensures (inv(s) ==> canBeginActiveServiceStop(s, startWaitTimedOut) ==> alwaysShutdownDeadlockFree(beginActiveServiceStop(s, startWaitTimedOut)))
  ensures (inv(s) ==> canBeginActiveServiceStop(s, startWaitTimedOut) ==> stepRetirementFailurePersists(s, beginActiveServiceStop(s, startWaitTimedOut)))
{
  if inv(s) && canBeginActiveServiceStop(s, startWaitTimedOut) { beginServiceStop_ensures(s, s.activeAttempt, startWaitTimedOut); }
}

lemma finishActiveStop_ensures(s: Shutdown, serviceWaitTimedOut: bool)
  ensures (inv(s) ==> canFinishActiveStop(s, serviceWaitTimedOut) ==> alwaysOneActiveAttempt(finishActiveStop(s, serviceWaitTimedOut)))
  ensures (inv(s) ==> canFinishActiveStop(s, serviceWaitTimedOut) ==> alwaysPreparationOnce(finishActiveStop(s, serviceWaitTimedOut)))
  ensures (inv(s) ==> canFinishActiveStop(s, serviceWaitTimedOut) ==> alwaysClosedIngressAbortsTurns(finishActiveStop(s, serviceWaitTimedOut)))
  ensures (inv(s) ==> canFinishActiveStop(s, serviceWaitTimedOut) ==> alwaysAttemptIdentityUnique(finishActiveStop(s, serviceWaitTimedOut)))
  ensures (inv(s) ==> canFinishActiveStop(s, serviceWaitTimedOut) ==> alwaysPublishedStopOwnership(finishActiveStop(s, serviceWaitTimedOut)))
  ensures (inv(s) ==> canFinishActiveStop(s, serviceWaitTimedOut) ==> alwaysStrictBaseOwnership(finishActiveStop(s, serviceWaitTimedOut)))
  ensures (inv(s) ==> canFinishActiveStop(s, serviceWaitTimedOut) ==> alwaysAttemptFailureHonest(finishActiveStop(s, serviceWaitTimedOut)))
  ensures (inv(s) ==> canFinishActiveStop(s, serviceWaitTimedOut) ==> alwaysPendingWorkIdentitiesUnique(finishActiveStop(s, serviceWaitTimedOut)))
  ensures (inv(s) ==> canFinishActiveStop(s, serviceWaitTimedOut) ==> alwaysStrictSuccessQuiescent(finishActiveStop(s, serviceWaitTimedOut)))
  ensures (inv(s) ==> canFinishActiveStop(s, serviceWaitTimedOut) ==> alwaysWaitingCallerHasOwner(finishActiveStop(s, serviceWaitTimedOut)))
  ensures (inv(s) ==> canFinishActiveStop(s, serviceWaitTimedOut) ==> alwaysStrictCallerAgreement(finishActiveStop(s, serviceWaitTimedOut)))
  ensures (inv(s) ==> canFinishActiveStop(s, serviceWaitTimedOut) ==> alwaysShutdownDeadlockFree(finishActiveStop(s, serviceWaitTimedOut)))
  ensures (inv(s) ==> canFinishActiveStop(s, serviceWaitTimedOut) ==> stepRetirementFailurePersists(s, finishActiveStop(s, serviceWaitTimedOut)))
{
  if inv(s) && canFinishActiveStop(s, serviceWaitTimedOut) { finishStopAttempt_ensures(s, s.activeAttempt, serviceWaitTimedOut); }
}

lemma observeStrictBase_ensures(s: Shutdown)
  ensures (inv(s) ==> canObserveStrictBase(s) ==> alwaysOneActiveAttempt(observeStrictBase(s)))
  ensures (inv(s) ==> canObserveStrictBase(s) ==> alwaysPreparationOnce(observeStrictBase(s)))
  ensures (inv(s) ==> canObserveStrictBase(s) ==> alwaysClosedIngressAbortsTurns(observeStrictBase(s)))
  ensures (inv(s) ==> canObserveStrictBase(s) ==> alwaysAttemptIdentityUnique(observeStrictBase(s)))
  ensures (inv(s) ==> canObserveStrictBase(s) ==> alwaysPublishedStopOwnership(observeStrictBase(s)))
  ensures (inv(s) ==> canObserveStrictBase(s) ==> alwaysStrictBaseOwnership(observeStrictBase(s)))
  ensures (inv(s) ==> canObserveStrictBase(s) ==> alwaysAttemptFailureHonest(observeStrictBase(s)))
  ensures (inv(s) ==> canObserveStrictBase(s) ==> alwaysPendingWorkIdentitiesUnique(observeStrictBase(s)))
  ensures (inv(s) ==> canObserveStrictBase(s) ==> alwaysStrictSuccessQuiescent(observeStrictBase(s)))
  ensures (inv(s) ==> canObserveStrictBase(s) ==> alwaysWaitingCallerHasOwner(observeStrictBase(s)))
  ensures (inv(s) ==> canObserveStrictBase(s) ==> alwaysStrictCallerAgreement(observeStrictBase(s)))
  ensures (inv(s) ==> canObserveStrictBase(s) ==> alwaysShutdownDeadlockFree(observeStrictBase(s)))
  ensures (inv(s) ==> canObserveStrictBase(s) ==> stepRetirementFailurePersists(s, observeStrictBase(s)))
{
  if inv(s) && canObserveStrictBase(s) {
    FindShutdownAttempt(s, s.strictAttempt);
    var a := stopAttempt(s, s.strictAttempt);
    assert a in s.attempts;
    var after := observeStrictBase(s);
    ShutdownProgress(after);
  }
}

lemma finishStrictDrain_ensures(s: Shutdown)
  ensures (inv(s) ==> canFinishStrictDrain(s) ==> alwaysOneActiveAttempt(finishStrictDrain(s)))
  ensures (inv(s) ==> canFinishStrictDrain(s) ==> alwaysPreparationOnce(finishStrictDrain(s)))
  ensures (inv(s) ==> canFinishStrictDrain(s) ==> alwaysClosedIngressAbortsTurns(finishStrictDrain(s)))
  ensures (inv(s) ==> canFinishStrictDrain(s) ==> alwaysAttemptIdentityUnique(finishStrictDrain(s)))
  ensures (inv(s) ==> canFinishStrictDrain(s) ==> alwaysPublishedStopOwnership(finishStrictDrain(s)))
  ensures (inv(s) ==> canFinishStrictDrain(s) ==> alwaysStrictBaseOwnership(finishStrictDrain(s)))
  ensures (inv(s) ==> canFinishStrictDrain(s) ==> alwaysAttemptFailureHonest(finishStrictDrain(s)))
  ensures (inv(s) ==> canFinishStrictDrain(s) ==> alwaysPendingWorkIdentitiesUnique(finishStrictDrain(s)))
  ensures (inv(s) ==> canFinishStrictDrain(s) ==> alwaysStrictSuccessQuiescent(finishStrictDrain(s)))
  ensures (inv(s) ==> canFinishStrictDrain(s) ==> alwaysWaitingCallerHasOwner(finishStrictDrain(s)))
  ensures (inv(s) ==> canFinishStrictDrain(s) ==> alwaysStrictCallerAgreement(finishStrictDrain(s)))
  ensures (inv(s) ==> canFinishStrictDrain(s) ==> alwaysShutdownDeadlockFree(finishStrictDrain(s)))
  ensures (inv(s) ==> canFinishStrictDrain(s) ==> stepRetirementFailurePersists(s, finishStrictDrain(s)))
{
  if inv(s) && canFinishStrictDrain(s) {
    var after := finishStrictDrain(s);
    ShutdownProgress(after);
  }
}

lemma step_ensures(current: Shutdown, event: Event)
  requires inv(current)
  ensures inv(step(current, event))
{
  if event.admitOwnedWork? && canAdmitOwnedWork(current, event.workId, event.kind) {
    admitOwnedWork_ensures(current, event.workId, event.kind);
    assert step(current, event) == admitOwnedWork(current, event.workId, event.kind);
  }
  else if event.callStop? && canCallStop(current, event.caller, event.fast) {
    callStop_ensures(current, event.caller, event.fast);
    assert step(current, event) == callStop(current, event.caller, event.fast);
  }
  else if event.beginServiceStop? && canBeginServiceStop(current, event.attemptId, event.startWaitTimedOut) {
    beginServiceStop_ensures(current, event.attemptId, event.startWaitTimedOut);
    assert step(current, event) == beginServiceStop(current, event.attemptId, event.startWaitTimedOut);
  }
  else if event.finishStopAttempt? && canFinishStopAttempt(current, event.attemptId, event.serviceWaitTimedOut) {
    finishStopAttempt_ensures(current, event.attemptId, event.serviceWaitTimedOut);
    assert step(current, event) == finishStopAttempt(current, event.attemptId, event.serviceWaitTimedOut);
  }
  else if event.finishRoomDrain? && canFinishRoomDrain(current, event.attemptId) {
    finishRoomDrain_ensures(current, event.attemptId);
    assert step(current, event) == finishRoomDrain(current, event.attemptId);
  }
  else if event.timeoutRoomDrain? && canTimeoutRoomDrain(current, event.attemptId) {
    timeoutRoomDrain_ensures(current, event.attemptId);
    assert step(current, event) == timeoutRoomDrain(current, event.attemptId);
  }
  else if event.observeStopAttempt? && canObserveStopAttempt(current, event.caller) {
    observeStopAttempt_ensures(current, event.caller);
    assert step(current, event) == observeStopAttempt(current, event.caller);
  }
  else if event.spawnRetirementChild? && canSpawnRetirementChild(current, event.parentId, event.workId, event.kind) {
    spawnRetirementChild_ensures(current, event.parentId, event.workId, event.kind);
    assert step(current, event) == spawnRetirementChild(current, event.parentId, event.workId, event.kind);
  }
  else if event.completeOwnedWork? && canCompleteOwnedWork(current, event.workId, event.teardownFailed) {
    completeOwnedWork_ensures(current, event.workId, event.teardownFailed);
    assert step(current, event) == completeOwnedWork(current, event.workId, event.teardownFailed);
  }
  else if event.finishStrictDrain? && canFinishStrictDrain(current) {
    finishStrictDrain_ensures(current);
    assert step(current, event) == finishStrictDrain(current);
  }
  else if event.observeStrictResult? && canObserveStrictResult(current, event.caller) {
    observeStrictResult_ensures(current, event.caller);
    assert step(current, event) == observeStrictResult(current, event.caller);
  }
  else if event.observeStrictBase? && canObserveStrictBase(current) {
    observeStrictBase_ensures(current);
    assert step(current, event) == observeStrictBase(current);
  }
  else if event.callStrictStop? && canCallStrictStop(current, event.caller, event.fast) {
    callStrictStop_ensures(current, event.caller, event.fast);
    assert step(current, event) == callStrictStop(current, event.caller, event.fast);
  }
  else if event.finishActiveRoomDrain? && canFinishActiveRoomDrain(current) {
    finishActiveRoomDrain_ensures(current);
    assert step(current, event) == finishActiveRoomDrain(current);
  }
  else if event.beginActiveServiceStop? && canBeginActiveServiceStop(current, event.startWaitTimedOut) {
    beginActiveServiceStop_ensures(current, event.startWaitTimedOut);
    assert step(current, event) == beginActiveServiceStop(current, event.startWaitTimedOut);
  }
  else if event.finishActiveStop? && canFinishActiveStop(current, event.serviceWaitTimedOut) {
    finishActiveStop_ensures(current, event.serviceWaitTimedOut);
    assert step(current, event) == finishActiveStop(current, event.serviceWaitTimedOut);
  }
  else { assert step(current, event) == current; }
}
