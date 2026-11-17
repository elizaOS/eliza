lemma revalidate_ensures(a: PaidAccess)
  ensures (inv(a) ==> canRevalidate(a) ==> alwaysOneFlightPerTuple(revalidate(a)))
  ensures (inv(a) ==> canRevalidate(a) ==> alwaysNoStaleAdmission(revalidate(a)))
  ensures (inv(a) ==> canRevalidate(a) ==> alwaysDefiniteCacheOnly(revalidate(a)))
  ensures (inv(a) ==> canRevalidate(a) ==> alwaysReadNumbersInRange(revalidate(a)))
  ensures (inv(a) ==> canRevalidate(a) ==> alwaysReadsPrecedeTheTuple(revalidate(a)))
  ensures (inv(a) ==> canRevalidate(a) ==> alwaysCurrentPendingReadIsTheFlight(revalidate(a)))
  ensures (inv(a) ==> canRevalidate(a) ==> alwaysNoWrongOwnerCleared(revalidate(a)))
  ensures (inv(a) ==> canRevalidate(a) ==> alwaysUnresolvedReadHasNoAnswer(revalidate(a)))
  ensures (inv(a) ==> canRevalidate(a) ==> stepFinishedReadKeepsSuccessorFlight(a, "revalidate", revalidate(a)))
  ensures (inv(a) ==> canRevalidate(a) ==> stepDeliveredAnswerMatchesAccount(a, revalidate(a)))
{
  if inv(a) && canRevalidate(a) {
    NewRead(a, revalidate(a));
  }
}

lemma joinFlight_ensures(a: PaidAccess, caller: int)
  ensures (inv(a) ==> alwaysOneFlightPerTuple(joinFlight(a, caller)))
  ensures (inv(a) ==> alwaysNoStaleAdmission(joinFlight(a, caller)))
  ensures (inv(a) ==> alwaysDefiniteCacheOnly(joinFlight(a, caller)))
  ensures (inv(a) ==> alwaysReadNumbersInRange(joinFlight(a, caller)))
  ensures (inv(a) ==> alwaysReadsPrecedeTheTuple(joinFlight(a, caller)))
  ensures (inv(a) ==> alwaysCurrentPendingReadIsTheFlight(joinFlight(a, caller)))
  ensures (inv(a) ==> alwaysNoWrongOwnerCleared(joinFlight(a, caller)))
  ensures (inv(a) ==> alwaysUnresolvedReadHasNoAnswer(joinFlight(a, caller)))
  ensures (inv(a) ==> stepFinishedReadKeepsSuccessorFlight(a, "joinFlight", joinFlight(a, caller)))
  ensures (inv(a) ==> stepDeliveredAnswerMatchesAccount(a, joinFlight(a, caller)))
{
  if inv(a) {
    var b := joinFlight(a, caller);
    if !matchingFlight(a) { NewRead(a, b); }
    Calls(a, b, caller, AccessCall(caller, CallPhase.CallWaiting, b.flight, a.tuple, noTuple));
  }
}

lemma beginCheck_ensures(a: PaidAccess, caller: int)
  ensures (inv(a) ==> canBeginCheck(a, caller) ==> alwaysOneFlightPerTuple(beginCheck(a, caller)))
  ensures (inv(a) ==> canBeginCheck(a, caller) ==> alwaysNoStaleAdmission(beginCheck(a, caller)))
  ensures (inv(a) ==> canBeginCheck(a, caller) ==> alwaysDefiniteCacheOnly(beginCheck(a, caller)))
  ensures (inv(a) ==> canBeginCheck(a, caller) ==> alwaysReadNumbersInRange(beginCheck(a, caller)))
  ensures (inv(a) ==> canBeginCheck(a, caller) ==> alwaysReadsPrecedeTheTuple(beginCheck(a, caller)))
  ensures (inv(a) ==> canBeginCheck(a, caller) ==> alwaysCurrentPendingReadIsTheFlight(beginCheck(a, caller)))
  ensures (inv(a) ==> canBeginCheck(a, caller) ==> alwaysNoWrongOwnerCleared(beginCheck(a, caller)))
  ensures (inv(a) ==> canBeginCheck(a, caller) ==> alwaysUnresolvedReadHasNoAnswer(beginCheck(a, caller)))
  ensures (inv(a) ==> canBeginCheck(a, caller) ==> stepFinishedReadKeepsSuccessorFlight(a, "beginCheck", beginCheck(a, caller)))
  ensures (inv(a) ==> canBeginCheck(a, caller) ==> stepDeliveredAnswerMatchesAccount(a, beginCheck(a, caller)))
{
  if inv(a) && canBeginCheck(a, caller) {
    if warm(a) {
      Calls(a, beginCheck(a, caller), caller, AccessCall(caller, CallPhase.CallAdmitted, 0, a.tuple, a.tuple));
    } else {
      joinFlight_ensures(a, caller);
    }
  }
}

lemma finishRead_ensures(a: PaidAccess, r: int)
  ensures (inv(a) ==> canFinishRead(a, r) ==> alwaysOneFlightPerTuple(finishRead(a, r)))
  ensures (inv(a) ==> canFinishRead(a, r) ==> alwaysNoStaleAdmission(finishRead(a, r)))
  ensures (inv(a) ==> canFinishRead(a, r) ==> alwaysDefiniteCacheOnly(finishRead(a, r)))
  ensures (inv(a) ==> canFinishRead(a, r) ==> alwaysReadNumbersInRange(finishRead(a, r)))
  ensures (inv(a) ==> canFinishRead(a, r) ==> alwaysReadsPrecedeTheTuple(finishRead(a, r)))
  ensures (inv(a) ==> canFinishRead(a, r) ==> alwaysCurrentPendingReadIsTheFlight(finishRead(a, r)))
  ensures (inv(a) ==> canFinishRead(a, r) ==> alwaysNoWrongOwnerCleared(finishRead(a, r)))
  ensures (inv(a) ==> canFinishRead(a, r) ==> alwaysUnresolvedReadHasNoAnswer(finishRead(a, r)))
  ensures (inv(a) ==> canFinishRead(a, r) ==> stepFinishedReadKeepsSuccessorFlight(a, "finishRead", finishRead(a, r)))
  ensures (inv(a) ==> canFinishRead(a, r) ==> stepDeliveredAnswerMatchesAccount(a, finishRead(a, r)))
{
  if inv(a) && canFinishRead(a, r) {
    Put(a, finishRead(a, r), r, readOf(a, r).(phase := ReadPhase.ReadDone));
  }
}

lemma identityRefused_ensures(a: PaidAccess, r: int)
  ensures (inv(a) ==> canIdentityRefused(a, r) ==> alwaysOneFlightPerTuple(identityRefused(a, r)))
  ensures (inv(a) ==> canIdentityRefused(a, r) ==> alwaysNoStaleAdmission(identityRefused(a, r)))
  ensures (inv(a) ==> canIdentityRefused(a, r) ==> alwaysDefiniteCacheOnly(identityRefused(a, r)))
  ensures (inv(a) ==> canIdentityRefused(a, r) ==> alwaysReadNumbersInRange(identityRefused(a, r)))
  ensures (inv(a) ==> canIdentityRefused(a, r) ==> alwaysReadsPrecedeTheTuple(identityRefused(a, r)))
  ensures (inv(a) ==> canIdentityRefused(a, r) ==> alwaysCurrentPendingReadIsTheFlight(identityRefused(a, r)))
  ensures (inv(a) ==> canIdentityRefused(a, r) ==> alwaysNoWrongOwnerCleared(identityRefused(a, r)))
  ensures (inv(a) ==> canIdentityRefused(a, r) ==> alwaysUnresolvedReadHasNoAnswer(identityRefused(a, r)))
  ensures (inv(a) ==> canIdentityRefused(a, r) ==> stepFinishedReadKeepsSuccessorFlight(a, "identityRefused", identityRefused(a, r)))
  ensures (inv(a) ==> canIdentityRefused(a, r) ==> stepDeliveredAnswerMatchesAccount(a, identityRefused(a, r)))
{
  if inv(a) && canIdentityRefused(a, r) {
    var x := readOf(a, r);
    var b := identityRefused(a, r);
    ReadIn(a, r);
    if x.tuple.generation == a.tuple.generation {
      Put(a, b, r, if (x.tuple.key == a.tuple.key) then x.(phase := ReadPhase.ReadRevoking) else x.(phase := ReadPhase.ReadResolved, outcome := AccessOutcome.AccessStale));
    } else {
      Put(a, b, r, x.(phase := ReadPhase.ReadResolved, outcome := AccessOutcome.AccessStale));
    }
  }
}

lemma finishRevocation_ensures(a: PaidAccess, r: int)
  ensures (inv(a) ==> canFinishRevocation(a, r) ==> alwaysOneFlightPerTuple(finishRevocation(a, r)))
  ensures (inv(a) ==> canFinishRevocation(a, r) ==> alwaysNoStaleAdmission(finishRevocation(a, r)))
  ensures (inv(a) ==> canFinishRevocation(a, r) ==> alwaysDefiniteCacheOnly(finishRevocation(a, r)))
  ensures (inv(a) ==> canFinishRevocation(a, r) ==> alwaysReadNumbersInRange(finishRevocation(a, r)))
  ensures (inv(a) ==> canFinishRevocation(a, r) ==> alwaysReadsPrecedeTheTuple(finishRevocation(a, r)))
  ensures (inv(a) ==> canFinishRevocation(a, r) ==> alwaysCurrentPendingReadIsTheFlight(finishRevocation(a, r)))
  ensures (inv(a) ==> canFinishRevocation(a, r) ==> alwaysNoWrongOwnerCleared(finishRevocation(a, r)))
  ensures (inv(a) ==> canFinishRevocation(a, r) ==> alwaysUnresolvedReadHasNoAnswer(finishRevocation(a, r)))
  ensures (inv(a) ==> canFinishRevocation(a, r) ==> stepFinishedReadKeepsSuccessorFlight(a, "finishRevocation", finishRevocation(a, r)))
  ensures (inv(a) ==> canFinishRevocation(a, r) ==> stepDeliveredAnswerMatchesAccount(a, finishRevocation(a, r)))
{
  if inv(a) && canFinishRevocation(a, r) {
    var x := readOf(a, r);
    var b := finishRevocation(a, r);
    if sameOwner(a, x.tuple) {
      Put(a, b, r, x.(phase := ReadPhase.ReadResolved, outcome := AccessOutcome.AccessRevoked));
    } else {
      Put(a, b, r, x.(phase := ReadPhase.ReadResolved, outcome := AccessOutcome.AccessStale));
    }
  }
}

lemma resolveRead_ensures(a: PaidAccess, r: int, unavailable: bool)
  ensures (inv(a) ==> canResolveRead(a, r, unavailable) ==> alwaysOneFlightPerTuple(resolveRead(a, r, unavailable)))
  ensures (inv(a) ==> canResolveRead(a, r, unavailable) ==> alwaysNoStaleAdmission(resolveRead(a, r, unavailable)))
  ensures (inv(a) ==> canResolveRead(a, r, unavailable) ==> alwaysDefiniteCacheOnly(resolveRead(a, r, unavailable)))
  ensures (inv(a) ==> canResolveRead(a, r, unavailable) ==> alwaysReadNumbersInRange(resolveRead(a, r, unavailable)))
  ensures (inv(a) ==> canResolveRead(a, r, unavailable) ==> alwaysReadsPrecedeTheTuple(resolveRead(a, r, unavailable)))
  ensures (inv(a) ==> canResolveRead(a, r, unavailable) ==> alwaysCurrentPendingReadIsTheFlight(resolveRead(a, r, unavailable)))
  ensures (inv(a) ==> canResolveRead(a, r, unavailable) ==> alwaysNoWrongOwnerCleared(resolveRead(a, r, unavailable)))
  ensures (inv(a) ==> canResolveRead(a, r, unavailable) ==> alwaysUnresolvedReadHasNoAnswer(resolveRead(a, r, unavailable)))
  ensures (inv(a) ==> canResolveRead(a, r, unavailable) ==> stepFinishedReadKeepsSuccessorFlight(a, "resolveRead", resolveRead(a, r, unavailable)))
  ensures (inv(a) ==> canResolveRead(a, r, unavailable) ==> stepDeliveredAnswerMatchesAccount(a, resolveRead(a, r, unavailable)))
{
  if inv(a) && canResolveRead(a, r, unavailable) {
    var x := readOf(a, r);
    var answer := if !(sameOwner(a, x.tuple)) then AccessOutcome.AccessStale else (if unavailable then AccessOutcome.AccessUnavailable else (if (x.tuple.key in a.refusedKeys) then AccessOutcome.AccessRefused else AccessOutcome.AccessActive));
    Put(a, resolveRead(a, r, unavailable), r, x.(phase := ReadPhase.ReadResolved, outcome := answer));
  }
}

lemma FilterSameWhere<T>(p: T -> bool, xs: seq<T>, ys: seq<T>)
  requires |xs| == |ys|
  requires forall i :: 0 <= i < |xs| && (p(xs[i]) || p(ys[i])) ==> xs[i] == ys[i]
  ensures ProofLib.Filter(p, xs) == ProofLib.Filter(p, ys)
  decreases |xs|
{
  if |xs| == 0 {
    ProofLib.FilterNil(p, xs);
    ProofLib.FilterNil(p, ys);
  } else {
    ProofLib.FilterCons(p, xs);
    ProofLib.FilterCons(p, ys);
    FilterSameWhere(p, xs[1..], ys[1..]);
  }
}

lemma ReadOfBridge(a: PaidAccess, r: int)
  ensures readOf(a, r) == (if 0 < |ProofLib.Filter((x: AccessRead) => (x.read == r), a.reads_)| then ProofLib.Filter((x: AccessRead) => (x.read == r), a.reads_)[0] else noRead)
{
}

lemma ReadIn(a: PaidAccess, r: int)
  ensures readOf(a, r) == noRead || (readOf(a, r) in a.reads_ && readOf(a, r).read == r)
{
  ReadOfBridge(a, r);
  var f := ProofLib.Filter((x: AccessRead) => (x.read == r), a.reads_);
  if 0 < |f| {
    ProofLib.FilterMember((x: AccessRead) => (x.read == r), a.reads_, f[0]);
  }
}

lemma ReadOfSame(a: PaidAccess, b: PaidAccess, r: int)
  requires |a.reads_| == |b.reads_|
  requires forall i :: 0 <= i < |a.reads_| && (a.reads_[i].read == r || b.reads_[i].read == r) ==> a.reads_[i] == b.reads_[i]
  ensures readOf(a, r) == readOf(b, r)
{
  ReadOfBridge(a, r);
  ReadOfBridge(b, r);
  FilterSameWhere((x: AccessRead) => (x.read == r), a.reads_, b.reads_);
}

lemma ReadOfOnly(a: PaidAccess, r: int, v: AccessRead)
  requires v in a.reads_ && v.read == r
  requires forall y :: y in a.reads_ && y.read == r ==> y == v
  ensures readOf(a, r) == v
{
  ReadOfBridge(a, r);
  ProofLib.FilterMember((x: AccessRead) => (x.read == r), a.reads_, v);
  var f := ProofLib.Filter((x: AccessRead) => (x.read == r), a.reads_);
  ProofLib.FilterMember((x: AccessRead) => (x.read == r), a.reads_, f[0]);
}

lemma PendingBridge(a: PaidAccess)
  ensures alwaysOneFlightPerTuple(a) <==> forall i, j :: 0 <= i < |a.reads_| && 0 <= j < |a.reads_| && i != j && a.reads_[i].phase.ReadPending? && a.reads_[j].phase.ReadPending? ==> a.reads_[i].tuple != a.reads_[j].tuple
{
  var rs := a.reads_;
  assert alwaysOneFlightPerTuple(a) <==> forall x :: x in rs && x.phase.ReadPending? ==> |ProofLib.Filter((y: AccessRead) => (y.phase.ReadPending? && (y.tuple == x.tuple)), rs)| == 1;
  forall i | 0 <= i < |rs| && rs[i].phase.ReadPending?
    ensures |ProofLib.Filter((y: AccessRead) => (y.phase.ReadPending? && (y.tuple == rs[i].tuple)), rs)| == 1 <==> forall j :: 0 <= j < |rs| && j != i ==> (rs[j].phase.ReadPending?, rs[j].tuple) != (rs[i].phase.ReadPending?, rs[i].tuple)
  {
    ProofLib.FilterCountOneIffUnique((y: AccessRead) => (y.phase.ReadPending? && (y.tuple == rs[i].tuple)), rs, (y: AccessRead) => (y.phase.ReadPending?, y.tuple), i);
  }
  if forall i, j :: 0 <= i < |rs| && 0 <= j < |rs| && i != j && rs[i].phase.ReadPending? && rs[j].phase.ReadPending? ==> rs[i].tuple != rs[j].tuple {
    forall x | x in rs && x.phase.ReadPending? ensures |ProofLib.Filter((y: AccessRead) => (y.phase.ReadPending? && (y.tuple == x.tuple)), rs)| == 1 {
      var i :| 0 <= i < |rs| && rs[i] == x;
    }
  }
}

lemma Calls(a: PaidAccess, b: PaidAccess, caller: int, n: AccessCall)
  requires alwaysNoStaleAdmission(a)
  requires b.calls == ProofLib.Filter((c: AccessCall) => (c.caller != caller), a.calls) + [n]
  requires n.phase.CallAdmitted? ==> n.admitted == n.tuple && n.admitted.generation == b.tuple.generation
  ensures alwaysNoStaleAdmission(b) && stepDeliveredAnswerMatchesAccount(a, b)
{
  forall c | c in b.calls ensures c == n || c in a.calls {
    if c != n {
      ProofLib.FilterMember((c: AccessCall) => (c.caller != caller), a.calls, c);
    }
  }
}

lemma NewRead(a: PaidAccess, b: PaidAccess)
  requires inv(a) && !matchingFlight(a)
  requires b.reads_ == a.reads_ + [AccessRead(|a.reads_| + 1, ReadPhase.ReadPending, a.tuple, AccessOutcome.NoOutcome)]
  requires b.flight == |a.reads_| + 1 && b.tuple == a.tuple && b.cache == a.cache
  ensures alwaysOneFlightPerTuple(b) && alwaysReadNumbersInRange(b) && alwaysReadsPrecedeTheTuple(b) && alwaysDefiniteCacheOnly(b)
  ensures alwaysCurrentPendingReadIsTheFlight(b) && alwaysUnresolvedReadHasNoAnswer(b)
{
  var rs := a.reads_;
  var n := AccessRead(|rs| + 1, ReadPhase.ReadPending, a.tuple, AccessOutcome.NoOutcome);
  PendingBridge(a);
  PendingBridge(b);
  forall i | 0 <= i < |rs| && rs[i].phase.ReadPending? ensures rs[i].tuple != a.tuple {
    assert rs[i] in rs;
  }
  forall y | y in b.reads_ && y.read == |rs| + 1 ensures y == n {
    if y in rs {}
  }
  ReadOfOnly(b, |rs| + 1, n);
  if a.cache != 0 {
    ReadIn(a, a.cache);
    ReadOfBridge(a, a.cache);
    ReadOfBridge(b, a.cache);
    ProofLib.FilterAppend((x: AccessRead) => (x.read == a.cache), rs, n);
  }
}

lemma Put(a: PaidAccess, b: PaidAccess, r: int, v: AccessRead)
  requires inv(a) && readOf(a, r).read == r && !readOf(a, r).phase.ReadDone?
  requires v.read == r && v.tuple == readOf(a, r).tuple && !v.phase.ReadPending?
  requires v.phase.ReadRevoking? ==> v.outcome.NoOutcome?
  requires readOf(a, r).phase.ReadResolved? ==> v.outcome == readOf(a, r).outcome
  requires b.reads_ == putRead(a, v)
  requires alwaysReadsPrecedeTheTuple(a.(tuple := b.tuple))
  requires b.tuple == a.tuple || forall y :: y in a.reads_ ==> y.tuple != b.tuple
  requires b.flight == a.flight || (b.flight == 0 && a.flight == r)
  requires b.cache == 0 || b.cache == a.cache || (b.cache == r && (v.outcome.AccessActive? || v.outcome.AccessRefused?))
  ensures alwaysOneFlightPerTuple(b) && alwaysReadsPrecedeTheTuple(b) && alwaysDefiniteCacheOnly(b)
  ensures alwaysCurrentPendingReadIsTheFlight(b) && alwaysUnresolvedReadHasNoAnswer(b)
  ensures readOf(b, r) == v
{
  var rs := a.reads_;
  var bs := b.reads_;
  var o := readOf(a, r);
  ReadIn(a, r);
  assert |bs| == |rs| && forall i :: 0 <= i < |rs| ==> bs[i] == (if rs[i].read == r then v else rs[i]);
  var k :| 0 <= k < |rs| && rs[k] == o;
  assert bs[k] == v;
  ReadOfOnly(b, r, v);
  forall y | y in bs ensures y == v || exists i :: 0 <= i < |rs| && rs[i].read != r && bs[i] == y && rs[i] == y {
    var i :| 0 <= i < |bs| && bs[i] == y;
  }
  PendingBridge(a);
  PendingBridge(b);
  if a.cache != 0 && a.cache != r { ReadOfSame(a, b, a.cache); }
  if a.flight != r { ReadOfSame(a, b, a.flight); }
  if a.cache == r && b.cache == a.cache {
    assert o in rs;
  }
  forall y | y in bs && y.phase.ReadPending? && y.tuple == b.tuple ensures matchingFlight(b) {
    var i :| 0 <= i < |rs| && rs[i].read != r && bs[i] == y && rs[i] == y;
    assert rs[i] in rs;
    if a.flight == r {
      assert k != i;
    }
  }
}
