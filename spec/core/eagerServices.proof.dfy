lemma startEager_ensures(s: EagerServices, jobId: int, serviceType: string)
  ensures (inv(s) ==> canStartEager(s, jobId, serviceType) ==> alwaysEagerAttemptLimit(startEager(s, jobId, serviceType)))
  ensures (inv(s) ==> canStartEager(s, jobId, serviceType) ==> alwaysEagerJobsUnique(startEager(s, jobId, serviceType)))
  ensures (inv(s) ==> canStartEager(s, jobId, serviceType) ==> alwaysSharedServiceStateValid(startEager(s, jobId, serviceType)))
  ensures (inv(s) ==> canStartEager(s, jobId, serviceType) ==> alwaysEagerCallIdentitiesFresh(startEager(s, jobId, serviceType)))
  ensures (inv(s) ==> canStartEager(s, jobId, serviceType) ==> stepNoEarlyWake(s, "startEager", startEager(s, jobId, serviceType)))
{
  if inv(s) && canStartEager(s, jobId, serviceType) {
    var after := startEager(s, jobId, serviceType);
    var n := after.jobs[|s.jobs|];
    forall r | r in after.jobs ensures r.id > 0 && |ProofLib.Filter((other: EagerRequest) => (other.id == r.id), after.jobs)| == 1 {
      ProofLib.FilterAppend((other: EagerRequest) => (other.id == r.id), s.jobs, n);
      if r in s.jobs {
        assert r.id != jobId;
      } else {
        ProofLib.FilterNone((other: EagerRequest) => (other.id == r.id), s.jobs);
      }
    }
  }
}

lemma wakeEager_ensures(s: EagerServices, jobId: int)
  ensures (inv(s) ==> canWakeEager(s, jobId) ==> alwaysEagerAttemptLimit(wakeEager(s, jobId)))
  ensures (inv(s) ==> canWakeEager(s, jobId) ==> alwaysEagerJobsUnique(wakeEager(s, jobId)))
  ensures (inv(s) ==> canWakeEager(s, jobId) ==> alwaysSharedServiceStateValid(wakeEager(s, jobId)))
  ensures (inv(s) ==> canWakeEager(s, jobId) ==> alwaysEagerCallIdentitiesFresh(wakeEager(s, jobId)))
  ensures (inv(s) ==> canWakeEager(s, jobId) ==> stepNoEarlyWake(s, "wakeEager", wakeEager(s, jobId)))
{
  if inv(s) && canWakeEager(s, jobId) {
    var after := wakeEager(s, jobId);
    TheJobs(s, jobId);
    SameIdsKeepJobsUnique(s, after);
    forall r | r in after.jobs ensures (((((((r.attempts >= 0) && (r.attempts <= 4)) && (r.failures >= 0)) && (r.failures <= r.attempts)) && (!(r.phase.EagerBackoff?) || ((r.attempts > 0) && (r.attempts < 4)))) && (!(r.phase.EagerReady?) || (r.attempts < 4))) && (!(r.phase.EagerWaiting?) || (r.failures < r.attempts))) {
      var k :| 0 <= k < |after.jobs| && after.jobs[k] == r;
      assert s.jobs[k] in s.jobs;
    }
    forall r | r in s.jobs && r.phase.EagerBackoff? && s.now < r.wakeAt ensures r in after.jobs {
      var k :| 0 <= k < |s.jobs| && s.jobs[k] == r;
      assert after.jobs[k] == r;
    }
  }
}

lemma settleAcquire_ensures(s: EagerServices, jobId: int)
  ensures (inv(s) ==> canSettleAcquire(s, jobId) ==> alwaysEagerAttemptLimit(settleAcquire(s, jobId)))
  ensures (inv(s) ==> canSettleAcquire(s, jobId) ==> alwaysEagerJobsUnique(settleAcquire(s, jobId)))
  ensures (inv(s) ==> canSettleAcquire(s, jobId) ==> alwaysSharedServiceStateValid(settleAcquire(s, jobId)))
  ensures (inv(s) ==> canSettleAcquire(s, jobId) ==> alwaysEagerCallIdentitiesFresh(settleAcquire(s, jobId)))
  ensures (inv(s) ==> canSettleAcquire(s, jobId) ==> stepNoEarlyWake(s, "settleAcquire", settleAcquire(s, jobId)))
{
  core__serviceInstances_settleAcquire_ensures(s.services, eagerJob(s, jobId).callId);
}

lemma acquireEager_ensures(s: EagerServices, jobId: int)
  ensures (inv(s) ==> canAcquireEager(s, jobId) ==> alwaysEagerAttemptLimit(acquireEager(s, jobId)))
  ensures (inv(s) ==> canAcquireEager(s, jobId) ==> alwaysEagerJobsUnique(acquireEager(s, jobId)))
  ensures (inv(s) ==> canAcquireEager(s, jobId) ==> alwaysSharedServiceStateValid(acquireEager(s, jobId)))
  ensures (inv(s) ==> canAcquireEager(s, jobId) ==> alwaysEagerCallIdentitiesFresh(acquireEager(s, jobId)))
  ensures (inv(s) ==> canAcquireEager(s, jobId) ==> stepNoEarlyWake(s, "acquireEager", acquireEager(s, jobId)))
{
  core__serviceInstances_acquireServices_ensures(s.services, s.nextCall, eagerJob(s, jobId).serviceType);
  if inv(s) && canAcquireEager(s, jobId) {
    var after := acquireEager(s, jobId);
    TheJobs(s, jobId);
    SameIdsKeepJobsUnique(s, after);
    forall r | r in after.jobs ensures (((((((r.attempts >= 0) && (r.attempts <= 4)) && (r.failures >= 0)) && (r.failures <= r.attempts)) && (!(r.phase.EagerBackoff?) || ((r.attempts > 0) && (r.attempts < 4)))) && (!(r.phase.EagerReady?) || (r.attempts < 4))) && (!(r.phase.EagerWaiting?) || (r.failures < r.attempts))) {
      var k :| 0 <= k < |after.jobs| && after.jobs[k] == r;
      assert s.jobs[k] in s.jobs;
    }
  }
}

lemma observeAcquire_ensures(s: EagerServices, jobId: int)
  ensures (inv(s) ==> canObserveAcquire(s, jobId) ==> alwaysEagerAttemptLimit(observeAcquire(s, jobId)))
  ensures (inv(s) ==> canObserveAcquire(s, jobId) ==> alwaysEagerJobsUnique(observeAcquire(s, jobId)))
  ensures (inv(s) ==> canObserveAcquire(s, jobId) ==> alwaysSharedServiceStateValid(observeAcquire(s, jobId)))
  ensures (inv(s) ==> canObserveAcquire(s, jobId) ==> alwaysEagerCallIdentitiesFresh(observeAcquire(s, jobId)))
  ensures (inv(s) ==> canObserveAcquire(s, jobId) ==> stepNoEarlyWake(s, "observeAcquire", observeAcquire(s, jobId)))
{
  if inv(s) && canObserveAcquire(s, jobId) {
    var after := observeAcquire(s, jobId);
    TheJobs(s, jobId);
    SameIdsKeepJobsUnique(s, after);
    forall r | r in after.jobs ensures (((((((r.attempts >= 0) && (r.attempts <= 4)) && (r.failures >= 0)) && (r.failures <= r.attempts)) && (!(r.phase.EagerBackoff?) || ((r.attempts > 0) && (r.attempts < 4)))) && (!(r.phase.EagerReady?) || (r.attempts < 4))) && (!(r.phase.EagerWaiting?) || (r.failures < r.attempts))) {
      var k :| 0 <= k < |after.jobs| && after.jobs[k] == r;
      assert s.jobs[k] in s.jobs;
    }
  }
}

lemma finishObserver_ensures(s: EagerServices, attemptId: int, ok: bool)
  ensures (inv(s) ==> canFinishObserver(s, attemptId, ok) ==> alwaysEagerAttemptLimit(finishObserver(s, attemptId, ok)))
  ensures (inv(s) ==> canFinishObserver(s, attemptId, ok) ==> alwaysEagerJobsUnique(finishObserver(s, attemptId, ok)))
  ensures (inv(s) ==> canFinishObserver(s, attemptId, ok) ==> alwaysSharedServiceStateValid(finishObserver(s, attemptId, ok)))
  ensures (inv(s) ==> canFinishObserver(s, attemptId, ok) ==> alwaysEagerCallIdentitiesFresh(finishObserver(s, attemptId, ok)))
  ensures (inv(s) ==> canFinishObserver(s, attemptId, ok) ==> stepNoEarlyWake(s, "finishObserver", finishObserver(s, attemptId, ok)))
{
  core__serviceInstances_finishObserver_ensures(s.services, attemptId, ok);
}

lemma stopRuntime_ensures(s: EagerServices)
  ensures (inv(s) ==> canStopRuntime(s) ==> alwaysEagerAttemptLimit(stopRuntime(s)))
  ensures (inv(s) ==> canStopRuntime(s) ==> alwaysEagerJobsUnique(stopRuntime(s)))
  ensures (inv(s) ==> canStopRuntime(s) ==> alwaysSharedServiceStateValid(stopRuntime(s)))
  ensures (inv(s) ==> canStopRuntime(s) ==> alwaysEagerCallIdentitiesFresh(stopRuntime(s)))
  ensures (inv(s) ==> canStopRuntime(s) ==> stepNoEarlyWake(s, "stopRuntime", stopRuntime(s)))
{
  core__serviceInstances_stopRuntime_ensures(s.services);
}

lemma invokeObjectStop_ensures(s: EagerServices, instanceId: int)
  ensures (inv(s) ==> canInvokeObjectStop(s, instanceId) ==> alwaysEagerAttemptLimit(invokeObjectStop(s, instanceId)))
  ensures (inv(s) ==> canInvokeObjectStop(s, instanceId) ==> alwaysEagerJobsUnique(invokeObjectStop(s, instanceId)))
  ensures (inv(s) ==> canInvokeObjectStop(s, instanceId) ==> alwaysSharedServiceStateValid(invokeObjectStop(s, instanceId)))
  ensures (inv(s) ==> canInvokeObjectStop(s, instanceId) ==> alwaysEagerCallIdentitiesFresh(invokeObjectStop(s, instanceId)))
  ensures (inv(s) ==> canInvokeObjectStop(s, instanceId) ==> stepNoEarlyWake(s, "invokeObjectStop", invokeObjectStop(s, instanceId)))
{
  core__serviceInstances_invokeObjectStop_ensures(s.services, instanceId);
}

lemma settleObjectStop_ensures(s: EagerServices, instanceId: int, ok: bool, errorId: string)
  ensures (inv(s) ==> canSettleObjectStop(s, instanceId, ok, errorId) ==> alwaysEagerAttemptLimit(settleObjectStop(s, instanceId, ok, errorId)))
  ensures (inv(s) ==> canSettleObjectStop(s, instanceId, ok, errorId) ==> alwaysEagerJobsUnique(settleObjectStop(s, instanceId, ok, errorId)))
  ensures (inv(s) ==> canSettleObjectStop(s, instanceId, ok, errorId) ==> alwaysSharedServiceStateValid(settleObjectStop(s, instanceId, ok, errorId)))
  ensures (inv(s) ==> canSettleObjectStop(s, instanceId, ok, errorId) ==> alwaysEagerCallIdentitiesFresh(settleObjectStop(s, instanceId, ok, errorId)))
  ensures (inv(s) ==> canSettleObjectStop(s, instanceId, ok, errorId) ==> stepNoEarlyWake(s, "settleObjectStop", settleObjectStop(s, instanceId, ok, errorId)))
{
  core__serviceInstances_settleObjectStop_ensures(s.services, instanceId, ok, errorId);
}

lemma finishLateStart_ensures(s: EagerServices, attemptId: int)
  ensures (inv(s) ==> canFinishLateStart(s, attemptId) ==> alwaysEagerAttemptLimit(finishLateStart(s, attemptId)))
  ensures (inv(s) ==> canFinishLateStart(s, attemptId) ==> alwaysEagerJobsUnique(finishLateStart(s, attemptId)))
  ensures (inv(s) ==> canFinishLateStart(s, attemptId) ==> alwaysSharedServiceStateValid(finishLateStart(s, attemptId)))
  ensures (inv(s) ==> canFinishLateStart(s, attemptId) ==> alwaysEagerCallIdentitiesFresh(finishLateStart(s, attemptId)))
  ensures (inv(s) ==> canFinishLateStart(s, attemptId) ==> stepNoEarlyWake(s, "finishLateStart", finishLateStart(s, attemptId)))
{
  core__serviceInstances_finishLateStart_ensures(s.services, attemptId);
}

lemma registerClass_ensures(s: EagerServices, classId: int, serviceType: string)
  ensures (inv(s) ==> canRegisterClass(s, classId, serviceType) ==> alwaysEagerAttemptLimit(registerClass(s, classId, serviceType)))
  ensures (inv(s) ==> canRegisterClass(s, classId, serviceType) ==> alwaysEagerJobsUnique(registerClass(s, classId, serviceType)))
  ensures (inv(s) ==> canRegisterClass(s, classId, serviceType) ==> alwaysSharedServiceStateValid(registerClass(s, classId, serviceType)))
  ensures (inv(s) ==> canRegisterClass(s, classId, serviceType) ==> alwaysEagerCallIdentitiesFresh(registerClass(s, classId, serviceType)))
  ensures (inv(s) ==> canRegisterClass(s, classId, serviceType) ==> stepNoEarlyWake(s, "registerClass", registerClass(s, classId, serviceType)))
{
  core__serviceInstances_registerClass_ensures(s.services, classId, serviceType);
}

lemma returnInstance_ensures(s: EagerServices, attemptId: int, instanceId: int)
  ensures (inv(s) ==> canReturnInstance(s, attemptId, instanceId) ==> alwaysEagerAttemptLimit(returnInstance(s, attemptId, instanceId)))
  ensures (inv(s) ==> canReturnInstance(s, attemptId, instanceId) ==> alwaysEagerJobsUnique(returnInstance(s, attemptId, instanceId)))
  ensures (inv(s) ==> canReturnInstance(s, attemptId, instanceId) ==> alwaysSharedServiceStateValid(returnInstance(s, attemptId, instanceId)))
  ensures (inv(s) ==> canReturnInstance(s, attemptId, instanceId) ==> alwaysEagerCallIdentitiesFresh(returnInstance(s, attemptId, instanceId)))
  ensures (inv(s) ==> canReturnInstance(s, attemptId, instanceId) ==> stepNoEarlyWake(s, "returnInstance", returnInstance(s, attemptId, instanceId)))
{
  core__serviceInstances_returnInstance_ensures(s.services, attemptId, instanceId);
}

lemma failStart_ensures(s: EagerServices, attemptId: int, errorId: string)
  ensures (inv(s) ==> canFailStart(s, attemptId, errorId) ==> alwaysEagerAttemptLimit(failStart(s, attemptId, errorId)))
  ensures (inv(s) ==> canFailStart(s, attemptId, errorId) ==> alwaysEagerJobsUnique(failStart(s, attemptId, errorId)))
  ensures (inv(s) ==> canFailStart(s, attemptId, errorId) ==> alwaysSharedServiceStateValid(failStart(s, attemptId, errorId)))
  ensures (inv(s) ==> canFailStart(s, attemptId, errorId) ==> alwaysEagerCallIdentitiesFresh(failStart(s, attemptId, errorId)))
  ensures (inv(s) ==> canFailStart(s, attemptId, errorId) ==> stepNoEarlyWake(s, "failStart", failStart(s, attemptId, errorId)))
{
  core__serviceInstances_failStart_ensures(s.services, attemptId, errorId);
}

lemma settleEagerAggregate_ensures(s: EagerServices, jobId: int)
  ensures (inv(s) ==> canSettleEagerAggregate(s, jobId) ==> alwaysEagerAttemptLimit(settleEagerAggregate(s, jobId)))
  ensures (inv(s) ==> canSettleEagerAggregate(s, jobId) ==> alwaysEagerJobsUnique(settleEagerAggregate(s, jobId)))
  ensures (inv(s) ==> canSettleEagerAggregate(s, jobId) ==> alwaysSharedServiceStateValid(settleEagerAggregate(s, jobId)))
  ensures (inv(s) ==> canSettleEagerAggregate(s, jobId) ==> alwaysEagerCallIdentitiesFresh(settleEagerAggregate(s, jobId)))
  ensures (inv(s) ==> canSettleEagerAggregate(s, jobId) ==> stepNoEarlyWake(s, "settleEagerAggregate", settleEagerAggregate(s, jobId)))
{
  core__serviceInstances_settleTypeAggregate_ensures(s.services, eagerJob(s, jobId).callId);
}

lemma clearEagerAggregate_ensures(s: EagerServices, jobId: int)
  ensures (inv(s) ==> canClearEagerAggregate(s, jobId) ==> alwaysEagerAttemptLimit(clearEagerAggregate(s, jobId)))
  ensures (inv(s) ==> canClearEagerAggregate(s, jobId) ==> alwaysEagerJobsUnique(clearEagerAggregate(s, jobId)))
  ensures (inv(s) ==> canClearEagerAggregate(s, jobId) ==> alwaysSharedServiceStateValid(clearEagerAggregate(s, jobId)))
  ensures (inv(s) ==> canClearEagerAggregate(s, jobId) ==> alwaysEagerCallIdentitiesFresh(clearEagerAggregate(s, jobId)))
  ensures (inv(s) ==> canClearEagerAggregate(s, jobId) ==> stepNoEarlyWake(s, "clearEagerAggregate", clearEagerAggregate(s, jobId)))
{
  core__serviceInstances_clearTypeAggregate_ensures(s.services, eagerJob(s, jobId).callId);
}

lemma resumeAcquire_ensures(s: EagerServices, jobId: int)
  ensures (inv(s) ==> canResumeAcquire(s, jobId) ==> alwaysEagerAttemptLimit(resumeAcquire(s, jobId)))
  ensures (inv(s) ==> canResumeAcquire(s, jobId) ==> alwaysEagerJobsUnique(resumeAcquire(s, jobId)))
  ensures (inv(s) ==> canResumeAcquire(s, jobId) ==> alwaysSharedServiceStateValid(resumeAcquire(s, jobId)))
  ensures (inv(s) ==> canResumeAcquire(s, jobId) ==> alwaysEagerCallIdentitiesFresh(resumeAcquire(s, jobId)))
  ensures (inv(s) ==> canResumeAcquire(s, jobId) ==> stepNoEarlyWake(s, "resumeAcquire", resumeAcquire(s, jobId)))
{
  core__serviceInstances_resumeAcquire_ensures(s.services, eagerJob(s, jobId).callId);
}

lemma TheJobs(s: EagerServices, jobId: int)
  requires alwaysEagerJobsUnique(s)
  ensures forall k :: 0 <= k < |s.jobs| && s.jobs[k].id == jobId ==> s.jobs[k] == eagerJob(s, jobId)
{
  forall k | 0 <= k < |s.jobs| && s.jobs[k].id == jobId ensures s.jobs[k] == eagerJob(s, jobId) {
    var r := s.jobs[k];
    assert r in s.jobs;
    ProofLib.FilterSamePredicate((other: EagerRequest) => (other.id == r.id), (j: EagerRequest) => (j.id == jobId), s.jobs);
    ProofLib.FilterCountOneIffUnique((j: EagerRequest) => (j.id == jobId), s.jobs, (x: EagerRequest) => x.id, k);
    var f := ProofLib.Filter((j: EagerRequest) => (j.id == jobId), s.jobs);
    ProofLib.FilterMember((j: EagerRequest) => (j.id == jobId), s.jobs, f[0]);
    var m :| 0 <= m < |s.jobs| && s.jobs[m] == f[0];
  }
}

lemma SameIdsKeepJobsUnique(s: EagerServices, t: EagerServices)
  requires alwaysEagerJobsUnique(s) && |s.jobs| == |t.jobs|
  requires forall k :: 0 <= k < |s.jobs| ==> s.jobs[k].id == t.jobs[k].id
  ensures alwaysEagerJobsUnique(t)
{
  forall r | r in t.jobs ensures r.id > 0 && |ProofLib.Filter((other: EagerRequest) => (other.id == r.id), t.jobs)| == 1 {
    var k :| 0 <= k < |t.jobs| && t.jobs[k] == r;
    var q := s.jobs[k];
    assert q in s.jobs;
    ProofLib.FilterLengthPointwise((other: EagerRequest) => (other.id == q.id), (other: EagerRequest) => (other.id == r.id), s.jobs, t.jobs);
  }
}
