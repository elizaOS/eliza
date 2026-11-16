lemma registerClass_ensures(s: EagerServices, classId: int, serviceType: string)
  ensures (inv(s) ==> canRegisterClass(s, classId, serviceType) ==> alwaysEagerAttemptLimit(registerClass(s, classId, serviceType)))
  ensures (inv(s) ==> canRegisterClass(s, classId, serviceType) ==> alwaysEagerJobsUnique(registerClass(s, classId, serviceType)))
  ensures (inv(s) ==> canRegisterClass(s, classId, serviceType) ==> alwaysSharedServiceStateValid(registerClass(s, classId, serviceType)))
  ensures (inv(s) ==> canRegisterClass(s, classId, serviceType) ==> stepNoEarlyWake(s, "registerClass", registerClass(s, classId, serviceType)))
{
  if inv(s) && canRegisterClass(s, classId, serviceType) {
    EagerServiceInvariantUsesImportedRules(s);
    core__serviceInstances_registerClass_ensures(s.services, classId, serviceType);
    EagerServiceInvariantUsesImportedRules(registerClass(s, classId, serviceType));
  }
}

lemma finishInitialization_ensures(s: EagerServices, ok: bool)
  ensures (inv(s) ==> canFinishInitialization(s, ok) ==> alwaysEagerAttemptLimit(finishInitialization(s, ok)))
  ensures (inv(s) ==> canFinishInitialization(s, ok) ==> alwaysEagerJobsUnique(finishInitialization(s, ok)))
  ensures (inv(s) ==> canFinishInitialization(s, ok) ==> alwaysSharedServiceStateValid(finishInitialization(s, ok)))
  ensures (inv(s) ==> canFinishInitialization(s, ok) ==> stepNoEarlyWake(s, "finishInitialization", finishInitialization(s, ok)))
{
  if inv(s) && canFinishInitialization(s, ok) {
    EagerServiceInvariantUsesImportedRules(s);
    core__serviceInstances_finishInitialization_ensures(s.services, ok);
    EagerServiceInvariantUsesImportedRules(finishInitialization(s, ok));
  }
}

lemma returnInstance_ensures(s: EagerServices, attemptId: int, instanceId: int)
  ensures (inv(s) ==> canReturnInstance(s, attemptId, instanceId) ==> alwaysEagerAttemptLimit(returnInstance(s, attemptId, instanceId)))
  ensures (inv(s) ==> canReturnInstance(s, attemptId, instanceId) ==> alwaysEagerJobsUnique(returnInstance(s, attemptId, instanceId)))
  ensures (inv(s) ==> canReturnInstance(s, attemptId, instanceId) ==> alwaysSharedServiceStateValid(returnInstance(s, attemptId, instanceId)))
  ensures (inv(s) ==> canReturnInstance(s, attemptId, instanceId) ==> stepNoEarlyWake(s, "returnInstance", returnInstance(s, attemptId, instanceId)))
{
  if inv(s) && canReturnInstance(s, attemptId, instanceId) {
    EagerServiceInvariantUsesImportedRules(s);
    core__serviceInstances_returnInstance_ensures(s.services, attemptId, instanceId);
    EagerServiceInvariantUsesImportedRules(returnInstance(s, attemptId, instanceId));
  }
}

lemma failStart_ensures(s: EagerServices, attemptId: int, errorId: string)
  ensures (inv(s) ==> canFailStart(s, attemptId, errorId) ==> alwaysEagerAttemptLimit(failStart(s, attemptId, errorId)))
  ensures (inv(s) ==> canFailStart(s, attemptId, errorId) ==> alwaysEagerJobsUnique(failStart(s, attemptId, errorId)))
  ensures (inv(s) ==> canFailStart(s, attemptId, errorId) ==> alwaysSharedServiceStateValid(failStart(s, attemptId, errorId)))
  ensures (inv(s) ==> canFailStart(s, attemptId, errorId) ==> stepNoEarlyWake(s, "failStart", failStart(s, attemptId, errorId)))
{
  if inv(s) && canFailStart(s, attemptId, errorId) {
    EagerServiceInvariantUsesImportedRules(s);
    core__serviceInstances_failStart_ensures(s.services, attemptId, errorId);
    EagerServiceInvariantUsesImportedRules(failStart(s, attemptId, errorId));
  }
}

lemma finishObserver_ensures(s: EagerServices, attemptId: int, ok: bool)
  ensures (inv(s) ==> canFinishObserver(s, attemptId, ok) ==> alwaysEagerAttemptLimit(finishObserver(s, attemptId, ok)))
  ensures (inv(s) ==> canFinishObserver(s, attemptId, ok) ==> alwaysEagerJobsUnique(finishObserver(s, attemptId, ok)))
  ensures (inv(s) ==> canFinishObserver(s, attemptId, ok) ==> alwaysSharedServiceStateValid(finishObserver(s, attemptId, ok)))
  ensures (inv(s) ==> canFinishObserver(s, attemptId, ok) ==> stepNoEarlyWake(s, "finishObserver", finishObserver(s, attemptId, ok)))
{
  if inv(s) && canFinishObserver(s, attemptId, ok) {
    EagerServiceInvariantUsesImportedRules(s);
    core__serviceInstances_finishObserver_ensures(s.services, attemptId, ok);
    EagerServiceInvariantUsesImportedRules(finishObserver(s, attemptId, ok));
  }
}

lemma resumeAcquire_ensures(s: EagerServices, jobId: int)
  ensures (inv(s) ==> canResumeAcquire(s, jobId) ==> alwaysEagerAttemptLimit(resumeAcquire(s, jobId)))
  ensures (inv(s) ==> canResumeAcquire(s, jobId) ==> alwaysEagerJobsUnique(resumeAcquire(s, jobId)))
  ensures (inv(s) ==> canResumeAcquire(s, jobId) ==> alwaysSharedServiceStateValid(resumeAcquire(s, jobId)))
  ensures (inv(s) ==> canResumeAcquire(s, jobId) ==> stepNoEarlyWake(s, "resumeAcquire", resumeAcquire(s, jobId)))
{
  if inv(s) && canResumeAcquire(s, jobId) {
    EagerServiceInvariantUsesImportedRules(s);
    core__serviceInstances_resumeAcquire_ensures(s.services, eagerJob(s, jobId).callId);
    EagerServiceInvariantUsesImportedRules(resumeAcquire(s, jobId));
  }
}

lemma settleEagerAggregate_ensures(s: EagerServices, jobId: int)
  ensures (inv(s) ==> canSettleEagerAggregate(s, jobId) ==> alwaysEagerAttemptLimit(settleEagerAggregate(s, jobId)))
  ensures (inv(s) ==> canSettleEagerAggregate(s, jobId) ==> alwaysEagerJobsUnique(settleEagerAggregate(s, jobId)))
  ensures (inv(s) ==> canSettleEagerAggregate(s, jobId) ==> alwaysSharedServiceStateValid(settleEagerAggregate(s, jobId)))
  ensures (inv(s) ==> canSettleEagerAggregate(s, jobId) ==> stepNoEarlyWake(s, "settleEagerAggregate", settleEagerAggregate(s, jobId)))
{
  if inv(s) && canSettleEagerAggregate(s, jobId) {
    EagerServiceInvariantUsesImportedRules(s);
    core__serviceInstances_settleTypeAggregate_ensures(s.services, eagerJob(s, jobId).callId);
    EagerServiceInvariantUsesImportedRules(settleEagerAggregate(s, jobId));
  }
}

lemma clearEagerAggregate_ensures(s: EagerServices, jobId: int)
  ensures (inv(s) ==> canClearEagerAggregate(s, jobId) ==> alwaysEagerAttemptLimit(clearEagerAggregate(s, jobId)))
  ensures (inv(s) ==> canClearEagerAggregate(s, jobId) ==> alwaysEagerJobsUnique(clearEagerAggregate(s, jobId)))
  ensures (inv(s) ==> canClearEagerAggregate(s, jobId) ==> alwaysSharedServiceStateValid(clearEagerAggregate(s, jobId)))
  ensures (inv(s) ==> canClearEagerAggregate(s, jobId) ==> stepNoEarlyWake(s, "clearEagerAggregate", clearEagerAggregate(s, jobId)))
{
  if inv(s) && canClearEagerAggregate(s, jobId) {
    EagerServiceInvariantUsesImportedRules(s);
    core__serviceInstances_clearTypeAggregate_ensures(s.services, eagerJob(s, jobId).callId);
    EagerServiceInvariantUsesImportedRules(clearEagerAggregate(s, jobId));
  }
}

lemma settleAcquire_ensures(s: EagerServices, jobId: int)
  ensures (inv(s) ==> canSettleAcquire(s, jobId) ==> alwaysEagerAttemptLimit(settleAcquire(s, jobId)))
  ensures (inv(s) ==> canSettleAcquire(s, jobId) ==> alwaysEagerJobsUnique(settleAcquire(s, jobId)))
  ensures (inv(s) ==> canSettleAcquire(s, jobId) ==> alwaysSharedServiceStateValid(settleAcquire(s, jobId)))
  ensures (inv(s) ==> canSettleAcquire(s, jobId) ==> stepNoEarlyWake(s, "settleAcquire", settleAcquire(s, jobId)))
{
  if inv(s) && canSettleAcquire(s, jobId) {
    EagerServiceInvariantUsesImportedRules(s);
    core__serviceInstances_settleAcquire_ensures(s.services, eagerJob(s, jobId).callId);
    EagerServiceInvariantUsesImportedRules(settleAcquire(s, jobId));
  }
}

lemma stopRuntime_ensures(s: EagerServices)
  ensures (inv(s) ==> canStopRuntime(s) ==> alwaysEagerAttemptLimit(stopRuntime(s)))
  ensures (inv(s) ==> canStopRuntime(s) ==> alwaysEagerJobsUnique(stopRuntime(s)))
  ensures (inv(s) ==> canStopRuntime(s) ==> alwaysSharedServiceStateValid(stopRuntime(s)))
  ensures (inv(s) ==> canStopRuntime(s) ==> stepNoEarlyWake(s, "stopRuntime", stopRuntime(s)))
{
  if inv(s) && canStopRuntime(s) {
    EagerServiceInvariantUsesImportedRules(s);
    core__serviceInstances_stopRuntime_ensures(s.services);
    EagerServiceInvariantUsesImportedRules(stopRuntime(s));
  }
}

lemma invokeObjectStop_ensures(s: EagerServices, instanceId: int)
  ensures (inv(s) ==> canInvokeObjectStop(s, instanceId) ==> alwaysEagerAttemptLimit(invokeObjectStop(s, instanceId)))
  ensures (inv(s) ==> canInvokeObjectStop(s, instanceId) ==> alwaysEagerJobsUnique(invokeObjectStop(s, instanceId)))
  ensures (inv(s) ==> canInvokeObjectStop(s, instanceId) ==> alwaysSharedServiceStateValid(invokeObjectStop(s, instanceId)))
  ensures (inv(s) ==> canInvokeObjectStop(s, instanceId) ==> stepNoEarlyWake(s, "invokeObjectStop", invokeObjectStop(s, instanceId)))
{
  if inv(s) && canInvokeObjectStop(s, instanceId) {
    EagerServiceInvariantUsesImportedRules(s);
    core__serviceInstances_invokeObjectStop_ensures(s.services, instanceId);
    EagerServiceInvariantUsesImportedRules(invokeObjectStop(s, instanceId));
  }
}

lemma settleObjectStop_ensures(s: EagerServices, instanceId: int, ok: bool, errorId: string)
  ensures (inv(s) ==> canSettleObjectStop(s, instanceId, ok, errorId) ==> alwaysEagerAttemptLimit(settleObjectStop(s, instanceId, ok, errorId)))
  ensures (inv(s) ==> canSettleObjectStop(s, instanceId, ok, errorId) ==> alwaysEagerJobsUnique(settleObjectStop(s, instanceId, ok, errorId)))
  ensures (inv(s) ==> canSettleObjectStop(s, instanceId, ok, errorId) ==> alwaysSharedServiceStateValid(settleObjectStop(s, instanceId, ok, errorId)))
  ensures (inv(s) ==> canSettleObjectStop(s, instanceId, ok, errorId) ==> stepNoEarlyWake(s, "settleObjectStop", settleObjectStop(s, instanceId, ok, errorId)))
{
  if inv(s) && canSettleObjectStop(s, instanceId, ok, errorId) {
    EagerServiceInvariantUsesImportedRules(s);
    core__serviceInstances_settleObjectStop_ensures(s.services, instanceId, ok, errorId);
    EagerServiceInvariantUsesImportedRules(settleObjectStop(s, instanceId, ok, errorId));
  }
}

lemma finishLateStart_ensures(s: EagerServices, attemptId: int)
  ensures (inv(s) ==> canFinishLateStart(s, attemptId) ==> alwaysEagerAttemptLimit(finishLateStart(s, attemptId)))
  ensures (inv(s) ==> canFinishLateStart(s, attemptId) ==> alwaysEagerJobsUnique(finishLateStart(s, attemptId)))
  ensures (inv(s) ==> canFinishLateStart(s, attemptId) ==> alwaysSharedServiceStateValid(finishLateStart(s, attemptId)))
  ensures (inv(s) ==> canFinishLateStart(s, attemptId) ==> stepNoEarlyWake(s, "finishLateStart", finishLateStart(s, attemptId)))
{
  if inv(s) && canFinishLateStart(s, attemptId) {
    EagerServiceInvariantUsesImportedRules(s);
    core__serviceInstances_finishLateStart_ensures(s.services, attemptId);
    EagerServiceInvariantUsesImportedRules(finishLateStart(s, attemptId));
  }
}

lemma acquireEager_ensures(s: EagerServices, jobId: int)
  ensures (inv(s) ==> canAcquireEager(s, jobId) ==> alwaysEagerAttemptLimit(acquireEager(s, jobId)))
  ensures (inv(s) ==> canAcquireEager(s, jobId) ==> alwaysEagerJobsUnique(acquireEager(s, jobId)))
  ensures (inv(s) ==> canAcquireEager(s, jobId) ==> alwaysSharedServiceStateValid(acquireEager(s, jobId)))
  ensures (inv(s) ==> canAcquireEager(s, jobId) ==> stepNoEarlyWake(s, "acquireEager", acquireEager(s, jobId)))
{
  if inv(s) && canAcquireEager(s, jobId) {
    EagerServiceInvariantUsesImportedRules(s);
    core__serviceInstances_acquireServices_ensures(s.services, s.nextCall, eagerJob(s, jobId).serviceType);
    EagerServiceInvariantUsesImportedRules(acquireEager(s, jobId));
    EagerAcquireAdvancesAttempt(s, jobId);
  }
}

lemma startEager_ensures(s: EagerServices, jobId: int, serviceType: string)
  ensures (inv(s) ==> canStartEager(s, jobId, serviceType) ==> alwaysEagerAttemptLimit(startEager(s, jobId, serviceType)))
  ensures (inv(s) ==> canStartEager(s, jobId, serviceType) ==> alwaysEagerJobsUnique(startEager(s, jobId, serviceType)))
  ensures (inv(s) ==> canStartEager(s, jobId, serviceType) ==> alwaysSharedServiceStateValid(startEager(s, jobId, serviceType)))
  ensures (inv(s) ==> canStartEager(s, jobId, serviceType) ==> stepNoEarlyWake(s, "startEager", startEager(s, jobId, serviceType)))
{
  if inv(s) && canStartEager(s, jobId, serviceType) {
    EagerStartUsesFreshJobId(s, jobId, serviceType);
  }
}

lemma wakeEager_ensures(s: EagerServices, jobId: int)
  ensures (inv(s) ==> canWakeEager(s, jobId) ==> alwaysEagerAttemptLimit(wakeEager(s, jobId)))
  ensures (inv(s) ==> canWakeEager(s, jobId) ==> alwaysEagerJobsUnique(wakeEager(s, jobId)))
  ensures (inv(s) ==> canWakeEager(s, jobId) ==> alwaysSharedServiceStateValid(wakeEager(s, jobId)))
  ensures (inv(s) ==> canWakeEager(s, jobId) ==> stepNoEarlyWake(s, "wakeEager", wakeEager(s, jobId)))
{
  if inv(s) && canWakeEager(s, jobId) {
    EagerWakeFollowsBackoff(s, jobId);
  }
}

lemma observeAcquire_ensures(s: EagerServices, jobId: int)
  ensures (inv(s) ==> canObserveAcquire(s, jobId) ==> alwaysEagerAttemptLimit(observeAcquire(s, jobId)))
  ensures (inv(s) ==> canObserveAcquire(s, jobId) ==> alwaysEagerJobsUnique(observeAcquire(s, jobId)))
  ensures (inv(s) ==> canObserveAcquire(s, jobId) ==> alwaysSharedServiceStateValid(observeAcquire(s, jobId)))
  ensures (inv(s) ==> canObserveAcquire(s, jobId) ==> stepNoEarlyWake(s, "observeAcquire", observeAcquire(s, jobId)))
{
  if inv(s) && canObserveAcquire(s, jobId) {
    EagerObservationRetainsAttemptBounds(s, jobId);
  }
}

lemma EagerServiceInvariantUsesImportedRules(s: EagerServices)
  ensures alwaysSharedServiceStateValid(s) == core__serviceInstances_inv(s.services)
{}

lemma EagerExistingJobMatchesLookup(s: EagerServices, jobId: int, row: EagerRequest)
  requires alwaysEagerJobsUnique(s) && row in s.jobs && row.id == jobId
  ensures row == eagerJob(s, jobId)
{
  reveal eagerJob();
  var byId := (job: EagerRequest) => job.id == jobId;
  var found := ProofLib.Filter(byId, s.jobs);
  ProofLib.FilterMember(byId, s.jobs, row);
  assert |found| == 1 && found[0] == row;
}

lemma EagerMappedJobIdsStayUnique(before: EagerServices, after: EagerServices)
  requires alwaysEagerJobsUnique(before) && |before.jobs| == |after.jobs|
  requires forall i | 0 <= i < |before.jobs| :: before.jobs[i].id == after.jobs[i].id
  ensures alwaysEagerJobsUnique(after)
{
  forall job | job in after.jobs
    ensures job.id > 0 && |ProofLib.Filter((other: EagerRequest) => other.id == job.id, after.jobs)| == 1
  {
    var i :| 0 <= i < |after.jobs| && after.jobs[i] == job;
    assert before.jobs[i] in before.jobs;
    var byId := (other: EagerRequest) => other.id == job.id;
    ProofLib.FilterLengthPointwise(byId, byId, before.jobs, after.jobs);
  }
}

lemma EagerStartUsesFreshJobId(s: EagerServices, jobId: int, serviceType: string)
  requires alwaysEagerJobsUnique(s) && canStartEager(s, jobId, serviceType)
  ensures alwaysEagerJobsUnique(startEager(s, jobId, serviceType))
{
  reveal startEager(), canStartEager();
  var after := startEager(s, jobId, serviceType);
  var added := after.jobs[|s.jobs|];
  assert after.jobs == s.jobs + [added] && added.id == jobId;
  forall job | job in after.jobs
    ensures job.id > 0 && |ProofLib.Filter((other: EagerRequest) => other.id == job.id, after.jobs)| == 1
  {
    var byId := (other: EagerRequest) => other.id == job.id;
    ProofLib.FilterAppend(byId, s.jobs, added);
    if job == added {
      ProofLib.FilterNone(byId, s.jobs);
    } else {
      assert job in s.jobs && job.id != jobId;
    }
  }
}

lemma EagerAcquireAdvancesAttempt(s: EagerServices, jobId: int)
  requires inv(s) && canAcquireEager(s, jobId)
  ensures alwaysEagerAttemptLimit(acquireEager(s, jobId))
  ensures alwaysEagerJobsUnique(acquireEager(s, jobId))
{
  reveal canAcquireEager(), acquireEager();
  var after := acquireEager(s, jobId);
  EagerMappedJobIdsStayUnique(s, after);
  forall job | job in after.jobs
    ensures 0 <= job.attempts <= 4 && 0 <= job.failures <= job.attempts
    ensures job.phase.EagerBackoff? ==> 0 < job.attempts < 4
    ensures job.phase.EagerReady? ==> job.attempts < 4
    ensures job.phase.EagerWaiting? ==> job.failures < job.attempts
  {
    var i :| 0 <= i < |after.jobs| && after.jobs[i] == job;
    var prior := s.jobs[i];
    assert prior in s.jobs;
    if prior.id == jobId {
      EagerExistingJobMatchesLookup(s, jobId, prior);
      assert prior.phase.EagerReady?;
    }
  }
}

lemma EagerObservationRetainsAttemptBounds(s: EagerServices, jobId: int)
  requires inv(s) && canObserveAcquire(s, jobId)
  ensures alwaysEagerAttemptLimit(observeAcquire(s, jobId))
  ensures alwaysEagerJobsUnique(observeAcquire(s, jobId))
{
  reveal canObserveAcquire(), observeAcquire();
  var after := observeAcquire(s, jobId);
  EagerMappedJobIdsStayUnique(s, after);
  forall job | job in after.jobs
    ensures 0 <= job.attempts <= 4 && 0 <= job.failures <= job.attempts
    ensures job.phase.EagerBackoff? ==> 0 < job.attempts < 4
    ensures job.phase.EagerReady? ==> job.attempts < 4
    ensures job.phase.EagerWaiting? ==> job.failures < job.attempts
  {
    var i :| 0 <= i < |after.jobs| && after.jobs[i] == job;
    var prior := s.jobs[i];
    assert prior in s.jobs;
    if prior.id == jobId {
      EagerExistingJobMatchesLookup(s, jobId, prior);
      assert prior.phase.EagerWaiting? && prior.failures < prior.attempts;
    }
  }
}

lemma EagerWakeFollowsBackoff(s: EagerServices, jobId: int)
  requires inv(s) && canWakeEager(s, jobId)
  ensures alwaysEagerAttemptLimit(wakeEager(s, jobId))
  ensures alwaysEagerJobsUnique(wakeEager(s, jobId))
  ensures stepNoEarlyWake(s, "wakeEager", wakeEager(s, jobId))
{
  reveal canWakeEager(), wakeEager();
  var after := wakeEager(s, jobId);
  EagerMappedJobIdsStayUnique(s, after);
  forall job | job in after.jobs
    ensures 0 <= job.attempts <= 4 && 0 <= job.failures <= job.attempts
    ensures job.phase.EagerBackoff? ==> 0 < job.attempts < 4
    ensures job.phase.EagerReady? ==> job.attempts < 4
    ensures job.phase.EagerWaiting? ==> job.failures < job.attempts
  {
    var i :| 0 <= i < |after.jobs| && after.jobs[i] == job;
    var prior := s.jobs[i];
    assert prior in s.jobs;
    if prior.id == jobId {
      EagerExistingJobMatchesLookup(s, jobId, prior);
      assert prior.phase.EagerBackoff? && prior.attempts < 4;
    }
  }
  forall prior | prior in s.jobs && prior.phase.EagerBackoff? && s.now < prior.wakeAt
    ensures prior in after.jobs
  {
    if prior.id == jobId {
      EagerExistingJobMatchesLookup(s, jobId, prior);
      assert false;
    }
    var i :| 0 <= i < |s.jobs| && s.jobs[i] == prior;
    assert after.jobs[i] == prior && prior in after.jobs;
  }
}
