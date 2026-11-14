lemma ApprovalRecords(s: ApprovalServiceState, t: ApprovalServiceState)
  requires alwaysApprovalRecordsAreUnique(s)
  requires |s.records| == |t.records|
  requires forall i :: 0 <= i < |s.records| ==> (s.records[i].id == t.records[i].id && s.records[i].name == t.records[i].name)
  requires s.workers.registered == t.workers.registered
  ensures alwaysApprovalRecordsAreUnique(t)
{
  ApprovalUniqueBridge(s);
  forall i | 0 <= i < |t.records|
    ensures t.records[i].id != "" && t.records[i].name in t.workers.registered &&
      |ProofLib.Filter((other: ServiceApproval) => other.id == t.records[i].id, t.records)| == 1
  {
    var r := s.records[i];
    assert r in s.records;
    ProofLib.FilterCountOneIffUnique((other: ServiceApproval) => other.id == r.id, s.records, (other: ServiceApproval) => other.id, i);
    ProofLib.FilterCountOneIffUnique((other: ServiceApproval) => other.id == t.records[i].id, t.records, (other: ServiceApproval) => other.id, i);
  }
  forall r | r in t.records
    ensures r.id != "" && r.name in t.workers.registered &&
      |ProofLib.Filter((other: ServiceApproval) => other.id == r.id, t.records)| == 1
  {
    var i :| 0 <= i < |t.records| && t.records[i] == r;
  }
  ApprovalUniqueBridge(t);
}

lemma ApprovalUniqueBridge(s: ApprovalServiceState)
  ensures alwaysApprovalRecordsAreUnique(s) <==>
    (forall r :: r in s.records ==> (r.id != "" && |ProofLib.Filter((other: ServiceApproval) => other.id == r.id, s.records)| == 1 && r.name in s.workers.registered))
{}

lemma ApprovalLookup(s: ApprovalServiceState, id: string)
  ensures approvalAt(s, id) == absent ||
    (approvalAt(s, id) in s.records && approvalAt(s, id).id == id)
{
  var selected := ProofLib.Filter((record: ServiceApproval) => record.id == id, s.records);
  if |selected| > 0 {
    ProofLib.FilterMember((record: ServiceApproval) => record.id == id, s.records, selected[0]);
  }
}

lemma ApprovalSlots(s: ApprovalServiceState, t: ApprovalServiceState)
  requires inv(s)
  requires |t.records| == |s.records|
  requires forall i :: 0 <= i < |s.records| ==> t.records[i].id == s.records[i].id && t.records[i].name == s.records[i].name
  requires t.workers == s.workers
  requires t.now >= 0
  requires forall i :: 0 <= i < |t.records| ==>
    core__approvals_validApproval(t.records[i].approval) &&
    t.records[i].approval.stopping == t.stopping &&
    ((t.records[i].approval.phase.Pending? || t.records[i].approval.phase.Cancelling?) && !t.stopping <==> t.records[i].id in t.pendingIds) &&
    (t.records[i].timeoutArmed ==> t.records[i].approval.phase.Pending? && !t.stopping && t.records[i].timeoutMs > 0 && t.records[i].timeoutRemaining >= 0 && t.records[i].expiresAt == t.records[i].createdAt + t.records[i].timeoutMs) &&
    ((t.records[i].approval.phase.Pending? || t.records[i].approval.phase.Cancelling?) && t.records[i].timeoutMs > 0 ==> t.records[i].expiresAt == t.records[i].createdAt + t.records[i].timeoutMs) &&
    (t.retired ==> t.records[i].approval.retired)
  requires t.stopping ==> |t.pendingIds| == 0
  requires forall id :: id in t.pendingIds ==> exists r :: r in t.records && r.id == id
  requires t.retired ==> t.stopping && |t.pendingIds| == 0
  ensures inv(t)
{
  ApprovalRecords(s, t);
  forall r | r in t.records
    ensures core__approvals_validApproval(r.approval) && r.approval.stopping == t.stopping &&
      (((r.approval.phase.Pending? || r.approval.phase.Cancelling?) && !t.stopping) <==> r.id in t.pendingIds) &&
      (r.timeoutArmed ==> r.approval.phase.Pending? && !t.stopping && r.timeoutMs > 0 && r.timeoutRemaining >= 0 && r.expiresAt == r.createdAt + r.timeoutMs) &&
      ((r.approval.phase.Pending? || r.approval.phase.Cancelling?) && r.timeoutMs > 0 ==> r.expiresAt == r.createdAt + r.timeoutMs) &&
      (t.retired ==> r.approval.retired)
  {
    var i :| 0 <= i < |t.records| && t.records[i] == r;
  }
}

lemma ApprovalRetainedOwner(s: ApprovalServiceState, t: ApprovalServiceState, id: string)
  requires |t.records| == |s.records|
  requires forall i :: 0 <= i < |s.records| ==> t.records[i].id == s.records[i].id
  requires exists r :: r in s.records && r.id == id
  ensures exists r :: r in t.records && r.id == id
{
  var r :| r in s.records && r.id == id;
  var i :| 0 <= i < |s.records| && s.records[i] == r;
  assert t.records[i] in t.records;
}

lemma elapse_ensures(s: ApprovalServiceState, elapsed: int)
  ensures (inv(s) ==> canElapse(s, elapsed) ==> alwaysCancellableRecordsKeepDeadline(elapse(s, elapsed)))
  ensures (inv(s) ==> canElapse(s, elapsed) ==> alwaysApprovalRecordsAreUnique(elapse(s, elapsed)))
  ensures (inv(s) ==> canElapse(s, elapsed) ==> alwaysAllComponentsRetainSafety(elapse(s, elapsed)))
  ensures (inv(s) ==> canElapse(s, elapsed) ==> alwaysRetirementDrainsEveryApproval(elapse(s, elapsed)))
  ensures (inv(s) ==> canElapse(s, elapsed) ==> alwaysPendingMapOwnsExactlyPending(elapse(s, elapsed)))
  ensures (inv(s) ==> canElapse(s, elapsed) ==> alwaysArmedTimersBelongToPending(elapse(s, elapsed)))
{
 if inv(s) && canElapse(s, elapsed) {
  var t := elapse(s, elapsed);
  forall i | 0 <= i < |t.records|
    ensures core__approvals_validApproval(t.records[i].approval) &&
      t.records[i].approval.stopping == t.stopping &&
      (((t.records[i].approval.phase.Pending? || t.records[i].approval.phase.Cancelling?) && !t.stopping) <==> t.records[i].id in t.pendingIds) &&
      (t.records[i].timeoutArmed ==> t.records[i].approval.phase.Pending? && !t.stopping && t.records[i].timeoutMs > 0 && t.records[i].timeoutRemaining >= 0 && t.records[i].expiresAt == t.records[i].createdAt + t.records[i].timeoutMs) &&
      ((t.records[i].approval.phase.Pending? || t.records[i].approval.phase.Cancelling?) && t.records[i].timeoutMs > 0 ==> t.records[i].expiresAt == t.records[i].createdAt + t.records[i].timeoutMs) &&
      (t.retired ==> t.records[i].approval.retired)
  {
    var r := s.records[i];
    assert r in s.records;

  }
  forall key | key in t.pendingIds ensures exists r :: r in t.records && r.id == key {
    assert key in s.pendingIds;
    ApprovalRetainedOwner(s, t, key);
  }
  ApprovalSlots(s, t);
 }
}

lemma stop_ensures(s: ApprovalServiceState)
  ensures (inv(s) ==> canStop(s) ==> alwaysCancellableRecordsKeepDeadline(stop(s)))
  ensures (inv(s) ==> canStop(s) ==> alwaysApprovalRecordsAreUnique(stop(s)))
  ensures (inv(s) ==> canStop(s) ==> alwaysAllComponentsRetainSafety(stop(s)))
  ensures (inv(s) ==> canStop(s) ==> alwaysRetirementDrainsEveryApproval(stop(s)))
  ensures (inv(s) ==> canStop(s) ==> alwaysPendingMapOwnsExactlyPending(stop(s)))
  ensures (inv(s) ==> canStop(s) ==> alwaysArmedTimersBelongToPending(stop(s)))
{
 if inv(s) && canStop(s) {
  var t := stop(s);
  forall i | 0 <= i < |t.records|
    ensures core__approvals_validApproval(t.records[i].approval) &&
      t.records[i].approval.stopping == t.stopping &&
      (((t.records[i].approval.phase.Pending? || t.records[i].approval.phase.Cancelling?) && !t.stopping) <==> t.records[i].id in t.pendingIds) &&
      (t.records[i].timeoutArmed ==> t.records[i].approval.phase.Pending? && !t.stopping && t.records[i].timeoutMs > 0 && t.records[i].timeoutRemaining >= 0 && t.records[i].expiresAt == t.records[i].createdAt + t.records[i].timeoutMs) &&
      ((t.records[i].approval.phase.Pending? || t.records[i].approval.phase.Cancelling?) && t.records[i].timeoutMs > 0 ==> t.records[i].expiresAt == t.records[i].createdAt + t.records[i].timeoutMs) &&
      (t.retired ==> t.records[i].approval.retired)
  {
    var r := s.records[i];
    assert r in s.records;
    core__approvals_stop_ensures(r.approval);
  }
  ApprovalSlots(s, t);
 }
}

lemma retire_ensures(s: ApprovalServiceState)
  ensures (inv(s) ==> canRetire(s) ==> alwaysCancellableRecordsKeepDeadline(retire(s)))
  ensures (inv(s) ==> canRetire(s) ==> alwaysApprovalRecordsAreUnique(retire(s)))
  ensures (inv(s) ==> canRetire(s) ==> alwaysAllComponentsRetainSafety(retire(s)))
  ensures (inv(s) ==> canRetire(s) ==> alwaysRetirementDrainsEveryApproval(retire(s)))
  ensures (inv(s) ==> canRetire(s) ==> alwaysPendingMapOwnsExactlyPending(retire(s)))
  ensures (inv(s) ==> canRetire(s) ==> alwaysArmedTimersBelongToPending(retire(s)))
{
 if inv(s) && canRetire(s) {
  var t := retire(s);
  forall i | 0 <= i < |t.records|
    ensures core__approvals_validApproval(t.records[i].approval) &&
      t.records[i].approval.stopping == t.stopping &&
      (((t.records[i].approval.phase.Pending? || t.records[i].approval.phase.Cancelling?) && !t.stopping) <==> t.records[i].id in t.pendingIds) &&
      (t.records[i].timeoutArmed ==> t.records[i].approval.phase.Pending? && !t.stopping && t.records[i].timeoutMs > 0 && t.records[i].timeoutRemaining >= 0 && t.records[i].expiresAt == t.records[i].createdAt + t.records[i].timeoutMs) &&
      ((t.records[i].approval.phase.Pending? || t.records[i].approval.phase.Cancelling?) && t.records[i].timeoutMs > 0 ==> t.records[i].expiresAt == t.records[i].createdAt + t.records[i].timeoutMs) &&
      (t.retired ==> t.records[i].approval.retired)
  {
    var r := s.records[i];
    assert r in s.records;
    core__approvals_retire_ensures(r.approval);
  }
  forall key | key in t.pendingIds ensures exists r :: r in t.records && r.id == key {
    assert key in s.pendingIds;
    ApprovalRetainedOwner(s, t, key);
  }
  ApprovalSlots(s, t);
 }
}

lemma claim_ensures(s: ApprovalServiceState, id: string, desired: core__approvals_Resolution)
  ensures (inv(s) ==> canClaim(s, id, desired) ==> alwaysCancellableRecordsKeepDeadline(claim(s, id, desired)))
  ensures (inv(s) ==> canClaim(s, id, desired) ==> alwaysApprovalRecordsAreUnique(claim(s, id, desired)))
  ensures (inv(s) ==> canClaim(s, id, desired) ==> alwaysAllComponentsRetainSafety(claim(s, id, desired)))
  ensures (inv(s) ==> canClaim(s, id, desired) ==> alwaysRetirementDrainsEveryApproval(claim(s, id, desired)))
  ensures (inv(s) ==> canClaim(s, id, desired) ==> alwaysPendingMapOwnsExactlyPending(claim(s, id, desired)))
  ensures (inv(s) ==> canClaim(s, id, desired) ==> alwaysArmedTimersBelongToPending(claim(s, id, desired)))
{
 if inv(s) && canClaim(s, id, desired) {
  var t := claim(s, id, desired);
  ApprovalLookup(s, id);
  var own := approvalAt(s, id);
  assert own in s.records && own.id == id;
  forall key: string | key != id ensures (key in t.pendingIds <==> key in s.pendingIds) {
    ProofLib.FilterMember((set_x: string) => !(set_x in [id]), s.pendingIds, key);
    ProofLib.FilterMember((set_x: string) => !(set_x in s.pendingIds), [id], key);
  }
  ProofLib.FilterMember((set_x: string) => !(set_x in [id]), s.pendingIds, id);
  ProofLib.FilterMember((set_x: string) => !(set_x in s.pendingIds), [id], id);
  forall i | 0 <= i < |t.records|
    ensures core__approvals_validApproval(t.records[i].approval) &&
      t.records[i].approval.stopping == t.stopping &&
      (((t.records[i].approval.phase.Pending? || t.records[i].approval.phase.Cancelling?) && !t.stopping) <==> t.records[i].id in t.pendingIds) &&
      (t.records[i].timeoutArmed ==> t.records[i].approval.phase.Pending? && !t.stopping && t.records[i].timeoutMs > 0 && t.records[i].timeoutRemaining >= 0 && t.records[i].expiresAt == t.records[i].createdAt + t.records[i].timeoutMs) &&
      ((t.records[i].approval.phase.Pending? || t.records[i].approval.phase.Cancelling?) && t.records[i].timeoutMs > 0 ==> t.records[i].expiresAt == t.records[i].createdAt + t.records[i].timeoutMs) &&
      (t.retired ==> t.records[i].approval.retired)
  {
    var r := s.records[i];
    assert r in s.records;
    if r.id == id {
      ApprovalAtRecord(s, r, i);
      core__approvals_claim_ensures(r.approval, desired);
    }
  }
  forall key | key in t.pendingIds ensures exists r :: r in t.records && r.id == key {
    if key == id {
      assert own in s.records;
    } else { assert key in s.pendingIds; }
    ApprovalRetainedOwner(s, t, key);
  }
  forall i | 0 <= i < |s.records|
    ensures t.records[i].id == s.records[i].id && t.records[i].name == s.records[i].name
  {
    if s.records[i].id == id {
      ApprovalAtRecord(s, s.records[i], i);
    }
  }
  ApprovalSlots(s, t);
 }
}

lemma callback_ensures(s: ApprovalServiceState, id: string, succeeded: bool)
  ensures (inv(s) ==> canCallback(s, id, succeeded) ==> alwaysCancellableRecordsKeepDeadline(callback(s, id, succeeded)))
  ensures (inv(s) ==> canCallback(s, id, succeeded) ==> alwaysApprovalRecordsAreUnique(callback(s, id, succeeded)))
  ensures (inv(s) ==> canCallback(s, id, succeeded) ==> alwaysAllComponentsRetainSafety(callback(s, id, succeeded)))
  ensures (inv(s) ==> canCallback(s, id, succeeded) ==> alwaysRetirementDrainsEveryApproval(callback(s, id, succeeded)))
  ensures (inv(s) ==> canCallback(s, id, succeeded) ==> alwaysPendingMapOwnsExactlyPending(callback(s, id, succeeded)))
  ensures (inv(s) ==> canCallback(s, id, succeeded) ==> alwaysArmedTimersBelongToPending(callback(s, id, succeeded)))
{
 if inv(s) && canCallback(s, id, succeeded) {
  var t := callback(s, id, succeeded);
  ApprovalLookup(s, id);
  var own := approvalAt(s, id);
  assert own in s.records && own.id == id;
  forall i | 0 <= i < |t.records|
    ensures core__approvals_validApproval(t.records[i].approval) &&
      t.records[i].approval.stopping == t.stopping &&
      (((t.records[i].approval.phase.Pending? || t.records[i].approval.phase.Cancelling?) && !t.stopping) <==> t.records[i].id in t.pendingIds) &&
      (t.records[i].timeoutArmed ==> t.records[i].approval.phase.Pending? && !t.stopping && t.records[i].timeoutMs > 0 && t.records[i].timeoutRemaining >= 0 && t.records[i].expiresAt == t.records[i].createdAt + t.records[i].timeoutMs) &&
      ((t.records[i].approval.phase.Pending? || t.records[i].approval.phase.Cancelling?) && t.records[i].timeoutMs > 0 ==> t.records[i].expiresAt == t.records[i].createdAt + t.records[i].timeoutMs) &&
      (t.retired ==> t.records[i].approval.retired)
  {
    var r := s.records[i];
    assert r in s.records;
    if r.id == id {
      ApprovalAtRecord(s, r, i);
      core__approvals_callback_ensures(r.approval, succeeded);
    }
  }
  forall key | key in t.pendingIds ensures exists r :: r in t.records && r.id == key {
    if key == id {
      assert own in s.records;
    } else { assert key in s.pendingIds; }
    ApprovalRetainedOwner(s, t, key);
  }
  forall i | 0 <= i < |s.records|
    ensures t.records[i].id == s.records[i].id && t.records[i].name == s.records[i].name
  {
    if s.records[i].id == id {
      ApprovalAtRecord(s, s.records[i], i);
    }
  }
  ApprovalSlots(s, t);
 }
}

lemma legacyCancel_ensures(s: ApprovalServiceState, id: string)
  ensures (inv(s) ==> canLegacyCancel(s, id) ==> alwaysCancellableRecordsKeepDeadline(legacyCancel(s, id)))
  ensures (inv(s) ==> canLegacyCancel(s, id) ==> alwaysApprovalRecordsAreUnique(legacyCancel(s, id)))
  ensures (inv(s) ==> canLegacyCancel(s, id) ==> alwaysAllComponentsRetainSafety(legacyCancel(s, id)))
  ensures (inv(s) ==> canLegacyCancel(s, id) ==> alwaysRetirementDrainsEveryApproval(legacyCancel(s, id)))
  ensures (inv(s) ==> canLegacyCancel(s, id) ==> alwaysPendingMapOwnsExactlyPending(legacyCancel(s, id)))
  ensures (inv(s) ==> canLegacyCancel(s, id) ==> alwaysArmedTimersBelongToPending(legacyCancel(s, id)))
{
 if inv(s) && canLegacyCancel(s, id) {
  var t := legacyCancel(s, id);
  ApprovalLookup(s, id);
  var own := approvalAt(s, id);
  assert own in s.records && own.id == id;
  forall key: string | key != id ensures (key in t.pendingIds <==> key in s.pendingIds) {
    ProofLib.FilterMember((set_x: string) => !(set_x in [id]), s.pendingIds, key);
    ProofLib.FilterMember((set_x: string) => !(set_x in s.pendingIds), [id], key);
  }
  ProofLib.FilterMember((set_x: string) => !(set_x in [id]), s.pendingIds, id);
  ProofLib.FilterMember((set_x: string) => !(set_x in s.pendingIds), [id], id);
  forall i | 0 <= i < |t.records|
    ensures core__approvals_validApproval(t.records[i].approval) &&
      t.records[i].approval.stopping == t.stopping &&
      (((t.records[i].approval.phase.Pending? || t.records[i].approval.phase.Cancelling?) && !t.stopping) <==> t.records[i].id in t.pendingIds) &&
      (t.records[i].timeoutArmed ==> t.records[i].approval.phase.Pending? && !t.stopping && t.records[i].timeoutMs > 0 && t.records[i].timeoutRemaining >= 0 && t.records[i].expiresAt == t.records[i].createdAt + t.records[i].timeoutMs) &&
      ((t.records[i].approval.phase.Pending? || t.records[i].approval.phase.Cancelling?) && t.records[i].timeoutMs > 0 ==> t.records[i].expiresAt == t.records[i].createdAt + t.records[i].timeoutMs) &&
      (t.retired ==> t.records[i].approval.retired)
  {
    var r := s.records[i];
    assert r in s.records;
    if r.id == id {
      ApprovalAtRecord(s, r, i);
      core__approvals_legacyCancel_ensures(r.approval);
    }
  }
  forall key | key in t.pendingIds ensures exists r :: r in t.records && r.id == key {
    if key == id {
      assert own in s.records;
    } else { assert key in s.pendingIds; }
    ApprovalRetainedOwner(s, t, key);
  }
  forall i | 0 <= i < |s.records|
    ensures t.records[i].id == s.records[i].id && t.records[i].name == s.records[i].name
  {
    if s.records[i].id == id {
      ApprovalAtRecord(s, s.records[i], i);
    }
  }
  ApprovalSlots(s, t);
 }
}

lemma finishWrite_ensures(s: ApprovalServiceState, id: string, succeeded: bool)
  ensures (inv(s) ==> canFinishWrite(s, id, succeeded) ==> alwaysCancellableRecordsKeepDeadline(finishWrite(s, id, succeeded)))
  ensures (inv(s) ==> canFinishWrite(s, id, succeeded) ==> alwaysApprovalRecordsAreUnique(finishWrite(s, id, succeeded)))
  ensures (inv(s) ==> canFinishWrite(s, id, succeeded) ==> alwaysAllComponentsRetainSafety(finishWrite(s, id, succeeded)))
  ensures (inv(s) ==> canFinishWrite(s, id, succeeded) ==> alwaysRetirementDrainsEveryApproval(finishWrite(s, id, succeeded)))
  ensures (inv(s) ==> canFinishWrite(s, id, succeeded) ==> alwaysPendingMapOwnsExactlyPending(finishWrite(s, id, succeeded)))
  ensures (inv(s) ==> canFinishWrite(s, id, succeeded) ==> alwaysArmedTimersBelongToPending(finishWrite(s, id, succeeded)))
{
 if inv(s) && canFinishWrite(s, id, succeeded) {
  var t := finishWrite(s, id, succeeded);
  ApprovalLookup(s, id);
  var own := approvalAt(s, id);
  assert own in s.records && own.id == id;
  forall key: string | key != id ensures (key in t.pendingIds <==> key in s.pendingIds) {
    ProofLib.FilterMember((set_x: string) => !(set_x in [id]), s.pendingIds, key);
    ProofLib.FilterMember((set_x: string) => !(set_x in s.pendingIds), [id], key);
  }
  ProofLib.FilterMember((set_x: string) => !(set_x in [id]), s.pendingIds, id);
  ProofLib.FilterMember((set_x: string) => !(set_x in s.pendingIds), [id], id);
  forall i | 0 <= i < |t.records|
    ensures core__approvals_validApproval(t.records[i].approval) &&
      t.records[i].approval.stopping == t.stopping &&
      (((t.records[i].approval.phase.Pending? || t.records[i].approval.phase.Cancelling?) && !t.stopping) <==> t.records[i].id in t.pendingIds) &&
      (t.records[i].timeoutArmed ==> t.records[i].approval.phase.Pending? && !t.stopping && t.records[i].timeoutMs > 0 && t.records[i].timeoutRemaining >= 0 && t.records[i].expiresAt == t.records[i].createdAt + t.records[i].timeoutMs) &&
      ((t.records[i].approval.phase.Pending? || t.records[i].approval.phase.Cancelling?) && t.records[i].timeoutMs > 0 ==> t.records[i].expiresAt == t.records[i].createdAt + t.records[i].timeoutMs) &&
      (t.retired ==> t.records[i].approval.retired)
  {
    var r := s.records[i];
    assert r in s.records;
    if r.id == id {
      ApprovalAtRecord(s, r, i);
      if !succeeded { core__approvals_writeFailed_ensures(r.approval); } else if s.stopping { core__approvals_finishLateWrite_ensures(r.approval); } else { core__approvals_publish_ensures(r.approval); }
    }
  }
  forall key | key in t.pendingIds ensures exists r :: r in t.records && r.id == key {
    if key == id {
      assert own in s.records;
    } else { assert key in s.pendingIds; }
    ApprovalRetainedOwner(s, t, key);
  }
  forall i | 0 <= i < |s.records|
    ensures t.records[i].id == s.records[i].id && t.records[i].name == s.records[i].name
  {
    if s.records[i].id == id {
      ApprovalAtRecord(s, s.records[i], i);
    }
  }
  ApprovalSlots(s, t);
 }
}

lemma deleteResult_ensures(s: ApprovalServiceState, id: string, succeeded: bool)
  ensures (inv(s) ==> canDeleteResult(s, id, succeeded) ==> alwaysCancellableRecordsKeepDeadline(deleteResult(s, id, succeeded)))
  ensures (inv(s) ==> canDeleteResult(s, id, succeeded) ==> alwaysApprovalRecordsAreUnique(deleteResult(s, id, succeeded)))
  ensures (inv(s) ==> canDeleteResult(s, id, succeeded) ==> alwaysAllComponentsRetainSafety(deleteResult(s, id, succeeded)))
  ensures (inv(s) ==> canDeleteResult(s, id, succeeded) ==> alwaysRetirementDrainsEveryApproval(deleteResult(s, id, succeeded)))
  ensures (inv(s) ==> canDeleteResult(s, id, succeeded) ==> alwaysPendingMapOwnsExactlyPending(deleteResult(s, id, succeeded)))
  ensures (inv(s) ==> canDeleteResult(s, id, succeeded) ==> alwaysArmedTimersBelongToPending(deleteResult(s, id, succeeded)))
{
 if inv(s) && canDeleteResult(s, id, succeeded) {
  var t := deleteResult(s, id, succeeded);
  ApprovalLookup(s, id);
  var own := approvalAt(s, id);
  assert own in s.records && own.id == id;
  forall key: string | key != id ensures (key in t.pendingIds <==> key in s.pendingIds) {
    ProofLib.FilterMember((set_x: string) => !(set_x in [id]), s.pendingIds, key);
    ProofLib.FilterMember((set_x: string) => !(set_x in s.pendingIds), [id], key);
  }
  ProofLib.FilterMember((set_x: string) => !(set_x in [id]), s.pendingIds, id);
  ProofLib.FilterMember((set_x: string) => !(set_x in s.pendingIds), [id], id);
  forall i | 0 <= i < |t.records|
    ensures core__approvals_validApproval(t.records[i].approval) &&
      t.records[i].approval.stopping == t.stopping &&
      (((t.records[i].approval.phase.Pending? || t.records[i].approval.phase.Cancelling?) && !t.stopping) <==> t.records[i].id in t.pendingIds) &&
      (t.records[i].timeoutArmed ==> t.records[i].approval.phase.Pending? && !t.stopping && t.records[i].timeoutMs > 0 && t.records[i].timeoutRemaining >= 0 && t.records[i].expiresAt == t.records[i].createdAt + t.records[i].timeoutMs) &&
      ((t.records[i].approval.phase.Pending? || t.records[i].approval.phase.Cancelling?) && t.records[i].timeoutMs > 0 ==> t.records[i].expiresAt == t.records[i].createdAt + t.records[i].timeoutMs) &&
      (t.retired ==> t.records[i].approval.retired)
  {
    var r := s.records[i];
    assert r in s.records;
    if r.id == id {
      ApprovalAtRecord(s, r, i);
      if succeeded { core__approvals_deleted_ensures(r.approval); } else { core__approvals_deleteFailed_ensures(r.approval); }
    }
  }
  forall key | key in t.pendingIds ensures exists r :: r in t.records && r.id == key {
    if key == id {
      assert own in s.records;
    } else { assert key in s.pendingIds; }
    ApprovalRetainedOwner(s, t, key);
  }
  forall i | 0 <= i < |s.records|
    ensures t.records[i].id == s.records[i].id && t.records[i].name == s.records[i].name
  {
    if s.records[i].id == id {
      ApprovalAtRecord(s, s.records[i], i);
    }
  }
  ApprovalSlots(s, t);
 }
}

lemma ApprovalAtRecord(s: ApprovalServiceState, r: ServiceApproval, i: int)
  requires alwaysApprovalRecordsAreUnique(s)
  requires 0 <= i < |s.records| && s.records[i] == r
  ensures approvalAt(s, r.id) == r
{
  ApprovalUniqueBridge(s);
  assert r in s.records;
  var selected := ProofLib.Filter((record: ServiceApproval) => record.id == r.id, s.records);
  ProofLib.FilterMember((record: ServiceApproval) => record.id == r.id, s.records, r);
  assert |selected| == 1;
  assert selected[0] == r;
}

lemma ApprovalAdmittedRecords(s: ApprovalServiceState, t: ApprovalServiceState, record: ServiceApproval)
  requires alwaysApprovalRecordsAreUnique(s)
  requires record.id != "" && !(exists r :: r in s.records && r.id == record.id)
  requires forall n :: n in s.workers.registered ==> n in t.workers.registered
  requires record.name in t.workers.registered
  requires t.records == s.records + [record]
  ensures alwaysApprovalRecordsAreUnique(t)
{
  ApprovalUniqueBridge(s);
  forall r | r in t.records
    ensures r.id != "" && r.name in t.workers.registered &&
      |ProofLib.Filter((other: ServiceApproval) => other.id == r.id, t.records)| == 1
  {
    if r == record {
      ProofLib.FilterOne((other: ServiceApproval) => other.id == r.id, t.records, |s.records|);
    } else {
      assert r in s.records;
      ProofLib.FilterAppend((other: ServiceApproval) => other.id == r.id, s.records, record);
    }
  }
  ApprovalUniqueBridge(t);
}

lemma admit_ensures(s: ApprovalServiceState, id: string, name: string, callbackRequired: bool, registrationSucceeds: bool, timeoutMs: int)
  ensures (inv(s) ==> canAdmit(s, id, name, callbackRequired, registrationSucceeds, timeoutMs) ==> alwaysCancellableRecordsKeepDeadline(admit(s, id, name, callbackRequired, registrationSucceeds, timeoutMs)))
  ensures (inv(s) ==> canAdmit(s, id, name, callbackRequired, registrationSucceeds, timeoutMs) ==> alwaysApprovalRecordsAreUnique(admit(s, id, name, callbackRequired, registrationSucceeds, timeoutMs)))
  ensures (inv(s) ==> canAdmit(s, id, name, callbackRequired, registrationSucceeds, timeoutMs) ==> alwaysAllComponentsRetainSafety(admit(s, id, name, callbackRequired, registrationSucceeds, timeoutMs)))
  ensures (inv(s) ==> canAdmit(s, id, name, callbackRequired, registrationSucceeds, timeoutMs) ==> alwaysRetirementDrainsEveryApproval(admit(s, id, name, callbackRequired, registrationSucceeds, timeoutMs)))
  ensures (inv(s) ==> canAdmit(s, id, name, callbackRequired, registrationSucceeds, timeoutMs) ==> alwaysPendingMapOwnsExactlyPending(admit(s, id, name, callbackRequired, registrationSucceeds, timeoutMs)))
  ensures (inv(s) ==> canAdmit(s, id, name, callbackRequired, registrationSucceeds, timeoutMs) ==> alwaysArmedTimersBelongToPending(admit(s, id, name, callbackRequired, registrationSucceeds, timeoutMs)))
{
  if inv(s) && canAdmit(s, id, name, callbackRequired, registrationSucceeds, timeoutMs) {
    var t := admit(s, id, name, callbackRequired, registrationSucceeds, timeoutMs);
    core__approvalWorkers_ensureWorker_ensures(s.workers, name, registrationSucceeds);
    assert forall n :: n in s.workers.registered ==> n in t.workers.registered;
    if core__approvalWorkers_taskMayPersist(t.workers, name) {
      var r := t.records[|s.records|];
      core__approvals_write_ensures(core__approvals_initial, callbackRequired);
      ApprovalAdmittedRecords(s, t, r);
      assert !(id in s.pendingIds);
      forall a | a in t.records
        ensures core__approvals_validApproval(a.approval) && a.approval.stopping == t.stopping &&
          (((a.approval.phase.Pending? || a.approval.phase.Cancelling?) && !t.stopping) <==> a.id in t.pendingIds) &&
          (a.timeoutArmed ==> a.approval.phase.Pending? && !t.stopping && a.timeoutMs > 0 && a.timeoutRemaining >= 0 && a.expiresAt == a.createdAt + a.timeoutMs) &&
          ((a.approval.phase.Pending? || a.approval.phase.Cancelling?) && a.timeoutMs > 0 ==> a.expiresAt == a.createdAt + a.timeoutMs)
      {
        if a != r { assert a in s.records; }
      }
      forall key | key in t.pendingIds ensures exists a :: a in t.records && a.id == key {
        var a :| a in s.records && a.id == key;
        assert a in t.records;
      }
    } else {
      ApprovalUniqueBridge(s);
      ApprovalUniqueBridge(t);
    }
  }
}
