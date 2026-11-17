// Proofs for spec/core/semaphore.md. The Iff lemmas turn the rules' filter counts into plain facts.

lemma UnionOne(a: seq<int>, c: int)
  ensures ProofLib.Filter((set_x: int) => !((set_x in a)), [c]) == (if c in a then [] else [c])
{
  ProofLib.FilterCons((set_x: int) => !((set_x in a)), [c]);
}

lemma DistinctFilter(p: int -> bool, xs: seq<int>)
  requires ProofLib.Distinct(xs)
  ensures ProofLib.Distinct(ProofLib.Filter(p, xs))
  decreases |xs|
{
  if |xs| == 0 {
  } else {
    ProofLib.FilterCons(p, xs);
    var tail := xs[1..];
    assert ProofLib.Distinct(tail) by {
      forall i, j | 0 <= i < j < |tail|
        ensures tail[i] != tail[j]
      {
      }
    }
    DistinctFilter(p, tail);
    var rest := ProofLib.Filter(p, tail);
    if p(xs[0]) {
      ProofLib.FilterMember(p, tail, xs[0]);
      assert !(xs[0] in tail) by {
        if xs[0] in tail {
          var k :| 0 <= k < |tail| && tail[k] == xs[0];
        }
      }
      var ys := [xs[0]] + rest;
      forall i, j | 0 <= i < j < |ys|
        ensures ys[i] != ys[j]
      {
        if i == 0 {
        } else {
        }
      }
    }
  }
}

lemma FilterSplit(p: int -> bool, q: int -> bool, xs: seq<int>)
  requires forall x :: q(x) == !p(x)
  ensures |ProofLib.Filter(p, xs)| + |ProofLib.Filter(q, xs)| == |xs|
  decreases |xs|
{
  if |xs| == 0 {
  } else {
    ProofLib.FilterCons(p, xs);
    ProofLib.FilterCons(q, xs);
    FilterSplit(p, q, xs[1..]);
  }
}

lemma DistinctIntIff(xs: seq<int>)
  ensures (forall h :: h in xs ==> |ProofLib.Filter((x: int) => (x == h), xs)| == 1) <==> ProofLib.Distinct(xs)
{
  if forall h :: h in xs ==> |ProofLib.Filter((x: int) => (x == h), xs)| == 1 {
    forall i, j | 0 <= i < j < |xs|
      ensures xs[i] != xs[j]
    {
      var h := xs[i];
      assert h in xs;
      ProofLib.FilterCountOneIffUnique((x: int) => (x == h), xs, (t: int) => t, i);
    }
  }
  if ProofLib.Distinct(xs) {
    forall h | h in xs
      ensures |ProofLib.Filter((x: int) => (x == h), xs)| == 1
    {
      var i :| 0 <= i < |xs| && xs[i] == h;
      ProofLib.FilterCountOneIffUnique((x: int) => (x == h), xs, (t: int) => t, i);
    }
  }
}

lemma HoldersIff(s: SemaphoreState)
  ensures alwaysHoldersDistinct(s) <==> ProofLib.Distinct(s.holders)
{
  DistinctIntIff(s.holders);
}

lemma WaiterIdsIff(xs: seq<Waiter>)
  ensures (forall w :: w in xs ==> |ProofLib.Filter((x: Waiter) => (x.id == w.id), xs)| == 1) <==> ProofLib.DistinctBy(xs, (t: Waiter) => t.id)
{
  if forall w :: w in xs ==> |ProofLib.Filter((x: Waiter) => (x.id == w.id), xs)| == 1 {
    forall i, k | 0 <= i < |xs| && 0 <= k < |xs| && i != k
      ensures xs[i].id != xs[k].id
    {
      var w := xs[i];
      ProofLib.FilterCountOneIffUnique((x: Waiter) => (x.id == w.id), xs, (t: Waiter) => t.id, i);
    }
  }
  if ProofLib.DistinctBy(xs, (t: Waiter) => t.id) {
    forall w | w in xs
      ensures |ProofLib.Filter((x: Waiter) => (x.id == w.id), xs)| == 1
    {
      var i :| 0 <= i < |xs| && xs[i] == w;
      ProofLib.FilterCountOneIffUnique((x: Waiter) => (x.id == w.id), xs, (t: Waiter) => t.id, i);
    }
  }
}

lemma WaitersIff(s: SemaphoreState)
  ensures alwaysWaitersUnique(s) <==> ((forall w :: w in s.waiters ==> w.id > 0 && w.ticket > 0 && w.ticket < s.nextTicket && !(w.id in s.holders)) && ProofLib.DistinctBy(s.waiters, (t: Waiter) => t.id))
{
  WaiterIdsIff(s.waiters);
}

lemma CancelledIff(s: SemaphoreState)
  ensures alwaysCancelledQueuedNeverOwns(s) <==> (forall q :: q in s.queuedAbort ==> !(q in s.holders) && !(q in s.completed))
{
  ProofLib.FilterNone((set_x: int) => (set_x in s.holders), s.queuedAbort);
  ProofLib.FilterNone((set_x: int) => (set_x in s.completed), s.queuedAbort);
  if forall q :: q in s.queuedAbort ==> !(q in s.holders) && !(q in s.completed) {
    forall i | 0 <= i < |s.queuedAbort|
      ensures !(s.queuedAbort[i] in s.holders) && !(s.queuedAbort[i] in s.completed)
    {
    }
  }
}

lemma HolderPresent(s: SemaphoreState)
  ensures |s.holders| > 0 ==> semaphoreProgressEnabled(s)
{
  if |s.holders| > 0 {
    assert canRelease(s, s.holders[0]);
  }
}

// acquire

lemma acquire_ensures(s: SemaphoreState, caller: int)
  ensures (inv(s) ==> canAcquire(s, caller) ==> alwaysPermitConservation(acquire(s, caller)))
  ensures (inv(s) ==> canAcquire(s, caller) ==> alwaysNoIdlePermitWithWaiters(acquire(s, caller)))
  ensures (inv(s) ==> canAcquire(s, caller) ==> alwaysWaitersUnique(acquire(s, caller)))
  ensures (inv(s) ==> canAcquire(s, caller) ==> alwaysHoldersDistinct(acquire(s, caller)))
  ensures (inv(s) ==> canAcquire(s, caller) ==> alwaysGrantedTicketsIssued(acquire(s, caller)))
  ensures (inv(s) ==> canAcquire(s, caller) ==> alwaysNextTicketPositive(acquire(s, caller)))
  ensures (inv(s) ==> canAcquire(s, caller) ==> alwaysCancelledQueuedNeverOwns(acquire(s, caller)))
  ensures (inv(s) ==> canAcquire(s, caller) ==> alwaysTerminalCallersDoNotWait(acquire(s, caller)))
  ensures (inv(s) ==> canAcquire(s, caller) ==> alwaysFIFOGrants(acquire(s, caller)))
  ensures (inv(s) ==> canAcquire(s, caller) ==> alwaysQueuedAbortWasAborted(acquire(s, caller)))
  ensures (inv(s) ==> canAcquire(s, caller) ==> alwaysConfiguredSemaphoreHasCapacity(acquire(s, caller)))
  ensures (inv(s) ==> canAcquire(s, caller) ==> alwaysSemaphoreDeadlockFree(acquire(s, caller)))
{
  if inv(s) && canAcquire(s, caller) {
    var a := acquire(s, caller);
    UnionOne(s.rejected, caller);
    UnionOne(s.holders, caller);
    WaitersIff(s);
    WaitersIff(a);
    HoldersIff(s);
    HoldersIff(a);
    CancelledIff(s);
    CancelledIff(a);
    HolderPresent(a);
    if !(caller in s.aborted) && s.available > 0 {
    } else if !(caller in s.aborted) {
      var nw := Waiter(caller, s.nextTicket);
    }
  }
}

// abortWaiter

lemma abortWaiter_ensures(s: SemaphoreState, caller: int)
  ensures (inv(s) ==> canAbortWaiter(s, caller) ==> alwaysPermitConservation(abortWaiter(s, caller)))
  ensures (inv(s) ==> canAbortWaiter(s, caller) ==> alwaysNoIdlePermitWithWaiters(abortWaiter(s, caller)))
  ensures (inv(s) ==> canAbortWaiter(s, caller) ==> alwaysWaitersUnique(abortWaiter(s, caller)))
  ensures (inv(s) ==> canAbortWaiter(s, caller) ==> alwaysHoldersDistinct(abortWaiter(s, caller)))
  ensures (inv(s) ==> canAbortWaiter(s, caller) ==> alwaysGrantedTicketsIssued(abortWaiter(s, caller)))
  ensures (inv(s) ==> canAbortWaiter(s, caller) ==> alwaysNextTicketPositive(abortWaiter(s, caller)))
  ensures (inv(s) ==> canAbortWaiter(s, caller) ==> alwaysCancelledQueuedNeverOwns(abortWaiter(s, caller)))
  ensures (inv(s) ==> canAbortWaiter(s, caller) ==> alwaysTerminalCallersDoNotWait(abortWaiter(s, caller)))
  ensures (inv(s) ==> canAbortWaiter(s, caller) ==> alwaysFIFOGrants(abortWaiter(s, caller)))
  ensures (inv(s) ==> canAbortWaiter(s, caller) ==> alwaysQueuedAbortWasAborted(abortWaiter(s, caller)))
  ensures (inv(s) ==> canAbortWaiter(s, caller) ==> alwaysConfiguredSemaphoreHasCapacity(abortWaiter(s, caller)))
  ensures (inv(s) ==> canAbortWaiter(s, caller) ==> alwaysSemaphoreDeadlockFree(abortWaiter(s, caller)))
{
  if inv(s) && canAbortWaiter(s, caller) {
    var a := abortWaiter(s, caller);
    UnionOne(s.aborted, caller);
    UnionOne(s.queuedAbort, caller);
    CancelledIff(s);
    CancelledIff(a);
  }
}

// cancelListener

lemma cancelListener_ensures(s: SemaphoreState, caller: int)
  ensures (inv(s) ==> canCancelListener(s, caller) ==> alwaysPermitConservation(cancelListener(s, caller)))
  ensures (inv(s) ==> canCancelListener(s, caller) ==> alwaysNoIdlePermitWithWaiters(cancelListener(s, caller)))
  ensures (inv(s) ==> canCancelListener(s, caller) ==> alwaysWaitersUnique(cancelListener(s, caller)))
  ensures (inv(s) ==> canCancelListener(s, caller) ==> alwaysHoldersDistinct(cancelListener(s, caller)))
  ensures (inv(s) ==> canCancelListener(s, caller) ==> alwaysGrantedTicketsIssued(cancelListener(s, caller)))
  ensures (inv(s) ==> canCancelListener(s, caller) ==> alwaysNextTicketPositive(cancelListener(s, caller)))
  ensures (inv(s) ==> canCancelListener(s, caller) ==> alwaysCancelledQueuedNeverOwns(cancelListener(s, caller)))
  ensures (inv(s) ==> canCancelListener(s, caller) ==> alwaysTerminalCallersDoNotWait(cancelListener(s, caller)))
  ensures (inv(s) ==> canCancelListener(s, caller) ==> alwaysFIFOGrants(cancelListener(s, caller)))
  ensures (inv(s) ==> canCancelListener(s, caller) ==> alwaysQueuedAbortWasAborted(cancelListener(s, caller)))
  ensures (inv(s) ==> canCancelListener(s, caller) ==> alwaysConfiguredSemaphoreHasCapacity(cancelListener(s, caller)))
  ensures (inv(s) ==> canCancelListener(s, caller) ==> alwaysSemaphoreDeadlockFree(cancelListener(s, caller)))
{
  if inv(s) && canCancelListener(s, caller) {
    var a := cancelListener(s, caller);
    UnionOne(s.rejected, caller);
    WaitersIff(s);
    WaitersIff(a);
    forall w
      ensures w in a.waiters <==> w in s.waiters && w.id != caller
    {
      ProofLib.FilterMember((w: Waiter) => (w.id != caller), s.waiters, w);
    }
    ProofLib.FilterKeepsDistinctBy((w: Waiter) => (w.id != caller), s.waiters, (t: Waiter) => t.id);
    HolderPresent(a);
  }
}

// release

lemma SkipStep(a: seq<int>, w: Waiter)
  ensures ((ids: seq<int>, w: Waiter) => (ids + Std.Collections.Seq.Filter((set_x: int) => !((set_x in ids)), [w.id])))(a, w) == a + (if w.id in a then [] else [w.id])
{
  reveal Std.Collections.Seq.Filter();
}

lemma SkipMemberAny(f: (seq<int>, Waiter) -> seq<int>, acc: seq<int>, ws: seq<Waiter>, x: int)
  requires forall a, w :: f(a, w) == a + (if w.id in a then [] else [w.id])
  ensures x in Std.Collections.Seq.FoldLeft(f, acc, ws) ==> x in acc || (exists w :: w in ws && w.id == x)
  decreases |ws|
{
  if |ws| > 0 {
    SkipMemberAny(f, f(acc, ws[0]), ws[1..], x);
  }
}

lemma SkipMember(acc: seq<int>, ws: seq<Waiter>, x: int)
  ensures x in Std.Collections.Seq.FoldLeft((ids: seq<int>, w: Waiter) => (ids + Std.Collections.Seq.Filter((set_x: int) => !((set_x in ids)), [w.id])), acc, ws) ==> x in acc || (exists w :: w in ws && w.id == x)
{
  forall a: seq<int>, w: Waiter
    ensures ((ids: seq<int>, w: Waiter) => (ids + Std.Collections.Seq.Filter((set_x: int) => !((set_x in ids)), [w.id])))(a, w) == a + (if w.id in a then [] else [w.id])
  {
    SkipStep(a, w);
  }
  SkipMemberAny((ids: seq<int>, w: Waiter) => (ids + Std.Collections.Seq.Filter((set_x: int) => !((set_x in ids)), [w.id])), acc, ws, x);
}

lemma ReleaseFacts(s: SemaphoreState, caller: int)
  requires inv(s) && canRelease(s, caller)
  ensures var a := release(s, caller);
    alwaysPermitConservation(a) && alwaysHoldersDistinct(a) && alwaysWaitersUnique(a)
    && alwaysGrantedTicketsIssued(a) && alwaysCancelledQueuedNeverOwns(a) && alwaysFIFOGrants(a)
    && alwaysSemaphoreDeadlockFree(a)
{
  var a := release(s, caller);
  var live := ProofLib.Filter((w: Waiter) => !((w.id in s.aborted)), s.waiters);
  var sel := (if ((0 <= 0) && (0 < |live|)) then live[0] else Waiter(0, s.nextTicket));
  var rest := ProofLib.Filter((set_x: int) => !((set_x in [caller])), s.holders);
  WaitersIff(s);
  WaitersIff(a);
  HoldersIff(s);
  HoldersIff(a);
  CancelledIff(s);
  CancelledIff(a);
  UnionOne(s.completed, caller);
  HolderPresent(a);
  // the rest of the holders
  FilterSplit((x: int) => (x == caller), (set_x: int) => !((set_x in [caller])), s.holders);
  DistinctFilter((set_x: int) => !((set_x in [caller])), s.holders);
  forall x
    ensures x in rest <==> x in s.holders && x != caller
  {
    ProofLib.FilterMember((set_x: int) => !((set_x in [caller])), s.holders, x);
  }
  if |live| > 0 {
    ProofLib.FilterMember((w: Waiter) => !((w.id in s.aborted)), s.waiters, sel);
    UnionOne(rest, sel.id);
    var w2 := ProofLib.Filter((w: Waiter) => (w.ticket > sel.ticket), s.waiters);
    forall w
      ensures w in w2 <==> w in s.waiters && w.ticket > sel.ticket
    {
      ProofLib.FilterMember((w: Waiter) => (w.ticket > sel.ticket), s.waiters, w);
    }
    ProofLib.FilterKeepsDistinctBy((w: Waiter) => (w.ticket > sel.ticket), s.waiters, (t: Waiter) => t.id);
    forall w | w in w2
      ensures w.id != sel.id && !(w.id in a.holders)
    {
      var i :| 0 <= i < |s.waiters| && s.waiters[i] == w;
      var j :| 0 <= j < |s.waiters| && s.waiters[j] == sel;
    }
  }
}

lemma ReleaseTerminal(s: SemaphoreState, caller: int)
  requires inv(s) && canRelease(s, caller)
  ensures alwaysTerminalCallersDoNotWait(release(s, caller))
{
  var a := release(s, caller);
  var live := ProofLib.Filter((w: Waiter) => !((w.id in s.aborted)), s.waiters);
  var sel := (if ((0 <= 0) && (0 < |live|)) then live[0] else Waiter(0, s.nextTicket));
  var early := ProofLib.Filter((w: Waiter) => (w.ticket < sel.ticket), s.waiters);
  var skipped := Std.Collections.Seq.FoldLeft((ids: seq<int>, w: Waiter) => (ids + Std.Collections.Seq.Filter((set_x: int) => !((set_x in ids)), [w.id])), [], early);
  WaitersIff(s);
  UnionOne(s.completed, caller);
  if |live| > 0 {
    forall w | w in a.waiters
      ensures !(w.id in a.rejected) && !(w.id in a.completed)
    {
      ProofLib.FilterMember((w: Waiter) => (w.ticket > sel.ticket), s.waiters, w);
      if w.id in a.rejected {
        ProofLib.FilterMember((set_x: int) => !((set_x in s.rejected)), skipped, w.id);
        SkipMember([], early, w.id);
        var v :| v in early && v.id == w.id;
        ProofLib.FilterMember((w: Waiter) => (w.ticket < sel.ticket), s.waiters, v);
      }
    }
  }
}

lemma release_ensures(s: SemaphoreState, caller: int)
  ensures (inv(s) ==> canRelease(s, caller) ==> alwaysPermitConservation(release(s, caller)))
  ensures (inv(s) ==> canRelease(s, caller) ==> alwaysNoIdlePermitWithWaiters(release(s, caller)))
  ensures (inv(s) ==> canRelease(s, caller) ==> alwaysWaitersUnique(release(s, caller)))
  ensures (inv(s) ==> canRelease(s, caller) ==> alwaysHoldersDistinct(release(s, caller)))
  ensures (inv(s) ==> canRelease(s, caller) ==> alwaysGrantedTicketsIssued(release(s, caller)))
  ensures (inv(s) ==> canRelease(s, caller) ==> alwaysNextTicketPositive(release(s, caller)))
  ensures (inv(s) ==> canRelease(s, caller) ==> alwaysCancelledQueuedNeverOwns(release(s, caller)))
  ensures (inv(s) ==> canRelease(s, caller) ==> alwaysTerminalCallersDoNotWait(release(s, caller)))
  ensures (inv(s) ==> canRelease(s, caller) ==> alwaysFIFOGrants(release(s, caller)))
  ensures (inv(s) ==> canRelease(s, caller) ==> alwaysQueuedAbortWasAborted(release(s, caller)))
  ensures (inv(s) ==> canRelease(s, caller) ==> alwaysConfiguredSemaphoreHasCapacity(release(s, caller)))
  ensures (inv(s) ==> canRelease(s, caller) ==> alwaysSemaphoreDeadlockFree(release(s, caller)))
{
  if inv(s) && canRelease(s, caller) {
    ReleaseFacts(s, caller);
    ReleaseTerminal(s, caller);
  }
}
