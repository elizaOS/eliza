lemma CallerCounts(xs: seq<ApprovalAttempt>)
  ensures (forall a :: a in xs ==> |ProofLib.Filter((b: ApprovalAttempt) => (b.caller == a.caller), xs)| == 1) <==> ProofLib.DistinctBy(xs, (a: ApprovalAttempt) => a.caller)
{
  forall i | 0 <= i < |xs|
    ensures |ProofLib.Filter((b: ApprovalAttempt) => (b.caller == xs[i].caller), xs)| == 1 <==> forall j :: 0 <= j < |xs| && j != i ==> xs[j].caller != xs[i].caller
  {
    ProofLib.FilterCountOneIffUnique((b: ApprovalAttempt) => (b.caller == xs[i].caller), xs, (a: ApprovalAttempt) => a.caller, i);
  }
  if ProofLib.DistinctBy(xs, (a: ApprovalAttempt) => a.caller) {
    forall x | x in xs
      ensures |ProofLib.Filter((b: ApprovalAttempt) => (b.caller == x.caller), xs)| == 1
    {
      var i :| 0 <= i < |xs| && xs[i] == x;
    }
  } else {
    var i, j :| 0 <= i < |xs| && 0 <= j < |xs| && i != j && xs[i].caller == xs[j].caller;
    assert xs[i] in xs;
  }
}

lemma AttemptOfAll(r: ApprovalRun, caller: string)
  requires ProofLib.DistinctBy(r.attempts, (a: ApprovalAttempt) => a.caller)
  ensures forall i :: 0 <= i < |r.attempts| && r.attempts[i].caller == caller ==> attemptOf(r, caller) == r.attempts[i]
  ensures attemptOf(r, caller).caller == caller
  ensures attemptOf(r, caller) in r.attempts || attemptOf(r, caller) == idleAttempt(caller)
{
  var p := (a: ApprovalAttempt) => (a.caller == caller);
  var f := ProofLib.Filter(p, r.attempts);
  if |f| > 0 {
    assert f[0] in f;
    ProofLib.FilterMember(p, r.attempts, f[0]);
    var j :| 0 <= j < |r.attempts| && r.attempts[j] == f[0];
  } else {
    ProofLib.FilterNone(p, r.attempts);
  }
}

lemma WithAttemptFacts(att: ApprovalAttempt, r: ApprovalRun)
  requires ProofLib.DistinctBy(r.attempts, (a: ApprovalAttempt) => a.caller)
  ensures withAttempt(att, r) == r.(attempts := withAttempt(att, r).attempts)
  ensures att in withAttempt(att, r).attempts
  ensures forall a :: a in withAttempt(att, r).attempts ==> a == att || (a in r.attempts && a.caller != att.caller)
  ensures forall a :: a in r.attempts && a.caller != att.caller ==> a in withAttempt(att, r).attempts
  ensures ProofLib.DistinctBy(withAttempt(att, r).attempts, (a: ApprovalAttempt) => a.caller)
{
  var t := withAttempt(att, r).attempts;
  if exists a :: a in r.attempts && (a.caller == att.caller) {
    var a :| a in r.attempts && a.caller == att.caller;
    var i :| 0 <= i < |r.attempts| && r.attempts[i] == a;
    assert t[i] == att;
    forall b | b in r.attempts && b.caller != att.caller
      ensures b in t
    {
      var j :| 0 <= j < |r.attempts| && r.attempts[j] == b;
      assert t[j] == b;
    }
  } else {
    assert t == r.attempts + [att];
    forall i | 0 <= i < |r.attempts|
      ensures r.attempts[i].caller != att.caller
    {
      assert r.attempts[i] in r.attempts;
    }
  }
}

lemma Setup(r: ApprovalRun, caller: string)
  requires alwaysLockHeldByWorkingCaller(r)
  ensures ProofLib.DistinctBy(r.attempts, (a: ApprovalAttempt) => a.caller)
  ensures forall i :: 0 <= i < |r.attempts| && r.attempts[i].caller == caller ==> attemptOf(r, caller) == r.attempts[i]
  ensures attemptOf(r, caller).caller == caller
  ensures attemptOf(r, caller) in r.attempts || attemptOf(r, caller) == idleAttempt(caller)
  ensures forall a :: a in r.attempts && a.caller == caller ==> a == attemptOf(r, caller)
{
  CallerCounts(r.attempts);
  AttemptOfAll(r, caller);
}

lemma requestDecision_ensures(r: ApprovalRun, caller: string, decision: ApprovalState, ownerOk: bool, versionOk: bool, digestOk: bool)
  ensures (inv(r) ==> canRequestDecision(r, caller, decision) ==> alwaysOneCanonicalDecision(requestDecision(r, caller, decision, ownerOk, versionOk, digestOk)))
  ensures (inv(r) ==> canRequestDecision(r, caller, decision) ==> alwaysUnsupportedNeverApproved(requestDecision(r, caller, decision, ownerOk, versionOk, digestOk)))
  ensures (inv(r) ==> canRequestDecision(r, caller, decision) ==> alwaysHonestResponse(requestDecision(r, caller, decision, ownerOk, versionOk, digestOk)))
  ensures (inv(r) ==> canRequestDecision(r, caller, decision) ==> alwaysCachedHasCanonicalReceipt(requestDecision(r, caller, decision, ownerOk, versionOk, digestOk)))
  ensures (inv(r) ==> canRequestDecision(r, caller, decision) ==> alwaysAttemptsWantADecision(requestDecision(r, caller, decision, ownerOk, versionOk, digestOk)))
  ensures (inv(r) ==> canRequestDecision(r, caller, decision) ==> alwaysLockHeldByWorkingCaller(requestDecision(r, caller, decision, ownerOk, versionOk, digestOk)))
{
  if inv(r) && canRequestDecision(r, caller, decision) {
    var after := requestDecision(r, caller, decision, ownerOk, versionOk, digestOk);
    Setup(r, caller);
    WithAttemptFacts(ApprovalAttempt(caller, CallerPhase.CallerQueued, decision, ownerOk, versionOk, digestOk, false, ApprovalState.PendingApproval), r);
    CallerCounts(after.attempts);
  }
}

lemma acquireRun_ensures(r: ApprovalRun, caller: string)
  ensures (inv(r) ==> canAcquireRun(r, caller) ==> alwaysOneCanonicalDecision(acquireRun(r, caller)))
  ensures (inv(r) ==> canAcquireRun(r, caller) ==> alwaysUnsupportedNeverApproved(acquireRun(r, caller)))
  ensures (inv(r) ==> canAcquireRun(r, caller) ==> alwaysHonestResponse(acquireRun(r, caller)))
  ensures (inv(r) ==> canAcquireRun(r, caller) ==> alwaysCachedHasCanonicalReceipt(acquireRun(r, caller)))
  ensures (inv(r) ==> canAcquireRun(r, caller) ==> alwaysAttemptsWantADecision(acquireRun(r, caller)))
  ensures (inv(r) ==> canAcquireRun(r, caller) ==> alwaysLockHeldByWorkingCaller(acquireRun(r, caller)))
{
  if inv(r) && canAcquireRun(r, caller) {
    var after := acquireRun(r, caller);
    var a := attemptOf(r, caller);
    Setup(r, caller);
    if !a.ownerOk {
      WithAttemptFacts(a.(phase := CallerPhase.CallerFailed), r);
    } else {
      WithAttemptFacts(a.(phase := CallerPhase.CallerReading), r.(lock := caller));
    }
    CallerCounts(after.attempts);
  }
}

lemma sendControl_ensures(r: ApprovalRun, caller: string, committed: bool)
  ensures (inv(r) ==> canSendControl(r, caller) ==> alwaysOneCanonicalDecision(sendControl(r, caller, committed)))
  ensures (inv(r) ==> canSendControl(r, caller) ==> alwaysUnsupportedNeverApproved(sendControl(r, caller, committed)))
  ensures (inv(r) ==> canSendControl(r, caller) ==> alwaysHonestResponse(sendControl(r, caller, committed)))
  ensures (inv(r) ==> canSendControl(r, caller) ==> alwaysCachedHasCanonicalReceipt(sendControl(r, caller, committed)))
  ensures (inv(r) ==> canSendControl(r, caller) ==> alwaysAttemptsWantADecision(sendControl(r, caller, committed)))
  ensures (inv(r) ==> canSendControl(r, caller) ==> alwaysLockHeldByWorkingCaller(sendControl(r, caller, committed)))
{
  if inv(r) && canSendControl(r, caller) {
    var after := sendControl(r, caller, committed);
    var a := attemptOf(r, caller);
    Setup(r, caller);
    if committed {
      WithAttemptFacts(a.(phase := CallerPhase.CallerReadingBack), r.(canonical := a.wants, effects := (r.effects + 1)));
    } else {
      WithAttemptFacts(a.(phase := CallerPhase.CallerFailed), r.(lock := ""));
    }
    CallerCounts(after.attempts);
  }
}

lemma readBack_ensures(r: ApprovalRun, caller: string, available: bool)
  ensures (inv(r) ==> canReadBack(r, caller) ==> alwaysOneCanonicalDecision(readBack(r, caller, available)))
  ensures (inv(r) ==> canReadBack(r, caller) ==> alwaysUnsupportedNeverApproved(readBack(r, caller, available)))
  ensures (inv(r) ==> canReadBack(r, caller) ==> alwaysHonestResponse(readBack(r, caller, available)))
  ensures (inv(r) ==> canReadBack(r, caller) ==> alwaysCachedHasCanonicalReceipt(readBack(r, caller, available)))
  ensures (inv(r) ==> canReadBack(r, caller) ==> alwaysAttemptsWantADecision(readBack(r, caller, available)))
  ensures (inv(r) ==> canReadBack(r, caller) ==> alwaysLockHeldByWorkingCaller(readBack(r, caller, available)))
{
  if inv(r) && canReadBack(r, caller) {
    var after := readBack(r, caller, available);
    var a := attemptOf(r, caller);
    Setup(r, caller);
    if available {
      WithAttemptFacts(a.(phase := CallerPhase.CallerPersisting), r);
    } else {
      WithAttemptFacts(a.(phase := CallerPhase.CallerFailed), r.(lock := ""));
    }
    CallerCounts(after.attempts);
  }
}

lemma persistDecision_ensures(r: ApprovalRun, caller: string, committed: bool)
  ensures (inv(r) ==> canPersistDecision(r, caller) ==> alwaysOneCanonicalDecision(persistDecision(r, caller, committed)))
  ensures (inv(r) ==> canPersistDecision(r, caller) ==> alwaysUnsupportedNeverApproved(persistDecision(r, caller, committed)))
  ensures (inv(r) ==> canPersistDecision(r, caller) ==> alwaysHonestResponse(persistDecision(r, caller, committed)))
  ensures (inv(r) ==> canPersistDecision(r, caller) ==> alwaysCachedHasCanonicalReceipt(persistDecision(r, caller, committed)))
  ensures (inv(r) ==> canPersistDecision(r, caller) ==> alwaysAttemptsWantADecision(persistDecision(r, caller, committed)))
  ensures (inv(r) ==> canPersistDecision(r, caller) ==> alwaysLockHeldByWorkingCaller(persistDecision(r, caller, committed)))
{
  if inv(r) && canPersistDecision(r, caller) {
    var after := persistDecision(r, caller, committed);
    var a := attemptOf(r, caller);
    Setup(r, caller);
    if committed {
      WithAttemptFacts(a.(phase := CallerPhase.CallerResuming), r.(cached := r.canonical, lock := ""));
    } else {
      WithAttemptFacts(a.(phase := CallerPhase.CallerFailed), r.(lock := ""));
    }
    CallerCounts(after.attempts);
  }
}

lemma resumeRun_ensures(r: ApprovalRun, caller: string, resumed: bool)
  ensures (inv(r) ==> canResumeRun(r, caller) ==> alwaysOneCanonicalDecision(resumeRun(r, caller, resumed)))
  ensures (inv(r) ==> canResumeRun(r, caller) ==> alwaysUnsupportedNeverApproved(resumeRun(r, caller, resumed)))
  ensures (inv(r) ==> canResumeRun(r, caller) ==> alwaysHonestResponse(resumeRun(r, caller, resumed)))
  ensures (inv(r) ==> canResumeRun(r, caller) ==> alwaysCachedHasCanonicalReceipt(resumeRun(r, caller, resumed)))
  ensures (inv(r) ==> canResumeRun(r, caller) ==> alwaysAttemptsWantADecision(resumeRun(r, caller, resumed)))
  ensures (inv(r) ==> canResumeRun(r, caller) ==> alwaysLockHeldByWorkingCaller(resumeRun(r, caller, resumed)))
{
  if inv(r) && canResumeRun(r, caller) {
    var after := resumeRun(r, caller, resumed);
    var a := attemptOf(r, caller);
    Setup(r, caller);
    if resumed {
      WithAttemptFacts(a.(phase := CallerPhase.CallerDone, responded := true, response := r.canonical), r);
    } else {
      WithAttemptFacts(a.(phase := CallerPhase.CallerFailed), r);
    }
    CallerCounts(after.attempts);
  }
}

lemma reviewApproval_ensures(r: ApprovalRun, caller: string)
  ensures (inv(r) ==> canReviewApproval(r, caller) ==> alwaysOneCanonicalDecision(reviewApproval(r, caller)))
  ensures (inv(r) ==> canReviewApproval(r, caller) ==> alwaysUnsupportedNeverApproved(reviewApproval(r, caller)))
  ensures (inv(r) ==> canReviewApproval(r, caller) ==> alwaysHonestResponse(reviewApproval(r, caller)))
  ensures (inv(r) ==> canReviewApproval(r, caller) ==> alwaysCachedHasCanonicalReceipt(reviewApproval(r, caller)))
  ensures (inv(r) ==> canReviewApproval(r, caller) ==> alwaysAttemptsWantADecision(reviewApproval(r, caller)))
  ensures (inv(r) ==> canReviewApproval(r, caller) ==> alwaysLockHeldByWorkingCaller(reviewApproval(r, caller)))
{
  if inv(r) && canReviewApproval(r, caller) {
    var after := reviewApproval(r, caller);
    var a := attemptOf(r, caller);
    var check := decideApproval(reviewFacts(r, a), a.wants.ApprovedRequest?);
    Setup(r, caller);
    if check.SendControl? {
      WithAttemptFacts(a.(phase := CallerPhase.CallerCommanding), r);
    } else {
      WithAttemptFacts(a.(phase := (if check.ReadCanonical? then CallerPhase.CallerResuming else CallerPhase.CallerFailed)), r.(lock := ""));
    }
    CallerCounts(after.attempts);
  }
}
