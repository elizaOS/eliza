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
    WarningFrame(s, ticket, firedAt);
    WarningPreservesCallState(s, ticket, firedAt);
    WarningKeepsHeldTimer(s, ticket, firedAt);
    WarningKeepsQueueOwners(s, ticket, firedAt);
    WarningKeepsTimerOwners(s, ticket, firedAt);
    WarningIsDue(s, ticket, firedAt);
    assert alwaysCleanupOwnsSettledTicket(s);
    assert alwaysQueueMutualExclusion(s);
    assert alwaysCallbackOwnsEveryKey(s);
    WarningKeepsQueuedTickets(s, ticket, firedAt);
    assert alwaysHeldTicketsAreRunning(s);
    assert stepCleanupRetainsOtherTails(s, "warn", after);
  }
}

lemma WarningKeepsQueuedTickets(s: Reconciliations, ticket: int, firedAt: int)
  requires alwaysWaitingTicketIsQueued(s)
  ensures alwaysWaitingTicketIsQueued(warn(s, ticket, firedAt))
{
  WarningFrame(s, ticket, firedAt);
}

lemma WarningFrame(s: Reconciliations, ticket: int, firedAt: int)
  ensures warn(s, ticket, firedAt).calls == s.calls
  ensures warn(s, ticket, firedAt).queue == s.queue
  ensures warn(s, ticket, firedAt).cleanupPending == s.cleanupPending
{
  reveal warn();
}

lemma WarningPreservesCallState(s: Reconciliations, ticket: int, firedAt: int)
  requires inv(s)
  ensures alwaysCallIdentitiesUnique(warn(s, ticket, firedAt))
  ensures alwaysAcquisitionCursor(warn(s, ticket, firedAt))
  ensures alwaysOneCallOwnsEachTicket(warn(s, ticket, firedAt))
  ensures stepWarningRetainsAllLocks(s, "warn", warn(s, ticket, firedAt))
{
  WarningFrame(s, ticket, firedAt);
  assert alwaysCallIdentitiesUnique(s);
  assert alwaysAcquisitionCursor(s);
  assert alwaysOneCallOwnsEachTicket(s);
}

lemma WarningKeepsHeldTimer(s: Reconciliations, ticket: int, firedAt: int)
  requires alwaysEachHeldTicketOwnsTimer(s)
  ensures alwaysEachHeldTicketOwnsTimer(warn(s, ticket, firedAt))
{
  var after := warn(s, ticket, firedAt);
  WarningFrame(s, ticket, firedAt);
  reveal warn();
  assert |after.timers| == |s.timers|;
  forall call | call in after.calls
    ensures forall held :: held in call.held ==> (exists timer :: timer in after.timers && timer.ticket == held && timer.callId == call.id && timer.adapter == call.adapter && !timer.cleared)
  {
    assert call in s.calls;
    forall held | held in call.held
      ensures (exists timer :: timer in after.timers && timer.ticket == held && timer.callId == call.id && timer.adapter == call.adapter && !timer.cleared)
    {
      var earlier :| earlier in s.timers && earlier.ticket == held && earlier.callId == call.id
        && earlier.adapter == call.adapter && !earlier.cleared;
      var i :| 0 <= i < |s.timers| && s.timers[i] == earlier;
      var updated := after.timers[i];
      assert updated in after.timers && updated.ticket == held && updated.callId == call.id && updated.adapter == call.adapter && !updated.cleared;
    }
  }
}

lemma WarningTimerFields(s: Reconciliations, ticket: int, firedAt: int)
  ensures |warn(s, ticket, firedAt).timers| == |s.timers|
  ensures forall i :: 0 <= i < |s.timers| ==> warn(s, ticket, firedAt).timers[i] == (if s.timers[i].ticket == ticket then s.timers[i].(fired := true, firedAt := firedAt) else s.timers[i])
{
  reveal warn();
}

lemma WarningKeepsQueueOwners(s: Reconciliations, ticket: int, firedAt: int)
  requires alwaysTimersOwnTheirQueueTicket(s)
  ensures alwaysTimersOwnTheirQueueTicket(warn(s, ticket, firedAt))
{
  var after := warn(s, ticket, firedAt);
  WarningFrame(s, ticket, firedAt);
  WarningTimerFields(s, ticket, firedAt);
  forall updated | updated in after.timers
    ensures exists entry :: entry in after.queue.entries && entry.ticket == updated.ticket && entry.scope.owner == updated.adapter && entry.scope.provider == updated.recordKey && entry.running == !updated.cleared && entry.complete == updated.cleared
  {
    var i :| 0 <= i < |after.timers| && after.timers[i] == updated;
    var previousTimer := s.timers[i];
    assert previousTimer in s.timers;
    assert updated.ticket == previousTimer.ticket && updated.adapter == previousTimer.adapter
      && updated.recordKey == previousTimer.recordKey && updated.cleared == previousTimer.cleared;
  }
}

lemma WarningKeepsTimerOwners(s: Reconciliations, ticket: int, firedAt: int)
  requires alwaysOneTimerPerAcquiredTicket(s)
  ensures alwaysOneTimerPerAcquiredTicket(warn(s, ticket, firedAt))
{
  var after := warn(s, ticket, firedAt);
  WarningFrame(s, ticket, firedAt);
  WarningTimerFields(s, ticket, firedAt);
  reveal ProofLib.Filter();
  forall updated | updated in after.timers
    ensures |ProofLib.Filter((other: WarningTimer) => other.ticket == updated.ticket, after.timers)| == 1
    ensures !updated.cleared ==> (exists call :: call in after.calls && call.id == updated.callId && call.adapter == updated.adapter && updated.ticket in call.held)
  {
    var i :| 0 <= i < |after.timers| && after.timers[i] == updated;
    var previousTimer := s.timers[i];
    assert previousTimer in s.timers;
    assert updated.ticket == previousTimer.ticket && updated.callId == previousTimer.callId
      && updated.adapter == previousTimer.adapter && updated.cleared == previousTimer.cleared;
    var sameTicket := (other: WarningTimer) => other.ticket == updated.ticket;
    ProofLib.FilterLengthPointwise(sameTicket, sameTicket, s.timers, after.timers);
  }
}

lemma WarningIsDue(s: Reconciliations, ticket: int, firedAt: int)
  requires canWarn(s, ticket, firedAt)
  requires alwaysOneTimerPerAcquiredTicket(s)
  requires alwaysWarnedTimersWereDue(s)
  ensures alwaysWarnedTimersWereDue(warn(s, ticket, firedAt))
{
  var after := warn(s, ticket, firedAt);
  WarningTimerFields(s, ticket, firedAt);
  var qualifying :| qualifying in s.timers && qualifying.ticket == ticket
    && !qualifying.cleared && !qualifying.fired && firedAt - qualifying.armedAt >= warningDelay;
  var index :| 0 <= index < |s.timers| && s.timers[index] == qualifying;
  var sameTicket := (timer: WarningTimer) => timer.ticket == ticket;
  ProofLib.FilterCountOneIffUnique(sameTicket, s.timers, (timer: WarningTimer) => timer.ticket, index);
  assert |Std.Collections.Seq.Filter(sameTicket, s.timers)| == 1;
  forall updated | updated in after.timers && updated.fired
    ensures updated.firedAt - updated.armedAt >= warningDelay
  {
    var i :| 0 <= i < |after.timers| && after.timers[i] == updated;
    var previousTimer := s.timers[i];
    if previousTimer.ticket == ticket {
      assert i == index;
      assert updated.firedAt == firedAt && updated.armedAt == qualifying.armedAt;
    } else {
      assert previousTimer in s.timers;
      assert updated == previousTimer;
    }
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
    CleanupRetainsCallState(s, ticket);
    CleanupKeepsOtherTails(s, ticket);
  }
}

lemma CleanupFrame(s: Reconciliations, ticket: int)
  ensures cleanupKey(s, ticket).calls == s.calls
  ensures cleanupKey(s, ticket).timers == s.timers
{
  reveal cleanupKey();
}

lemma CleanupRetainsCallState(s: Reconciliations, ticket: int)
  requires inv(s)
  ensures alwaysOneCallOwnsEachTicket(cleanupKey(s, ticket))
  ensures alwaysOneTimerPerAcquiredTicket(cleanupKey(s, ticket))
{
  var after := cleanupKey(s, ticket);
  CleanupFrame(s, ticket);
  CleanupPreservesOwners(s, after);
  CleanupPreservesTimers(s, after);
}

lemma CleanupPreservesOwners(before: Reconciliations, after: Reconciliations)
  requires before.calls == after.calls
  requires alwaysOneCallOwnsEachTicket(before)
  ensures alwaysOneCallOwnsEachTicket(after)
{
  reveal alwaysOneCallOwnsEachTicket();
}

lemma CleanupPreservesTimers(before: Reconciliations, after: Reconciliations)
  requires before.calls == after.calls
  requires before.timers == after.timers
  requires alwaysOneTimerPerAcquiredTicket(before)
  ensures alwaysOneTimerPerAcquiredTicket(after)
{
  reveal alwaysOneTimerPerAcquiredTicket();
}

lemma CleanupKeepsOtherTails(s: Reconciliations, ticket: int)
  requires canCleanupKey(s, ticket)
  requires alwaysCleanupOwnsSettledTicket(s)
  ensures alwaysCleanupOwnsSettledTicket(cleanupKey(s, ticket))
  ensures stepCleanupRetainsOtherTails(s, "cleanupKey", cleanupKey(s, ticket))
{
  var after := cleanupKey(s, ticket);
  reveal cleanupKey(), core__connectorQueues_cleanup();
  assert after.queue.entries == s.queue.entries;
  var pending := (set_x: int) => !(set_x in [ticket]);
  forall other | other in after.cleanupPending
    ensures core__connectorQueues_canCleanup(after.queue, other)
  {
    ProofLib.FilterMember(pending, s.cleanupPending, other);
    assert other in s.cleanupPending;
    assert core__connectorQueues_canCleanup(s.queue, other);
  }
  forall tail | tail in s.queue.tails
    ensures tail in after.queue.tails ||
      (tail.ticket in s.cleanupPending && tail.ticket !in after.cleanupPending)
  {
    if tail.ticket == ticket {
      ProofLib.FilterMember(pending, s.cleanupPending, ticket);
    } else {
      ProofLib.FilterMember((queuedTail: core__connectorQueues_QueueTail) => queuedTail.ticket != ticket, s.queue.tails, tail);
    }
  }
}
