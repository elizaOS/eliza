lemma SessionUniqueBridge(s: SessionStore)
  ensures alwaysSessionReferencesAreUnique(s) <==> (s.now >= 0 && forall r :: r in s.rows ==> (r.reference != "" && |ProofLib.Filter((other: StoredSession) => other.reference == r.reference, s.rows)| == 1 && r.session.now == s.now && r.session.owner == owner(r.bindings)))
{}

lemma SessionQueueBridge(s: SessionStore)
  ensures alwaysAtomicTailHasOneOwner(s) <==> ((s.active.id == 0 || s.active.id in s.usedTransactions) &&
    forall w :: w in s.waiting ==> (w.id > 0 && w.id != s.active.id && w.id in s.usedTransactions && |ProofLib.Filter((other: SessionTransaction) => other.id == w.id, s.waiting)| == 1))
{}

lemma SessionLookup(s: SessionStore, reference: string)
  ensures rowAt(s, reference) == emptyRow || (rowAt(s, reference) in s.rows && rowAt(s, reference).reference == reference)
{
  var rs := ProofLib.Filter((row: StoredSession) => row.reference == reference, s.rows);
  if |rs| > 0 {
    ProofLib.FilterMember((row: StoredSession) => row.reference == reference, s.rows, rs[0]);
  }
}

lemma SessionRows(s: SessionStore, t: SessionStore)
  requires alwaysSessionReferencesAreUnique(s) && t.now >= 0
  requires |s.rows| <= |t.rows| && |t.rows| <= |s.rows|+1
  requires forall i :: 0 <= i < |s.rows| ==> s.rows[i].reference == t.rows[i].reference
  requires |s.rows| != |t.rows| ==> !(exists r :: r in s.rows && r.reference == t.rows[|s.rows|].reference)
  requires forall r :: r in t.rows ==> r.reference != "" && r.session.now == t.now && r.session.owner == owner(r.bindings)
  ensures alwaysSessionReferencesAreUnique(t)
{
  SessionUniqueBridge(s);
  forall i, j | 0 <= i < |t.rows| && 0 <= j < |t.rows| && i != j
    ensures t.rows[i].reference != t.rows[j].reference
  {
    if i < |s.rows| && j < |s.rows| {
      var a := s.rows[i];
      assert a in s.rows;
      ProofLib.FilterCountOneIffUnique((other: StoredSession) => other.reference == a.reference, s.rows, (other: StoredSession) => other.reference, i);
    }
  }
  forall r | r in t.rows ensures |ProofLib.Filter((other: StoredSession) => other.reference == r.reference, t.rows)| == 1 {
    var i :| 0 <= i < |t.rows| && t.rows[i] == r;
    ProofLib.FilterOne((other: StoredSession) => other.reference == r.reference, t.rows, i);
  }
  SessionUniqueBridge(t);
}

lemma SessionQueueAppend(s: SessionStore, t: SessionStore, tx: SessionTransaction)
  requires alwaysAtomicTailHasOneOwner(s) && t.active == s.active && tx.id > 0 && !(tx.id in s.usedTransactions)
  requires t.waiting == s.waiting + [tx]
  requires forall id :: id in s.usedTransactions || id == tx.id ==> id in t.usedTransactions
  ensures alwaysAtomicTailHasOneOwner(t)
{
  SessionQueueBridge(s);
  assert tx.id != s.active.id;
  forall w | w in t.waiting
    ensures w.id > 0 && w.id != t.active.id && w.id in t.usedTransactions &&
      |ProofLib.Filter((other: SessionTransaction) => other.id == w.id, t.waiting)| == 1
  {
    if w == tx {
      ProofLib.FilterOne((other: SessionTransaction) => other.id == w.id, t.waiting, |s.waiting|);
    } else {
      assert w in s.waiting;
      ProofLib.FilterAppend((other: SessionTransaction) => other.id == w.id, s.waiting, tx);
    }
  }
  SessionQueueBridge(t);
}

lemma SessionQueueTail(s: SessionStore,t: SessionStore)
  requires alwaysAtomicTailHasOneOwner(s) && |s.waiting| > 0
  requires t.active == s.waiting[0] && t.waiting == s.waiting[1..] && t.usedTransactions == s.usedTransactions
  ensures alwaysAtomicTailHasOneOwner(t)
{
  SessionQueueBridge(s);
  assert t.active in s.waiting;
  forall w | w in t.waiting
    ensures w.id > 0 && w.id != t.active.id && w.id in t.usedTransactions &&
      |ProofLib.Filter((other: SessionTransaction) => other.id == w.id, t.waiting)| == 1
  {
    var i :| 0 <= i < |t.waiting| && t.waiting[i] == w;
    assert s.waiting[i+1] == w;
    assert w in s.waiting;
    ProofLib.FilterCountOneIffUnique((other: SessionTransaction) => other.id == w.id, s.waiting, (other: SessionTransaction) => other.id, i+1);
    ProofLib.FilterCons((other: SessionTransaction) => other.id == w.id, s.waiting);
  }
  SessionQueueBridge(t);
}

lemma SessionQueueReset(s: SessionStore,t: SessionStore)
  requires alwaysAtomicTailHasOneOwner(s) && t.active.id == 0
  requires t.waiting == s.waiting && t.usedTransactions == s.usedTransactions
  ensures alwaysAtomicTailHasOneOwner(t)
{
  SessionQueueBridge(s);
  SessionQueueBridge(t);
}

lemma SessionRowsPruned(s: SessionStore,t: SessionStore,cutoff: int)
  requires inv(s) && t == deleteExpired(s, cutoff)
  ensures alwaysSessionReferencesAreUnique(t) && alwaysEverySessionKeepsItsEffect(t)
{
  var keep := (row: StoredSession) => row.session.phase.Committed? || (if row.session.phase.Completed? then row.completedAt > cutoff else row.session.expiresAt > cutoff);
  assert t.rows == ProofLib.Filter(keep, s.rows);
  SessionUniqueBridge(s);
  forall i,j | 0 <= i < |s.rows| && 0 <= j < |s.rows| && i != j
    ensures s.rows[i].reference != s.rows[j].reference
  {
    var r := s.rows[i]; assert r in s.rows;
    ProofLib.FilterCountOneIffUnique((other: StoredSession) => other.reference == r.reference, s.rows, (other: StoredSession) => other.reference, i);
  }
  assert ProofLib.DistinctBy(s.rows, (r: StoredSession) => r.reference);
  ProofLib.FilterKeepsDistinctBy(keep, s.rows, (r: StoredSession) => r.reference);
  forall r | r in t.rows ensures r in s.rows &&
    |ProofLib.Filter((other: StoredSession) => other.reference == r.reference, t.rows)| == 1
  {
    ProofLib.FilterMember(keep,s.rows,r);
    var i :| 0 <= i < |t.rows| && t.rows[i] == r;
    ProofLib.FilterOne((other: StoredSession) => other.reference == r.reference, t.rows, i);
  }
  SessionUniqueBridge(t);
}

lemma admitTransaction_ensures(s: SessionStore, transactionId: int, reference: string)
  ensures (inv(s) ==> canAdmitTransaction(s, transactionId, reference) ==> alwaysSessionReferencesAreUnique(admitTransaction(s, transactionId, reference)))
  ensures (inv(s) ==> canAdmitTransaction(s, transactionId, reference) ==> alwaysEverySessionKeepsItsEffect(admitTransaction(s, transactionId, reference)))
  ensures (inv(s) ==> canAdmitTransaction(s, transactionId, reference) ==> alwaysAtomicTailHasOneOwner(admitTransaction(s, transactionId, reference)))
  ensures (inv(s) ==> canAdmitTransaction(s, transactionId, reference) ==> stepOnlySelectedSessionChanges(s, "admitTransaction", admitTransaction(s, transactionId, reference)))
{
  if inv(s) && canAdmitTransaction(s, transactionId, reference) {
    var t := admitTransaction(s, transactionId, reference);
    var added := SessionTransaction(transactionId, reference);
    forall n | n in s.usedTransactions || n == transactionId
      ensures n in t.usedTransactions
    { ProofLib.FilterMember((set_x: int) => !(set_x in s.usedTransactions), [transactionId], n); }
    SessionQueueAppend(s,t,added);
  }
}

lemma beginTransaction_ensures(s: SessionStore)
  ensures (inv(s) ==> canBeginTransaction(s) ==> alwaysSessionReferencesAreUnique(beginTransaction(s)))
  ensures (inv(s) ==> canBeginTransaction(s) ==> alwaysEverySessionKeepsItsEffect(beginTransaction(s)))
  ensures (inv(s) ==> canBeginTransaction(s) ==> alwaysAtomicTailHasOneOwner(beginTransaction(s)))
  ensures (inv(s) ==> canBeginTransaction(s) ==> stepOnlySelectedSessionChanges(s, "beginTransaction", beginTransaction(s)))
{
  if inv(s) && canBeginTransaction(s) {
    var t := beginTransaction(s);
    SessionQueueTail(s,t);
  }
}

lemma endTransaction_ensures(s: SessionStore)
  ensures (inv(s) ==> canEndTransaction(s) ==> alwaysSessionReferencesAreUnique(endTransaction(s)))
  ensures (inv(s) ==> canEndTransaction(s) ==> alwaysEverySessionKeepsItsEffect(endTransaction(s)))
  ensures (inv(s) ==> canEndTransaction(s) ==> alwaysAtomicTailHasOneOwner(endTransaction(s)))
  ensures (inv(s) ==> canEndTransaction(s) ==> stepOnlySelectedSessionChanges(s, "endTransaction", endTransaction(s)))
{
  if inv(s) && canEndTransaction(s) {
    var t := endTransaction(s);
    SessionQueueReset(s,t);
  }
}

lemma createSession_ensures(s: SessionStore, bindings: SessionBindings, decisionId: string, expiresAt: int)
  ensures (inv(s) ==> canCreateSession(s, bindings, decisionId, expiresAt) ==> alwaysSessionReferencesAreUnique(createSession(s, bindings, decisionId, expiresAt)))
  ensures (inv(s) ==> canCreateSession(s, bindings, decisionId, expiresAt) ==> alwaysEverySessionKeepsItsEffect(createSession(s, bindings, decisionId, expiresAt)))
  ensures (inv(s) ==> canCreateSession(s, bindings, decisionId, expiresAt) ==> alwaysAtomicTailHasOneOwner(createSession(s, bindings, decisionId, expiresAt)))
  ensures (inv(s) ==> canCreateSession(s, bindings, decisionId, expiresAt) ==> stepOnlySelectedSessionChanges(s, "createSession", createSession(s, bindings, decisionId, expiresAt)))
{
  if inv(s) && canCreateSession(s, bindings, decisionId, expiresAt) {
    var t := createSession(s, bindings, decisionId, expiresAt);
    core__sessions_create_ensures(core__sessions_initial.(now := s.now),owner(bindings),expiresAt);
    forall r | r in t.rows ensures r.reference != "" && r.session.now == t.now && r.session.owner == owner(r.bindings) {
      var i :| 0 <= i < |t.rows| && t.rows[i] == r;
      if i < |s.rows| { assert s.rows[i] in s.rows; }
    }
    SessionRows(s,t);
    var added := t.rows[|s.rows|];
    forall r | r in t.rows
      ensures core__sessions_alwaysAtMostOneInvocation(r.session) &&
        core__sessions_alwaysEffectHasCommittedOwner(r.session) &&
        core__sessions_alwaysAmbiguousCommitRemainsDurable(r.session) &&
        core__sessions_alwaysCompletedHasOutcome(r.session) &&
        core__sessions_alwaysLiveClaimHasToken(r.session) &&
        core__sessions_alwaysClaimSequenceIsValid(r.session)
    {
      if r != added { assert r in s.rows; }
    }
  }
}

lemma observeTime_ensures(s: SessionStore, now: int)
  ensures (inv(s) ==> canObserveTime(s, now) ==> alwaysSessionReferencesAreUnique(observeTime(s, now)))
  ensures (inv(s) ==> canObserveTime(s, now) ==> alwaysEverySessionKeepsItsEffect(observeTime(s, now)))
  ensures (inv(s) ==> canObserveTime(s, now) ==> alwaysAtomicTailHasOneOwner(observeTime(s, now)))
  ensures (inv(s) ==> canObserveTime(s, now) ==> stepOnlySelectedSessionChanges(s, "observeTime", observeTime(s, now)))
{
  if inv(s) && canObserveTime(s, now) {
    var t := observeTime(s, now);
    forall r | r in t.rows ensures r.reference != "" && r.session.now == t.now && r.session.owner == owner(r.bindings) {
      var i :| 0 <= i < |t.rows| && t.rows[i] == r;
      if i < |s.rows| { assert s.rows[i] in s.rows; }
    }
    SessionRows(s,t);
  }
}

lemma deleteExpired_ensures(s: SessionStore, cutoff: int)
  ensures (inv(s) ==> canDeleteExpired(s, cutoff) ==> alwaysSessionReferencesAreUnique(deleteExpired(s, cutoff)))
  ensures (inv(s) ==> canDeleteExpired(s, cutoff) ==> alwaysEverySessionKeepsItsEffect(deleteExpired(s, cutoff)))
  ensures (inv(s) ==> canDeleteExpired(s, cutoff) ==> alwaysAtomicTailHasOneOwner(deleteExpired(s, cutoff)))
  ensures (inv(s) ==> canDeleteExpired(s, cutoff) ==> stepOnlySelectedSessionChanges(s, "deleteExpired", deleteExpired(s, cutoff)))
{
  if inv(s) && canDeleteExpired(s, cutoff) {
    var t := deleteExpired(s, cutoff);
    SessionRowsPruned(s,t,cutoff);
  }
}

lemma elapse_ensures(s: SessionStore, elapsed: int)
  ensures (inv(s) ==> canElapse(s, elapsed) ==> alwaysSessionReferencesAreUnique(elapse(s, elapsed)))
  ensures (inv(s) ==> canElapse(s, elapsed) ==> alwaysEverySessionKeepsItsEffect(elapse(s, elapsed)))
  ensures (inv(s) ==> canElapse(s, elapsed) ==> alwaysAtomicTailHasOneOwner(elapse(s, elapsed)))
  ensures (inv(s) ==> canElapse(s, elapsed) ==> stepOnlySelectedSessionChanges(s, "elapse", elapse(s, elapsed)))
{
  if inv(s) && canElapse(s, elapsed) {
    var t := elapse(s, elapsed);
    forall r | r in t.rows ensures r.reference != "" && r.session.now == t.now && r.session.owner == owner(r.bindings) {
      var i :| 0 <= i < |t.rows| && t.rows[i] == r;
      if i < |s.rows| { assert s.rows[i] in s.rows; }
    }
    SessionRows(s,t);
  }
}

lemma advanceSession_ensures(s: SessionStore, command: SessionCommand, bindings: SessionBindings, decisionId: string, replayKey: string, responseDigest: string, leaseDuration: int, claimToken: int)
  ensures (inv(s) ==> canAdvanceSession(s, command, bindings, decisionId, replayKey, responseDigest, leaseDuration, claimToken) ==> alwaysSessionReferencesAreUnique(advanceSession(s, command, bindings, decisionId, replayKey, responseDigest, leaseDuration, claimToken)))
  ensures (inv(s) ==> canAdvanceSession(s, command, bindings, decisionId, replayKey, responseDigest, leaseDuration, claimToken) ==> alwaysEverySessionKeepsItsEffect(advanceSession(s, command, bindings, decisionId, replayKey, responseDigest, leaseDuration, claimToken)))
  ensures (inv(s) ==> canAdvanceSession(s, command, bindings, decisionId, replayKey, responseDigest, leaseDuration, claimToken) ==> alwaysAtomicTailHasOneOwner(advanceSession(s, command, bindings, decisionId, replayKey, responseDigest, leaseDuration, claimToken)))
  ensures (inv(s) ==> canAdvanceSession(s, command, bindings, decisionId, replayKey, responseDigest, leaseDuration, claimToken) ==> stepOnlySelectedSessionChanges(s, "advanceSession", advanceSession(s, command, bindings, decisionId, replayKey, responseDigest, leaseDuration, claimToken)))
{
  if inv(s) && canAdvanceSession(s, command, bindings, decisionId, replayKey, responseDigest, leaseDuration, claimToken) {
    var t := advanceSession(s, command, bindings, decisionId, replayKey, responseDigest, leaseDuration, claimToken);
    var chosen := rowAt(s,s.active.reference);
    SessionLookup(s,s.active.reference);
    assert chosen in s.rows && chosen.reference == s.active.reference;
    if command.AcquireSession? { core__sessions_acquire_ensures(chosen.session,owner(bindings),responseDigest,leaseDuration); }
    else if command.CommitSession? { core__sessions_commit_ensures(chosen.session,chosen.session.owner,claimToken,responseDigest); }
    else if command.InvokeSession? { core__sessions_invoke_ensures(chosen.session,chosen.session.owner,claimToken); }
    else if command.LoseSessionExecutor? { core__sessions_loseExecutor_ensures(chosen.session); }
    else if command.RecordSessionOutcome? { core__sessions_recordOutcome_ensures(chosen.session); }
    else if command.CompleteSession? { core__sessions_complete_ensures(chosen.session); }
    else { core__sessions_revoke_ensures(chosen.session); }
    forall r | r in s.rows && r.reference != s.active.reference ensures r in t.rows {
      var i :| 0 <= i < |s.rows| && s.rows[i] == r;
      assert t.rows[i] == r;
    }
    forall r | r in t.rows ensures r.reference != "" && r.session.now == t.now && r.session.owner == owner(r.bindings) {
      var i :| 0 <= i < |t.rows| && t.rows[i] == r;
      if i < |s.rows| { assert s.rows[i] in s.rows; }
    }
    SessionRows(s,t);
  }
}
