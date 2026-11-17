lemma SemAcquireView(s: SemaphoreState, caller: int)
  ensures acquire(s, caller) == (if (caller in s.aborted) then
    s.(rejected := (s.rejected + ProofLib.Filter((set_x: int) => !((set_x in s.rejected)), [caller])))
  else
    if (s.available > 0) then
      s.(available := (s.available - 1), holders := (s.holders + ProofLib.Filter((set_x: int) => !((set_x in s.holders)), [caller])))
    else
      s.(waiters := (s.waiters + [Waiter(caller, s.nextTicket)]), nextTicket := (s.nextTicket + 1)))
{
}

lemma SemAbortWaiterView(s: SemaphoreState, caller: int)
  ensures abortWaiter(s, caller) == (s.(aborted := (s.aborted + ProofLib.Filter((set_x: int) => !((set_x in s.aborted)), [caller])), queuedAbort := (if (exists w :: w in s.waiters && (w.id == caller)) then (s.queuedAbort + ProofLib.Filter((set_x: int) => !((set_x in s.queuedAbort)), [caller])) else s.queuedAbort)))
{
}

lemma SemCancelListenerView(s: SemaphoreState, caller: int)
  ensures cancelListener(s, caller) == (s.(waiters := ProofLib.Filter((w: Waiter) => (w.id != caller), s.waiters), rejected := (s.rejected + ProofLib.Filter((set_x: int) => !((set_x in s.rejected)), [caller]))))
{
}

lemma SemReleaseView(s: SemaphoreState, caller: int)
  ensures (var local_0 := ProofLib.Filter((w: Waiter) => !((w.id in s.aborted)), s.waiters);
  var local_1 := (if ((0 <= 0) && (0 < |local_0|)) then local_0[0] else Waiter(0, s.nextTicket));
  release(s, caller).available == (if (|local_0| == 0) then (s.available + 1) else s.available))
  ensures (var local_0 := ProofLib.Filter((w: Waiter) => !((w.id in s.aborted)), s.waiters);
  var local_1 := (if ((0 <= 0) && (0 < |local_0|)) then local_0[0] else Waiter(0, s.nextTicket));
  release(s, caller).holders == (if (|local_0| == 0) then ProofLib.Filter((set_x: int) => !((set_x in [caller])), s.holders) else (ProofLib.Filter((set_x: int) => !((set_x in [caller])), s.holders) + ProofLib.Filter((set_x: int) => !((set_x in Std.Collections.Seq.Filter((set_x: int) => !((set_x in [caller])), s.holders))), [local_1.id]))))
  ensures (var local_0 := ProofLib.Filter((w: Waiter) => !((w.id in s.aborted)), s.waiters);
  var local_1 := (if ((0 <= 0) && (0 < |local_0|)) then local_0[0] else Waiter(0, s.nextTicket));
  release(s, caller).completed == (s.completed + ProofLib.Filter((set_x: int) => !((set_x in s.completed)), [caller])))
  ensures (var local_0 := ProofLib.Filter((w: Waiter) => !((w.id in s.aborted)), s.waiters);
  var local_1 := (if ((0 <= 0) && (0 < |local_0|)) then local_0[0] else Waiter(0, s.nextTicket));
  release(s, caller).granted == (if (|local_0| == 0) then s.granted else (s.granted + [local_1])))
  ensures (var local_0 := ProofLib.Filter((w: Waiter) => !((w.id in s.aborted)), s.waiters);
  var local_1 := (if ((0 <= 0) && (0 < |local_0|)) then local_0[0] else Waiter(0, s.nextTicket));
  var local_2 := Std.Collections.Seq.FoldLeft((ids: seq<int>, w: Waiter) => (ids + Std.Collections.Seq.Filter((set_x: int) => !((set_x in ids)), [w.id])), [], ProofLib.Filter((w: Waiter) => (w.ticket < local_1.ticket), s.waiters));
  release(s, caller).rejected == (s.rejected + ProofLib.Filter((set_x: int) => !((set_x in s.rejected)), local_2)))
  ensures (var local_0 := ProofLib.Filter((w: Waiter) => !((w.id in s.aborted)), s.waiters);
  var local_1 := (if ((0 <= 0) && (0 < |local_0|)) then local_0[0] else Waiter(0, s.nextTicket));
  release(s, caller).waiters == (if (|local_0| == 0) then [] else ProofLib.Filter((w: Waiter) => (w.ticket > local_1.ticket), s.waiters)))
{
}

lemma SemAlwaysWaitersUniqueView(s: SemaphoreState)
  ensures alwaysWaitersUnique(s) == (!((exists w :: w in s.waiters && !((((((w.id > 0) && (w.ticket > 0)) && (w.ticket < s.nextTicket)) && (|ProofLib.Filter((x: Waiter) => (x.id == w.id), s.waiters)| == 1)) && !((w.id in s.holders)))))))
{
}

lemma SemOwnerView(s: SemaphoreState)
  ensures alwaysPermitOwnersUnique(s) == (forall owner :: owner in s.holders ==> |ProofLib.Filter((other: int) => (other == owner), s.holders)| == 1)
{
}

lemma SemCancelledCounts(s: SemaphoreState)
  ensures alwaysCancelledQueuedNeverOwns(s) == ((|ProofLib.Filter((set_x: int) => (set_x in s.holders), s.queuedAbort)| == 0) && (|ProofLib.Filter((set_x: int) => (set_x in s.completed), s.queuedAbort)| == 0))
{
}

lemma SemCancelledView(s: SemaphoreState)
  ensures alwaysCancelledQueuedNeverOwns(s) == (forall owner :: owner in s.queuedAbort ==> owner !in s.holders && owner !in s.completed)
{
  SemCancelledCounts(s);
  ProofLib.FilterNone((set_x: int) => (set_x in s.holders), s.queuedAbort);
  ProofLib.FilterNone((set_x: int) => (set_x in s.completed), s.queuedAbort);
  if alwaysCancelledQueuedNeverOwns(s) {
    forall owner | owner in s.queuedAbort
      ensures owner !in s.holders && owner !in s.completed
    {
      ProofLib.FilterMember((set_x: int) => (set_x in s.holders), s.queuedAbort, owner);
      ProofLib.FilterMember((set_x: int) => (set_x in s.completed), s.queuedAbort, owner);
    }
  } else if forall owner :: owner in s.queuedAbort ==> owner !in s.holders && owner !in s.completed {
    assert forall i :: 0 <= i < |s.queuedAbort| ==> s.queuedAbort[i] !in s.holders && s.queuedAbort[i] !in s.completed;
  }
}

lemma SemUnion(xs: seq<int>, item: int)
  ensures item in xs + ProofLib.Filter((set_x: int) => !((set_x in xs)), [item])
  ensures forall value :: value in xs + ProofLib.Filter((set_x: int) => !((set_x in xs)), [item]) ==> value in xs || value == item
  ensures item !in xs ==> xs + ProofLib.Filter((set_x: int) => !((set_x in xs)), [item]) == xs + [item]
{
  ProofLib.FilterCons((set_x: int) => !((set_x in xs)), [item]);
  ProofLib.FilterNil((set_x: int) => !((set_x in xs)), []);
}

lemma SemRemoveCount(xs: seq<int>, item: int)
  ensures |ProofLib.Filter((set_x: int) => !((set_x in [item])), xs)| + |ProofLib.Filter((other: int) => (other == item), xs)| == |xs|
  decreases |xs|
{
  if |xs| == 0 {
    ProofLib.FilterNil((set_x: int) => !((set_x in [item])), xs);
    ProofLib.FilterNil((other: int) => (other == item), xs);
  } else {
    ProofLib.FilterCons((set_x: int) => !((set_x in [item])), xs);
    ProofLib.FilterCons((other: int) => (other == item), xs);
    SemRemoveCount(xs[1..], item);
  }
}

lemma SemRemovedUnion(xs: seq<int>, caller: int, added: int)
  requires added !in xs
  ensures ProofLib.Filter((set_x: int) => !((set_x in [caller])), xs) + ProofLib.Filter((set_x: int) => !((set_x in Std.Collections.Seq.Filter((set_x: int) => !((set_x in [caller])), xs))), [added]) == ProofLib.Filter((set_x: int) => !((set_x in [caller])), xs) + [added]
{
  ProofLib.FilterMember((set_x: int) => !((set_x in [caller])), xs, added);
  ProofLib.FilterCons((set_x: int) => !((set_x in Std.Collections.Seq.Filter((set_x: int) => !((set_x in [caller])), xs))), [added]);
  ProofLib.FilterNil((set_x: int) => !((set_x in Std.Collections.Seq.Filter((set_x: int) => !((set_x in [caller])), xs))), []);
}

lemma SemOwnerAppend(xs: seq<int>, item: int)
  requires forall owner :: owner in xs ==> |ProofLib.Filter((other: int) => (other == owner), xs)| == 1
  requires item !in xs
  ensures forall owner :: owner in xs + [item] ==> |ProofLib.Filter((other: int) => (other == owner), xs + [item])| == 1
{
  forall owner | owner in xs + [item]
    ensures |ProofLib.Filter((other: int) => (other == owner), xs + [item])| == 1
  {
    ProofLib.FilterAppend((other: int) => (other == owner), xs, item);
    if owner == item { ProofLib.FilterNone((other: int) => (other == owner), xs); }
  }
}

lemma SemOwnerRemove(xs: seq<int>, item: int, after: seq<int>)
  requires after == ProofLib.Filter((set_x: int) => !((set_x in [item])), xs)
  requires forall owner :: owner in xs ==> |ProofLib.Filter((other: int) => (other == owner), xs)| == 1
  ensures forall owner :: owner in after ==> |ProofLib.Filter((other: int) => (other == owner), after)| == 1
{
  forall owner | owner in after
    ensures |ProofLib.Filter((other: int) => (other == owner), after)| == 1
  {
    ProofLib.FilterMember((set_x: int) => !((set_x in [item])), xs, owner);
    ProofLib.FilterOfFilterLength((set_x: int) => !((set_x in [item])), (other: int) => (other == owner), (other: int) => (other == owner), xs);
    ProofLib.FilterMember((other: int) => (other == owner), after, owner);
  }
}

lemma SemFoldIds(rows: seq<Waiter>, ids: seq<int>, item: int)
  requires item in Std.Collections.Seq.FoldLeft((ids: seq<int>, w: Waiter) => (ids + Std.Collections.Seq.Filter((set_x: int) => !((set_x in ids)), [w.id])), ids, rows)
  ensures item in ids || exists row :: row in rows && row.id == item
  decreases |rows|
{
  reveal Std.Collections.Seq.FoldLeft();
  if |rows| > 0 {
    SemUnion(ids, rows[0].id);
    var next := ids + ProofLib.Filter((set_x: int) => !((set_x in ids)), [rows[0].id]);
    SemFoldIds(rows[1..], next, item);
    assert rows == [rows[0]] + rows[1..];
  }
}

lemma SemWaiterIds(xs: seq<Waiter>, left: Waiter, right: Waiter)
  requires forall w :: w in xs ==> |ProofLib.Filter((x: Waiter) => (x.id == w.id), xs)| == 1
  requires left in xs && right in xs && left.ticket != right.ticket
  ensures left.id != right.id
{
  if left.id == right.id {
    var i :| 0 <= i < |xs| && xs[i] == left;
    var j :| 0 <= j < |xs| && xs[j] == right;
    assert i != j;
    ProofLib.FilterTwo((x: Waiter) => (x.id == left.id), xs, i, j);
  }
}

lemma SemProgress(s: SemaphoreState)
  requires alwaysPermitConservation(s) && alwaysNoIdlePermitWithWaiters(s) && alwaysConfiguredSemaphoreHasCapacity(s)
  ensures alwaysSemaphoreDeadlockFree(s)
{
  if |s.holders| > 0 {
    assert s.holders[0] in s.holders;
    assert canRelease(s, s.holders[0]);
    assert exists owner :: owner in s.holders && canRelease(s, owner);
    assert semaphoreProgressEnabled(s);
  } else if |s.waiters| > 0 {
    assert s.available == s.capacity;
    assert s.available == 0;
    assert !s.configured;
    assert false;
  }
}

lemma acquire_ensures(s: SemaphoreState, caller: int)
  ensures (inv(s) ==> canAcquire(s, caller) ==> alwaysPermitConservation(acquire(s, caller)))
  ensures (inv(s) ==> canAcquire(s, caller) ==> alwaysNoIdlePermitWithWaiters(acquire(s, caller)))
  ensures (inv(s) ==> canAcquire(s, caller) ==> alwaysWaitersUnique(acquire(s, caller)))
  ensures (inv(s) ==> canAcquire(s, caller) ==> alwaysCancelledQueuedNeverOwns(acquire(s, caller)))
  ensures (inv(s) ==> canAcquire(s, caller) ==> alwaysTerminalCallersDoNotWait(acquire(s, caller)))
  ensures (inv(s) ==> canAcquire(s, caller) ==> alwaysFIFOGrants(acquire(s, caller)))
  ensures (inv(s) ==> canAcquire(s, caller) ==> alwaysConfiguredSemaphoreHasCapacity(acquire(s, caller)))
  ensures (inv(s) ==> canAcquire(s, caller) ==> alwaysSemaphoreDeadlockFree(acquire(s, caller)))
  ensures (inv(s) ==> canAcquire(s, caller) ==> alwaysTicketAllocatorPositive(acquire(s, caller)))
  ensures (inv(s) ==> canAcquire(s, caller) ==> alwaysGrantsPrecedeNextTicket(acquire(s, caller)))
  ensures (inv(s) ==> canAcquire(s, caller) ==> alwaysQueuedAbortWasObserved(acquire(s, caller)))
  ensures (inv(s) ==> canAcquire(s, caller) ==> alwaysPermitOwnersUnique(acquire(s, caller)))
{
  if inv(s) && canAcquire(s, caller) {
    SemAcquireView(s, caller);
    var after := acquire(s, caller);
    SemAlwaysWaitersUniqueView(s); SemAlwaysWaitersUniqueView(after);
    SemOwnerView(s); SemOwnerView(after);
    SemCancelledView(s); SemCancelledView(after);
    if caller in s.aborted {
      SemUnion(s.rejected, caller);
    } else if s.available > 0 {
      SemUnion(s.holders, caller);
      SemOwnerAppend(s.holders, caller);
      assert |s.waiters| == 0;
      assert caller !in s.queuedAbort;
    } else {
      var added := Waiter(caller, s.nextTicket);
      forall w | w in after.waiters
        ensures w.id > 0 && w.ticket > 0 && w.ticket < after.nextTicket && |ProofLib.Filter((x: Waiter) => (x.id == w.id), after.waiters)| == 1 && w.id !in after.holders
      {
        ProofLib.FilterAppend((x: Waiter) => (x.id == w.id), s.waiters, added);
        if w == added { ProofLib.FilterNone((x: Waiter) => (x.id == w.id), s.waiters); }
      }
    }
    SemProgress(after);
  }
}

lemma abortWaiter_ensures(s: SemaphoreState, caller: int)
  ensures (inv(s) ==> canAbortWaiter(s, caller) ==> alwaysPermitConservation(abortWaiter(s, caller)))
  ensures (inv(s) ==> canAbortWaiter(s, caller) ==> alwaysNoIdlePermitWithWaiters(abortWaiter(s, caller)))
  ensures (inv(s) ==> canAbortWaiter(s, caller) ==> alwaysWaitersUnique(abortWaiter(s, caller)))
  ensures (inv(s) ==> canAbortWaiter(s, caller) ==> alwaysCancelledQueuedNeverOwns(abortWaiter(s, caller)))
  ensures (inv(s) ==> canAbortWaiter(s, caller) ==> alwaysTerminalCallersDoNotWait(abortWaiter(s, caller)))
  ensures (inv(s) ==> canAbortWaiter(s, caller) ==> alwaysFIFOGrants(abortWaiter(s, caller)))
  ensures (inv(s) ==> canAbortWaiter(s, caller) ==> alwaysConfiguredSemaphoreHasCapacity(abortWaiter(s, caller)))
  ensures (inv(s) ==> canAbortWaiter(s, caller) ==> alwaysSemaphoreDeadlockFree(abortWaiter(s, caller)))
  ensures (inv(s) ==> canAbortWaiter(s, caller) ==> alwaysTicketAllocatorPositive(abortWaiter(s, caller)))
  ensures (inv(s) ==> canAbortWaiter(s, caller) ==> alwaysGrantsPrecedeNextTicket(abortWaiter(s, caller)))
  ensures (inv(s) ==> canAbortWaiter(s, caller) ==> alwaysQueuedAbortWasObserved(abortWaiter(s, caller)))
  ensures (inv(s) ==> canAbortWaiter(s, caller) ==> alwaysPermitOwnersUnique(abortWaiter(s, caller)))
{
  if inv(s) && canAbortWaiter(s, caller) {
    SemAbortWaiterView(s, caller);
    var after := abortWaiter(s, caller);
    SemCancelledView(s); SemCancelledView(after);
    SemUnion(s.aborted, caller); SemUnion(s.queuedAbort, caller);
    if exists w :: w in s.waiters && w.id == caller {
      var w :| w in s.waiters && w.id == caller;
      assert caller !in s.holders && caller !in s.completed;
    }
  }
}

lemma cancelListener_ensures(s: SemaphoreState, caller: int)
  ensures (inv(s) ==> canCancelListener(s, caller) ==> alwaysPermitConservation(cancelListener(s, caller)))
  ensures (inv(s) ==> canCancelListener(s, caller) ==> alwaysNoIdlePermitWithWaiters(cancelListener(s, caller)))
  ensures (inv(s) ==> canCancelListener(s, caller) ==> alwaysWaitersUnique(cancelListener(s, caller)))
  ensures (inv(s) ==> canCancelListener(s, caller) ==> alwaysCancelledQueuedNeverOwns(cancelListener(s, caller)))
  ensures (inv(s) ==> canCancelListener(s, caller) ==> alwaysTerminalCallersDoNotWait(cancelListener(s, caller)))
  ensures (inv(s) ==> canCancelListener(s, caller) ==> alwaysFIFOGrants(cancelListener(s, caller)))
  ensures (inv(s) ==> canCancelListener(s, caller) ==> alwaysConfiguredSemaphoreHasCapacity(cancelListener(s, caller)))
  ensures (inv(s) ==> canCancelListener(s, caller) ==> alwaysSemaphoreDeadlockFree(cancelListener(s, caller)))
  ensures (inv(s) ==> canCancelListener(s, caller) ==> alwaysTicketAllocatorPositive(cancelListener(s, caller)))
  ensures (inv(s) ==> canCancelListener(s, caller) ==> alwaysGrantsPrecedeNextTicket(cancelListener(s, caller)))
  ensures (inv(s) ==> canCancelListener(s, caller) ==> alwaysQueuedAbortWasObserved(cancelListener(s, caller)))
  ensures (inv(s) ==> canCancelListener(s, caller) ==> alwaysPermitOwnersUnique(cancelListener(s, caller)))
{
  if inv(s) && canCancelListener(s, caller) {
    SemCancelListenerView(s, caller);
    var after := cancelListener(s, caller);
    SemAlwaysWaitersUniqueView(s); SemAlwaysWaitersUniqueView(after);
    SemUnion(s.rejected, caller);
    forall w | w in after.waiters
      ensures w in s.waiters && w.id != caller && |ProofLib.Filter((x: Waiter) => (x.id == w.id), after.waiters)| == 1
    {
      ProofLib.FilterMember((w: Waiter) => (w.id != caller), s.waiters, w);
      ProofLib.FilterOfFilterLength((w: Waiter) => (w.id != caller), (x: Waiter) => (x.id == w.id), (x: Waiter) => (x.id == w.id), s.waiters);
      ProofLib.FilterMember((x: Waiter) => (x.id == w.id), after.waiters, w);
    }
    SemProgress(after);
  }
}

lemma release_ensures(s: SemaphoreState, caller: int)
  ensures (inv(s) ==> canRelease(s, caller) ==> alwaysPermitConservation(release(s, caller)))
  ensures (inv(s) ==> canRelease(s, caller) ==> alwaysNoIdlePermitWithWaiters(release(s, caller)))
  ensures (inv(s) ==> canRelease(s, caller) ==> alwaysWaitersUnique(release(s, caller)))
  ensures (inv(s) ==> canRelease(s, caller) ==> alwaysCancelledQueuedNeverOwns(release(s, caller)))
  ensures (inv(s) ==> canRelease(s, caller) ==> alwaysTerminalCallersDoNotWait(release(s, caller)))
  ensures (inv(s) ==> canRelease(s, caller) ==> alwaysFIFOGrants(release(s, caller)))
  ensures (inv(s) ==> canRelease(s, caller) ==> alwaysConfiguredSemaphoreHasCapacity(release(s, caller)))
  ensures (inv(s) ==> canRelease(s, caller) ==> alwaysSemaphoreDeadlockFree(release(s, caller)))
  ensures (inv(s) ==> canRelease(s, caller) ==> alwaysTicketAllocatorPositive(release(s, caller)))
  ensures (inv(s) ==> canRelease(s, caller) ==> alwaysGrantsPrecedeNextTicket(release(s, caller)))
  ensures (inv(s) ==> canRelease(s, caller) ==> alwaysQueuedAbortWasObserved(release(s, caller)))
  ensures (inv(s) ==> canRelease(s, caller) ==> alwaysPermitOwnersUnique(release(s, caller)))
{
  if inv(s) && canRelease(s, caller) {
    SemReleaseOwners(s, caller);
    SemReleaseWaiters(s, caller);
    SemReleaseFIFO(s, caller);
    SemReleaseTerminal(s, caller);
    SemReleaseView(s, caller);
    var after := release(s, caller);
    if |s.waiters| == 0 { ProofLib.FilterNil((w: Waiter) => !((w.id in s.aborted)), s.waiters); }
    SemProgress(after);
  }
}

lemma SemReleaseOwners(s: SemaphoreState, caller: int)
  requires inv(s) && canRelease(s, caller)
  ensures alwaysPermitConservation(release(s, caller))
  ensures alwaysCancelledQueuedNeverOwns(release(s, caller))
  ensures alwaysPermitOwnersUnique(release(s, caller))
{
  SemReleaseView(s, caller);
  SemOwnerView(s); SemOwnerView(release(s, caller));
  SemCancelledView(s); SemCancelledView(release(s, caller));
  var live := ProofLib.Filter((w: Waiter) => !((w.id in s.aborted)), s.waiters);
  var kept := ProofLib.Filter((set_x: int) => !((set_x in [caller])), s.holders);
  SemRemoveCount(s.holders, caller);
  SemOwnerRemove(s.holders, caller, kept);
  assert |kept| == |s.holders| - 1;
  SemUnion(s.completed, caller);
  forall owner | owner in kept
    ensures owner in s.holders && owner != caller
  {
    ProofLib.FilterMember((set_x: int) => !((set_x in [caller])), s.holders, owner);
  }
  if |live| > 0 {
    var selected := live[0];
    ProofLib.FilterMember((w: Waiter) => !((w.id in s.aborted)), s.waiters, selected);
    assert selected.id !in s.holders && selected.id !in s.queuedAbort;
    SemRemovedUnion(s.holders, caller, selected.id);
    SemOwnerAppend(kept, selected.id);
  }
}

lemma SemReleaseWaiters(s: SemaphoreState, caller: int)
  requires inv(s) && canRelease(s, caller)
  ensures alwaysWaitersUnique(release(s, caller))
{
  SemReleaseView(s, caller);
  var after := release(s, caller);
  SemAlwaysWaitersUniqueView(s); SemAlwaysWaitersUniqueView(after);
  var live := ProofLib.Filter((w: Waiter) => !((w.id in s.aborted)), s.waiters);
  if |live| > 0 {
    var selected := live[0];
    ProofLib.FilterMember((w: Waiter) => !((w.id in s.aborted)), s.waiters, selected);
    var kept := ProofLib.Filter((set_x: int) => !((set_x in [caller])), s.holders);
    SemRemovedUnion(s.holders, caller, selected.id);
    forall w | w in after.waiters
      ensures w in s.waiters && w.ticket > selected.ticket && w.id > 0 && w.ticket > 0 && w.ticket < after.nextTicket && |ProofLib.Filter((x: Waiter) => (x.id == w.id), after.waiters)| == 1 && w.id !in after.holders
    {
      ProofLib.FilterMember((w: Waiter) => (w.ticket > selected.ticket), s.waiters, w);
      ProofLib.FilterOfFilterLength((w: Waiter) => (w.ticket > selected.ticket), (x: Waiter) => (x.id == w.id), (x: Waiter) => (x.id == w.id), s.waiters);
      ProofLib.FilterMember((x: Waiter) => (x.id == w.id), after.waiters, w);
      SemWaiterIds(s.waiters, w, selected);
      if w.id in kept { ProofLib.FilterMember((set_x: int) => !((set_x in [caller])), s.holders, w.id); }
    }
  }
}

lemma SemReleaseTerminal(s: SemaphoreState, caller: int)
  requires inv(s) && canRelease(s, caller)
  ensures alwaysTerminalCallersDoNotWait(release(s, caller))
{
  SemReleaseView(s, caller);
  SemAlwaysWaitersUniqueView(s);
  var after := release(s, caller);
  var live := ProofLib.Filter((w: Waiter) => !((w.id in s.aborted)), s.waiters);
  if |live| > 0 {
    var selected := live[0];
    var rows := ProofLib.Filter((w: Waiter) => (w.ticket < selected.ticket), s.waiters);
    var skipped := Std.Collections.Seq.FoldLeft((ids: seq<int>, w: Waiter) => (ids + Std.Collections.Seq.Filter((set_x: int) => !((set_x in ids)), [w.id])), [], rows);
    SemUnion(s.completed, caller);
    forall w | w in after.waiters
      ensures w.id !in after.rejected && w.id !in after.completed
    {
      ProofLib.FilterMember((w: Waiter) => (w.ticket > selected.ticket), s.waiters, w);
      assert w.id != caller;
      assert w.id !in skipped by {
        if w.id in skipped {
          SemFoldIds(rows, [], w.id);
          var other :| other in rows && other.id == w.id;
          ProofLib.FilterMember((w: Waiter) => (w.ticket < selected.ticket), s.waiters, other);
          SemWaiterIds(s.waiters, w, other);
        }
      }
      if w.id in after.rejected {
        ProofLib.FilterMember((set_x: int) => !((set_x in s.rejected)), skipped, w.id);
      }
    }
  }
}

lemma SemReleaseFIFO(s: SemaphoreState, caller: int)
  requires inv(s) && canRelease(s, caller)
  ensures alwaysFIFOGrants(release(s, caller))
  ensures alwaysGrantsPrecedeNextTicket(release(s, caller))
{
  SemReleaseView(s, caller);
  var after := release(s, caller);
  var live := ProofLib.Filter((w: Waiter) => !((w.id in s.aborted)), s.waiters);
  if |live| > 0 {
    var selected := live[0];
    ProofLib.FilterMember((w: Waiter) => !((w.id in s.aborted)), s.waiters, selected);
    forall w | w in after.waiters
      ensures forall g :: g in after.granted ==> g.ticket < w.ticket
    {
      ProofLib.FilterMember((w: Waiter) => (w.ticket > selected.ticket), s.waiters, w);
    }
  }
}
