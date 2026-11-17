lemma declareTooLarge_ensures(r: Requests)
  ensures (inv(r) ==> canDeclareTooLarge(r) ==> alwaysBodyBounded(declareTooLarge(r)))
  ensures (inv(r) ==> canDeclareTooLarge(r) ==> alwaysResponseMatchesRequest(declareTooLarge(r)))
  ensures (inv(r) ==> canDeclareTooLarge(r) ==> alwaysCloseAfterFlush(declareTooLarge(r)))
  ensures (inv(r) ==> canDeclareTooLarge(r) ==> alwaysBucketBalanced(declareTooLarge(r)))
  ensures (inv(r) ==> canDeclareTooLarge(r) ==> alwaysCasBounded(declareTooLarge(r)))
  ensures (inv(r) ==> canDeclareTooLarge(r) ==> alwaysLogBounded(declareTooLarge(r)))
  ensures (inv(r) ==> canDeclareTooLarge(r) ==> alwaysLogEntriesInOrder(declareTooLarge(r)))
  ensures (inv(r) ==> canDeclareTooLarge(r) ==> alwaysRecentCreditWarningRetained(declareTooLarge(r)))
  ensures (inv(r) ==> canDeclareTooLarge(r) ==> stepAnsweredOnce(r, declareTooLarge(r)))
  ensures (inv(r) ==> canDeclareTooLarge(r) ==> stepBucketsAreIndependent(r, declareTooLarge(r)))
{
  if inv(r) && canDeclareTooLarge(r) {
    Buckets(r, declareTooLarge(r));
  }
}

lemma receiveChunk_ensures(r: Requests)
  ensures (inv(r) ==> canReceiveChunk(r) ==> alwaysBodyBounded(receiveChunk(r)))
  ensures (inv(r) ==> canReceiveChunk(r) ==> alwaysResponseMatchesRequest(receiveChunk(r)))
  ensures (inv(r) ==> canReceiveChunk(r) ==> alwaysCloseAfterFlush(receiveChunk(r)))
  ensures (inv(r) ==> canReceiveChunk(r) ==> alwaysBucketBalanced(receiveChunk(r)))
  ensures (inv(r) ==> canReceiveChunk(r) ==> alwaysCasBounded(receiveChunk(r)))
  ensures (inv(r) ==> canReceiveChunk(r) ==> alwaysLogBounded(receiveChunk(r)))
  ensures (inv(r) ==> canReceiveChunk(r) ==> alwaysLogEntriesInOrder(receiveChunk(r)))
  ensures (inv(r) ==> canReceiveChunk(r) ==> alwaysRecentCreditWarningRetained(receiveChunk(r)))
  ensures (inv(r) ==> canReceiveChunk(r) ==> stepAnsweredOnce(r, receiveChunk(r)))
  ensures (inv(r) ==> canReceiveChunk(r) ==> stepBucketsAreIndependent(r, receiveChunk(r)))
{
  if inv(r) && canReceiveChunk(r) {
    Buckets(r, receiveChunk(r));
  }
}

lemma endRequest_ensures(r: Requests)
  ensures (inv(r) ==> canEndRequest(r) ==> alwaysBodyBounded(endRequest(r)))
  ensures (inv(r) ==> canEndRequest(r) ==> alwaysResponseMatchesRequest(endRequest(r)))
  ensures (inv(r) ==> canEndRequest(r) ==> alwaysCloseAfterFlush(endRequest(r)))
  ensures (inv(r) ==> canEndRequest(r) ==> alwaysBucketBalanced(endRequest(r)))
  ensures (inv(r) ==> canEndRequest(r) ==> alwaysCasBounded(endRequest(r)))
  ensures (inv(r) ==> canEndRequest(r) ==> alwaysLogBounded(endRequest(r)))
  ensures (inv(r) ==> canEndRequest(r) ==> alwaysLogEntriesInOrder(endRequest(r)))
  ensures (inv(r) ==> canEndRequest(r) ==> alwaysRecentCreditWarningRetained(endRequest(r)))
  ensures (inv(r) ==> canEndRequest(r) ==> stepAnsweredOnce(r, endRequest(r)))
  ensures (inv(r) ==> canEndRequest(r) ==> stepBucketsAreIndependent(r, endRequest(r)))
{
  if inv(r) && canEndRequest(r) {
    Buckets(r, endRequest(r));
  }
}

lemma dispatchBody_ensures(r: Requests)
  ensures (inv(r) ==> canDispatchBody(r) ==> alwaysBodyBounded(dispatchBody(r)))
  ensures (inv(r) ==> canDispatchBody(r) ==> alwaysResponseMatchesRequest(dispatchBody(r)))
  ensures (inv(r) ==> canDispatchBody(r) ==> alwaysCloseAfterFlush(dispatchBody(r)))
  ensures (inv(r) ==> canDispatchBody(r) ==> alwaysBucketBalanced(dispatchBody(r)))
  ensures (inv(r) ==> canDispatchBody(r) ==> alwaysCasBounded(dispatchBody(r)))
  ensures (inv(r) ==> canDispatchBody(r) ==> alwaysLogBounded(dispatchBody(r)))
  ensures (inv(r) ==> canDispatchBody(r) ==> alwaysLogEntriesInOrder(dispatchBody(r)))
  ensures (inv(r) ==> canDispatchBody(r) ==> alwaysRecentCreditWarningRetained(dispatchBody(r)))
  ensures (inv(r) ==> canDispatchBody(r) ==> stepAnsweredOnce(r, dispatchBody(r)))
  ensures (inv(r) ==> canDispatchBody(r) ==> stepBucketsAreIndependent(r, dispatchBody(r)))
{
  if inv(r) && canDispatchBody(r) {
    Buckets(r, dispatchBody(r));
  }
}

lemma respondAccepted_ensures(r: Requests)
  ensures (inv(r) ==> canRespondAccepted(r) ==> alwaysBodyBounded(respondAccepted(r)))
  ensures (inv(r) ==> canRespondAccepted(r) ==> alwaysResponseMatchesRequest(respondAccepted(r)))
  ensures (inv(r) ==> canRespondAccepted(r) ==> alwaysCloseAfterFlush(respondAccepted(r)))
  ensures (inv(r) ==> canRespondAccepted(r) ==> alwaysBucketBalanced(respondAccepted(r)))
  ensures (inv(r) ==> canRespondAccepted(r) ==> alwaysCasBounded(respondAccepted(r)))
  ensures (inv(r) ==> canRespondAccepted(r) ==> alwaysLogBounded(respondAccepted(r)))
  ensures (inv(r) ==> canRespondAccepted(r) ==> alwaysLogEntriesInOrder(respondAccepted(r)))
  ensures (inv(r) ==> canRespondAccepted(r) ==> alwaysRecentCreditWarningRetained(respondAccepted(r)))
  ensures (inv(r) ==> canRespondAccepted(r) ==> stepAnsweredOnce(r, respondAccepted(r)))
  ensures (inv(r) ==> canRespondAccepted(r) ==> stepBucketsAreIndependent(r, respondAccepted(r)))
{
  if inv(r) && canRespondAccepted(r) {
    Buckets(r, respondAccepted(r));
  }
}

lemma respondTooLarge_ensures(r: Requests)
  ensures (inv(r) ==> canRespondTooLarge(r) ==> alwaysBodyBounded(respondTooLarge(r)))
  ensures (inv(r) ==> canRespondTooLarge(r) ==> alwaysResponseMatchesRequest(respondTooLarge(r)))
  ensures (inv(r) ==> canRespondTooLarge(r) ==> alwaysCloseAfterFlush(respondTooLarge(r)))
  ensures (inv(r) ==> canRespondTooLarge(r) ==> alwaysBucketBalanced(respondTooLarge(r)))
  ensures (inv(r) ==> canRespondTooLarge(r) ==> alwaysCasBounded(respondTooLarge(r)))
  ensures (inv(r) ==> canRespondTooLarge(r) ==> alwaysLogBounded(respondTooLarge(r)))
  ensures (inv(r) ==> canRespondTooLarge(r) ==> alwaysLogEntriesInOrder(respondTooLarge(r)))
  ensures (inv(r) ==> canRespondTooLarge(r) ==> alwaysRecentCreditWarningRetained(respondTooLarge(r)))
  ensures (inv(r) ==> canRespondTooLarge(r) ==> stepAnsweredOnce(r, respondTooLarge(r)))
  ensures (inv(r) ==> canRespondTooLarge(r) ==> stepBucketsAreIndependent(r, respondTooLarge(r)))
{
  if inv(r) && canRespondTooLarge(r) {
    Buckets(r, respondTooLarge(r));
  }
}

lemma flush_ensures(r: Requests)
  ensures (inv(r) ==> canFlush(r) ==> alwaysBodyBounded(flush(r)))
  ensures (inv(r) ==> canFlush(r) ==> alwaysResponseMatchesRequest(flush(r)))
  ensures (inv(r) ==> canFlush(r) ==> alwaysCloseAfterFlush(flush(r)))
  ensures (inv(r) ==> canFlush(r) ==> alwaysBucketBalanced(flush(r)))
  ensures (inv(r) ==> canFlush(r) ==> alwaysCasBounded(flush(r)))
  ensures (inv(r) ==> canFlush(r) ==> alwaysLogBounded(flush(r)))
  ensures (inv(r) ==> canFlush(r) ==> alwaysLogEntriesInOrder(flush(r)))
  ensures (inv(r) ==> canFlush(r) ==> alwaysRecentCreditWarningRetained(flush(r)))
  ensures (inv(r) ==> canFlush(r) ==> stepAnsweredOnce(r, flush(r)))
  ensures (inv(r) ==> canFlush(r) ==> stepBucketsAreIndependent(r, flush(r)))
{
  if inv(r) && canFlush(r) {
    Buckets(r, flush(r));
  }
}

lemma closeConnection_ensures(r: Requests)
  ensures (inv(r) ==> canCloseConnection(r) ==> alwaysBodyBounded(closeConnection(r)))
  ensures (inv(r) ==> canCloseConnection(r) ==> alwaysResponseMatchesRequest(closeConnection(r)))
  ensures (inv(r) ==> canCloseConnection(r) ==> alwaysCloseAfterFlush(closeConnection(r)))
  ensures (inv(r) ==> canCloseConnection(r) ==> alwaysBucketBalanced(closeConnection(r)))
  ensures (inv(r) ==> canCloseConnection(r) ==> alwaysCasBounded(closeConnection(r)))
  ensures (inv(r) ==> canCloseConnection(r) ==> alwaysLogBounded(closeConnection(r)))
  ensures (inv(r) ==> canCloseConnection(r) ==> alwaysLogEntriesInOrder(closeConnection(r)))
  ensures (inv(r) ==> canCloseConnection(r) ==> alwaysRecentCreditWarningRetained(closeConnection(r)))
  ensures (inv(r) ==> canCloseConnection(r) ==> stepAnsweredOnce(r, closeConnection(r)))
  ensures (inv(r) ==> canCloseConnection(r) ==> stepBucketsAreIndependent(r, closeConnection(r)))
{
  if inv(r) && canCloseConnection(r) {
    Buckets(r, closeConnection(r));
  }
}

lemma peerAbort_ensures(r: Requests)
  ensures (inv(r) ==> canPeerAbort(r) ==> alwaysBodyBounded(peerAbort(r)))
  ensures (inv(r) ==> canPeerAbort(r) ==> alwaysResponseMatchesRequest(peerAbort(r)))
  ensures (inv(r) ==> canPeerAbort(r) ==> alwaysCloseAfterFlush(peerAbort(r)))
  ensures (inv(r) ==> canPeerAbort(r) ==> alwaysBucketBalanced(peerAbort(r)))
  ensures (inv(r) ==> canPeerAbort(r) ==> alwaysCasBounded(peerAbort(r)))
  ensures (inv(r) ==> canPeerAbort(r) ==> alwaysLogBounded(peerAbort(r)))
  ensures (inv(r) ==> canPeerAbort(r) ==> alwaysLogEntriesInOrder(peerAbort(r)))
  ensures (inv(r) ==> canPeerAbort(r) ==> alwaysRecentCreditWarningRetained(peerAbort(r)))
  ensures (inv(r) ==> canPeerAbort(r) ==> stepAnsweredOnce(r, peerAbort(r)))
  ensures (inv(r) ==> canPeerAbort(r) ==> stepBucketsAreIndependent(r, peerAbort(r)))
{
  if inv(r) && canPeerAbort(r) {
    Buckets(r, peerAbort(r));
  }
}

lemma refill_ensures(r: Requests, principal: int)
  ensures (inv(r) ==> canRefill(r, principal) ==> alwaysBodyBounded(refill(r, principal)))
  ensures (inv(r) ==> canRefill(r, principal) ==> alwaysResponseMatchesRequest(refill(r, principal)))
  ensures (inv(r) ==> canRefill(r, principal) ==> alwaysCloseAfterFlush(refill(r, principal)))
  ensures (inv(r) ==> canRefill(r, principal) ==> alwaysBucketBalanced(refill(r, principal)))
  ensures (inv(r) ==> canRefill(r, principal) ==> alwaysCasBounded(refill(r, principal)))
  ensures (inv(r) ==> canRefill(r, principal) ==> alwaysLogBounded(refill(r, principal)))
  ensures (inv(r) ==> canRefill(r, principal) ==> alwaysLogEntriesInOrder(refill(r, principal)))
  ensures (inv(r) ==> canRefill(r, principal) ==> alwaysRecentCreditWarningRetained(refill(r, principal)))
  ensures (inv(r) ==> canRefill(r, principal) ==> stepAnsweredOnce(r, refill(r, principal)))
  ensures (inv(r) ==> canRefill(r, principal) ==> stepBucketsAreIndependent(r, refill(r, principal)))
{
  if inv(r) && canRefill(r, principal) {
    Buckets(r, refill(r, principal));
  }
}

lemma admitCall_ensures(r: Requests, principal: int)
  ensures (inv(r) ==> canAdmitCall(r, principal) ==> alwaysBodyBounded(admitCall(r, principal)))
  ensures (inv(r) ==> canAdmitCall(r, principal) ==> alwaysResponseMatchesRequest(admitCall(r, principal)))
  ensures (inv(r) ==> canAdmitCall(r, principal) ==> alwaysCloseAfterFlush(admitCall(r, principal)))
  ensures (inv(r) ==> canAdmitCall(r, principal) ==> alwaysBucketBalanced(admitCall(r, principal)))
  ensures (inv(r) ==> canAdmitCall(r, principal) ==> alwaysCasBounded(admitCall(r, principal)))
  ensures (inv(r) ==> canAdmitCall(r, principal) ==> alwaysLogBounded(admitCall(r, principal)))
  ensures (inv(r) ==> canAdmitCall(r, principal) ==> alwaysLogEntriesInOrder(admitCall(r, principal)))
  ensures (inv(r) ==> canAdmitCall(r, principal) ==> alwaysRecentCreditWarningRetained(admitCall(r, principal)))
  ensures (inv(r) ==> canAdmitCall(r, principal) ==> stepAnsweredOnce(r, admitCall(r, principal)))
  ensures (inv(r) ==> canAdmitCall(r, principal) ==> stepBucketsAreIndependent(r, admitCall(r, principal)))
{
  if inv(r) && canAdmitCall(r, principal) {
    Buckets(r, admitCall(r, principal));
  }
}

lemma casConflict_ensures(r: Requests)
  ensures (inv(r) ==> canCasConflict(r) ==> alwaysBodyBounded(casConflict(r)))
  ensures (inv(r) ==> canCasConflict(r) ==> alwaysResponseMatchesRequest(casConflict(r)))
  ensures (inv(r) ==> canCasConflict(r) ==> alwaysCloseAfterFlush(casConflict(r)))
  ensures (inv(r) ==> canCasConflict(r) ==> alwaysBucketBalanced(casConflict(r)))
  ensures (inv(r) ==> canCasConflict(r) ==> alwaysCasBounded(casConflict(r)))
  ensures (inv(r) ==> canCasConflict(r) ==> alwaysLogBounded(casConflict(r)))
  ensures (inv(r) ==> canCasConflict(r) ==> alwaysLogEntriesInOrder(casConflict(r)))
  ensures (inv(r) ==> canCasConflict(r) ==> alwaysRecentCreditWarningRetained(casConflict(r)))
  ensures (inv(r) ==> canCasConflict(r) ==> stepAnsweredOnce(r, casConflict(r)))
  ensures (inv(r) ==> canCasConflict(r) ==> stepBucketsAreIndependent(r, casConflict(r)))
{
  if inv(r) && canCasConflict(r) {
    Buckets(r, casConflict(r));
  }
}

lemma casCommit_ensures(r: Requests)
  ensures (inv(r) ==> canCasCommit(r) ==> alwaysBodyBounded(casCommit(r)))
  ensures (inv(r) ==> canCasCommit(r) ==> alwaysResponseMatchesRequest(casCommit(r)))
  ensures (inv(r) ==> canCasCommit(r) ==> alwaysCloseAfterFlush(casCommit(r)))
  ensures (inv(r) ==> canCasCommit(r) ==> alwaysBucketBalanced(casCommit(r)))
  ensures (inv(r) ==> canCasCommit(r) ==> alwaysCasBounded(casCommit(r)))
  ensures (inv(r) ==> canCasCommit(r) ==> alwaysLogBounded(casCommit(r)))
  ensures (inv(r) ==> canCasCommit(r) ==> alwaysLogEntriesInOrder(casCommit(r)))
  ensures (inv(r) ==> canCasCommit(r) ==> alwaysRecentCreditWarningRetained(casCommit(r)))
  ensures (inv(r) ==> canCasCommit(r) ==> stepAnsweredOnce(r, casCommit(r)))
  ensures (inv(r) ==> canCasCommit(r) ==> stepBucketsAreIndependent(r, casCommit(r)))
{
  if inv(r) && canCasCommit(r) {
    Buckets(r, casCommit(r));
  }
}

lemma elapse_ensures(r: Requests)
  ensures (inv(r) ==> alwaysBodyBounded(elapse(r)))
  ensures (inv(r) ==> alwaysResponseMatchesRequest(elapse(r)))
  ensures (inv(r) ==> alwaysCloseAfterFlush(elapse(r)))
  ensures (inv(r) ==> alwaysBucketBalanced(elapse(r)))
  ensures (inv(r) ==> alwaysCasBounded(elapse(r)))
  ensures (inv(r) ==> alwaysLogBounded(elapse(r)))
  ensures (inv(r) ==> alwaysLogEntriesInOrder(elapse(r)))
  ensures (inv(r) ==> alwaysRecentCreditWarningRetained(elapse(r)))
  ensures (inv(r) ==> stepAnsweredOnce(r, elapse(r)))
  ensures (inv(r) ==> stepBucketsAreIndependent(r, elapse(r)))
{
  if inv(r) {
    Buckets(r, elapse(r));
    InOrderBridge(r);
    var n := r.now + 30;
    RCChar(r.history, n);
    RCChar(r.history, r.now);
    RCChar(r.buffer, r.now);
    forall e | e in r.history && e.credit && n - e.at <= creditLookback && e.id == recentCredit(r.history, n) ensures e in r.buffer {
      var wk :| wk in r.buffer && wk.credit && r.now - wk.at <= creditLookback && wk.id == recentCredit(r.buffer, r.now);
      if e.id < wk.id {
        assert wk.id <= recentCredit(r.history, n);
      }
      SameId(r.history, e, wk);
    }
    RCSub(r.history, r.buffer, n);
  }
}

lemma appendLog_ensures(r: Requests, credit: bool)
  ensures (inv(r) ==> alwaysBodyBounded(appendLog(r, credit)))
  ensures (inv(r) ==> alwaysResponseMatchesRequest(appendLog(r, credit)))
  ensures (inv(r) ==> alwaysCloseAfterFlush(appendLog(r, credit)))
  ensures (inv(r) ==> alwaysBucketBalanced(appendLog(r, credit)))
  ensures (inv(r) ==> alwaysCasBounded(appendLog(r, credit)))
  ensures (inv(r) ==> alwaysLogBounded(appendLog(r, credit)))
  ensures (inv(r) ==> alwaysLogEntriesInOrder(appendLog(r, credit)))
  ensures (inv(r) ==> alwaysRecentCreditWarningRetained(appendLog(r, credit)))
  ensures (inv(r) ==> stepAnsweredOnce(r, appendLog(r, credit)))
  ensures (inv(r) ==> stepBucketsAreIndependent(r, appendLog(r, credit)))
{
  if inv(r) {
    Buckets(r, appendLog(r, credit));
    AppendLogKeepsLog(r, credit);
  }
}

lemma Buckets(before: Requests, after: Requests)
  ensures stepBucketsAreIndependent(before, after) == !((tokensOf(before, 1) != tokensOf(after, 1)) && (tokensOf(before, 2) != tokensOf(after, 2)))
{
  ProofLib.FilterCons((p: int) => (tokensOf(before, p) != tokensOf(after, p)), principals);
  ProofLib.FilterCons((p: int) => (tokensOf(before, p) != tokensOf(after, p)), principals[1..]);
  ProofLib.FilterNil((p: int) => (tokensOf(before, p) != tokensOf(after, p)), principals[1..][1..]);
}

lemma CountOne(xs: seq<LogEntry>)
  ensures (forall e :: e in xs ==> |ProofLib.Filter((f: LogEntry) => (f.id == e.id), xs)| == 1) <==> ProofLib.DistinctBy(xs, (e: LogEntry) => e.id)
{
  forall i | 0 <= i < |xs| ensures |ProofLib.Filter((f: LogEntry) => (f.id == xs[i].id), xs)| == 1 <==> forall j :: 0 <= j < |xs| && j != i ==> xs[j].id != xs[i].id {
    ProofLib.FilterCountOneIffUnique((f: LogEntry) => (f.id == xs[i].id), xs, (e: LogEntry) => e.id, i);
  }
}

lemma InOrderBridge(r: Requests)
  ensures alwaysLogEntriesInOrder(r) <==> r.nextLog >= 0 && (forall e :: e in r.history ==> e.id >= 0 && e.id < r.nextLog && e.at <= r.now) && (forall e, f :: e in r.history && f in r.history && e.id < f.id ==> e.at <= f.at) && ProofLib.DistinctBy(r.history, (e: LogEntry) => e.id) && (forall e :: e in r.buffer ==> e in r.history) && ProofLib.DistinctBy(r.buffer, (e: LogEntry) => e.id)
{
  InOrderText(r);
  CountOne(r.history);
  CountOne(r.buffer);
}

lemma SameId(xs: seq<LogEntry>, a: LogEntry, b: LogEntry)
  requires ProofLib.DistinctBy(xs, (e: LogEntry) => e.id) && a in xs && b in xs && a.id == b.id
  ensures a == b
{
  var i :| 0 <= i < |xs| && xs[i] == a;
  var j :| 0 <= j < |xs| && xs[j] == b;
}

lemma DistinctLen(xs: seq<LogEntry>, ids: set<int>)
  requires ProofLib.DistinctBy(xs, (e: LogEntry) => e.id) && forall e :: e in xs ==> e.id in ids
  ensures |xs| <= |ids|
  decreases |xs|
{
  if |xs| > 0 {
    forall e | e in xs[1..] ensures e.id in ids - {xs[0].id} {
      var j :| 0 <= j < |xs[1..]| && xs[1..][j] == e;
      assert xs[j + 1] == e;
    }
    assert ProofLib.DistinctBy(xs[1..], (e: LogEntry) => e.id) by {
      forall i, j | 0 <= i < |xs[1..]| && 0 <= j < |xs[1..]| && i != j ensures xs[1..][i].id != xs[1..][j].id {
        assert xs[1..][i] == xs[i + 1] && xs[1..][j] == xs[j + 1];
      }
    }
    DistinctLen(xs[1..], ids - {xs[0].id});
  }
}

lemma EvictedBridge(entries: seq<LogEntry>, newest: int, now: int)
  ensures evicted(entries, newest, now) == (if (|entries| > logCapacity) then ProofLib.Filter((e: LogEntry) => ((e.id >= (newest - 1)) || (e.id == recentCredit(entries, now))), entries) else entries)
{
}

lemma RCFold(xs: seq<LogEntry>, now: int, acc: int)
  ensures Std.Collections.Seq.FoldLeft((latest: int, e: LogEntry) => (if ((e.credit && ((now - e.at) <= creditLookback)) && (e.id > latest)) then e.id else latest), acc, xs) >= acc
  ensures Std.Collections.Seq.FoldLeft((latest: int, e: LogEntry) => (if ((e.credit && ((now - e.at) <= creditLookback)) && (e.id > latest)) then e.id else latest), acc, xs) == acc || exists e :: e in xs && e.credit && now - e.at <= creditLookback && e.id == Std.Collections.Seq.FoldLeft((latest: int, e: LogEntry) => (if ((e.credit && ((now - e.at) <= creditLookback)) && (e.id > latest)) then e.id else latest), acc, xs)
  ensures forall e :: e in xs && e.credit && now - e.at <= creditLookback ==> e.id <= Std.Collections.Seq.FoldLeft((latest: int, e: LogEntry) => (if ((e.credit && ((now - e.at) <= creditLookback)) && (e.id > latest)) then e.id else latest), acc, xs)
  decreases |xs|
{
  if |xs| > 0 {
    RCFold(xs[1..], now, (if ((xs[0].credit && ((now - xs[0].at) <= creditLookback)) && (xs[0].id > acc)) then xs[0].id else acc));
    assert forall e :: e in xs[1..] ==> e in xs;
    assert forall e :: e in xs ==> e == xs[0] || e in xs[1..];
  }
}

lemma RCChar(xs: seq<LogEntry>, now: int)
  ensures recentCredit(xs, now) >= -1
  ensures recentCredit(xs, now) == -1 || exists e :: e in xs && e.credit && now - e.at <= creditLookback && e.id == recentCredit(xs, now)
  ensures forall e :: e in xs && e.credit && now - e.at <= creditLookback ==> e.id <= recentCredit(xs, now)
{
  RCFold(xs, now, -1);
}

lemma RCAppend(xs: seq<LogEntry>, x: LogEntry, now: int)
  ensures recentCredit(xs + [x], now) == (if ((x.credit && ((now - x.at) <= creditLookback)) && (x.id > recentCredit(xs, now))) then x.id else recentCredit(xs, now))
{
  ProofLib.FoldLeftAppend((latest: int, e: LogEntry) => (if ((e.credit && ((now - e.at) <= creditLookback)) && (e.id > latest)) then e.id else latest), -1, xs, x);
}

lemma RCSub(xs: seq<LogEntry>, ys: seq<LogEntry>, now: int)
  requires forall e :: e in ys ==> e in xs
  requires forall e :: e in xs && e.credit && now - e.at <= creditLookback && e.id == recentCredit(xs, now) ==> e in ys
  ensures recentCredit(ys, now) == recentCredit(xs, now)
{
  RCChar(xs, now);
  RCChar(ys, now);
}

lemma InOrderText(r: Requests)
  ensures alwaysLogEntriesInOrder(r) == (((r.nextLog >= 0) && !((exists e :: e in r.history && !((((((e.id >= 0) && (e.id < r.nextLog)) && (e.at <= r.now)) && (|ProofLib.Filter((f: LogEntry) => (f.id == e.id), r.history)| == 1)) && !((exists f :: f in r.history && !((!((e.id < f.id)) || (e.at <= f.at)))))))))) && !((exists e :: e in r.buffer && !(((e in r.history) && (|ProofLib.Filter((f: LogEntry) => (f.id == e.id), r.buffer)| == 1))))))
{
}

lemma AppendLogKeepsLog(r: Requests, credit: bool)
  requires inv(r)
  ensures alwaysLogBounded(appendLog(r, credit)) && alwaysLogEntriesInOrder(appendLog(r, credit)) && alwaysRecentCreditWarningRetained(appendLog(r, credit))
{
  var x := LogEntry(r.nextLog, credit, r.now);
  var b := r.buffer + [x];
  var after := appendLog(r, credit);
  InOrderBridge(r);
  InOrderBridge(after);
  assert after.history == r.history + [x];
  forall e, f | e in after.history && f in after.history && e.id < f.id ensures e.at <= f.at {
    if f != x && e != x {
      assert e in r.history && f in r.history;
    }
  }
  ProofLib.DistinctByConcat(r.history, [x], (e: LogEntry) => e.id);
  assert forall e :: e in b ==> e in after.history && e.id <= r.nextLog;
  ProofLib.DistinctByConcat(r.buffer, [x], (e: LogEntry) => e.id);
  RCAppend(r.history, x, r.now);
  RCAppend(r.buffer, x, r.now);
  EvictedBridge(b, r.nextLog, r.now);
  if |b| > logCapacity {
    var keep := recentCredit(b, r.now);
    var p := (e: LogEntry) => ((e.id >= (r.nextLog - 1)) || (e.id == keep));
    var kept := ProofLib.Filter(p, b);
    assert after.buffer == kept;
    forall e | e in b || e in kept ensures e in kept <==> e in b && p(e) {
      ProofLib.FilterMember(p, b, e);
    }
    ProofLib.FilterKeepsDistinctBy(p, b, (e: LogEntry) => e.id);
    assert forall e :: e in kept ==> e.id in {r.nextLog - 1, r.nextLog, keep};
    DistinctLen(kept, {r.nextLog - 1, r.nextLog, keep});
    assert |{r.nextLog - 1, r.nextLog, keep}| <= 3;
    RCChar(b, r.now);
    assert forall e :: e in b && e.credit && r.now - e.at <= creditLookback && e.id == recentCredit(b, r.now) ==> e in kept;
    RCSub(b, kept, r.now);
  } else {
    assert after.buffer == b;
  }
}
