lemma AddOne(a: seq<int>, x: int)
  ensures a + ProofLib.Filter((set_x: int) => !((set_x in a)), [x]) == (if x in a then a else a + [x])
{
  ProofLib.FilterCons((set_x: int) => !((set_x in a)), [x]);
  ProofLib.FilterNil((set_x: int) => !((set_x in a)), [x][1..]);
}

lemma Union(a: seq<int>, c: seq<int>)
  ensures forall y :: y in a + ProofLib.Filter((set_x: int) => !((set_x in a)), c) <==> (y in a || y in c)
{
  forall y ensures y in ProofLib.Filter((set_x: int) => !((set_x in a)), c) <==> (y in c && !(y in a)) {
    ProofLib.FilterMember((set_x: int) => !((set_x in a)), c, y);
  }
}

lemma KeepAll(p: int -> bool, xs: seq<int>)
  requires forall i :: 0 <= i < |xs| ==> p(xs[i])
  ensures ProofLib.Filter(p, xs) == xs
  decreases |xs|
{
  if |xs| == 0 { ProofLib.FilterNil(p, xs); } else { ProofLib.FilterCons(p, xs); KeepAll(p, xs[1..]); }
}

lemma RemoveCount(a: seq<int>, c: int)
  requires ProofLib.Distinct(a) && c in a
  ensures |ProofLib.Filter((set_x: int) => !((set_x in [c])), a)| == |a| - 1
  decreases |a|
{
  ProofLib.FilterCons((set_x: int) => !((set_x in [c])), a);
  if a[0] == c {
    assert forall i :: 0 <= i < |a[1..]| ==> a[1..][i] != c by { assert forall i :: 0 < i < |a| ==> a[i] != a[0]; }
    KeepAll((set_x: int) => !((set_x in [c])), a[1..]);
  } else {
    RemoveCount(a[1..], c);
  }
}

lemma Remove(a: seq<int>, c: int)
  ensures forall y :: y in ProofLib.Filter((set_x: int) => !((set_x in [c])), a) <==> y in a && y != c
  ensures ProofLib.Distinct(a) ==> ProofLib.Distinct(ProofLib.Filter((set_x: int) => !((set_x in [c])), a))
  ensures ProofLib.Distinct(a) && c in a ==> |ProofLib.Filter((set_x: int) => !((set_x in [c])), a)| == |a| - 1
{
  forall y ensures y in ProofLib.Filter((set_x: int) => !((set_x in [c])), a) <==> y in a && y != c {
    ProofLib.FilterMember((set_x: int) => !((set_x in [c])), a, y);
  }
  if ProofLib.Distinct(a) {
    ProofLib.FilterKeepsDistinctBy((set_x: int) => !((set_x in [c])), a, (x: int) => x);
    if c in a { RemoveCount(a, c); }
  }
}

lemma SkipIds(acc: seq<int>, ws: seq<Waiter>)
  ensures forall y :: y in Std.Collections.Seq.FoldLeft((ids: seq<int>, w: Waiter) => (ids + Std.Collections.Seq.Filter((set_x: int) => !((set_x in ids)), [w.id])), acc, ws) ==> y in acc || exists w :: w in ws && w.id == y
  decreases |ws|
{
  if |ws| > 0 {
    var f := (ids: seq<int>, w: Waiter) => (ids + Std.Collections.Seq.Filter((set_x: int) => !((set_x in ids)), [w.id]));
    ProofLib.FilterCons((set_x: int) => !((set_x in acc)), [ws[0].id]);
    ProofLib.FilterNil((set_x: int) => !((set_x in acc)), [ws[0].id][1..]);
    assert forall y :: y in f(acc, ws[0]) ==> y in acc || y == ws[0].id;
    SkipIds(f(acc, ws[0]), ws[1..]);
    assert forall w :: w in ws[1..] ==> w in ws;
  }
}

lemma View(s: SemaphoreState)
  ensures alwaysWaitersUnique(s) == ((forall w :: w in s.waiters ==> w.id > 0 && w.ticket > 0 && w.ticket < s.nextTicket && !(w.id in s.holders)) && ProofLib.DistinctBy(s.waiters, (x: Waiter) => x.id))
  ensures alwaysEachHolderCountedOnce(s) == ProofLib.Distinct(s.holders)
  ensures alwaysCancelledQueuedNeverOwns(s) == (forall x :: x in s.queuedAbort ==> !(x in s.holders) && !(x in s.completed))
{
  var W := s.waiters;
  var H := s.holders;
  var Q := s.queuedAbort;
  assert alwaysWaitersUnique(s) == (forall w :: w in W ==> w.id > 0 && w.ticket > 0 && w.ticket < s.nextTicket && |ProofLib.Filter((x: Waiter) => (x.id == w.id), W)| == 1 && !(w.id in H));
  if forall w :: w in W ==> |ProofLib.Filter((x: Waiter) => (x.id == w.id), W)| == 1 {
    forall i, j | 0 <= i < |W| && 0 <= j < |W| && i != j ensures W[i].id != W[j].id {
      if W[i].id == W[j].id { assert W[i] in W; ProofLib.FilterTwo((x: Waiter) => (x.id == W[i].id), W, i, j); }
    }
  }
  if ProofLib.DistinctBy(W, (x: Waiter) => x.id) {
    forall w | w in W ensures |ProofLib.Filter((x: Waiter) => (x.id == w.id), W)| == 1 {
      var i :| 0 <= i < |W| && W[i] == w;
      ProofLib.FilterOne((x: Waiter) => (x.id == w.id), W, i);
    }
  }
  assert alwaysEachHolderCountedOnce(s) == (forall h :: h in H ==> |ProofLib.Filter((x: int) => (x == h), H)| == 1);
  if forall h :: h in H ==> |ProofLib.Filter((x: int) => (x == h), H)| == 1 {
    forall i, j | 0 <= i < j < |H| ensures H[i] != H[j] {
      if H[i] == H[j] { assert H[i] in H; ProofLib.FilterTwo((x: int) => (x == H[i]), H, i, j); }
    }
  }
  if ProofLib.Distinct(H) {
    forall h | h in H ensures |ProofLib.Filter((x: int) => (x == h), H)| == 1 {
      ProofLib.FilterDistinctCountOne((x: int) => (x == h), H, h);
    }
  }
  ViewQueued(s);
}

lemma ViewQueued(s: SemaphoreState)
  ensures alwaysCancelledQueuedNeverOwns(s) == (forall x :: x in s.queuedAbort ==> !(x in s.holders) && !(x in s.completed))
{
  var Q := s.queuedAbort;
  ProofLib.FilterNone((set_x: int) => (set_x in s.holders), Q);
  ProofLib.FilterNone((set_x: int) => (set_x in s.completed), Q);
  assert alwaysCancelledQueuedNeverOwns(s) == ((forall i :: 0 <= i < |Q| ==> !(Q[i] in s.holders)) && (forall i :: 0 <= i < |Q| ==> !(Q[i] in s.completed)));
  if forall i :: 0 <= i < |Q| ==> !(Q[i] in s.holders) && !(Q[i] in s.completed) {
    forall x | x in Q ensures !(x in s.holders) && !(x in s.completed) {
      var i :| 0 <= i < |Q| && Q[i] == x;
    }
  } else {
    var i :| 0 <= i < |Q| && !(!(Q[i] in s.holders) && !(Q[i] in s.completed));
    assert Q[i] in Q;
    assert !alwaysCancelledQueuedNeverOwns(s);
    assert !(forall x :: x in s.queuedAbort ==> !(x in s.holders) && !(x in s.completed));
  }
}

lemma Shapes(s: SemaphoreState, caller: int)
  ensures acquire(s, caller) == (if (caller in s.aborted) then s.(rejected := (s.rejected + ProofLib.Filter((set_x: int) => !((set_x in s.rejected)), [caller]))) else if (s.available > 0) then s.(available := (s.available - 1), holders := (s.holders + ProofLib.Filter((set_x: int) => !((set_x in s.holders)), [caller]))) else s.(waiters := (s.waiters + [Waiter(caller, s.nextTicket)]), nextTicket := (s.nextTicket + 1)))
  ensures abortWaiter(s, caller) == (s.(aborted := (s.aborted + ProofLib.Filter((set_x: int) => !((set_x in s.aborted)), [caller])), queuedAbort := (if (exists w :: w in s.waiters && (w.id == caller)) then (s.queuedAbort + ProofLib.Filter((set_x: int) => !((set_x in s.queuedAbort)), [caller])) else s.queuedAbort)))
  ensures cancelListener(s, caller) == (s.(waiters := ProofLib.Filter((w: Waiter) => (w.id != caller), s.waiters), rejected := (s.rejected + ProofLib.Filter((set_x: int) => !((set_x in s.rejected)), [caller]))))
{
}

lemma acquire_ensures(s: SemaphoreState, caller: int)
  ensures (inv(s) ==> canAcquire(s, caller) ==> alwaysPermitConservation(acquire(s, caller)))
  ensures (inv(s) ==> canAcquire(s, caller) ==> alwaysNoIdlePermitWithWaiters(acquire(s, caller)))
  ensures (inv(s) ==> canAcquire(s, caller) ==> alwaysWaitersUnique(acquire(s, caller)))
  ensures (inv(s) ==> canAcquire(s, caller) ==> alwaysEachHolderCountedOnce(acquire(s, caller)))
  ensures (inv(s) ==> canAcquire(s, caller) ==> alwaysCancelledQueuedNeverOwns(acquire(s, caller)))
  ensures (inv(s) ==> canAcquire(s, caller) ==> alwaysTerminalCallersDoNotWait(acquire(s, caller)))
  ensures (inv(s) ==> canAcquire(s, caller) ==> alwaysFIFOGrants(acquire(s, caller)))
  ensures (inv(s) ==> canAcquire(s, caller) ==> alwaysQueuedAbortWasAborted(acquire(s, caller)))
  ensures (inv(s) ==> canAcquire(s, caller) ==> alwaysGrantedTicketsWereIssued(acquire(s, caller)))
  ensures (inv(s) ==> canAcquire(s, caller) ==> alwaysSemaphoreDeadlockFree(acquire(s, caller)))
  ensures (inv(s) ==> canAcquire(s, caller) ==> alwaysConfiguredSemaphoreHasCapacity(acquire(s, caller)))
{
  if inv(s) && canAcquire(s, caller) {
    var a := acquire(s, caller);
    Shapes(s, caller);
    View(s);
    View(a);
    if caller in s.aborted {
      AddOne(s.rejected, caller);
    } else if s.available > 0 {
      AddOne(s.holders, caller);
      assert caller in a.holders && canRelease(a, caller);
    } else {
      assert s.holders[0] in a.holders && canRelease(a, s.holders[0]);
    }
  }
}

lemma abortWaiter_ensures(s: SemaphoreState, caller: int)
  ensures (inv(s) ==> canAbortWaiter(s, caller) ==> alwaysPermitConservation(abortWaiter(s, caller)))
  ensures (inv(s) ==> canAbortWaiter(s, caller) ==> alwaysNoIdlePermitWithWaiters(abortWaiter(s, caller)))
  ensures (inv(s) ==> canAbortWaiter(s, caller) ==> alwaysWaitersUnique(abortWaiter(s, caller)))
  ensures (inv(s) ==> canAbortWaiter(s, caller) ==> alwaysEachHolderCountedOnce(abortWaiter(s, caller)))
  ensures (inv(s) ==> canAbortWaiter(s, caller) ==> alwaysCancelledQueuedNeverOwns(abortWaiter(s, caller)))
  ensures (inv(s) ==> canAbortWaiter(s, caller) ==> alwaysTerminalCallersDoNotWait(abortWaiter(s, caller)))
  ensures (inv(s) ==> canAbortWaiter(s, caller) ==> alwaysFIFOGrants(abortWaiter(s, caller)))
  ensures (inv(s) ==> canAbortWaiter(s, caller) ==> alwaysQueuedAbortWasAborted(abortWaiter(s, caller)))
  ensures (inv(s) ==> canAbortWaiter(s, caller) ==> alwaysGrantedTicketsWereIssued(abortWaiter(s, caller)))
  ensures (inv(s) ==> canAbortWaiter(s, caller) ==> alwaysSemaphoreDeadlockFree(abortWaiter(s, caller)))
  ensures (inv(s) ==> canAbortWaiter(s, caller) ==> alwaysConfiguredSemaphoreHasCapacity(abortWaiter(s, caller)))
{
  if inv(s) && canAbortWaiter(s, caller) {
    Shapes(s, caller);
    View(s);
    View(abortWaiter(s, caller));
    AddOne(s.aborted, caller);
    AddOne(s.queuedAbort, caller);
  }
}

lemma cancelListener_ensures(s: SemaphoreState, caller: int)
  ensures (inv(s) ==> canCancelListener(s, caller) ==> alwaysPermitConservation(cancelListener(s, caller)))
  ensures (inv(s) ==> canCancelListener(s, caller) ==> alwaysNoIdlePermitWithWaiters(cancelListener(s, caller)))
  ensures (inv(s) ==> canCancelListener(s, caller) ==> alwaysWaitersUnique(cancelListener(s, caller)))
  ensures (inv(s) ==> canCancelListener(s, caller) ==> alwaysEachHolderCountedOnce(cancelListener(s, caller)))
  ensures (inv(s) ==> canCancelListener(s, caller) ==> alwaysCancelledQueuedNeverOwns(cancelListener(s, caller)))
  ensures (inv(s) ==> canCancelListener(s, caller) ==> alwaysTerminalCallersDoNotWait(cancelListener(s, caller)))
  ensures (inv(s) ==> canCancelListener(s, caller) ==> alwaysFIFOGrants(cancelListener(s, caller)))
  ensures (inv(s) ==> canCancelListener(s, caller) ==> alwaysQueuedAbortWasAborted(cancelListener(s, caller)))
  ensures (inv(s) ==> canCancelListener(s, caller) ==> alwaysGrantedTicketsWereIssued(cancelListener(s, caller)))
  ensures (inv(s) ==> canCancelListener(s, caller) ==> alwaysSemaphoreDeadlockFree(cancelListener(s, caller)))
  ensures (inv(s) ==> canCancelListener(s, caller) ==> alwaysConfiguredSemaphoreHasCapacity(cancelListener(s, caller)))
{
  if inv(s) && canCancelListener(s, caller) {
    var a := cancelListener(s, caller);
    Shapes(s, caller);
    View(s);
    View(a);
    AddOne(s.rejected, caller);
    forall w ensures w in a.waiters <==> w in s.waiters && w.id != caller {
      ProofLib.FilterMember((w: Waiter) => (w.id != caller), s.waiters, w);
    }
    ProofLib.FilterKeepsDistinctBy((w: Waiter) => (w.id != caller), s.waiters, (x: Waiter) => x.id);
    if |s.holders| > 0 {
      assert s.holders[0] in a.holders && canRelease(a, s.holders[0]);
    } else if |a.waiters| > 0 {
      assert a.waiters[0] in a.waiters;
    }
  }
}

lemma ReleaseShape(s: SemaphoreState, caller: int, sel: Waiter)
  requires sel == (if 0 < |ProofLib.Filter((w: Waiter) => !((w.id in s.aborted)), s.waiters)| then ProofLib.Filter((w: Waiter) => !((w.id in s.aborted)), s.waiters)[0] else Waiter(0, s.nextTicket))
  ensures release(s, caller).(available := s.available, holders := s.holders, completed := s.completed, granted := s.granted, rejected := s.rejected, waiters := s.waiters) == s
  ensures release(s, caller).available == (if |ProofLib.Filter((w: Waiter) => !((w.id in s.aborted)), s.waiters)| == 0 then s.available + 1 else s.available)
  ensures release(s, caller).holders == (if |ProofLib.Filter((w: Waiter) => !((w.id in s.aborted)), s.waiters)| == 0 then ProofLib.Filter((set_x: int) => !((set_x in [caller])), s.holders) else ProofLib.Filter((set_x: int) => !((set_x in [caller])), s.holders) + ProofLib.Filter((set_x: int) => !((set_x in Std.Collections.Seq.Filter((set_x: int) => !((set_x in [caller])), s.holders))), [sel.id]))
  ensures release(s, caller).completed == s.completed + ProofLib.Filter((set_x: int) => !((set_x in s.completed)), [caller])
  ensures release(s, caller).granted == (if |ProofLib.Filter((w: Waiter) => !((w.id in s.aborted)), s.waiters)| == 0 then s.granted else s.granted + [sel])
  ensures release(s, caller).rejected == s.rejected + ProofLib.Filter((set_x: int) => !((set_x in s.rejected)), Std.Collections.Seq.FoldLeft((ids: seq<int>, w: Waiter) => (ids + Std.Collections.Seq.Filter((set_x: int) => !((set_x in ids)), [w.id])), [], ProofLib.Filter((w: Waiter) => (w.ticket < sel.ticket), s.waiters)))
  ensures release(s, caller).waiters == (if |ProofLib.Filter((w: Waiter) => !((w.id in s.aborted)), s.waiters)| == 0 then [] else ProofLib.Filter((w: Waiter) => (w.ticket > sel.ticket), s.waiters))
{
}

lemma ReleaseHolders(s: SemaphoreState, caller: int, sel: Waiter)
  requires inv(s) && canRelease(s, caller)
  requires |ProofLib.Filter((w: Waiter) => !((w.id in s.aborted)), s.waiters)| > 0 && sel == ProofLib.Filter((w: Waiter) => !((w.id in s.aborted)), s.waiters)[0]
  ensures sel in s.waiters && !(sel.id in s.aborted)
  ensures |release(s, caller).holders| == |s.holders| && ProofLib.Distinct(release(s, caller).holders)
  ensures forall y :: y in release(s, caller).holders <==> (y in s.holders && y != caller) || y == sel.id
{
  ReleaseShape(s, caller, sel);
  View(s);
  var rest := ProofLib.Filter((set_x: int) => !((set_x in [caller])), s.holders);
  assert sel in ProofLib.Filter((w: Waiter) => !((w.id in s.aborted)), s.waiters);
  ProofLib.FilterMember((w: Waiter) => !((w.id in s.aborted)), s.waiters, sel);
  Remove(s.holders, caller);
  ProofLib.FilterCons((set_x: int) => !((set_x in Std.Collections.Seq.Filter((set_x: int) => !((set_x in [caller])), s.holders))), [sel.id]);
  ProofLib.FilterNil((set_x: int) => !((set_x in Std.Collections.Seq.Filter((set_x: int) => !((set_x in [caller])), s.holders))), [sel.id][1..]);
  assert !(sel.id in rest);
}

lemma ReleaseQueue(s: SemaphoreState, caller: int, sel: Waiter)
  requires |ProofLib.Filter((w: Waiter) => !((w.id in s.aborted)), s.waiters)| > 0 && sel == ProofLib.Filter((w: Waiter) => !((w.id in s.aborted)), s.waiters)[0]
  ensures forall w :: w in release(s, caller).waiters <==> w in s.waiters && w.ticket > sel.ticket
  ensures ProofLib.DistinctBy(s.waiters, (x: Waiter) => x.id) ==> ProofLib.DistinctBy(release(s, caller).waiters, (x: Waiter) => x.id)
  ensures forall y :: y in release(s, caller).rejected ==> y in s.rejected || exists w :: w in s.waiters && w.ticket < sel.ticket && w.id == y
  ensures forall y :: y in release(s, caller).completed <==> y in s.completed || y == caller
{
  ReleaseShape(s, caller, sel);
  var W := s.waiters;
  var early := ProofLib.Filter((w: Waiter) => (w.ticket < sel.ticket), W);
  var skipped := Std.Collections.Seq.FoldLeft((ids: seq<int>, w: Waiter) => (ids + Std.Collections.Seq.Filter((set_x: int) => !((set_x in ids)), [w.id])), [], early);
  AddOne(s.completed, caller);
  SkipIds([], early);
  Union(s.rejected, skipped);
  forall w | w in early ensures w in W && w.ticket < sel.ticket {
    ProofLib.FilterMember((w: Waiter) => (w.ticket < sel.ticket), W, w);
  }
  forall w ensures w in ProofLib.Filter((w: Waiter) => (w.ticket > sel.ticket), W) <==> w in W && w.ticket > sel.ticket {
    ProofLib.FilterMember((w: Waiter) => (w.ticket > sel.ticket), W, w);
  }
  if ProofLib.DistinctBy(W, (x: Waiter) => x.id) {
    ProofLib.FilterKeepsDistinctBy((w: Waiter) => (w.ticket > sel.ticket), W, (x: Waiter) => x.id);
  }
}

lemma ReleaseIdle(s: SemaphoreState, caller: int)
  requires inv(s) && canRelease(s, caller)
  requires |ProofLib.Filter((w: Waiter) => !((w.id in s.aborted)), s.waiters)| == 0
  ensures release(s, caller).available == s.available + 1 && release(s, caller).waiters == [] && release(s, caller).granted == s.granted
  ensures |release(s, caller).holders| == |s.holders| - 1 && ProofLib.Distinct(release(s, caller).holders)
  ensures forall y :: y in release(s, caller).holders <==> y in s.holders && y != caller
  ensures forall y :: y in release(s, caller).completed <==> y in s.completed || y == caller
{
  ReleaseShape(s, caller, Waiter(0, s.nextTicket));
  View(s);
  Remove(s.holders, caller);
  AddOne(s.completed, caller);
}

lemma release_ensures(s: SemaphoreState, caller: int)
  ensures (inv(s) ==> canRelease(s, caller) ==> alwaysPermitConservation(release(s, caller)))
  ensures (inv(s) ==> canRelease(s, caller) ==> alwaysNoIdlePermitWithWaiters(release(s, caller)))
  ensures (inv(s) ==> canRelease(s, caller) ==> alwaysWaitersUnique(release(s, caller)))
  ensures (inv(s) ==> canRelease(s, caller) ==> alwaysEachHolderCountedOnce(release(s, caller)))
  ensures (inv(s) ==> canRelease(s, caller) ==> alwaysCancelledQueuedNeverOwns(release(s, caller)))
  ensures (inv(s) ==> canRelease(s, caller) ==> alwaysTerminalCallersDoNotWait(release(s, caller)))
  ensures (inv(s) ==> canRelease(s, caller) ==> alwaysFIFOGrants(release(s, caller)))
  ensures (inv(s) ==> canRelease(s, caller) ==> alwaysQueuedAbortWasAborted(release(s, caller)))
  ensures (inv(s) ==> canRelease(s, caller) ==> alwaysGrantedTicketsWereIssued(release(s, caller)))
  ensures (inv(s) ==> canRelease(s, caller) ==> alwaysSemaphoreDeadlockFree(release(s, caller)))
  ensures (inv(s) ==> canRelease(s, caller) ==> alwaysConfiguredSemaphoreHasCapacity(release(s, caller)))
{
  if inv(s) && canRelease(s, caller) {
    var a := release(s, caller);
    View(s);
    View(a);
    var W := s.waiters;
    var live := ProofLib.Filter((w: Waiter) => !((w.id in s.aborted)), W);
    if |live| > 0 {
      var sel := live[0];
      ReleaseShape(s, caller, sel);
      ReleaseHolders(s, caller, sel);
      ReleaseQueue(s, caller, sel);
      forall w, v | w in W && v in W && w.ticket != v.ticket ensures w.id != v.id {
        var i :| 0 <= i < |W| && W[i] == w;
        var j :| 0 <= j < |W| && W[j] == v;
      }
      assert sel.id in a.holders && canRelease(a, sel.id);
    } else {
      ReleaseShape(s, caller, Waiter(0, s.nextTicket));
      ReleaseIdle(s, caller);
      if |a.holders| > 0 {
        assert a.holders[0] in a.holders && canRelease(a, a.holders[0]);
      }
    }
  }
}
