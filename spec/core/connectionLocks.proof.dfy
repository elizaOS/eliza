lemma LockCallIds(s: Reconciliations)
  ensures alwaysCallIdentitiesUnique(s) <==> (forall call :: call in s.calls ==> (call.id > 0 && |ProofLib.Filter((other: Reconciliation) => (other.id == call.id), s.calls)| == 1))
{}

lemma LockTimerIds(s: Reconciliations)
  ensures alwaysOneTimerPerAcquiredTicket(s) <==> (forall timer :: timer in s.timers ==> (|ProofLib.Filter((other: WarningTimer) => (other.ticket == timer.ticket), s.timers)| == 1 && (!timer.cleared ==> (exists call :: call in s.calls && call.id == timer.callId && call.adapter == timer.adapter && timer.ticket in call.held))))
{}

lemma LockOwnsBridge(s: Reconciliations)
  ensures alwaysOneCallOwnsEachTicket(s) <==> (forall call :: call in s.calls ==> ((forall ticket :: ticket in call.held ==> (ticket > 0 && ticket != call.waiting && |ProofLib.Filter((other: int) => (other == ticket), call.held)| == 1)) && (forall other :: other in s.calls ==> (other.id == call.id || ((call.waiting == 0 || (other.waiting != call.waiting && !(call.waiting in other.held))) && (forall ticket :: ticket in call.held ==> (other.waiting != ticket && !(ticket in other.held))))))))
{}

lemma LockQueueTickets(q: core__connectorQueues_ConnectorQueues)
  ensures core__connectorQueues_alwaysAllocatedTickets(q) <==> (q.serial >= 1 && (forall entry :: entry in q.entries ==> (entry.ticket > 0 && entry.ticket < q.serial && |ProofLib.Filter((other: core__connectorQueues_QueueEntry) => (other.ticket == entry.ticket), q.entries)| == 1)))
{}

lemma LockCallAtBridge(s: Reconciliations, id: int)
  ensures callAt(s, id) == (if 0 < |ProofLib.Filter((call: Reconciliation) => (call.id == id), s.calls)| then ProofLib.Filter((call: Reconciliation) => (call.id == id), s.calls)[0] else noCall)
{}

lemma LockCallAt(s: Reconciliations, id: int)
  requires alwaysCallIdentitiesUnique(s)
  requires !callAt(s, id).phase.Reconciled?
  ensures exists i :: 0 <= i < |s.calls| && s.calls[i] == callAt(s, id) && s.calls[i].id == id && (forall j :: 0 <= j < |s.calls| && j != i ==> s.calls[j].id != id)
{
  var xs := s.calls;
  var p := (call: Reconciliation) => (call.id == id);
  LockCallAtBridge(s, id);
  assert 0 < |ProofLib.Filter(p, xs)|;
  ProofLib.FilterSubset(p, xs);
  var c := ProofLib.Filter(p, xs)[0];
  ProofLib.FilterMember(p, xs, c);
  var i :| 0 <= i < |xs| && xs[i] == c;
  LockCallIds(s);
  ProofLib.FilterSamePredicate(p, (other: Reconciliation) => (other.id == c.id), xs);
  ProofLib.FilterCountOneIffUnique(p, xs, (call: Reconciliation) => call.id, i);
}

lemma LockEntryUnique(q: core__connectorQueues_ConnectorQueues, a: core__connectorQueues_QueueEntry, b: core__connectorQueues_QueueEntry)
  requires core__connectorQueues_alwaysAllocatedTickets(q)
  requires a in q.entries && b in q.entries && a.ticket == b.ticket
  ensures a == b
{
  LockQueueTickets(q);
  var i :| 0 <= i < |q.entries| && q.entries[i] == a;
  var j :| 0 <= j < |q.entries| && q.entries[j] == b;
  if i != j {
    ProofLib.FilterTwo((other: core__connectorQueues_QueueEntry) => (other.ticket == a.ticket), q.entries, i, j);
  }
}

lemma LockTimerUnique(s: Reconciliations, a: WarningTimer, b: WarningTimer)
  requires alwaysOneTimerPerAcquiredTicket(s)
  requires a in s.timers && b in s.timers && a.ticket == b.ticket
  ensures a == b
{
  LockTimerIds(s);
  var i :| 0 <= i < |s.timers| && s.timers[i] == a;
  var j :| 0 <= j < |s.timers| && s.timers[j] == b;
  if i != j {
    ProofLib.FilterTwo((other: WarningTimer) => (other.ticket == a.ticket), s.timers, i, j);
  }
}

lemma LockOwnsReplace(s: Reconciliations, t: Reconciliations, i: int, d: Reconciliation)
  requires alwaysOneCallOwnsEachTicket(s)
  requires 0 <= i < |s.calls| && d.id == s.calls[i].id && t.calls == s.calls[i := d]
  requires forall x :: x in d.held ==> (x > 0 && x != d.waiting && |ProofLib.Filter((other: int) => (other == x), d.held)| == 1)
  requires forall j :: 0 <= j < |s.calls| && j != i && s.calls[j].id != d.id ==>
    ((d.waiting == 0 || (s.calls[j].waiting != d.waiting && !(d.waiting in s.calls[j].held))) && (forall x :: x in d.held ==> (s.calls[j].waiting != x && !(x in s.calls[j].held)))) &&
    ((s.calls[j].waiting == 0 || (d.waiting != s.calls[j].waiting && !(s.calls[j].waiting in d.held))) && (forall x :: x in s.calls[j].held ==> (d.waiting != x && !(x in d.held))))
  ensures alwaysOneCallOwnsEachTicket(t)
{
  LockOwnsBridge(s);
  LockOwnsBridge(t);
  forall call | call in t.calls
    ensures (forall ticket :: ticket in call.held ==> (ticket > 0 && ticket != call.waiting && |ProofLib.Filter((other: int) => (other == ticket), call.held)| == 1)) && (forall other :: other in t.calls ==> (other.id == call.id || ((call.waiting == 0 || (other.waiting != call.waiting && !(call.waiting in other.held))) && (forall ticket :: ticket in call.held ==> (other.waiting != ticket && !(ticket in other.held))))))
  {
    var j :| 0 <= j < |t.calls| && t.calls[j] == call;
    if j != i {
      assert call in s.calls;
    }
    forall other | other in t.calls
      ensures (other.id == call.id || ((call.waiting == 0 || (other.waiting != call.waiting && !(call.waiting in other.held))) && (forall ticket :: ticket in call.held ==> (other.waiting != ticket && !(ticket in other.held)))))
    {
      var k :| 0 <= k < |t.calls| && t.calls[k] == other;
      if k != i {
        assert other in s.calls;
      }
    }
  }
}

lemma LockSameCalls(s: Reconciliations, t: Reconciliations)
  requires s.calls == t.calls
  ensures alwaysCallIdentitiesUnique(s) == alwaysCallIdentitiesUnique(t)
  ensures alwaysAcquisitionCursor(s) == alwaysAcquisitionCursor(t)
  ensures alwaysCallbackOwnsEveryKey(s) == alwaysCallbackOwnsEveryKey(t)
  ensures alwaysOneCallOwnsEachTicket(s) == alwaysOneCallOwnsEachTicket(t)
  ensures s.queue == t.queue ==> alwaysWaitingTicketIsQueued(s) == alwaysWaitingTicketIsQueued(t)
  ensures s.queue == t.queue ==> alwaysHeldTicketsAreRunning(s) == alwaysHeldTicketsAreRunning(t)
  ensures s.queue == t.queue ==> alwaysQueueMutualExclusion(s) == alwaysQueueMutualExclusion(t)
  ensures s.queue == t.queue && s.cleanupPending == t.cleanupPending ==> alwaysCleanupOwnsSettledTicket(s) == alwaysCleanupOwnsSettledTicket(t)
{}

lemma LockCallIdsPointwise(s: Reconciliations, t: Reconciliations)
  requires alwaysCallIdentitiesUnique(s)
  requires |s.calls| == |t.calls| && (forall j :: 0 <= j < |s.calls| ==> s.calls[j].id == t.calls[j].id)
  ensures alwaysCallIdentitiesUnique(t)
{
  LockCallIds(s);
  LockCallIds(t);
  forall call | call in t.calls
    ensures call.id > 0 && |ProofLib.Filter((other: Reconciliation) => (other.id == call.id), t.calls)| == 1
  {
    var j :| 0 <= j < |t.calls| && t.calls[j] == call;
    assert s.calls[j] in s.calls;
    ProofLib.FilterLengthPointwise((other: Reconciliation) => (other.id == call.id), (other: Reconciliation) => (other.id == call.id), s.calls, t.calls);
  }
}

lemma LockCallIdsAppend(s: Reconciliations, t: Reconciliations, row: Reconciliation)
  requires alwaysCallIdentitiesUnique(s)
  requires t.calls == s.calls + [row] && row.id > 0 && (forall call :: call in s.calls ==> call.id != row.id)
  ensures alwaysCallIdentitiesUnique(t)
{
  LockCallIds(s);
  LockCallIds(t);
  forall call | call in t.calls
    ensures call.id > 0 && |ProofLib.Filter((other: Reconciliation) => (other.id == call.id), t.calls)| == 1
  {
    var p := (other: Reconciliation) => (other.id == call.id);
    ProofLib.FilterAppend(p, s.calls, row);
    if call == row {
      ProofLib.FilterNone(p, s.calls);
    } else {
      assert call in s.calls;
    }
  }
}

lemma LockTimerCountsPointwise(s: Reconciliations, t: Reconciliations)
  requires alwaysOneTimerPerAcquiredTicket(s)
  requires |s.timers| == |t.timers| && (forall j :: 0 <= j < |s.timers| ==> s.timers[j].ticket == t.timers[j].ticket)
  ensures forall timer :: timer in t.timers ==> |ProofLib.Filter((other: WarningTimer) => (other.ticket == timer.ticket), t.timers)| == 1
{
  LockTimerIds(s);
  forall timer | timer in t.timers
    ensures |ProofLib.Filter((other: WarningTimer) => (other.ticket == timer.ticket), t.timers)| == 1
  {
    var j :| 0 <= j < |t.timers| && t.timers[j] == timer;
    assert s.timers[j] in s.timers;
    ProofLib.FilterLengthPointwise((other: WarningTimer) => (other.ticket == timer.ticket), (other: WarningTimer) => (other.ticket == timer.ticket), s.timers, t.timers);
  }
}

lemma LockTimerCallsPointwise(s: Reconciliations, t: Reconciliations)
  requires alwaysOneTimerPerAcquiredTicket(s) && alwaysEachHeldTicketOwnsTimer(s)
  requires s.timers == t.timers && |s.calls| == |t.calls|
  requires forall j :: 0 <= j < |s.calls| ==> (s.calls[j].id == t.calls[j].id && s.calls[j].adapter == t.calls[j].adapter && s.calls[j].held == t.calls[j].held)
  ensures alwaysOneTimerPerAcquiredTicket(t) && alwaysEachHeldTicketOwnsTimer(t)
{
  LockTimerIds(s);
  LockTimerOwners(s.timers, s.calls, t.calls);
  LockTimerJoin(t);
  LockHeldTimers(s, t);
}

lemma LockTimerOwners(timers: seq<WarningTimer>, before: seq<Reconciliation>, after: seq<Reconciliation>)
  requires forall timer :: timer in timers && !timer.cleared ==> exists call :: call in before && call.id == timer.callId && call.adapter == timer.adapter && timer.ticket in call.held
  requires |before| == |after|
  requires forall j :: 0 <= j < |before| ==> (before[j].id == after[j].id && before[j].adapter == after[j].adapter && (forall x :: x in before[j].held ==> x in after[j].held))
  ensures forall timer :: timer in timers && !timer.cleared ==> exists call :: call in after && call.id == timer.callId && call.adapter == timer.adapter && timer.ticket in call.held
{
  forall timer | timer in timers && !timer.cleared
    ensures exists call :: call in after && call.id == timer.callId && call.adapter == timer.adapter && timer.ticket in call.held
  {
    var call :| call in before && call.id == timer.callId && call.adapter == timer.adapter && timer.ticket in call.held;
    var j :| 0 <= j < |before| && before[j] == call;
    assert after[j] in after;
  }
}

lemma LockTimerJoin(t: Reconciliations)
  requires forall timer :: timer in t.timers ==> |ProofLib.Filter((other: WarningTimer) => (other.ticket == timer.ticket), t.timers)| == 1
  requires forall timer :: timer in t.timers && !timer.cleared ==> exists call :: call in t.calls && call.id == timer.callId && call.adapter == timer.adapter && timer.ticket in call.held
  ensures alwaysOneTimerPerAcquiredTicket(t)
{
  LockTimerIds(t);
}

lemma LockHeldTimers(s: Reconciliations, t: Reconciliations)
  requires alwaysEachHeldTicketOwnsTimer(s)
  requires |s.calls| == |t.calls|
  requires forall j :: 0 <= j < |s.calls| ==> (s.calls[j].id == t.calls[j].id && s.calls[j].adapter == t.calls[j].adapter && s.calls[j].held == t.calls[j].held)
  requires forall o :: o in s.timers && !o.cleared ==> exists u :: u in t.timers && u.ticket == o.ticket && u.callId == o.callId && u.adapter == o.adapter && !u.cleared
  ensures alwaysEachHeldTicketOwnsTimer(t)
{
  forall call, x | call in t.calls && x in call.held
    ensures exists timer :: timer in t.timers && timer.ticket == x && timer.callId == call.id && timer.adapter == call.adapter && !timer.cleared
  {
    var j :| 0 <= j < |t.calls| && t.calls[j] == call;
    var sc := s.calls[j];
    assert sc in s.calls && x in sc.held;
    var o :| o in s.timers && o.ticket == x && o.callId == sc.id && o.adapter == sc.adapter && !o.cleared;
  }
}

lemma LockBelowSerial(s: Reconciliations)
  requires alwaysWaitingTicketIsQueued(s) && alwaysHeldTicketsAreRunning(s) && alwaysTimersOwnTheirQueueTicket(s)
  requires core__connectorQueues_alwaysAllocatedTickets(s.queue)
  ensures forall call :: call in s.calls ==> (0 <= call.waiting < s.queue.serial && (forall x :: x in call.held ==> 0 < x < s.queue.serial))
  ensures forall timer :: timer in s.timers ==> 0 < timer.ticket < s.queue.serial
{
  LockQueueTickets(s.queue);
}

lemma LockOwnsAppendIdle(s: Reconciliations, t: Reconciliations, row: Reconciliation)
  requires alwaysOneCallOwnsEachTicket(s)
  requires t.calls == s.calls + [row] && row.waiting == 0 && row.held == []
  ensures alwaysOneCallOwnsEachTicket(t)
{
  LockOwnsBridge(s);
  LockOwnsBridge(t);
  forall call | call in t.calls
    ensures (forall ticket :: ticket in call.held ==> (ticket > 0 && ticket != call.waiting && |ProofLib.Filter((other: int) => (other == ticket), call.held)| == 1)) && (forall other :: other in t.calls ==> (other.id == call.id || ((call.waiting == 0 || (other.waiting != call.waiting && !(call.waiting in other.held))) && (forall ticket :: ticket in call.held ==> (other.waiting != ticket && !(ticket in other.held))))))
  {
    if call != row {
      assert call in s.calls;
    }
    forall other | other in t.calls
      ensures (other.id == call.id || ((call.waiting == 0 || (other.waiting != call.waiting && !(call.waiting in other.held))) && (forall ticket :: ticket in call.held ==> (other.waiting != ticket && !(ticket in other.held)))))
    {
      if other != row {
        assert other in s.calls;
      }
    }
  }
}

lemma LockWarnShape(s: Reconciliations, t: Reconciliations, ticket: int, firedAt: int)
  requires t == warn(s, ticket, firedAt)
  ensures t.calls == s.calls && t.queue == s.queue && t.cleanupPending == s.cleanupPending && |t.timers| == |s.timers|
  ensures forall j :: 0 <= j < |s.timers| ==> (s.timers[j].ticket == t.timers[j].ticket && s.timers[j].callId == t.timers[j].callId && s.timers[j].adapter == t.timers[j].adapter && s.timers[j].recordKey == t.timers[j].recordKey && s.timers[j].cleared == t.timers[j].cleared)
{}

lemma LockTimersPointwise(s: Reconciliations, t: Reconciliations)
  requires alwaysOneTimerPerAcquiredTicket(s) && alwaysEachHeldTicketOwnsTimer(s) && alwaysTimersOwnTheirQueueTicket(s)
  requires s.calls == t.calls && s.queue == t.queue && |s.timers| == |t.timers|
  requires forall j :: 0 <= j < |s.timers| ==> (s.timers[j].ticket == t.timers[j].ticket && s.timers[j].callId == t.timers[j].callId && s.timers[j].adapter == t.timers[j].adapter && s.timers[j].recordKey == t.timers[j].recordKey && s.timers[j].cleared == t.timers[j].cleared)
  ensures alwaysOneTimerPerAcquiredTicket(t) && alwaysEachHeldTicketOwnsTimer(t) && alwaysTimersOwnTheirQueueTicket(t)
{
  LockTimerCountsPointwise(s, t);
  LockTimerIds(s);
  forall timer | timer in t.timers && !timer.cleared
    ensures exists call :: call in t.calls && call.id == timer.callId && call.adapter == timer.adapter && timer.ticket in call.held
  {
    var j :| 0 <= j < |t.timers| && t.timers[j] == timer;
    assert s.timers[j] in s.timers;
  }
  LockTimerJoin(t);
  LockLiveTimersKept(s.timers, t.timers);
  LockHeldTimers(s, t);
  forall timer | timer in t.timers
    ensures exists entry :: entry in t.queue.entries && entry.ticket == timer.ticket && entry.scope.owner == timer.adapter && entry.scope.provider == timer.recordKey && entry.running == !timer.cleared && entry.complete == timer.cleared
  {
    var j :| 0 <= j < |t.timers| && t.timers[j] == timer;
    assert s.timers[j] in s.timers;
  }
}

lemma LockLiveTimersKept(before: seq<WarningTimer>, after: seq<WarningTimer>)
  requires |before| == |after|
  requires forall j :: 0 <= j < |before| ==> (before[j].ticket == after[j].ticket && before[j].callId == after[j].callId && before[j].adapter == after[j].adapter && before[j].cleared == after[j].cleared)
  ensures forall o :: o in before && !o.cleared ==> exists u :: u in after && u.ticket == o.ticket && u.callId == o.callId && u.adapter == o.adapter && !u.cleared
{
  forall o | o in before && !o.cleared
    ensures exists u :: u in after && u.ticket == o.ticket && u.callId == o.callId && u.adapter == o.adapter && !u.cleared
  {
    var j :| 0 <= j < |before| && before[j] == o;
    assert after[j] in after;
  }
}

lemma LockWarnDue(s: Reconciliations, t: Reconciliations, ticket: int, firedAt: int)
  requires alwaysOneTimerPerAcquiredTicket(s) && alwaysWarnedTimersWereDue(s)
  requires canWarn(s, ticket, firedAt) && t == warn(s, ticket, firedAt)
  ensures alwaysWarnedTimersWereDue(t)
{
  var w :| w in s.timers && w.ticket == ticket && !w.cleared && !w.fired && firedAt - w.armedAt >= warningDelay;
  forall timer | timer in t.timers
    ensures !timer.fired || timer.firedAt - timer.armedAt >= warningDelay
  {
    var j :| 0 <= j < |t.timers| && t.timers[j] == timer;
    assert s.timers[j] in s.timers;
    if s.timers[j].ticket == ticket {
      LockTimerUnique(s, s.timers[j], w);
    }
  }
}

lemma LockCleanupPendingBridge(s: Reconciliations, ticket: int)
  ensures cleanupKey(s, ticket).cleanupPending == ProofLib.Filter((set_x: int) => !((set_x in [ticket])), s.cleanupPending)
  ensures cleanupKey(s, ticket).queue.tails == ProofLib.Filter((queuedTail: core__connectorQueues_QueueTail) => (queuedTail.ticket != ticket), s.queue.tails)
{}

lemma LockCleanup(s: Reconciliations, t: Reconciliations, ticket: int)
  requires alwaysCleanupOwnsSettledTicket(s)
  requires canCleanupKey(s, ticket) && t == cleanupKey(s, ticket)
  ensures alwaysCleanupOwnsSettledTicket(t) && stepCleanupRetainsOtherTails(s, "cleanupKey", t) && t.calls == s.calls
{
  LockCleanupPendingBridge(s, ticket);
  forall x | x in t.cleanupPending
    ensures core__connectorQueues_canCleanup(t.queue, x)
  {
    ProofLib.FilterMember((set_x: int) => !((set_x in [ticket])), s.cleanupPending, x);
  }
  forall qt | qt in s.queue.tails
    ensures qt in t.queue.tails || (qt.ticket in s.cleanupPending && !(qt.ticket in t.cleanupPending))
  {
    ProofLib.FilterMember((queuedTail: core__connectorQueues_QueueTail) => (queuedTail.ticket != ticket), s.queue.tails, qt);
    ProofLib.FilterMember((set_x: int) => !((set_x in [ticket])), s.cleanupPending, qt.ticket);
  }
}

lemma LockCallback(s: Reconciliations, t: Reconciliations, i: int, success: bool)
  requires alwaysOneCallOwnsEachTicket(s) && alwaysOneTimerPerAcquiredTicket(s) && alwaysEachHeldTicketOwnsTimer(s) && alwaysCallIdentitiesUnique(s) && alwaysWaitingTicketIsQueued(s)
  requires 0 <= i < |s.calls| && s.calls[i].phase.ExecutingRecords? && (forall j :: 0 <= j < |s.calls| && j != i ==> s.calls[j].id != s.calls[i].id)
  requires t == callbackReturns(s, s.calls[i].id, success)
  ensures alwaysOneCallOwnsEachTicket(t) && alwaysOneTimerPerAcquiredTicket(t) && alwaysCallIdentitiesUnique(t) && alwaysWaitingTicketIsQueued(t)
{
  var c := s.calls[i];
  var d := c.(phase := (if (|c.held| == 0) then ReconcilePhase.Reconciled else ReconcilePhase.ReleasingRecords), failed := !(success));
  assert t.calls == s.calls[i := d];
  assert c in s.calls;
  LockOwnsBridge(s);
  forall j | 0 <= j < |s.calls| && j != i
    ensures s.calls[j] in s.calls
  {}
  LockOwnsReplace(s, t, i, d);
  LockCallIdsPointwise(s, t);
  LockTimerCallsPointwise(s, t);
  forall call | call in t.calls
    ensures call.waiting >= 0 && (call.waiting > 0 ==> (call.phase.AcquiringRecords? && exists entry :: entry in t.queue.entries && entry.ticket == call.waiting && entry.scope.owner == call.adapter && entry.scope.provider == (if ((0 <= call.position) && (call.position < |call.recordKeys|)) then call.recordKeys[call.position] else noKey).key && !entry.running && !entry.complete))
  {
    var j :| 0 <= j < |t.calls| && t.calls[j] == call;
    assert s.calls[j] in s.calls;
  }
}

lemma LockBeginKept(q: core__connectorQueues_ConnectorQueues, w: int)
  ensures forall e :: e in q.entries && e.ticket != w ==> e in core__connectorQueues_begin(q, w).entries
  ensures forall e :: e in q.entries && e.ticket == w ==> e.(running := true) in core__connectorQueues_begin(q, w).entries
{
  var after := core__connectorQueues_begin(q, w).entries;
  forall e | e in q.entries
    ensures (e.ticket != w ==> e in after) && (e.ticket == w ==> e.(running := true) in after)
  {
    var k :| 0 <= k < |q.entries| && q.entries[k] == e;
    assert after[k] in after;
  }
}

lemma LockFinishKept(q: core__connectorQueues_ConnectorQueues, r: int, ok: bool)
  ensures forall e :: e in q.entries && e.ticket != r ==> e in core__connectorQueues_finish(q, r, ok).entries
  ensures forall e :: e in q.entries && e.ticket == r ==> e.(running := false, complete := true, failed := !ok) in core__connectorQueues_finish(q, r, ok).entries
{
  var after := core__connectorQueues_finish(q, r, ok).entries;
  forall e | e in q.entries
    ensures (e.ticket != r ==> e in after) && (e.ticket == r ==> e.(running := false, complete := true, failed := !ok) in after)
  {
    var k :| 0 <= k < |q.entries| && q.entries[k] == e;
    assert after[k] in after;
  }
}

lemma LockReplaced(xs: seq<Reconciliation>, i: int, d: Reconciliation)
  requires 0 <= i < |xs|
  ensures forall call :: call in xs[i := d] ==> call == d || call in xs
{
  forall call | call in xs[i := d]
    ensures call == d || call in xs
  {
    var j :| 0 <= j < |xs[i := d]| && xs[i := d][j] == call;
  }
}

lemma LockPair(s: Reconciliations, a: Reconciliation, b: Reconciliation)
  requires alwaysOneCallOwnsEachTicket(s)
  requires a in s.calls && b in s.calls && a.id != b.id
  ensures forall x :: x in a.held ==> (x > 0 && x != a.waiting && |ProofLib.Filter((other: int) => (other == x), a.held)| == 1)
  ensures a.waiting == 0 || (b.waiting != a.waiting && !(a.waiting in b.held))
  ensures forall x :: x in a.held ==> (b.waiting != x && !(x in b.held))
{
  LockOwnsBridge(s);
}

lemma LockLocal(s: Reconciliations, a: Reconciliation)
  requires alwaysOneCallOwnsEachTicket(s) && a in s.calls
  ensures forall x :: x in a.held ==> (x > 0 && x != a.waiting && |ProofLib.Filter((other: int) => (other == x), a.held)| == 1)
{
  LockOwnsBridge(s);
}

lemma LockEnqueueShape(s: Reconciliations, t: Reconciliations, i: int)
  requires 0 <= i < |s.calls| && callAt(s, s.calls[i].id) == s.calls[i]
  requires forall j :: 0 <= j < |s.calls| && j != i ==> s.calls[j].id != s.calls[i].id
  requires t == enqueueKey(s, s.calls[i].id)
  ensures t.calls == s.calls[i := s.calls[i].(waiting := s.queue.serial)]
  ensures t.queue == core__connectorQueues_admit(s.queue, core__connectorQueues_QueueScope(s.calls[i].adapter, (if ((0 <= s.calls[i].position) && (s.calls[i].position < |s.calls[i].recordKeys|)) then s.calls[i].recordKeys[s.calls[i].position] else noKey).key))
  ensures t.timers == s.timers && t.cleanupPending == s.cleanupPending
{
  assert |t.calls| == |s.calls|;
  forall j | 0 <= j < |s.calls|
    ensures t.calls[j] == s.calls[i := s.calls[i].(waiting := s.queue.serial)][j]
  {}
}

lemma LockEnqueueOwns(s: Reconciliations, t: Reconciliations, i: int, w: int)
  requires alwaysOneCallOwnsEachTicket(s)
  requires 0 <= i < |s.calls| && s.calls[i].waiting == 0 && w > 0
  requires forall j :: 0 <= j < |s.calls| && j != i ==> s.calls[j].id != s.calls[i].id
  requires forall call :: call in s.calls ==> (call.waiting < w && (forall x :: x in call.held ==> x < w))
  requires t.calls == s.calls[i := s.calls[i].(waiting := w)]
  ensures alwaysOneCallOwnsEachTicket(t)
{
  var c := s.calls[i];
  var d := c.(waiting := w);
  assert c in s.calls;
  LockLocal(s, c);
  forall j | 0 <= j < |s.calls| && j != i && s.calls[j].id != d.id
    ensures ((d.waiting == 0 || (s.calls[j].waiting != d.waiting && !(d.waiting in s.calls[j].held))) && (forall x :: x in d.held ==> (s.calls[j].waiting != x && !(x in s.calls[j].held)))) &&
      ((s.calls[j].waiting == 0 || (d.waiting != s.calls[j].waiting && !(s.calls[j].waiting in d.held))) && (forall x :: x in s.calls[j].held ==> (d.waiting != x && !(x in d.held))))
  {
    assert s.calls[j] in s.calls;
    LockPair(s, c, s.calls[j]);
    LockPair(s, s.calls[j], c);
  }
  LockOwnsReplace(s, t, i, d);
}

lemma LockEnqueueWaiting(s: Reconciliations, t: Reconciliations, i: int, e: core__connectorQueues_QueueEntry)
  requires alwaysWaitingTicketIsQueued(s)
  requires 0 <= i < |s.calls| && s.calls[i].phase.AcquiringRecords?
  requires t.calls == s.calls[i := s.calls[i].(waiting := e.ticket)] && e.ticket > 0
  requires e in t.queue.entries && e.scope.owner == s.calls[i].adapter && e.scope.provider == (if ((0 <= s.calls[i].position) && (s.calls[i].position < |s.calls[i].recordKeys|)) then s.calls[i].recordKeys[s.calls[i].position] else noKey).key && !e.running && !e.complete
  requires forall entry :: entry in s.queue.entries ==> entry in t.queue.entries
  ensures alwaysWaitingTicketIsQueued(t)
{
  LockReplaced(s.calls, i, s.calls[i].(waiting := e.ticket));
  forall call | call in t.calls
    ensures call.waiting >= 0 && (call.waiting > 0 ==> (call.phase.AcquiringRecords? && exists entry :: entry in t.queue.entries && entry.ticket == call.waiting && entry.scope.owner == call.adapter && entry.scope.provider == (if ((0 <= call.position) && (call.position < |call.recordKeys|)) then call.recordKeys[call.position] else noKey).key && !entry.running && !entry.complete))
  {
  }
}

lemma LockAcquireShape(s: Reconciliations, t: Reconciliations, i: int, armedAt: int)
  requires 0 <= i < |s.calls| && callAt(s, s.calls[i].id) == s.calls[i]
  requires forall j :: 0 <= j < |s.calls| && j != i ==> s.calls[j].id != s.calls[i].id
  requires t == acquireKey(s, s.calls[i].id, armedAt)
  ensures t.calls == s.calls[i := s.calls[i].(held := (s.calls[i].held + [s.calls[i].waiting]), waiting := 0, position := (s.calls[i].position + 1), phase := (if ((s.calls[i].position + 1) == |s.calls[i].recordKeys|) then ReconcilePhase.ExecutingRecords else ReconcilePhase.AcquiringRecords))]
  ensures t.queue == core__connectorQueues_begin(s.queue, s.calls[i].waiting)
  ensures t.timers == s.timers + [WarningTimer(s.calls[i].waiting, s.calls[i].id, s.calls[i].adapter, (if ((0 <= s.calls[i].position) && (s.calls[i].position < |s.calls[i].recordKeys|)) then s.calls[i].recordKeys[s.calls[i].position] else noKey).key, armedAt, false, false, 0)]
  ensures t.cleanupPending == s.cleanupPending
{
  var d := s.calls[i].(held := (s.calls[i].held + [s.calls[i].waiting]), waiting := 0, position := (s.calls[i].position + 1), phase := (if ((s.calls[i].position + 1) == |s.calls[i].recordKeys|) then ReconcilePhase.ExecutingRecords else ReconcilePhase.AcquiringRecords));
  assert |t.calls| == |s.calls|;
  forall j | 0 <= j < |s.calls|
    ensures t.calls[j] == s.calls[i := d][j]
  {}
}

lemma LockAcquireCalls(s: Reconciliations, t: Reconciliations, i: int, d: Reconciliation)
  requires alwaysCallIdentitiesUnique(s) && alwaysAcquisitionCursor(s) && alwaysCallbackOwnsEveryKey(s) && alwaysOneCallOwnsEachTicket(s)
  requires 0 <= i < |s.calls| && s.calls[i].phase.AcquiringRecords? && s.calls[i].waiting > 0
  requires forall j :: 0 <= j < |s.calls| && j != i ==> s.calls[j].id != s.calls[i].id
  requires d == s.calls[i].(held := (s.calls[i].held + [s.calls[i].waiting]), waiting := 0, position := (s.calls[i].position + 1), phase := (if ((s.calls[i].position + 1) == |s.calls[i].recordKeys|) then ReconcilePhase.ExecutingRecords else ReconcilePhase.AcquiringRecords))
  requires t.calls == s.calls[i := d]
  ensures alwaysCallIdentitiesUnique(t) && alwaysAcquisitionCursor(t) && alwaysCallbackOwnsEveryKey(t) && alwaysOneCallOwnsEachTicket(t)
{
  var c := s.calls[i];
  var w := c.waiting;
  assert c in s.calls;
  LockCallIdsPointwise(s, t);
  LockReplaced(s.calls, i, d);
  LockLocal(s, c);
  forall x | x in d.held
    ensures x > 0 && x != d.waiting && |ProofLib.Filter((other: int) => (other == x), d.held)| == 1
  {
    var q := (other: int) => (other == x);
    ProofLib.FilterAppend(q, c.held, w);
    if x == w {
      ProofLib.FilterNone(q, c.held);
    }
  }
  forall j | 0 <= j < |s.calls| && j != i && s.calls[j].id != d.id
    ensures ((d.waiting == 0 || (s.calls[j].waiting != d.waiting && !(d.waiting in s.calls[j].held))) && (forall x :: x in d.held ==> (s.calls[j].waiting != x && !(x in s.calls[j].held)))) &&
      ((s.calls[j].waiting == 0 || (d.waiting != s.calls[j].waiting && !(s.calls[j].waiting in d.held))) && (forall x :: x in s.calls[j].held ==> (d.waiting != x && !(x in d.held))))
  {
    assert s.calls[j] in s.calls;
    LockPair(s, c, s.calls[j]);
    LockPair(s, s.calls[j], c);
  }
  LockOwnsReplace(s, t, i, d);
}

lemma LockNoTimerForWaiting(s: Reconciliations, e: core__connectorQueues_QueueEntry)
  requires alwaysTimersOwnTheirQueueTicket(s) && core__connectorQueues_alwaysAllocatedTickets(s.queue)
  requires e in s.queue.entries && !e.running && !e.complete
  ensures forall timer :: timer in s.timers ==> timer.ticket != e.ticket
{
  forall timer | timer in s.timers
    ensures timer.ticket != e.ticket
  {
    var f :| f in s.queue.entries && f.ticket == timer.ticket && f.scope.owner == timer.adapter && f.scope.provider == timer.recordKey && f.running == !timer.cleared && f.complete == timer.cleared;
    if timer.ticket == e.ticket {
      LockEntryUnique(s.queue, e, f);
    }
  }
}

lemma LockAcquireTimers(s: Reconciliations, t: Reconciliations, i: int, d: Reconciliation, nt: WarningTimer)
  requires alwaysOneTimerPerAcquiredTicket(s) && alwaysEachHeldTicketOwnsTimer(s) && alwaysWarnedTimersWereDue(s)
  requires 0 <= i < |s.calls| && (forall timer :: timer in s.timers ==> timer.ticket != nt.ticket)
  requires d.id == s.calls[i].id && d.adapter == s.calls[i].adapter && d.held == s.calls[i].held + [nt.ticket]
  requires nt.callId == d.id && nt.adapter == d.adapter && !nt.cleared && !nt.fired
  requires t.calls == s.calls[i := d] && t.timers == s.timers + [nt]
  ensures alwaysOneTimerPerAcquiredTicket(t) && alwaysEachHeldTicketOwnsTimer(t) && alwaysWarnedTimersWereDue(t)
{
  LockTimerIds(s);
  forall timer | timer in t.timers
    ensures |ProofLib.Filter((other: WarningTimer) => (other.ticket == timer.ticket), t.timers)| == 1
  {
    var p := (other: WarningTimer) => (other.ticket == timer.ticket);
    ProofLib.FilterAppend(p, s.timers, nt);
    if timer == nt {
      ProofLib.FilterNone(p, s.timers);
    }
  }
  LockTimerOwners(s.timers, s.calls, t.calls);
  assert d in t.calls;
  LockTimerJoin(t);
  LockAppendWarned(s, t, nt);
  LockAcquireHeld(s, t, i, d, nt);
}

lemma LockAppendWarned(s: Reconciliations, t: Reconciliations, nt: WarningTimer)
  requires alwaysWarnedTimersWereDue(s) && t.timers == s.timers + [nt] && !nt.fired
  ensures alwaysWarnedTimersWereDue(t)
{}

lemma LockAcquireHeld(s: Reconciliations, t: Reconciliations, i: int, d: Reconciliation, nt: WarningTimer)
  requires alwaysEachHeldTicketOwnsTimer(s)
  requires 0 <= i < |s.calls|
  requires d.id == s.calls[i].id && d.adapter == s.calls[i].adapter && d.held == s.calls[i].held + [nt.ticket]
  requires nt.callId == d.id && nt.adapter == d.adapter && !nt.cleared
  requires t.calls == s.calls[i := d] && t.timers == s.timers + [nt]
  ensures alwaysEachHeldTicketOwnsTimer(t)
{
  forall j, x | 0 <= j < |t.calls| && x in t.calls[j].held
    ensures exists timer :: timer in t.timers && timer.ticket == x && timer.callId == t.calls[j].id && timer.adapter == t.calls[j].adapter && !timer.cleared
  {
    if j == i && x == nt.ticket {
      assert nt in t.timers;
    } else {
      assert s.calls[j] in s.calls && x in s.calls[j].held;
      var o :| o in s.timers && o.ticket == x && o.callId == s.calls[j].id && o.adapter == s.calls[j].adapter && !o.cleared;
      assert o in t.timers;
    }
  }
}

lemma LockAcquireQueue(s: Reconciliations, t: Reconciliations, i: int, d: Reconciliation, nt: WarningTimer, e: core__connectorQueues_QueueEntry)
  requires alwaysTimersOwnTheirQueueTicket(s) && alwaysCleanupOwnsSettledTicket(s) && alwaysHeldTicketsAreRunning(s) && alwaysWaitingTicketIsQueued(s) && alwaysOneCallOwnsEachTicket(s)
  requires 0 <= i < |s.calls| && (forall j :: 0 <= j < |s.calls| && j != i ==> s.calls[j].id != s.calls[i].id)
  requires e in s.queue.entries && e.ticket == s.calls[i].waiting && e.ticket > 0 && e.scope.owner == nt.adapter && e.scope.provider == nt.recordKey && !e.running && !e.complete
  requires forall timer :: timer in s.timers ==> timer.ticket != e.ticket
  requires d.waiting == 0 && d.held == s.calls[i].held + [e.ticket]
  requires nt.ticket == e.ticket && !nt.cleared
  requires t.calls == s.calls[i := d] && t.timers == s.timers + [nt] && t.queue == core__connectorQueues_begin(s.queue, e.ticket) && t.cleanupPending == s.cleanupPending
  ensures alwaysTimersOwnTheirQueueTicket(t) && alwaysCleanupOwnsSettledTicket(t) && alwaysHeldTicketsAreRunning(t) && alwaysWaitingTicketIsQueued(t)
{
  var c := s.calls[i];
  LockBeginKept(s.queue, e.ticket);
  assert e.(running := true) in t.queue.entries;
  LockReplaced(s.calls, i, d);
  assert c in s.calls;
  LockLocal(s, c);
  forall call | call in t.calls && call != d
    ensures (forall x :: x in call.held ==> x != e.ticket) && call.waiting != e.ticket
  {
    var j :| 0 <= j < |s.calls| && s.calls[j] == call;
    if j != i {
      LockPair(s, c, call);
    }
  }
}

lemma LockReleaseShape(s: Reconciliations, t: Reconciliations, i: int, r: int)
  requires 0 <= i < |s.calls| && callAt(s, s.calls[i].id) == s.calls[i] && |s.calls[i].held| > 0 && r == s.calls[i].held[|s.calls[i].held| - 1]
  requires forall j :: 0 <= j < |s.calls| && j != i ==> s.calls[j].id != s.calls[i].id
  requires t == releaseKey(s, s.calls[i].id)
  ensures t.calls == s.calls[i := s.calls[i].(held := ProofLib.Filter((value: int) => (value != r), s.calls[i].held), phase := (if (|s.calls[i].held| == 1) then ReconcilePhase.Reconciled else ReconcilePhase.ReleasingRecords))]
  ensures t.queue == core__connectorQueues_finish(s.queue, r, !(s.calls[i].failed))
  ensures |t.timers| == |s.timers| && (forall j :: 0 <= j < |s.timers| ==> t.timers[j] == (if s.timers[j].ticket == r then s.timers[j].(cleared := true) else s.timers[j]))
  ensures t.cleanupPending == s.cleanupPending + ProofLib.Filter((set_x: int) => !((set_x in s.cleanupPending)), [r])
{
  var d := s.calls[i].(held := ProofLib.Filter((value: int) => (value != r), s.calls[i].held), phase := (if (|s.calls[i].held| == 1) then ReconcilePhase.Reconciled else ReconcilePhase.ReleasingRecords));
  assert |t.calls| == |s.calls|;
  forall j | 0 <= j < |s.calls|
    ensures t.calls[j] == s.calls[i := d][j]
  {}
}

lemma LockReleaseCalls(s: Reconciliations, t: Reconciliations, i: int, d: Reconciliation, r: int)
  requires alwaysCallIdentitiesUnique(s) && alwaysOneCallOwnsEachTicket(s)
  requires 0 <= i < |s.calls| && r in s.calls[i].held
  requires forall j :: 0 <= j < |s.calls| && j != i ==> s.calls[j].id != s.calls[i].id
  requires d.id == s.calls[i].id && d.waiting == s.calls[i].waiting && d.held == ProofLib.Filter((value: int) => (value != r), s.calls[i].held)
  requires t.calls == s.calls[i := d]
  ensures alwaysCallIdentitiesUnique(t) && alwaysOneCallOwnsEachTicket(t)
  ensures forall x :: x in d.held <==> (x in s.calls[i].held && x != r)
{
  var c := s.calls[i];
  assert c in s.calls;
  LockCallIdsPointwise(s, t);
  LockLocal(s, c);
  forall x
    ensures x in d.held <==> (x in c.held && x != r)
  {
    ProofLib.FilterMember((value: int) => (value != r), c.held, x);
  }
  forall x | x in d.held
    ensures x > 0 && x != d.waiting && |ProofLib.Filter((other: int) => (other == x), d.held)| == 1
  {
    ProofLib.FilterOfFilterShorter((value: int) => (value != r), (other: int) => (other == x), c.held);
    ProofLib.FilterMember((other: int) => (other == x), d.held, x);
  }
  forall j | 0 <= j < |s.calls| && j != i && s.calls[j].id != d.id
    ensures ((d.waiting == 0 || (s.calls[j].waiting != d.waiting && !(d.waiting in s.calls[j].held))) && (forall x :: x in d.held ==> (s.calls[j].waiting != x && !(x in s.calls[j].held)))) &&
      ((s.calls[j].waiting == 0 || (d.waiting != s.calls[j].waiting && !(s.calls[j].waiting in d.held))) && (forall x :: x in s.calls[j].held ==> (d.waiting != x && !(x in d.held))))
  {
    assert s.calls[j] in s.calls;
    LockPair(s, c, s.calls[j]);
    LockPair(s, s.calls[j], c);
  }
  LockOwnsReplace(s, t, i, d);
}

lemma LockReleaseOthers(s: Reconciliations, i: int, r: int)
  requires alwaysOneCallOwnsEachTicket(s)
  requires 0 <= i < |s.calls| && r in s.calls[i].held
  requires forall j :: 0 <= j < |s.calls| && j != i ==> s.calls[j].id != s.calls[i].id
  ensures forall j :: 0 <= j < |s.calls| && j != i ==> (s.calls[j].waiting != r && !(r in s.calls[j].held))
{
  forall j | 0 <= j < |s.calls| && j != i
    ensures s.calls[j].waiting != r && !(r in s.calls[j].held)
  {
    assert s.calls[i] in s.calls && s.calls[j] in s.calls;
    LockPair(s, s.calls[i], s.calls[j]);
  }
}

lemma LockReleaseTimers(s: Reconciliations, t: Reconciliations, i: int, d: Reconciliation, r: int)
  requires alwaysOneTimerPerAcquiredTicket(s) && alwaysEachHeldTicketOwnsTimer(s) && alwaysWarnedTimersWereDue(s) && alwaysTimersOwnTheirQueueTicket(s)
  requires 0 <= i < |s.calls| && d.id == s.calls[i].id && d.adapter == s.calls[i].adapter
  requires forall x :: x in d.held <==> (x in s.calls[i].held && x != r)
  requires forall j :: 0 <= j < |s.calls| && j != i ==> !(r in s.calls[j].held)
  requires t.calls == s.calls[i := d]
  requires |t.timers| == |s.timers| && (forall j :: 0 <= j < |s.timers| ==> t.timers[j] == (if s.timers[j].ticket == r then s.timers[j].(cleared := true) else s.timers[j]))
  requires t.queue == core__connectorQueues_finish(s.queue, r, !(s.calls[i].failed))
  ensures alwaysOneTimerPerAcquiredTicket(t) && alwaysEachHeldTicketOwnsTimer(t) && alwaysWarnedTimersWereDue(t) && alwaysTimersOwnTheirQueueTicket(t)
{
  LockReleaseTimerOwners(s, t, i, d, r);
  LockReleaseHeld(s, t, i, d, r);
  LockReleaseTimerEntries(s, t, i, r);
  forall k | 0 <= k < |t.timers|
    ensures !t.timers[k].fired || t.timers[k].firedAt - t.timers[k].armedAt >= warningDelay
  {
    assert s.timers[k] in s.timers;
  }
}

lemma LockReleaseTimerOwners(s: Reconciliations, t: Reconciliations, i: int, d: Reconciliation, r: int)
  requires alwaysOneTimerPerAcquiredTicket(s)
  requires 0 <= i < |s.calls| && d.id == s.calls[i].id && d.adapter == s.calls[i].adapter
  requires forall x :: x in d.held <==> (x in s.calls[i].held && x != r)
  requires forall j :: 0 <= j < |s.calls| && j != i ==> !(r in s.calls[j].held)
  requires t.calls == s.calls[i := d]
  requires |t.timers| == |s.timers| && (forall j :: 0 <= j < |s.timers| ==> t.timers[j] == (if s.timers[j].ticket == r then s.timers[j].(cleared := true) else s.timers[j]))
  ensures alwaysOneTimerPerAcquiredTicket(t)
{
  LockTimerCountsPointwise(s, t);
  LockTimerIds(s);
  forall k | 0 <= k < |t.timers| && !t.timers[k].cleared
    ensures exists call :: call in t.calls && call.id == t.timers[k].callId && call.adapter == t.timers[k].adapter && t.timers[k].ticket in call.held
  {
    var o := s.timers[k];
    assert o in s.timers;
    var call :| call in s.calls && call.id == o.callId && call.adapter == o.adapter && o.ticket in call.held;
    var j :| 0 <= j < |s.calls| && s.calls[j] == call;
    assert t.calls[j] in t.calls;
  }
  LockTimerJoin(t);
}

lemma LockReleaseHeld(s: Reconciliations, t: Reconciliations, i: int, d: Reconciliation, r: int)
  requires alwaysEachHeldTicketOwnsTimer(s)
  requires 0 <= i < |s.calls| && d.id == s.calls[i].id && d.adapter == s.calls[i].adapter
  requires forall x :: x in d.held <==> (x in s.calls[i].held && x != r)
  requires forall j :: 0 <= j < |s.calls| && j != i ==> !(r in s.calls[j].held)
  requires t.calls == s.calls[i := d]
  requires |t.timers| == |s.timers| && (forall j :: 0 <= j < |s.timers| ==> t.timers[j] == (if s.timers[j].ticket == r then s.timers[j].(cleared := true) else s.timers[j]))
  ensures alwaysEachHeldTicketOwnsTimer(t)
{
  forall j, x | 0 <= j < |t.calls| && x in t.calls[j].held
    ensures exists timer :: timer in t.timers && timer.ticket == x && timer.callId == t.calls[j].id && timer.adapter == t.calls[j].adapter && !timer.cleared
  {
    assert s.calls[j] in s.calls && x in s.calls[j].held && x != r;
    var o :| o in s.timers && o.ticket == x && o.callId == s.calls[j].id && o.adapter == s.calls[j].adapter && !o.cleared;
    var m :| 0 <= m < |s.timers| && s.timers[m] == o;
    assert t.timers[m] in t.timers;
  }
}

lemma LockReleaseTimerEntries(s: Reconciliations, t: Reconciliations, i: int, r: int)
  requires alwaysTimersOwnTheirQueueTicket(s) && 0 <= i < |s.calls|
  requires |t.timers| == |s.timers| && (forall j :: 0 <= j < |s.timers| ==> t.timers[j] == (if s.timers[j].ticket == r then s.timers[j].(cleared := true) else s.timers[j]))
  requires t.queue == core__connectorQueues_finish(s.queue, r, !(s.calls[i].failed))
  ensures alwaysTimersOwnTheirQueueTicket(t)
{
  LockFinishKept(s.queue, r, !(s.calls[i].failed));
  forall k | 0 <= k < |t.timers|
    ensures exists entry :: entry in t.queue.entries && entry.ticket == t.timers[k].ticket && entry.scope.owner == t.timers[k].adapter && entry.scope.provider == t.timers[k].recordKey && entry.running == !t.timers[k].cleared && entry.complete == t.timers[k].cleared
  {
    var o := s.timers[k];
    assert o in s.timers;
    var f :| f in s.queue.entries && f.ticket == o.ticket && f.scope.owner == o.adapter && f.scope.provider == o.recordKey && f.running == !o.cleared && f.complete == o.cleared;
    if o.ticket == r {
      assert f.(running := false, complete := true, failed := !(!(s.calls[i].failed))) in t.queue.entries;
    }
  }
  forall timer | timer in t.timers
    ensures exists entry :: entry in t.queue.entries && entry.ticket == timer.ticket && entry.scope.owner == timer.adapter && entry.scope.provider == timer.recordKey && entry.running == !timer.cleared && entry.complete == timer.cleared
  {
    var k :| 0 <= k < |t.timers| && t.timers[k] == timer;
  }
}

lemma LockReleaseQueue(s: Reconciliations, t: Reconciliations, i: int, d: Reconciliation, r: int, er: core__connectorQueues_QueueEntry)
  requires alwaysCleanupOwnsSettledTicket(s) && alwaysHeldTicketsAreRunning(s) && alwaysWaitingTicketIsQueued(s)
  requires 0 <= i < |s.calls| && s.calls[i].phase.ReleasingRecords? && d.waiting == s.calls[i].waiting
  requires forall x :: x in d.held <==> (x in s.calls[i].held && x != r)
  requires forall j :: 0 <= j < |s.calls| && j != i ==> (s.calls[j].waiting != r && !(r in s.calls[j].held))
  requires er in s.queue.entries && er.ticket == r
  requires t.calls == s.calls[i := d]
  requires t.queue == core__connectorQueues_finish(s.queue, r, !(s.calls[i].failed))
  requires t.cleanupPending == s.cleanupPending + ProofLib.Filter((set_x: int) => !((set_x in s.cleanupPending)), [r])
  ensures alwaysCleanupOwnsSettledTicket(t) && alwaysHeldTicketsAreRunning(t)
  ensures forall j :: 0 <= j < |t.calls| ==> (t.calls[j].waiting >= 0 && (t.calls[j].waiting > 0 ==> (t.calls[j].phase.AcquiringRecords? && exists entry :: entry in t.queue.entries && entry.ticket == t.calls[j].waiting && entry.scope.owner == t.calls[j].adapter && entry.scope.provider == (if ((0 <= t.calls[j].position) && (t.calls[j].position < |t.calls[j].recordKeys|)) then t.calls[j].recordKeys[t.calls[j].position] else noKey).key && !entry.running && !entry.complete)))
{
  LockFinishKept(s.queue, r, !(s.calls[i].failed));
  ProofLib.FilterCons((set_x: int) => !((set_x in s.cleanupPending)), [r]);
  ProofLib.FilterNil((set_x: int) => !((set_x in s.cleanupPending)), [r][1..]);
  assert er.(running := false, complete := true, failed := !(!(s.calls[i].failed))) in t.queue.entries;
  forall x | x in t.cleanupPending
    ensures core__connectorQueues_canCleanup(t.queue, x)
  {
    if x in s.cleanupPending {
      var f :| f in s.queue.entries && f.ticket == x && f.complete;
      if f.ticket == r {
        assert f.(running := false, complete := true, failed := !(!(s.calls[i].failed))) in t.queue.entries;
      }
    }
  }
  forall j, x | 0 <= j < |t.calls| && x in t.calls[j].held
    ensures exists entry :: entry in t.queue.entries && entry.ticket == x && entry.running
  {
    assert s.calls[j] in s.calls && x in s.calls[j].held && x != r;
  }
  forall j | 0 <= j < |t.calls|
    ensures t.calls[j].waiting >= 0 && (t.calls[j].waiting > 0 ==> (t.calls[j].phase.AcquiringRecords? && exists entry :: entry in t.queue.entries && entry.ticket == t.calls[j].waiting && entry.scope.owner == t.calls[j].adapter && entry.scope.provider == (if ((0 <= t.calls[j].position) && (t.calls[j].position < |t.calls[j].recordKeys|)) then t.calls[j].recordKeys[t.calls[j].position] else noKey).key && !entry.running && !entry.complete))
  {
    assert s.calls[j] in s.calls;
  }
}

lemma LockWaitingJoin(t: Reconciliations)
  requires forall j :: 0 <= j < |t.calls| ==> (t.calls[j].waiting >= 0 && (t.calls[j].waiting > 0 ==> (t.calls[j].phase.AcquiringRecords? && exists entry :: entry in t.queue.entries && entry.ticket == t.calls[j].waiting && entry.scope.owner == t.calls[j].adapter && entry.scope.provider == (if ((0 <= t.calls[j].position) && (t.calls[j].position < |t.calls[j].recordKeys|)) then t.calls[j].recordKeys[t.calls[j].position] else noKey).key && !entry.running && !entry.complete)))
  ensures alwaysWaitingTicketIsQueued(t)
{
  forall call | call in t.calls
    ensures call.waiting >= 0 && (call.waiting > 0 ==> (call.phase.AcquiringRecords? && exists entry :: entry in t.queue.entries && entry.ticket == call.waiting && entry.scope.owner == call.adapter && entry.scope.provider == (if ((0 <= call.position) && (call.position < |call.recordKeys|)) then call.recordKeys[call.position] else noKey).key && !entry.running && !entry.complete))
  {
    var j :| 0 <= j < |t.calls| && t.calls[j] == call;
  }
}

lemma admit_ensures(s: Reconciliations, id: int, adapter: string, recordKeys: seq<RecordKey>)
  ensures (inv(s) ==> canAdmit(s, id, recordKeys) ==> alwaysOneTimerPerAcquiredTicket(admit(s, id, adapter, recordKeys)))
  ensures (inv(s) ==> canAdmit(s, id, recordKeys) ==> alwaysTimersOwnTheirQueueTicket(admit(s, id, adapter, recordKeys)))
  ensures (inv(s) ==> canAdmit(s, id, recordKeys) ==> alwaysEachHeldTicketOwnsTimer(admit(s, id, adapter, recordKeys)))
  ensures (inv(s) ==> canAdmit(s, id, recordKeys) ==> alwaysCleanupOwnsSettledTicket(admit(s, id, adapter, recordKeys)))
  ensures (inv(s) ==> canAdmit(s, id, recordKeys) ==> alwaysQueueMutualExclusion(admit(s, id, adapter, recordKeys)))
  ensures (inv(s) ==> canAdmit(s, id, recordKeys) ==> alwaysCallIdentitiesUnique(admit(s, id, adapter, recordKeys)))
  ensures (inv(s) ==> canAdmit(s, id, recordKeys) ==> alwaysAcquisitionCursor(admit(s, id, adapter, recordKeys)))
  ensures (inv(s) ==> canAdmit(s, id, recordKeys) ==> alwaysCallbackOwnsEveryKey(admit(s, id, adapter, recordKeys)))
  ensures (inv(s) ==> canAdmit(s, id, recordKeys) ==> alwaysWaitingTicketIsQueued(admit(s, id, adapter, recordKeys)))
  ensures (inv(s) ==> canAdmit(s, id, recordKeys) ==> alwaysHeldTicketsAreRunning(admit(s, id, adapter, recordKeys)))
  ensures (inv(s) ==> canAdmit(s, id, recordKeys) ==> alwaysOneCallOwnsEachTicket(admit(s, id, adapter, recordKeys)))
  ensures (inv(s) ==> canAdmit(s, id, recordKeys) ==> alwaysWarnedTimersWereDue(admit(s, id, adapter, recordKeys)))
  ensures (inv(s) ==> canAdmit(s, id, recordKeys) ==> stepWarningRetainsAllLocks(s, "admit", admit(s, id, adapter, recordKeys)))
  ensures (inv(s) ==> canAdmit(s, id, recordKeys) ==> stepCleanupRetainsOtherTails(s, "admit", admit(s, id, adapter, recordKeys)))
{
  if inv(s) && canAdmit(s, id, recordKeys) {
    var after := admit(s, id, adapter, recordKeys);
    var row := after.calls[|after.calls| - 1];
    assert after.calls == s.calls + [row];
    LockCallIdsAppend(s, after, row);
    LockOwnsAppendIdle(s, after, row);
  }
}

lemma warn_ensures(s: Reconciliations, ticket: int, firedAt: int)
  ensures (inv(s) ==> canWarn(s, ticket, firedAt) ==> alwaysOneTimerPerAcquiredTicket(warn(s, ticket, firedAt)))
  ensures (inv(s) ==> canWarn(s, ticket, firedAt) ==> alwaysTimersOwnTheirQueueTicket(warn(s, ticket, firedAt)))
  ensures (inv(s) ==> canWarn(s, ticket, firedAt) ==> alwaysEachHeldTicketOwnsTimer(warn(s, ticket, firedAt)))
  ensures (inv(s) ==> canWarn(s, ticket, firedAt) ==> alwaysCleanupOwnsSettledTicket(warn(s, ticket, firedAt)))
  ensures (inv(s) ==> canWarn(s, ticket, firedAt) ==> alwaysQueueMutualExclusion(warn(s, ticket, firedAt)))
  ensures (inv(s) ==> canWarn(s, ticket, firedAt) ==> alwaysCallIdentitiesUnique(warn(s, ticket, firedAt)))
  ensures (inv(s) ==> canWarn(s, ticket, firedAt) ==> alwaysAcquisitionCursor(warn(s, ticket, firedAt)))
  ensures (inv(s) ==> canWarn(s, ticket, firedAt) ==> alwaysCallbackOwnsEveryKey(warn(s, ticket, firedAt)))
  ensures (inv(s) ==> canWarn(s, ticket, firedAt) ==> alwaysWaitingTicketIsQueued(warn(s, ticket, firedAt)))
  ensures (inv(s) ==> canWarn(s, ticket, firedAt) ==> alwaysHeldTicketsAreRunning(warn(s, ticket, firedAt)))
  ensures (inv(s) ==> canWarn(s, ticket, firedAt) ==> alwaysOneCallOwnsEachTicket(warn(s, ticket, firedAt)))
  ensures (inv(s) ==> canWarn(s, ticket, firedAt) ==> alwaysWarnedTimersWereDue(warn(s, ticket, firedAt)))
  ensures (inv(s) ==> canWarn(s, ticket, firedAt) ==> stepWarningRetainsAllLocks(s, "warn", warn(s, ticket, firedAt)))
  ensures (inv(s) ==> canWarn(s, ticket, firedAt) ==> stepCleanupRetainsOtherTails(s, "warn", warn(s, ticket, firedAt)))
{
  if inv(s) && canWarn(s, ticket, firedAt) {
    var after := warn(s, ticket, firedAt);
    LockWarnDue(s, after, ticket, firedAt);
    LockWarnShape(s, after, ticket, firedAt);
    LockTimersPointwise(s, after);
    LockSameCalls(s, after);
  }
}

lemma callbackReturns_ensures(s: Reconciliations, id: int, success: bool)
  ensures (inv(s) ==> canCallbackReturns(s, id) ==> alwaysOneTimerPerAcquiredTicket(callbackReturns(s, id, success)))
  ensures (inv(s) ==> canCallbackReturns(s, id) ==> alwaysTimersOwnTheirQueueTicket(callbackReturns(s, id, success)))
  ensures (inv(s) ==> canCallbackReturns(s, id) ==> alwaysEachHeldTicketOwnsTimer(callbackReturns(s, id, success)))
  ensures (inv(s) ==> canCallbackReturns(s, id) ==> alwaysCleanupOwnsSettledTicket(callbackReturns(s, id, success)))
  ensures (inv(s) ==> canCallbackReturns(s, id) ==> alwaysQueueMutualExclusion(callbackReturns(s, id, success)))
  ensures (inv(s) ==> canCallbackReturns(s, id) ==> alwaysCallIdentitiesUnique(callbackReturns(s, id, success)))
  ensures (inv(s) ==> canCallbackReturns(s, id) ==> alwaysAcquisitionCursor(callbackReturns(s, id, success)))
  ensures (inv(s) ==> canCallbackReturns(s, id) ==> alwaysCallbackOwnsEveryKey(callbackReturns(s, id, success)))
  ensures (inv(s) ==> canCallbackReturns(s, id) ==> alwaysWaitingTicketIsQueued(callbackReturns(s, id, success)))
  ensures (inv(s) ==> canCallbackReturns(s, id) ==> alwaysHeldTicketsAreRunning(callbackReturns(s, id, success)))
  ensures (inv(s) ==> canCallbackReturns(s, id) ==> alwaysOneCallOwnsEachTicket(callbackReturns(s, id, success)))
  ensures (inv(s) ==> canCallbackReturns(s, id) ==> alwaysWarnedTimersWereDue(callbackReturns(s, id, success)))
  ensures (inv(s) ==> canCallbackReturns(s, id) ==> stepWarningRetainsAllLocks(s, "callbackReturns", callbackReturns(s, id, success)))
  ensures (inv(s) ==> canCallbackReturns(s, id) ==> stepCleanupRetainsOtherTails(s, "callbackReturns", callbackReturns(s, id, success)))
{
  if inv(s) && canCallbackReturns(s, id) {
    var after := callbackReturns(s, id, success);
    LockCallAt(s, id);
    var i :| 0 <= i < |s.calls| && s.calls[i] == callAt(s, id) && s.calls[i].id == id && (forall j :: 0 <= j < |s.calls| && j != i ==> s.calls[j].id != id);
    LockCallback(s, after, i, success);
  }
}

lemma cleanupKey_ensures(s: Reconciliations, ticket: int)
  ensures (inv(s) ==> canCleanupKey(s, ticket) ==> alwaysOneTimerPerAcquiredTicket(cleanupKey(s, ticket)))
  ensures (inv(s) ==> canCleanupKey(s, ticket) ==> alwaysTimersOwnTheirQueueTicket(cleanupKey(s, ticket)))
  ensures (inv(s) ==> canCleanupKey(s, ticket) ==> alwaysEachHeldTicketOwnsTimer(cleanupKey(s, ticket)))
  ensures (inv(s) ==> canCleanupKey(s, ticket) ==> alwaysCleanupOwnsSettledTicket(cleanupKey(s, ticket)))
  ensures (inv(s) ==> canCleanupKey(s, ticket) ==> alwaysQueueMutualExclusion(cleanupKey(s, ticket)))
  ensures (inv(s) ==> canCleanupKey(s, ticket) ==> alwaysCallIdentitiesUnique(cleanupKey(s, ticket)))
  ensures (inv(s) ==> canCleanupKey(s, ticket) ==> alwaysAcquisitionCursor(cleanupKey(s, ticket)))
  ensures (inv(s) ==> canCleanupKey(s, ticket) ==> alwaysCallbackOwnsEveryKey(cleanupKey(s, ticket)))
  ensures (inv(s) ==> canCleanupKey(s, ticket) ==> alwaysWaitingTicketIsQueued(cleanupKey(s, ticket)))
  ensures (inv(s) ==> canCleanupKey(s, ticket) ==> alwaysHeldTicketsAreRunning(cleanupKey(s, ticket)))
  ensures (inv(s) ==> canCleanupKey(s, ticket) ==> alwaysOneCallOwnsEachTicket(cleanupKey(s, ticket)))
  ensures (inv(s) ==> canCleanupKey(s, ticket) ==> alwaysWarnedTimersWereDue(cleanupKey(s, ticket)))
  ensures (inv(s) ==> canCleanupKey(s, ticket) ==> stepWarningRetainsAllLocks(s, "cleanupKey", cleanupKey(s, ticket)))
  ensures (inv(s) ==> canCleanupKey(s, ticket) ==> stepCleanupRetainsOtherTails(s, "cleanupKey", cleanupKey(s, ticket)))
{
  if inv(s) && canCleanupKey(s, ticket) {
    var after := cleanupKey(s, ticket);
    LockCleanup(s, after, ticket);
    LockSameCalls(s, after);
  }
}

lemma enqueueKey_ensures(s: Reconciliations, id: int)
  ensures (inv(s) ==> canEnqueueKey(s, id) ==> alwaysOneTimerPerAcquiredTicket(enqueueKey(s, id)))
  ensures (inv(s) ==> canEnqueueKey(s, id) ==> alwaysTimersOwnTheirQueueTicket(enqueueKey(s, id)))
  ensures (inv(s) ==> canEnqueueKey(s, id) ==> alwaysEachHeldTicketOwnsTimer(enqueueKey(s, id)))
  ensures (inv(s) ==> canEnqueueKey(s, id) ==> alwaysCleanupOwnsSettledTicket(enqueueKey(s, id)))
  ensures (inv(s) ==> canEnqueueKey(s, id) ==> alwaysQueueMutualExclusion(enqueueKey(s, id)))
  ensures (inv(s) ==> canEnqueueKey(s, id) ==> alwaysCallIdentitiesUnique(enqueueKey(s, id)))
  ensures (inv(s) ==> canEnqueueKey(s, id) ==> alwaysAcquisitionCursor(enqueueKey(s, id)))
  ensures (inv(s) ==> canEnqueueKey(s, id) ==> alwaysCallbackOwnsEveryKey(enqueueKey(s, id)))
  ensures (inv(s) ==> canEnqueueKey(s, id) ==> alwaysWaitingTicketIsQueued(enqueueKey(s, id)))
  ensures (inv(s) ==> canEnqueueKey(s, id) ==> alwaysHeldTicketsAreRunning(enqueueKey(s, id)))
  ensures (inv(s) ==> canEnqueueKey(s, id) ==> alwaysOneCallOwnsEachTicket(enqueueKey(s, id)))
  ensures (inv(s) ==> canEnqueueKey(s, id) ==> alwaysWarnedTimersWereDue(enqueueKey(s, id)))
  ensures (inv(s) ==> canEnqueueKey(s, id) ==> stepWarningRetainsAllLocks(s, "enqueueKey", enqueueKey(s, id)))
  ensures (inv(s) ==> canEnqueueKey(s, id) ==> stepCleanupRetainsOtherTails(s, "enqueueKey", enqueueKey(s, id)))
{
  if inv(s) && canEnqueueKey(s, id) {
    var after := enqueueKey(s, id);
    LockCallAt(s, id);
    var i :| 0 <= i < |s.calls| && s.calls[i] == callAt(s, id) && s.calls[i].id == id && (forall j :: 0 <= j < |s.calls| && j != i ==> s.calls[j].id != id);
    var c := s.calls[i];
    var scope := core__connectorQueues_QueueScope(c.adapter, (if ((0 <= c.position) && (c.position < |c.recordKeys|)) then c.recordKeys[c.position] else noKey).key);
    LockEnqueueShape(s, after, i);
    LockBelowSerial(s);
    LockQueueTickets(s.queue);
    core__connectorQueues_admit_ensures(s.queue, scope);
    LockEnqueueOwns(s, after, i, s.queue.serial);
    LockCallIdsPointwise(s, after);
    LockTimerCallsPointwise(s, after);
    var e := core__connectorQueues_QueueEntry(scope, s.queue.serial, false, false, false);
    assert after.queue.entries == s.queue.entries + [e];
    LockEnqueueWaiting(s, after, i, e);
  }
}

lemma acquireKey_ensures(s: Reconciliations, id: int, armedAt: int)
  ensures (inv(s) ==> canAcquireKey(s, id) ==> alwaysOneTimerPerAcquiredTicket(acquireKey(s, id, armedAt)))
  ensures (inv(s) ==> canAcquireKey(s, id) ==> alwaysTimersOwnTheirQueueTicket(acquireKey(s, id, armedAt)))
  ensures (inv(s) ==> canAcquireKey(s, id) ==> alwaysEachHeldTicketOwnsTimer(acquireKey(s, id, armedAt)))
  ensures (inv(s) ==> canAcquireKey(s, id) ==> alwaysCleanupOwnsSettledTicket(acquireKey(s, id, armedAt)))
  ensures (inv(s) ==> canAcquireKey(s, id) ==> alwaysQueueMutualExclusion(acquireKey(s, id, armedAt)))
  ensures (inv(s) ==> canAcquireKey(s, id) ==> alwaysCallIdentitiesUnique(acquireKey(s, id, armedAt)))
  ensures (inv(s) ==> canAcquireKey(s, id) ==> alwaysAcquisitionCursor(acquireKey(s, id, armedAt)))
  ensures (inv(s) ==> canAcquireKey(s, id) ==> alwaysCallbackOwnsEveryKey(acquireKey(s, id, armedAt)))
  ensures (inv(s) ==> canAcquireKey(s, id) ==> alwaysWaitingTicketIsQueued(acquireKey(s, id, armedAt)))
  ensures (inv(s) ==> canAcquireKey(s, id) ==> alwaysHeldTicketsAreRunning(acquireKey(s, id, armedAt)))
  ensures (inv(s) ==> canAcquireKey(s, id) ==> alwaysOneCallOwnsEachTicket(acquireKey(s, id, armedAt)))
  ensures (inv(s) ==> canAcquireKey(s, id) ==> alwaysWarnedTimersWereDue(acquireKey(s, id, armedAt)))
  ensures (inv(s) ==> canAcquireKey(s, id) ==> stepWarningRetainsAllLocks(s, "acquireKey", acquireKey(s, id, armedAt)))
  ensures (inv(s) ==> canAcquireKey(s, id) ==> stepCleanupRetainsOtherTails(s, "acquireKey", acquireKey(s, id, armedAt)))
{
  if inv(s) && canAcquireKey(s, id) {
    var after := acquireKey(s, id, armedAt);
    LockCallAt(s, id);
    var i :| 0 <= i < |s.calls| && s.calls[i] == callAt(s, id) && s.calls[i].id == id && (forall j :: 0 <= j < |s.calls| && j != i ==> s.calls[j].id != id);
    var c := s.calls[i];
    var key := (if ((0 <= c.position) && (c.position < |c.recordKeys|)) then c.recordKeys[c.position] else noKey);
    var d := c.(held := (c.held + [c.waiting]), waiting := 0, position := (c.position + 1), phase := (if ((c.position + 1) == |c.recordKeys|) then ReconcilePhase.ExecutingRecords else ReconcilePhase.AcquiringRecords));
    var nt := WarningTimer(c.waiting, c.id, c.adapter, key.key, armedAt, false, false, 0);
    LockAcquireShape(s, after, i, armedAt);
    assert c in s.calls;
    var e :| e in s.queue.entries && e.ticket == c.waiting && e.scope.owner == c.adapter && e.scope.provider == key.key && !e.running && !e.complete;
    LockNoTimerForWaiting(s, e);
    core__connectorQueues_begin_ensures(s.queue, c.waiting);
    LockAcquireCalls(s, after, i, d);
    LockAcquireTimers(s, after, i, d, nt);
    LockAcquireQueue(s, after, i, d, nt, e);
  }
}

lemma releaseKey_ensures(s: Reconciliations, id: int)
  ensures (inv(s) ==> canReleaseKey(s, id) ==> alwaysOneTimerPerAcquiredTicket(releaseKey(s, id)))
  ensures (inv(s) ==> canReleaseKey(s, id) ==> alwaysTimersOwnTheirQueueTicket(releaseKey(s, id)))
  ensures (inv(s) ==> canReleaseKey(s, id) ==> alwaysEachHeldTicketOwnsTimer(releaseKey(s, id)))
  ensures (inv(s) ==> canReleaseKey(s, id) ==> alwaysCleanupOwnsSettledTicket(releaseKey(s, id)))
  ensures (inv(s) ==> canReleaseKey(s, id) ==> alwaysQueueMutualExclusion(releaseKey(s, id)))
  ensures (inv(s) ==> canReleaseKey(s, id) ==> alwaysCallIdentitiesUnique(releaseKey(s, id)))
  ensures (inv(s) ==> canReleaseKey(s, id) ==> alwaysAcquisitionCursor(releaseKey(s, id)))
  ensures (inv(s) ==> canReleaseKey(s, id) ==> alwaysCallbackOwnsEveryKey(releaseKey(s, id)))
  ensures (inv(s) ==> canReleaseKey(s, id) ==> alwaysWaitingTicketIsQueued(releaseKey(s, id)))
  ensures (inv(s) ==> canReleaseKey(s, id) ==> alwaysHeldTicketsAreRunning(releaseKey(s, id)))
  ensures (inv(s) ==> canReleaseKey(s, id) ==> alwaysOneCallOwnsEachTicket(releaseKey(s, id)))
  ensures (inv(s) ==> canReleaseKey(s, id) ==> alwaysWarnedTimersWereDue(releaseKey(s, id)))
  ensures (inv(s) ==> canReleaseKey(s, id) ==> stepWarningRetainsAllLocks(s, "releaseKey", releaseKey(s, id)))
  ensures (inv(s) ==> canReleaseKey(s, id) ==> stepCleanupRetainsOtherTails(s, "releaseKey", releaseKey(s, id)))
{
  if inv(s) && canReleaseKey(s, id) {
    var after := releaseKey(s, id);
    LockCallAt(s, id);
    var i :| 0 <= i < |s.calls| && s.calls[i] == callAt(s, id) && s.calls[i].id == id && (forall j :: 0 <= j < |s.calls| && j != i ==> s.calls[j].id != id);
    var c := s.calls[i];
    var r := c.held[|c.held| - 1];
    var d := c.(held := ProofLib.Filter((value: int) => (value != r), c.held), phase := (if (|c.held| == 1) then ReconcilePhase.Reconciled else ReconcilePhase.ReleasingRecords));
    LockReleaseShape(s, after, i, r);
    assert c in s.calls && r in c.held;
    var er :| er in s.queue.entries && er.ticket == r && er.running;
    core__connectorQueues_finish_ensures(s.queue, r, !(c.failed));
    LockReleaseCalls(s, after, i, d, r);
    LockReleaseOthers(s, i, r);
    LockReleaseTimers(s, after, i, d, r);
    LockReleaseQueue(s, after, i, d, r, er);
    LockWaitingJoin(after);
  }
}
