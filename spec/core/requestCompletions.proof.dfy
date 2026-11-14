lemma CompletionState(s: RequestCompletions, t: RequestCompletions)
  requires inv(s)
  requires |s.attempts| <= |t.attempts| && |t.attempts| <= |s.attempts| + 1
  requires |s.results| <= |t.results| && |t.results| <= |s.results| + 1
  requires forall i :: 0 <= i < |s.attempts| ==> s.attempts[i].id == t.attempts[i].id
  requires forall i :: 0 <= i < |s.results| ==> s.results[i].id == t.results[i].id && s.results[i].attempt == t.results[i].attempt && (s.results[i].changed ==> t.results[i].changed)
  requires |s.attempts| != |t.attempts| ==> !(exists a :: a in s.attempts && a.id == t.attempts[|s.attempts|].id)
  requires |s.results| != |t.results| ==> !(exists r :: r in s.results && r.id == t.results[|s.results|].id)
  requires |s.results| != |t.results| ==> exists a :: a in t.attempts && a.id == t.results[|s.results|].attempt
  ensures inv(t) && stepChangedAssociationStaysChanged(s, t)
{
  forall i, j | 0 <= i < |t.attempts| && 0 <= j < |t.attempts| && i != j
    ensures t.attempts[i].id != t.attempts[j].id
  {
    if i < |s.attempts| && j < |s.attempts| {
      var a := s.attempts[i];
      assert a in s.attempts;
      ProofLib.FilterCountOneIffUnique((other: Attempt) => other.id == a.id, s.attempts, (other: Attempt) => other.id, i);
    }
  }
  forall i, j | 0 <= i < |t.results| && 0 <= j < |t.results| && i != j
    ensures t.results[i].id != t.results[j].id
  {
    if i < |s.results| && j < |s.results| {
      var r := s.results[i];
      assert r in s.results;
      ProofLib.FilterCountOneIffUnique((other: Completion) => other.id == r.id, s.results, (other: Completion) => other.id, i);
    }
  }
  forall a | a in t.attempts
    ensures |ProofLib.Filter((other: Attempt) => other.id == a.id, t.attempts)| == 1
  {
    var i :| 0 <= i < |t.attempts| && t.attempts[i] == a;
    ProofLib.FilterOne((other: Attempt) => other.id == a.id, t.attempts, i);
  }
  forall r | r in t.results
    ensures |ProofLib.Filter((other: Completion) => other.id == r.id, t.results)| == 1 &&
      (exists a :: a in t.attempts && a.id == r.attempt)
  {
    var i :| 0 <= i < |t.results| && t.results[i] == r;
    ProofLib.FilterOne((other: Completion) => other.id == r.id, t.results, i);
    if i < |s.results| {
      var before := s.results[i];
      assert before in s.results;
      var a :| a in s.attempts && a.id == before.attempt;
      var j :| 0 <= j < |s.attempts| && s.attempts[j] == a;
      assert t.attempts[j] in t.attempts;
    }
  }
  assert alwaysAttemptAndResultIdentityUnique(t);
  forall r | r in s.results && r.changed
    ensures resultAt(t, r.id).changed
  {
    var i :| 0 <= i < |s.results| && s.results[i] == r;
    assert t.results[i] in t.results;
    CompletionAtRecord(t, t.results[i]);
  }
}

lemma CompletionAtRecord(s: RequestCompletions, r: Completion)
  requires alwaysAttemptAndResultIdentityUnique(s)
  requires r in s.results
  ensures resultAt(s, r.id) == r
{
  var selected := ProofLib.Filter((result: Completion) => result.id == r.id, s.results);
  ProofLib.FilterMember((result: Completion) => result.id == r.id, s.results, r);
  ProofLib.FilterSamePredicate((result: Completion) => result.id == r.id, (other: Completion) => other.id == r.id, s.results);
  assert |selected| == 1;
  assert selected[0] == r;
}

lemma CompletionLookup(s: RequestCompletions, id: string)
  ensures resultAt(s, id) == emptyCompletion || (resultAt(s, id) in s.results && resultAt(s, id).id == id)
  ensures attemptAt(s, id) == emptyAttempt || (attemptAt(s, id) in s.attempts && attemptAt(s, id).id == id)
{
  var rs := ProofLib.Filter((result: Completion) => result.id == id, s.results);
  if |rs| > 0 { ProofLib.FilterMember((result: Completion) => result.id == id, s.results, rs[0]); }
  var ats := ProofLib.Filter((attempt: Attempt) => attempt.id == id, s.attempts);
  if |ats| > 0 { ProofLib.FilterMember((attempt: Attempt) => attempt.id == id, s.attempts, ats[0]); }
}

lemma CompletionAbsent(s: RequestCompletions, id: string)
  requires alwaysAttemptAndResultIdentityUnique(s)
  requires id != "" && resultAt(s, id).id == ""
  ensures !(exists r :: r in s.results && r.id == id)
{
  if exists r :: r in s.results && r.id == id {
    var r :| r in s.results && r.id == id;
    CompletionAtRecord(s, r);
  }
}

lemma observeAuthority_ensures(s: RequestCompletions, revision: int, live: bool, classification: RequestClass)
  ensures (inv(s) ==> canObserveAuthority(s, revision) ==> alwaysAttemptAndResultIdentityUnique(observeAuthority(s, revision, live, classification)))
  ensures (inv(s) ==> canObserveAuthority(s, revision) ==> alwaysCompletionOwnsAttempt(observeAuthority(s, revision, live, classification)))
  ensures (inv(s) ==> canObserveAuthority(s, revision) ==> stepChangedAssociationStaysChanged(s, observeAuthority(s, revision, live, classification)))
{
  if inv(s) && canObserveAuthority(s, revision) {

    CompletionState(s, observeAuthority(s, revision, live, classification));
  }
}

lemma beginAttempt_ensures(s: RequestCompletions, id: string)
  ensures (inv(s) ==> canBeginAttempt(s, id) ==> alwaysAttemptAndResultIdentityUnique(beginAttempt(s, id)))
  ensures (inv(s) ==> canBeginAttempt(s, id) ==> alwaysCompletionOwnsAttempt(beginAttempt(s, id)))
  ensures (inv(s) ==> canBeginAttempt(s, id) ==> stepChangedAssociationStaysChanged(s, beginAttempt(s, id)))
{
  if inv(s) && canBeginAttempt(s, id) {

    CompletionState(s, beginAttempt(s, id));
  }
}

lemma checkOperation_ensures(s: RequestCompletions, id: string, operation: Operation, registered: Operation, denialId: string)
  ensures (inv(s) ==> canCheckOperation(s, operation) ==> alwaysAttemptAndResultIdentityUnique(checkOperation(s, id, operation, registered, denialId)))
  ensures (inv(s) ==> canCheckOperation(s, operation) ==> alwaysCompletionOwnsAttempt(checkOperation(s, id, operation, registered, denialId)))
  ensures (inv(s) ==> canCheckOperation(s, operation) ==> stepChangedAssociationStaysChanged(s, checkOperation(s, id, operation, registered, denialId)))
{
  if inv(s) && canCheckOperation(s, operation) {
    CompletionLookup(s, id);
    CompletionState(s, checkOperation(s, id, operation, registered, denialId));
  }
}

lemma copyCompletion_ensures(s: RequestCompletions, sourceId: string, targetId: string, sourceFingerprint: string, targetFingerprint: string)
  ensures (inv(s) ==> canCopyCompletion(s, sourceId, targetId, sourceFingerprint, targetFingerprint) ==> alwaysAttemptAndResultIdentityUnique(copyCompletion(s, sourceId, targetId, sourceFingerprint, targetFingerprint)))
  ensures (inv(s) ==> canCopyCompletion(s, sourceId, targetId, sourceFingerprint, targetFingerprint) ==> alwaysCompletionOwnsAttempt(copyCompletion(s, sourceId, targetId, sourceFingerprint, targetFingerprint)))
  ensures (inv(s) ==> canCopyCompletion(s, sourceId, targetId, sourceFingerprint, targetFingerprint) ==> stepChangedAssociationStaysChanged(s, copyCompletion(s, sourceId, targetId, sourceFingerprint, targetFingerprint)))
{
  if inv(s) && canCopyCompletion(s, sourceId, targetId, sourceFingerprint, targetFingerprint) {

    CompletionState(s, copyCompletion(s, sourceId, targetId, sourceFingerprint, targetFingerprint));
  }
}

lemma bindResult_ensures(s: RequestCompletions, resultId: string, attemptId: string, fingerprint: string, projectionHash: string, currentRegistration: bool, canonicalDispatch: bool)
  ensures (inv(s) ==> canBindResult(s, resultId, attemptId) ==> alwaysAttemptAndResultIdentityUnique(bindResult(s, resultId, attemptId, fingerprint, projectionHash, currentRegistration, canonicalDispatch)))
  ensures (inv(s) ==> canBindResult(s, resultId, attemptId) ==> alwaysCompletionOwnsAttempt(bindResult(s, resultId, attemptId, fingerprint, projectionHash, currentRegistration, canonicalDispatch)))
  ensures (inv(s) ==> canBindResult(s, resultId, attemptId) ==> stepChangedAssociationStaysChanged(s, bindResult(s, resultId, attemptId, fingerprint, projectionHash, currentRegistration, canonicalDispatch)))
{
  if inv(s) && canBindResult(s, resultId, attemptId) {
    CompletionLookup(s, attemptId);
    if resultAt(s, resultId).id == "" { CompletionAbsent(s, resultId); }
    CompletionState(s, bindResult(s, resultId, attemptId, fingerprint, projectionHash, currentRegistration, canonicalDispatch));
  }
}

lemma projectResult_ensures(s: RequestCompletions, sourceId: string, targetId: string, fingerprint: string, projectionHash: string, ownerMatches: bool, sourceFingerprint: string)
  ensures (inv(s) ==> canProjectResult(s, sourceId, targetId, ownerMatches) ==> alwaysAttemptAndResultIdentityUnique(projectResult(s, sourceId, targetId, fingerprint, projectionHash, ownerMatches, sourceFingerprint)))
  ensures (inv(s) ==> canProjectResult(s, sourceId, targetId, ownerMatches) ==> alwaysCompletionOwnsAttempt(projectResult(s, sourceId, targetId, fingerprint, projectionHash, ownerMatches, sourceFingerprint)))
  ensures (inv(s) ==> canProjectResult(s, sourceId, targetId, ownerMatches) ==> stepChangedAssociationStaysChanged(s, projectResult(s, sourceId, targetId, fingerprint, projectionHash, ownerMatches, sourceFingerprint)))
{
  if inv(s) && canProjectResult(s, sourceId, targetId, ownerMatches) {
    CompletionLookup(s, sourceId);
    CompletionAbsent(s, targetId);
    CompletionState(s, projectResult(s, sourceId, targetId, fingerprint, projectionHash, ownerMatches, sourceFingerprint));
  }
}

lemma inspectCompletion_ensures(s: RequestCompletions, resultId: string, ownerMatches: bool, fingerprint: string, registrationCurrent: bool)
  ensures (inv(s) ==> canInspectCompletion(s, resultId, ownerMatches) ==> alwaysAttemptAndResultIdentityUnique(inspectCompletion(s, resultId, ownerMatches, fingerprint, registrationCurrent)))
  ensures (inv(s) ==> canInspectCompletion(s, resultId, ownerMatches) ==> alwaysCompletionOwnsAttempt(inspectCompletion(s, resultId, ownerMatches, fingerprint, registrationCurrent)))
  ensures (inv(s) ==> canInspectCompletion(s, resultId, ownerMatches) ==> stepChangedAssociationStaysChanged(s, inspectCompletion(s, resultId, ownerMatches, fingerprint, registrationCurrent)))
{
  if inv(s) && canInspectCompletion(s, resultId, ownerMatches) {
    CompletionLookup(s, resultId);
    var t := inspectCompletion(s, resultId, ownerMatches, fingerprint, registrationCurrent);
    forall i | 0 <= i < |s.results|
      ensures s.results[i].id == t.results[i].id && s.results[i].attempt == t.results[i].attempt && (s.results[i].changed ==> t.results[i].changed)
    {
      var r := s.results[i];
      assert r in s.results;
      if r.id == resultId { CompletionAtRecord(s, r); }
    }
    CompletionState(s, t);
  }
}

lemma wrapDenialError_ensures(s: RequestCompletions, sourceDenial: string, errorId: string)
  ensures (inv(s) ==> canWrapDenialError(s, sourceDenial, errorId) ==> alwaysAttemptAndResultIdentityUnique(wrapDenialError(s, sourceDenial, errorId)))
  ensures (inv(s) ==> canWrapDenialError(s, sourceDenial, errorId) ==> alwaysCompletionOwnsAttempt(wrapDenialError(s, sourceDenial, errorId)))
  ensures (inv(s) ==> canWrapDenialError(s, sourceDenial, errorId) ==> stepChangedAssociationStaysChanged(s, wrapDenialError(s, sourceDenial, errorId)))
{
  if inv(s) && canWrapDenialError(s, sourceDenial, errorId) {

    CompletionState(s, wrapDenialError(s, sourceDenial, errorId));
  }
}

lemma transferDenial_ensures(s: RequestCompletions, sourceDenial: string, targetResult: string, expectedAttempt: string, targetNotStarted: bool, sourceNotStarted: bool)
  ensures (inv(s) ==> canTransferDenial(s, sourceDenial, targetResult, expectedAttempt, targetNotStarted, sourceNotStarted) ==> alwaysAttemptAndResultIdentityUnique(transferDenial(s, sourceDenial, targetResult, expectedAttempt, targetNotStarted, sourceNotStarted)))
  ensures (inv(s) ==> canTransferDenial(s, sourceDenial, targetResult, expectedAttempt, targetNotStarted, sourceNotStarted) ==> alwaysCompletionOwnsAttempt(transferDenial(s, sourceDenial, targetResult, expectedAttempt, targetNotStarted, sourceNotStarted)))
  ensures (inv(s) ==> canTransferDenial(s, sourceDenial, targetResult, expectedAttempt, targetNotStarted, sourceNotStarted) ==> stepChangedAssociationStaysChanged(s, transferDenial(s, sourceDenial, targetResult, expectedAttempt, targetNotStarted, sourceNotStarted)))
{
  if inv(s) && canTransferDenial(s, sourceDenial, targetResult, expectedAttempt, targetNotStarted, sourceNotStarted) {

    CompletionState(s, transferDenial(s, sourceDenial, targetResult, expectedAttempt, targetNotStarted, sourceNotStarted));
  }
}

lemma lawCopySourceMismatchIsSticky_ensures(s: RequestCompletions, sourceId: string, targetId: string, sourceFingerprint: string, targetFingerprint: string)
  ensures (lawCopySourceMismatchIsSticky(s, sourceId, targetId, sourceFingerprint, targetFingerprint) == true)
{
  if alwaysAttemptAndResultIdentityUnique(s) && canCopyCompletion(s,sourceId,targetId,sourceFingerprint,targetFingerprint) && resultAt(s,sourceId).fingerprint != sourceFingerprint {
    CompletionLookup(s,sourceId);
    var row := resultAt(s,sourceId);
    assert row.hasFact && row != emptyCompletion && row in s.results;
    var t := copyCompletion(s,sourceId,targetId,sourceFingerprint,targetFingerprint);
    var i :| 0 <= i < |s.results| && s.results[i] == row;
    assert t.results[i] in t.results && t.results[i].id == sourceId && t.results[i].changed;
    var selected := ProofLib.Filter((result: Completion) => result.id == sourceId,t.results);
    var before := ProofLib.Filter((result: Completion) => result.id == sourceId,s.results);
    ProofLib.FilterLengthPointwise((result: Completion) => result.id == sourceId,(result: Completion) => result.id == sourceId,s.results,t.results);
    ProofLib.FilterMember((result: Completion) => result.id == sourceId,t.results,t.results[i]);
    assert |before| == 1 && |selected| == 1 && selected[0] == t.results[i];
  }
}
