lemma ApprovalReadLookup(s: ApprovalRetirement, id: int)
  ensures readAt(s,id) == emptyQuery || (readAt(s,id) in s.queries && readAt(s,id).workId == id)
{
  var rs := ProofLib.Filter((query: ApprovalQuery) => query.workId == id,s.queries);
  if |rs| > 0 { ProofLib.FilterMember((query: ApprovalQuery) => query.workId == id,s.queries,rs[0]); }
}

lemma ApprovalReadSettlement(s: ApprovalRetirement, t: ApprovalRetirement, prior: ApprovalQuery, changed: ApprovalQuery)
  requires inv(s) && prior in s.queries && prior.workId == changed.workId && !readFinished(prior.phase)
  requires t == s.(queries := putRead(changed,s),tracker := readCompletion(changed,s))
  requires forall r :: r in s.queries && r.workId == prior.workId ==> r == prior
  ensures inv(t)
{
  ApprovalReplaceReadIdentity(s,t,changed);
  forall r | r in t.queries
    ensures (exists w :: w in t.tracker.works && w.id == r.workId && w.invoked && w.settled == readFinished(r.phase) && (w.active || readFinished(r.phase)))
  {
    var i :| 0 <= i < |t.queries| && t.queries[i] == r;
    var p := s.queries[i];
    assert p in s.queries;
    var w :| w in s.tracker.works && w.id == p.workId && w.invoked && w.settled == readFinished(p.phase) && (w.active || readFinished(p.phase));
    var j :| 0 <= j < |s.tracker.works| && s.tracker.works[j] == w;
    assert t.tracker.works[j] in t.tracker.works;
  }
}

lemma ApprovalReadsFrame(s: ApprovalRetirement,t: ApprovalRetirement)
  requires inv(s)
  requires t.approvals == s.approvals && t.queries == s.queries && t.drainId == s.drainId
  requires t.tracker.generation == s.tracker.generation && |t.tracker.works| == |s.tracker.works|
  requires forall i :: 0 <= i < |s.tracker.works| ==> (t.tracker.works[i].id == s.tracker.works[i].id &&
    t.tracker.works[i].invoked == s.tracker.works[i].invoked &&
    t.tracker.works[i].settled == s.tracker.works[i].settled &&
    (t.tracker.works[i].active ==> s.tracker.works[i].active) &&
    (!s.tracker.works[i].settled ==> t.tracker.works[i].active == s.tracker.works[i].active))
  ensures inv(t)
{
  forall r | r in t.queries
    ensures (exists w :: w in t.tracker.works && w.id == r.workId && w.invoked && w.settled == readFinished(r.phase) && (w.active || readFinished(r.phase)))
  {
    var w :| w in s.tracker.works && w.id == r.workId && w.invoked && w.settled == readFinished(r.phase) && (w.active || readFinished(r.phase));
    var j :| 0 <= j < |s.tracker.works| && s.tracker.works[j] == w;
    assert t.tracker.works[j] in t.tracker.works;
  }
}

lemma ApprovalReadUniqueBridge(s: ApprovalRetirement)
  ensures alwaysReadIdentitiesAreUnique(s) <==>
    (forall q :: q in s.queries ==> (q.workId > 0 && |ProofLib.Filter((other: ApprovalQuery) => other.workId == q.workId,s.queries)| == 1))
{}

lemma ApprovalReadAt(s: ApprovalRetirement,q: ApprovalQuery)
  requires alwaysReadIdentitiesAreUnique(s) && q in s.queries
  ensures readAt(s,q.workId) == q
{
  ApprovalReadUniqueBridge(s);
  var id := q.workId;
  var rs := ProofLib.Filter((query: ApprovalQuery) => query.workId == id,s.queries);
  ProofLib.FilterMember((query: ApprovalQuery) => query.workId == id,s.queries,q);
  assert |rs| == 1;
  assert rs[0] == q;
}

lemma ApprovalReplaceReadIdentity(s: ApprovalRetirement,t: ApprovalRetirement,changed: ApprovalQuery)
  requires alwaysReadIdentitiesAreUnique(s) && t.queries == putRead(changed,s)
  ensures alwaysReadIdentitiesAreUnique(t)
{
  ApprovalReadUniqueBridge(s); ApprovalReadUniqueBridge(t);
  forall q | q in t.queries ensures q.workId > 0 && |ProofLib.Filter((other: ApprovalQuery) => other.workId == q.workId,t.queries)| == 1 {
    var i :| 0 <= i < |t.queries| && t.queries[i] == q;
    var prior := s.queries[i];
    assert prior in s.queries;
    ProofLib.FilterLengthPointwise((other: ApprovalQuery) => other.workId == prior.workId,(other: ApprovalQuery) => other.workId == q.workId,s.queries,t.queries);
  }
}

lemma ApprovalReadAdmission(s: ApprovalRetirement,t: ApprovalRetirement,q: ApprovalQuery)
  requires inv(s) && !s.approvals.stopping && q.workId > 0
  requires !(exists w :: w in s.tracker.works && w.id == q.workId)
  requires t == s.(queries := s.queries + [q],
    tracker := core__retirementTracker_invokeWork(core__retirementTracker_publishWork(s.tracker,q.workId,false),q.workId))
  requires !readFinished(q.phase)
  ensures inv(t)
{
  ApprovalReadUniqueBridge(s); ApprovalReadUniqueBridge(t);
  forall r | r in s.queries ensures r.workId != q.workId
  {
    if r.workId == q.workId {
      var w :| w in s.tracker.works && w.id == r.workId && w.invoked && w.settled == readFinished(r.phase) && (w.active || readFinished(r.phase));
    }
  }
  forall r | r in t.queries
    ensures r.workId > 0 && |ProofLib.Filter((other: ApprovalQuery) => other.workId == r.workId,t.queries)| == 1
    ensures exists w :: w in t.tracker.works && w.id == r.workId && w.invoked && w.settled == readFinished(r.phase) && (w.active || readFinished(r.phase))
  {
    if r == q {
      ProofLib.FilterOne((other: ApprovalQuery) => other.workId == r.workId,t.queries,|s.queries|);
      assert t.tracker.works[|s.tracker.works|] in t.tracker.works;
    } else {
      assert r in s.queries;
      ProofLib.FilterAppend((other: ApprovalQuery) => other.workId == r.workId,s.queries,q);
      var w :| w in s.tracker.works && w.id == r.workId && w.invoked && w.settled == readFinished(r.phase) && (w.active || readFinished(r.phase));
      var j :| 0 <= j < |s.tracker.works| && s.tracker.works[j] == w;
      assert t.tracker.works[j] in t.tracker.works;
    }
  }
}

lemma admitRead_ensures(s: ApprovalRetirement, workId: int, kind: ApprovalReadKind, agentId: string, roomId: string, workerName: string)
  ensures (inv(s) ==> canAdmitRead(s, workId, kind, agentId, roomId, workerName) ==> alwaysRetiredHasNoReadOwner(admitRead(s, workId, kind, agentId, roomId, workerName)))
  ensures (inv(s) ==> canAdmitRead(s, workId, kind, agentId, roomId, workerName) ==> alwaysReadIdentitiesAreUnique(admitRead(s, workId, kind, agentId, roomId, workerName)))
  ensures (inv(s) ==> canAdmitRead(s, workId, kind, agentId, roomId, workerName) ==> alwaysReadPromisesStayAccounted(admitRead(s, workId, kind, agentId, roomId, workerName)))
  ensures (inv(s) ==> canAdmitRead(s, workId, kind, agentId, roomId, workerName) ==> alwaysApprovalComponentIsConsistent(admitRead(s, workId, kind, agentId, roomId, workerName)))
  ensures (inv(s) ==> canAdmitRead(s, workId, kind, agentId, roomId, workerName) ==> alwaysStopClosesAdmission(admitRead(s, workId, kind, agentId, roomId, workerName)))
{
  if inv(s) && canAdmitRead(s, workId, kind, agentId, roomId, workerName) {
    var t := admitRead(s, workId, kind, agentId, roomId, workerName);
    ApprovalReadAdmission(s,t,t.queries[|s.queries|]);
  }
}

lemma releaseRead_ensures(s: ApprovalRetirement, workId: int)
  ensures (inv(s) ==> canReleaseRead(s, workId) ==> alwaysRetiredHasNoReadOwner(releaseRead(s, workId)))
  ensures (inv(s) ==> canReleaseRead(s, workId) ==> alwaysReadIdentitiesAreUnique(releaseRead(s, workId)))
  ensures (inv(s) ==> canReleaseRead(s, workId) ==> alwaysReadPromisesStayAccounted(releaseRead(s, workId)))
  ensures (inv(s) ==> canReleaseRead(s, workId) ==> alwaysApprovalComponentIsConsistent(releaseRead(s, workId)))
  ensures (inv(s) ==> canReleaseRead(s, workId) ==> alwaysStopClosesAdmission(releaseRead(s, workId)))
{
  if inv(s) && canReleaseRead(s, workId) {
    var t := releaseRead(s, workId);
    ApprovalReadsFrame(s,t);
  }
}

lemma settleRoom_ensures(s: ApprovalRetirement, workId: int, ok: bool, worldPresent: bool)
  ensures (inv(s) ==> canSettleRoom(s, workId, ok, worldPresent) ==> alwaysRetiredHasNoReadOwner(settleRoom(s, workId, ok, worldPresent)))
  ensures (inv(s) ==> canSettleRoom(s, workId, ok, worldPresent) ==> alwaysReadIdentitiesAreUnique(settleRoom(s, workId, ok, worldPresent)))
  ensures (inv(s) ==> canSettleRoom(s, workId, ok, worldPresent) ==> alwaysReadPromisesStayAccounted(settleRoom(s, workId, ok, worldPresent)))
  ensures (inv(s) ==> canSettleRoom(s, workId, ok, worldPresent) ==> alwaysApprovalComponentIsConsistent(settleRoom(s, workId, ok, worldPresent)))
  ensures (inv(s) ==> canSettleRoom(s, workId, ok, worldPresent) ==> alwaysStopClosesAdmission(settleRoom(s, workId, ok, worldPresent)))
{
  if inv(s) && canSettleRoom(s, workId, ok, worldPresent) {
    var t := settleRoom(s, workId, ok, worldPresent);
    ApprovalReadLookup(s,workId);
    var prior := readAt(s,workId);
    assert prior in s.queries;
    var i :| 0 <= i < |s.queries| && s.queries[i] == prior;
    forall r | r in s.queries && r.workId == workId ensures r == prior { ApprovalReadAt(s,r); }
    ApprovalReadSettlement(s,t,prior,t.queries[i]);
  }
}

lemma settleRole_ensures(s: ApprovalRetirement, workId: int, ok: bool, role: string)
  ensures (inv(s) ==> canSettleRole(s, workId, ok, role) ==> alwaysRetiredHasNoReadOwner(settleRole(s, workId, ok, role)))
  ensures (inv(s) ==> canSettleRole(s, workId, ok, role) ==> alwaysReadIdentitiesAreUnique(settleRole(s, workId, ok, role)))
  ensures (inv(s) ==> canSettleRole(s, workId, ok, role) ==> alwaysReadPromisesStayAccounted(settleRole(s, workId, ok, role)))
  ensures (inv(s) ==> canSettleRole(s, workId, ok, role) ==> alwaysApprovalComponentIsConsistent(settleRole(s, workId, ok, role)))
  ensures (inv(s) ==> canSettleRole(s, workId, ok, role) ==> alwaysStopClosesAdmission(settleRole(s, workId, ok, role)))
{
  if inv(s) && canSettleRole(s, workId, ok, role) {
    var t := settleRole(s, workId, ok, role);
    ApprovalReadLookup(s,workId);
    var prior := readAt(s,workId);
    assert prior in s.queries;
    var i :| 0 <= i < |s.queries| && s.queries[i] == prior;
    forall r | r in s.queries && r.workId == workId ensures r == prior { ApprovalReadAt(s,r); }
    ApprovalReadSettlement(s,t,prior,t.queries[i]);
  }
}

lemma settleTasks_ensures(s: ApprovalRetirement, workId: int, ok: bool, resultRows: seq<string>, foundWorkerTask: bool, allowedRoles: seq<string>)
  ensures (inv(s) ==> canSettleTasks(s, workId, ok, resultRows, foundWorkerTask, allowedRoles) ==> alwaysRetiredHasNoReadOwner(settleTasks(s, workId, ok, resultRows, foundWorkerTask, allowedRoles)))
  ensures (inv(s) ==> canSettleTasks(s, workId, ok, resultRows, foundWorkerTask, allowedRoles) ==> alwaysReadIdentitiesAreUnique(settleTasks(s, workId, ok, resultRows, foundWorkerTask, allowedRoles)))
  ensures (inv(s) ==> canSettleTasks(s, workId, ok, resultRows, foundWorkerTask, allowedRoles) ==> alwaysReadPromisesStayAccounted(settleTasks(s, workId, ok, resultRows, foundWorkerTask, allowedRoles)))
  ensures (inv(s) ==> canSettleTasks(s, workId, ok, resultRows, foundWorkerTask, allowedRoles) ==> alwaysApprovalComponentIsConsistent(settleTasks(s, workId, ok, resultRows, foundWorkerTask, allowedRoles)))
  ensures (inv(s) ==> canSettleTasks(s, workId, ok, resultRows, foundWorkerTask, allowedRoles) ==> alwaysStopClosesAdmission(settleTasks(s, workId, ok, resultRows, foundWorkerTask, allowedRoles)))
{
  if inv(s) && canSettleTasks(s, workId, ok, resultRows, foundWorkerTask, allowedRoles) {
    var t := settleTasks(s, workId, ok, resultRows, foundWorkerTask, allowedRoles);
    ApprovalReadLookup(s,workId);
    var prior := readAt(s,workId);
    assert prior in s.queries;
    var i :| 0 <= i < |s.queries| && s.queries[i] == prior;
    forall r | r in s.queries && r.workId == workId ensures r == prior { ApprovalReadAt(s,r); }
    ApprovalReadSettlement(s,t,prior,t.queries[i]);
  }
}

lemma retire_ensures(s: ApprovalRetirement)
  ensures (inv(s) ==> canRetire(s) ==> alwaysRetiredHasNoReadOwner(retire(s)))
  ensures (inv(s) ==> canRetire(s) ==> alwaysReadIdentitiesAreUnique(retire(s)))
  ensures (inv(s) ==> canRetire(s) ==> alwaysReadPromisesStayAccounted(retire(s)))
  ensures (inv(s) ==> canRetire(s) ==> alwaysApprovalComponentIsConsistent(retire(s)))
  ensures (inv(s) ==> canRetire(s) ==> alwaysStopClosesAdmission(retire(s)))
{
  if inv(s) && canRetire(s) {
    var t := retire(s);
    core__approvalService_retire_ensures(s.approvals);
  }
}

lemma elapse_ensures(s: ApprovalRetirement, elapsed: int)
  ensures (inv(s) ==> canElapse(s, elapsed) ==> alwaysRetiredHasNoReadOwner(elapse(s, elapsed)))
  ensures (inv(s) ==> canElapse(s, elapsed) ==> alwaysReadIdentitiesAreUnique(elapse(s, elapsed)))
  ensures (inv(s) ==> canElapse(s, elapsed) ==> alwaysReadPromisesStayAccounted(elapse(s, elapsed)))
  ensures (inv(s) ==> canElapse(s, elapsed) ==> alwaysApprovalComponentIsConsistent(elapse(s, elapsed)))
  ensures (inv(s) ==> canElapse(s, elapsed) ==> alwaysStopClosesAdmission(elapse(s, elapsed)))
{
  if inv(s) && canElapse(s, elapsed) {
    var t := elapse(s, elapsed);
    core__approvalService_elapse_ensures(s.approvals, elapsed);
  }
}

lemma observeTime_ensures(s: ApprovalRetirement, now: int)
  ensures (inv(s) ==> canObserveTime(s, now) ==> alwaysRetiredHasNoReadOwner(observeTime(s, now)))
  ensures (inv(s) ==> canObserveTime(s, now) ==> alwaysReadIdentitiesAreUnique(observeTime(s, now)))
  ensures (inv(s) ==> canObserveTime(s, now) ==> alwaysReadPromisesStayAccounted(observeTime(s, now)))
  ensures (inv(s) ==> canObserveTime(s, now) ==> alwaysApprovalComponentIsConsistent(observeTime(s, now)))
  ensures (inv(s) ==> canObserveTime(s, now) ==> alwaysStopClosesAdmission(observeTime(s, now)))
{
  if inv(s) && canObserveTime(s, now) {
    var t := observeTime(s, now);
    core__approvalService_observeTime_ensures(s.approvals, now);
  }
}

lemma admit_ensures(s: ApprovalRetirement, id: string, name: string, callbackRequired: bool, registrationSucceeds: bool, timeoutMs: int)
  ensures (inv(s) ==> canAdmit(s, id, name, callbackRequired, registrationSucceeds, timeoutMs) ==> alwaysRetiredHasNoReadOwner(admit(s, id, name, callbackRequired, registrationSucceeds, timeoutMs)))
  ensures (inv(s) ==> canAdmit(s, id, name, callbackRequired, registrationSucceeds, timeoutMs) ==> alwaysReadIdentitiesAreUnique(admit(s, id, name, callbackRequired, registrationSucceeds, timeoutMs)))
  ensures (inv(s) ==> canAdmit(s, id, name, callbackRequired, registrationSucceeds, timeoutMs) ==> alwaysReadPromisesStayAccounted(admit(s, id, name, callbackRequired, registrationSucceeds, timeoutMs)))
  ensures (inv(s) ==> canAdmit(s, id, name, callbackRequired, registrationSucceeds, timeoutMs) ==> alwaysApprovalComponentIsConsistent(admit(s, id, name, callbackRequired, registrationSucceeds, timeoutMs)))
  ensures (inv(s) ==> canAdmit(s, id, name, callbackRequired, registrationSucceeds, timeoutMs) ==> alwaysStopClosesAdmission(admit(s, id, name, callbackRequired, registrationSucceeds, timeoutMs)))
{
  if inv(s) && canAdmit(s, id, name, callbackRequired, registrationSucceeds, timeoutMs) {
    var t := admit(s, id, name, callbackRequired, registrationSucceeds, timeoutMs);
    core__approvalService_admit_ensures(s.approvals, id, name, callbackRequired, registrationSucceeds, timeoutMs);
  }
}

lemma finishWrite_ensures(s: ApprovalRetirement, id: string, succeeded: bool)
  ensures (inv(s) ==> canFinishWrite(s, id, succeeded) ==> alwaysRetiredHasNoReadOwner(finishWrite(s, id, succeeded)))
  ensures (inv(s) ==> canFinishWrite(s, id, succeeded) ==> alwaysReadIdentitiesAreUnique(finishWrite(s, id, succeeded)))
  ensures (inv(s) ==> canFinishWrite(s, id, succeeded) ==> alwaysReadPromisesStayAccounted(finishWrite(s, id, succeeded)))
  ensures (inv(s) ==> canFinishWrite(s, id, succeeded) ==> alwaysApprovalComponentIsConsistent(finishWrite(s, id, succeeded)))
  ensures (inv(s) ==> canFinishWrite(s, id, succeeded) ==> alwaysStopClosesAdmission(finishWrite(s, id, succeeded)))
{
  if inv(s) && canFinishWrite(s, id, succeeded) {
    var t := finishWrite(s, id, succeeded);
    core__approvalService_finishWrite_ensures(s.approvals, id, succeeded);
  }
}

lemma claim_ensures(s: ApprovalRetirement, id: string, desired: core__approvals_Resolution)
  ensures (inv(s) ==> canClaim(s, id, desired) ==> alwaysRetiredHasNoReadOwner(claim(s, id, desired)))
  ensures (inv(s) ==> canClaim(s, id, desired) ==> alwaysReadIdentitiesAreUnique(claim(s, id, desired)))
  ensures (inv(s) ==> canClaim(s, id, desired) ==> alwaysReadPromisesStayAccounted(claim(s, id, desired)))
  ensures (inv(s) ==> canClaim(s, id, desired) ==> alwaysApprovalComponentIsConsistent(claim(s, id, desired)))
  ensures (inv(s) ==> canClaim(s, id, desired) ==> alwaysStopClosesAdmission(claim(s, id, desired)))
{
  if inv(s) && canClaim(s, id, desired) {
    var t := claim(s, id, desired);
    core__approvalService_claim_ensures(s.approvals, id, desired);
  }
}

lemma callback_ensures(s: ApprovalRetirement, id: string, succeeded: bool)
  ensures (inv(s) ==> canCallback(s, id, succeeded) ==> alwaysRetiredHasNoReadOwner(callback(s, id, succeeded)))
  ensures (inv(s) ==> canCallback(s, id, succeeded) ==> alwaysReadIdentitiesAreUnique(callback(s, id, succeeded)))
  ensures (inv(s) ==> canCallback(s, id, succeeded) ==> alwaysReadPromisesStayAccounted(callback(s, id, succeeded)))
  ensures (inv(s) ==> canCallback(s, id, succeeded) ==> alwaysApprovalComponentIsConsistent(callback(s, id, succeeded)))
  ensures (inv(s) ==> canCallback(s, id, succeeded) ==> alwaysStopClosesAdmission(callback(s, id, succeeded)))
{
  if inv(s) && canCallback(s, id, succeeded) {
    var t := callback(s, id, succeeded);
    core__approvalService_callback_ensures(s.approvals, id, succeeded);
  }
}

lemma deleteResult_ensures(s: ApprovalRetirement, id: string, succeeded: bool)
  ensures (inv(s) ==> canDeleteResult(s, id, succeeded) ==> alwaysRetiredHasNoReadOwner(deleteResult(s, id, succeeded)))
  ensures (inv(s) ==> canDeleteResult(s, id, succeeded) ==> alwaysReadIdentitiesAreUnique(deleteResult(s, id, succeeded)))
  ensures (inv(s) ==> canDeleteResult(s, id, succeeded) ==> alwaysReadPromisesStayAccounted(deleteResult(s, id, succeeded)))
  ensures (inv(s) ==> canDeleteResult(s, id, succeeded) ==> alwaysApprovalComponentIsConsistent(deleteResult(s, id, succeeded)))
  ensures (inv(s) ==> canDeleteResult(s, id, succeeded) ==> alwaysStopClosesAdmission(deleteResult(s, id, succeeded)))
{
  if inv(s) && canDeleteResult(s, id, succeeded) {
    var t := deleteResult(s, id, succeeded);
    core__approvalService_deleteResult_ensures(s.approvals, id, succeeded);
  }
}

lemma legacyCancel_ensures(s: ApprovalRetirement, id: string)
  ensures (inv(s) ==> canLegacyCancel(s, id) ==> alwaysRetiredHasNoReadOwner(legacyCancel(s, id)))
  ensures (inv(s) ==> canLegacyCancel(s, id) ==> alwaysReadIdentitiesAreUnique(legacyCancel(s, id)))
  ensures (inv(s) ==> canLegacyCancel(s, id) ==> alwaysReadPromisesStayAccounted(legacyCancel(s, id)))
  ensures (inv(s) ==> canLegacyCancel(s, id) ==> alwaysApprovalComponentIsConsistent(legacyCancel(s, id)))
  ensures (inv(s) ==> canLegacyCancel(s, id) ==> alwaysStopClosesAdmission(legacyCancel(s, id)))
{
  if inv(s) && canLegacyCancel(s, id) {
    var t := legacyCancel(s, id);
    core__approvalService_legacyCancel_ensures(s.approvals, id);
  }
}

lemma stop_ensures(s: ApprovalRetirement, drainId: int)
  ensures (inv(s) ==> canStop(s, drainId) ==> alwaysRetiredHasNoReadOwner(stop(s, drainId)))
  ensures (inv(s) ==> canStop(s, drainId) ==> alwaysReadIdentitiesAreUnique(stop(s, drainId)))
  ensures (inv(s) ==> canStop(s, drainId) ==> alwaysReadPromisesStayAccounted(stop(s, drainId)))
  ensures (inv(s) ==> canStop(s, drainId) ==> alwaysApprovalComponentIsConsistent(stop(s, drainId)))
  ensures (inv(s) ==> canStop(s, drainId) ==> alwaysStopClosesAdmission(stop(s, drainId)))
{
  if inv(s) && canStop(s, drainId) {
    var t := stop(s, drainId);
    core__approvalService_stop_ensures(s.approvals);
  }
}

lemma snapshotReads_ensures(s: ApprovalRetirement)
  ensures (inv(s) ==> canSnapshotReads(s) ==> alwaysRetiredHasNoReadOwner(snapshotReads(s)))
  ensures (inv(s) ==> canSnapshotReads(s) ==> alwaysReadIdentitiesAreUnique(snapshotReads(s)))
  ensures (inv(s) ==> canSnapshotReads(s) ==> alwaysReadPromisesStayAccounted(snapshotReads(s)))
  ensures (inv(s) ==> canSnapshotReads(s) ==> alwaysApprovalComponentIsConsistent(snapshotReads(s)))
  ensures (inv(s) ==> canSnapshotReads(s) ==> alwaysStopClosesAdmission(snapshotReads(s)))
{
  if inv(s) && canSnapshotReads(s) {
    var t := snapshotReads(s);
    ApprovalReadsFrame(s,t);
  }
}

lemma finishReadBatch_ensures(s: ApprovalRetirement)
  ensures (inv(s) ==> canFinishReadBatch(s) ==> alwaysRetiredHasNoReadOwner(finishReadBatch(s)))
  ensures (inv(s) ==> canFinishReadBatch(s) ==> alwaysReadIdentitiesAreUnique(finishReadBatch(s)))
  ensures (inv(s) ==> canFinishReadBatch(s) ==> alwaysReadPromisesStayAccounted(finishReadBatch(s)))
  ensures (inv(s) ==> canFinishReadBatch(s) ==> alwaysApprovalComponentIsConsistent(finishReadBatch(s)))
  ensures (inv(s) ==> canFinishReadBatch(s) ==> alwaysStopClosesAdmission(finishReadBatch(s)))
{
  if inv(s) && canFinishReadBatch(s) {
    var t := finishReadBatch(s);
    ApprovalReadsFrame(s,t);
  }
}
