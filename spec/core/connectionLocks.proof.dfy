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
    AdmittedCallFrame(s, id, adapter, recordKeys);
    AdmitKeepsCallIdentities(s, id, adapter, recordKeys);
    AdmitKeepsTimerOwners(s, id, adapter, recordKeys);
    AdmitKeepsExclusiveTickets(s, id, adapter, recordKeys);
  }
}

lemma AdmittedCallFrame(s: Reconciliations, id: int, adapter: string, recordKeys: seq<RecordKey>)
  ensures var after := admit(s, id, adapter, recordKeys);
    |after.calls| == |s.calls| + 1 &&
    (var added := after.calls[|s.calls|];
      after.calls == s.calls + [added] && added.id == id && added.waiting == 0 && added.held == [])
{
  reveal admit();
}

lemma AdmitKeepsCallIdentities(s: Reconciliations, id: int, adapter: string, recordKeys: seq<RecordKey>)
  requires canAdmit(s, id, recordKeys)
  requires alwaysCallIdentitiesUnique(s)
  ensures alwaysCallIdentitiesUnique(admit(s, id, adapter, recordKeys))
{
  var after := admit(s, id, adapter, recordKeys);
  AdmittedCallFrame(s, id, adapter, recordKeys);
  var added := after.calls[|s.calls|];
  reveal canAdmit(), ProofLib.Filter();
  forall call | call in after.calls
    ensures call.id > 0 &&
      |ProofLib.Filter((other: Reconciliation) => other.id == call.id, after.calls)| == 1
  {
    var matches := (other: Reconciliation) => other.id == call.id;
    ProofLib.FilterAppend(matches, s.calls, added);
    if call == added {
      ProofLib.FilterNone(matches, s.calls);
    } else {
      assert call in s.calls;
      assert call.id != added.id;
      assert |Std.Collections.Seq.Filter(matches, s.calls)| == 1;
    }
  }
}

lemma AdmitKeepsExclusiveTickets(s: Reconciliations, id: int, adapter: string, recordKeys: seq<RecordKey>)
  requires canAdmit(s, id, recordKeys)
  requires alwaysOneCallOwnsEachTicket(s)
  ensures alwaysOneCallOwnsEachTicket(admit(s, id, adapter, recordKeys))
{
  var after := admit(s, id, adapter, recordKeys);
  AdmittedCallFrame(s, id, adapter, recordKeys);
  var added := after.calls[|s.calls|];
  forall call | call in after.calls
    ensures forall ticket | ticket in call.held ::
      ticket > 0 && ticket != call.waiting &&
      |Std.Collections.Seq.Filter((other: int) => other == ticket, call.held)| == 1
    ensures forall other | other in after.calls ::
      other.id == call.id ||
      ((call.waiting == 0 || (other.waiting != call.waiting && call.waiting !in other.held)) &&
      (forall ticket | ticket in call.held :: other.waiting != ticket && ticket !in other.held))
  {
    if call != added {
      assert call in s.calls;
      forall other | other in after.calls && other.id != call.id
        ensures (call.waiting == 0 || (other.waiting != call.waiting && call.waiting !in other.held)) &&
          (forall ticket | ticket in call.held :: other.waiting != ticket && ticket !in other.held)
      {
        if other != added {
          assert other in s.calls;
        } else {
          forall ticket | ticket in call.held
            ensures ticket > 0
          {
          }
        }
      }
    }
  }
}

lemma AdmitKeepsTimerOwners(s: Reconciliations, id: int, adapter: string, recordKeys: seq<RecordKey>)
  requires alwaysOneTimerPerAcquiredTicket(s)
  ensures alwaysOneTimerPerAcquiredTicket(admit(s, id, adapter, recordKeys))
{
  var after := admit(s, id, adapter, recordKeys);
  AdmittedCallFrame(s, id, adapter, recordKeys);
  reveal admit();
  assert after.timers == s.timers;
  forall timer | timer in after.timers
    ensures |Std.Collections.Seq.Filter((other: WarningTimer) => other.ticket == timer.ticket, after.timers)| == 1
    ensures !timer.cleared ==> (exists call ::
      call in after.calls && call.id == timer.callId && call.adapter == timer.adapter && timer.ticket in call.held)
  {
    assert timer in s.timers;
    if !timer.cleared {
      var call :| call in s.calls && call.id == timer.callId && call.adapter == timer.adapter && timer.ticket in call.held;
      assert call in after.calls;
    }
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
    CallbackFrame(s, id, success);
    CallbackKeepsCallIdentities(s, id, success);
    CallbackKeepsWaitingTickets(s, id, success);
    CallbackKeepsTimerOwners(s, id, success);
    CallbackKeepsExclusiveTickets(s, id, success);
  }
}

lemma CallbackFrame(s: Reconciliations, id: int, success: bool)
  ensures callbackReturns(s, id, success).timers == s.timers
  ensures callbackReturns(s, id, success).queue == s.queue
  ensures callbackReturns(s, id, success).cleanupPending == s.cleanupPending
  ensures |callbackReturns(s, id, success).calls| == |s.calls|
  ensures forall i | 0 <= i < |s.calls| ::
    var returned := callbackReturns(s, id, success).calls[i];
    var original := s.calls[i];
    returned.id == original.id && returned.adapter == original.adapter &&
    returned.waiting == original.waiting && returned.held == original.held &&
    (original.id != id ==> returned == original)
{
  reveal callbackReturns();
}

lemma CallbackSelectedCall(s: Reconciliations, id: int)
  requires canCallbackReturns(s, id)
  requires alwaysCallIdentitiesUnique(s)
  ensures callAt(s, id) in s.calls
  ensures forall call | call in s.calls && call.id == id :: call == callAt(s, id)
{
  reveal callAt(), canCallbackReturns(), ProofLib.Filter();
  var sameId := (call: Reconciliation) => (call.id == id);
  var matching := ProofLib.Filter((call: Reconciliation) => (call.id == id), s.calls);
  var selected := callAt(s, id);
  assert selected.phase.ExecutingRecords?;
  assert !noCall.phase.ExecutingRecords?;
  assert |matching| > 0 && selected == matching[0];
  ProofLib.FilterMember(sameId, s.calls, selected);
  assert selected in s.calls && selected.id == id;
  assert |Std.Collections.Seq.Filter((other: Reconciliation) => other.id == selected.id, s.calls)| == 1;
  assert |matching| == 1;
  forall call | call in s.calls && call.id == id
    ensures call == selected
  {
    ProofLib.FilterMember(sameId, s.calls, call);
    assert call in matching;
  }
}

lemma CallbackKeepsCallIdentities(s: Reconciliations, id: int, success: bool)
  requires alwaysCallIdentitiesUnique(s)
  ensures alwaysCallIdentitiesUnique(callbackReturns(s, id, success))
{
  var after := callbackReturns(s, id, success);
  CallbackFrame(s, id, success);
  reveal ProofLib.Filter();
  forall returned | returned in after.calls
    ensures returned.id > 0 &&
      |ProofLib.Filter((other: Reconciliation) => other.id == returned.id, after.calls)| == 1
  {
    var i :| 0 <= i < |after.calls| && after.calls[i] == returned;
    var original := s.calls[i];
    assert original.id == returned.id;
    var sameId := (other: Reconciliation) => other.id == returned.id;
    ProofLib.FilterLengthPointwise(sameId, sameId, s.calls, after.calls);
    assert original in s.calls;
    assert |Std.Collections.Seq.Filter(sameId, s.calls)| == 1;
  }
}

lemma CallbackKeepsWaitingTickets(s: Reconciliations, id: int, success: bool)
  requires canCallbackReturns(s, id)
  requires alwaysCallIdentitiesUnique(s)
  requires alwaysWaitingTicketIsQueued(s)
  ensures alwaysWaitingTicketIsQueued(callbackReturns(s, id, success))
{
  var after := callbackReturns(s, id, success);
  CallbackFrame(s, id, success);
  CallbackSelectedCall(s, id);
  assert callAt(s, id).phase.ExecutingRecords?;
  assert callAt(s, id).waiting == 0;
  forall returned | returned in after.calls
    ensures returned.waiting >= 0 && (returned.waiting > 0 ==>
      returned.phase.AcquiringRecords? &&
      (exists entry :: entry in after.queue.entries && entry.ticket == returned.waiting &&
        entry.scope.owner == returned.adapter &&
        entry.scope.provider == (if 0 <= returned.position < |returned.recordKeys| then returned.recordKeys[returned.position] else noKey).key &&
        !entry.running && !entry.complete))
  {
    var i :| 0 <= i < |after.calls| && after.calls[i] == returned;
    var original := s.calls[i];
    assert original in s.calls;
    if original.id == id {
      assert original == callAt(s, id);
    } else {
      assert original == returned;
    }
  }
}

lemma CallbackKeepsTimerOwners(s: Reconciliations, id: int, success: bool)
  requires alwaysOneTimerPerAcquiredTicket(s)
  ensures alwaysOneTimerPerAcquiredTicket(callbackReturns(s, id, success))
{
  var after := callbackReturns(s, id, success);
  CallbackFrame(s, id, success);
  forall timer | timer in after.timers
    ensures |Std.Collections.Seq.Filter((other: WarningTimer) => other.ticket == timer.ticket, after.timers)| == 1 &&
      (!timer.cleared ==> (exists call ::
        call in after.calls && call.id == timer.callId && call.adapter == timer.adapter && timer.ticket in call.held))
  {
    assert timer in s.timers;
    if !timer.cleared {
      var original :| original in s.calls && original.id == timer.callId &&
        original.adapter == timer.adapter && timer.ticket in original.held;
      var i :| 0 <= i < |s.calls| && s.calls[i] == original;
      assert after.calls[i] in after.calls;
    }
  }
}

lemma CallbackKeepsExclusiveTickets(s: Reconciliations, id: int, success: bool)
  requires alwaysOneCallOwnsEachTicket(s)
  ensures alwaysOneCallOwnsEachTicket(callbackReturns(s, id, success))
{
  var after := callbackReturns(s, id, success);
  CallbackFrame(s, id, success);
  forall call | call in after.calls
    ensures forall ticket | ticket in call.held ::
      ticket > 0 && ticket != call.waiting &&
      |Std.Collections.Seq.Filter((other: int) => other == ticket, call.held)| == 1
    ensures forall other | other in after.calls ::
      other.id == call.id ||
      ((call.waiting == 0 || (other.waiting != call.waiting && call.waiting !in other.held)) &&
      (forall ticket | ticket in call.held :: other.waiting != ticket && ticket !in other.held))
  {
    var i :| 0 <= i < |after.calls| && after.calls[i] == call;
    var original := s.calls[i];
    assert original in s.calls;
    assert original.held == call.held && original.waiting == call.waiting && original.id == call.id;
    forall other | other in after.calls && other.id != call.id
      ensures (call.waiting == 0 || (other.waiting != call.waiting && call.waiting !in other.held)) &&
        (forall ticket | ticket in call.held :: other.waiting != ticket && ticket !in other.held)
    {
      var j :| 0 <= j < |after.calls| && after.calls[j] == other;
      var previous := s.calls[j];
      assert previous in s.calls;
      assert previous.id != original.id;
      forall ticket | ticket in call.held
        ensures other.waiting != ticket && ticket !in other.held
      {
        CallbackOtherTicket(s, original, previous, ticket);
      }
    }
  }
}

lemma CallbackOtherTicket(s: Reconciliations, call: Reconciliation, other: Reconciliation, ticket: int)
  requires alwaysOneCallOwnsEachTicket(s)
  requires call in s.calls && other in s.calls && other.id != call.id
  requires ticket in call.held
  ensures other.waiting != ticket && ticket !in other.held
{
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
    var call := callAt(s, id);
    var key := if 0 <= call.position < |call.recordKeys| then call.recordKeys[call.position] else noKey;
    QueuedKeyFrame(s, id);
    core__connectorQueues_admit_ensures(s.queue, core__connectorQueues_QueueScope(call.adapter, key.key));
    EnqueuePreservesCallIdentities(s, id);
    EnqueuePreservesTimerOwners(s, id);
    EnqueuePreservesWaitingTickets(s, id);
    EnqueuePreservesExclusiveTickets(s, id);
  }
}

lemma QueuedKeyCallLookup(s: Reconciliations, id: int)
  requires canEnqueueKey(s, id)
  requires alwaysCallIdentitiesUnique(s)
  ensures callAt(s, id) in s.calls
  ensures forall call | call in s.calls && call.id == id :: call == callAt(s, id)
{
  reveal callAt(), canEnqueueKey(), ProofLib.Filter();
  var sameId := (call: Reconciliation) => (call.id == id);
  var matching := ProofLib.Filter((call: Reconciliation) => (call.id == id), s.calls);
  var selected := callAt(s, id);
  assert selected.phase.AcquiringRecords?;
  assert !noCall.phase.AcquiringRecords?;
  assert |matching| > 0 && selected == matching[0];
  ProofLib.FilterMember(sameId, s.calls, selected);
  assert selected in s.calls && selected.id == id;
  assert |Std.Collections.Seq.Filter((other: Reconciliation) => other.id == selected.id, s.calls)| == 1;
  assert |matching| == 1;
  forall call | call in s.calls && call.id == id
    ensures call == selected
  {
    ProofLib.FilterMember(sameId, s.calls, call);
    assert call in matching;
  }
}

lemma QueuedKeyFrame(s: Reconciliations, id: int)
  ensures enqueueKey(s, id).timers == s.timers
  ensures enqueueKey(s, id).cleanupPending == s.cleanupPending
  ensures |enqueueKey(s, id).calls| == |s.calls|
  ensures var call := callAt(s, id);
    var key := if 0 <= call.position < |call.recordKeys| then call.recordKeys[call.position] else noKey;
    enqueueKey(s, id).queue == core__connectorQueues_admit(s.queue, core__connectorQueues_QueueScope(call.adapter, key.key))
  ensures forall i | 0 <= i < |s.calls| ::
    enqueueKey(s, id).calls[i] ==
      (if s.calls[i].id == id then s.calls[i].(waiting := s.queue.serial) else s.calls[i])
{
  reveal enqueueKey();
}

lemma ExistingCallTicketsPrecedeNext(s: Reconciliations)
  requires alwaysQueueMutualExclusion(s) && alwaysWaitingTicketIsQueued(s) && alwaysHeldTicketsAreRunning(s)
  ensures s.queue.serial > 0
  ensures forall call | call in s.calls :: call.waiting < s.queue.serial
  ensures forall call | call in s.calls :: forall ticket | ticket in call.held :: ticket < s.queue.serial
{
  forall call | call in s.calls
    ensures call.waiting < s.queue.serial
    ensures forall ticket | ticket in call.held :: ticket < s.queue.serial
  {
    if call.waiting > 0 {
      var entry :| entry in s.queue.entries && entry.ticket == call.waiting;
      assert entry.ticket < s.queue.serial;
    }
    forall ticket | ticket in call.held
      ensures ticket < s.queue.serial
    {
      var entry :| entry in s.queue.entries && entry.ticket == ticket && entry.running;
      assert entry.ticket < s.queue.serial;
    }
  }
}

lemma EnqueuePreservesCallIdentities(s: Reconciliations, id: int)
  requires alwaysCallIdentitiesUnique(s)
  ensures alwaysCallIdentitiesUnique(enqueueKey(s, id))
{
  var after := enqueueKey(s, id);
  QueuedKeyFrame(s, id);
  reveal ProofLib.Filter();
  forall call | call in after.calls
    ensures call.id > 0 && |ProofLib.Filter((other: Reconciliation) => other.id == call.id, after.calls)| == 1
  {
    var i :| 0 <= i < |after.calls| && after.calls[i] == call;
    var prior := s.calls[i];
    assert prior in s.calls && prior.id == call.id;
    var sameId := (other: Reconciliation) => other.id == call.id;
    ProofLib.FilterLengthPointwise(sameId, sameId, s.calls, after.calls);
  }
}

lemma EnqueuePreservesTimerOwners(s: Reconciliations, id: int)
  requires alwaysOneTimerPerAcquiredTicket(s)
  ensures alwaysOneTimerPerAcquiredTicket(enqueueKey(s, id))
{
  var after := enqueueKey(s, id);
  QueuedKeyFrame(s, id);
  forall timer | timer in after.timers
    ensures |Std.Collections.Seq.Filter((other: WarningTimer) => other.ticket == timer.ticket, after.timers)| == 1
    ensures !timer.cleared ==> (exists call ::
      call in after.calls && call.id == timer.callId && call.adapter == timer.adapter && timer.ticket in call.held)
  {
    assert timer in s.timers;
    if !timer.cleared {
      var prior :| prior in s.calls && prior.id == timer.callId &&
        prior.adapter == timer.adapter && timer.ticket in prior.held;
      var i :| 0 <= i < |s.calls| && s.calls[i] == prior;
      assert after.calls[i] in after.calls;
    }
  }
}

lemma EnqueuePreservesWaitingTickets(s: Reconciliations, id: int)
  requires canEnqueueKey(s, id)
  requires alwaysCallIdentitiesUnique(s) && alwaysQueueMutualExclusion(s) && alwaysWaitingTicketIsQueued(s)
  ensures alwaysWaitingTicketIsQueued(enqueueKey(s, id))
{
  var after := enqueueKey(s, id);
  QueuedKeyFrame(s, id);
  QueuedKeyCallLookup(s, id);
  reveal canEnqueueKey(), core__connectorQueues_admit();
  var selected := callAt(s, id);
  var record := if 0 <= selected.position < |selected.recordKeys| then selected.recordKeys[selected.position] else noKey;
  var added := core__connectorQueues_QueueEntry(core__connectorQueues_QueueScope(selected.adapter, record.key),
    s.queue.serial, false, false, false);
  assert after.queue.entries == s.queue.entries + [added];
  forall call | call in after.calls
    ensures call.waiting >= 0 &&
      (call.waiting > 0 ==> call.phase.AcquiringRecords? && (exists entry ::
        entry in after.queue.entries && entry.ticket == call.waiting && entry.scope.owner == call.adapter &&
        entry.scope.provider == (if 0 <= call.position < |call.recordKeys| then call.recordKeys[call.position] else noKey).key &&
        !entry.running && !entry.complete))
  {
    var i :| 0 <= i < |after.calls| && after.calls[i] == call;
    var prior := s.calls[i];
    assert prior in s.calls;
    if prior.id == id {
      assert prior == selected;
      assert added in after.queue.entries;
    } else if call.waiting > 0 {
      var entry :| entry in s.queue.entries && entry.ticket == prior.waiting && entry.scope.owner == prior.adapter &&
        entry.scope.provider == (if 0 <= prior.position < |prior.recordKeys| then prior.recordKeys[prior.position] else noKey).key &&
        !entry.running && !entry.complete;
      assert entry in after.queue.entries;
    }
  }
}

lemma EnqueuePreservesExclusiveTickets(s: Reconciliations, id: int)
  requires inv(s)
  ensures alwaysOneCallOwnsEachTicket(enqueueKey(s, id))
{
  reveal alwaysOneCallOwnsEachTicket();
  var after := enqueueKey(s, id);
  QueuedKeyFrame(s, id);
  forall call | call in after.calls
    ensures forall ticket | ticket in call.held ::
      ticket > 0 && ticket != call.waiting &&
      |Std.Collections.Seq.Filter((other: int) => other == ticket, call.held)| == 1
    ensures forall other | other in after.calls ::
      other.id == call.id ||
      ((call.waiting == 0 || (other.waiting != call.waiting && call.waiting !in other.held)) &&
      (forall ticket | ticket in call.held :: other.waiting != ticket && ticket !in other.held))
  {
    var i :| 0 <= i < |after.calls| && after.calls[i] == call;
    EnqueueKeepsLocalTickets(s, id, i);
    EnqueueKeepsOtherCallTickets(s, id, i);
  }
}

lemma EnqueueKeepsLocalTickets(s: Reconciliations, id: int, i: int)
  requires alwaysOneCallOwnsEachTicket(s) && alwaysQueueMutualExclusion(s)
  requires alwaysWaitingTicketIsQueued(s) && alwaysHeldTicketsAreRunning(s)
  requires 0 <= i < |s.calls|
  ensures var call := enqueueKey(s, id).calls[i];
    forall ticket | ticket in call.held ::
      ticket > 0 && ticket != call.waiting &&
      |Std.Collections.Seq.Filter((other: int) => other == ticket, call.held)| == 1
{
  QueuedKeyFrame(s, id);
  ExistingCallTicketsPrecedeNext(s);
  var prior := s.calls[i];
  var call := enqueueKey(s, id).calls[i];
  assert prior in s.calls && prior.held == call.held;
  forall ticket | ticket in call.held
    ensures ticket > 0 && ticket != call.waiting &&
      |Std.Collections.Seq.Filter((other: int) => other == ticket, call.held)| == 1
  {
    assert ticket in prior.held;
    if prior.id == id {
      assert ticket < s.queue.serial && call.waiting == s.queue.serial;
    } else {
      assert call.waiting == prior.waiting;
    }
  }
}

lemma EnqueueKeepsOtherCallTickets(s: Reconciliations, id: int, i: int)
  requires inv(s) && 0 <= i < |s.calls|
  ensures var after := enqueueKey(s, id);
    var call := after.calls[i];
    forall other | other in after.calls && other.id != call.id ::
      (call.waiting == 0 || (other.waiting != call.waiting && call.waiting !in other.held)) &&
      (forall ticket | ticket in call.held :: other.waiting != ticket && ticket !in other.held)
{
  QueuedKeyFrame(s, id);
  var after := enqueueKey(s, id);
  var call := after.calls[i];
  forall other | other in after.calls && other.id != call.id
    ensures (call.waiting == 0 || (other.waiting != call.waiting && call.waiting !in other.held)) &&
      (forall ticket | ticket in call.held :: other.waiting != ticket && ticket !in other.held)
  {
    var j :| 0 <= j < |after.calls| && after.calls[j] == other;
    assert s.calls[i].id == call.id && s.calls[j].id == other.id;
    EnqueueKeepsTicketPair(s, id, i, j);
  }
}

lemma EnqueueKeepsTicketPair(s: Reconciliations, id: int, i: int, j: int)
  requires inv(s)
  requires 0 <= i < |s.calls| && 0 <= j < |s.calls|
  requires s.calls[i].id != s.calls[j].id
  ensures var call := enqueueKey(s, id).calls[i];
    var other := enqueueKey(s, id).calls[j];
    (call.waiting == 0 || (other.waiting != call.waiting && call.waiting !in other.held)) &&
    (forall ticket | ticket in call.held :: other.waiting != ticket && ticket !in other.held)
{
  var after := enqueueKey(s, id);
  var prior := s.calls[i];
  var peer := s.calls[j];
  QueuedKeyFrame(s, id);
  ExistingCallTicketsPrecedeNext(s);
  var call := after.calls[i];
  var other := after.calls[j];
  assert prior in s.calls && peer in s.calls && call.held == prior.held && other.held == peer.held;
  if prior.id == id {
    assert call.waiting == s.queue.serial && other.waiting == peer.waiting;
    assert other.waiting < s.queue.serial && s.queue.serial !in other.held;
  } else {
    assert call.waiting == prior.waiting;
    if peer.id == id {
      assert other.waiting == s.queue.serial && prior.waiting < s.queue.serial;
    }
  }
  forall ticket | ticket in call.held
    ensures other.waiting != ticket && ticket !in other.held
  {
    assert ticket in prior.held;
    CallbackOtherTicket(s, prior, peer, ticket);
    if peer.id == id {
      assert ticket < s.queue.serial && other.waiting == s.queue.serial;
    } else {
      assert other.waiting == peer.waiting;
    }
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
    AcquireKeepsTimerQueueOwners(s, id, armedAt);
    AcquireKeepsOneTimerPerTicket(s, id, armedAt);
    AcquireKeepsHeldTicketTimers(s, id, armedAt);
    AcquireKeepsQueueInvariants(s, id, armedAt);
    AcquireKeepsHeldEntriesRunning(s, id, armedAt);
    AcquireKeepsOtherWaitingEntries(s, id, armedAt);
    AcquireKeepsCallIdentities(s, id, armedAt);
    AcquireKeepsCallProgress(s, id, armedAt);
    AcquireKeepsExclusiveTicketCustody(s, id, armedAt);
  }
}
lemma AcquiringCallLookup(s: Reconciliations, id: int)
  requires alwaysCallIdentitiesUnique(s) && canAcquireKey(s, id)
  ensures callAt(s, id) in s.calls && callAt(s, id).id == id
  ensures forall call | call in s.calls && call.id == id :: call == callAt(s, id)
{
  reveal canAcquireKey(), callAt();
  var sameId := (call: Reconciliation) => call.id == id;
  var matches := ProofLib.Filter(sameId, s.calls);
  var selected := callAt(s, id);
  assert selected.waiting > 0 && noCall.waiting == 0;
  assert |matches| > 0 && matches[0] == selected;
  ProofLib.FilterMember(sameId, s.calls, selected);
  assert |matches| == 1;
  forall call | call in s.calls && call.id == id
    ensures call == selected
  {
    ProofLib.FilterMember(sameId, s.calls, call);
    assert call in matches;
  }
}

lemma QueueEntryTicketIdentifies(s: core__connectorQueues_ConnectorQueues,
                                left: core__connectorQueues_QueueEntry,
                                right: core__connectorQueues_QueueEntry)
  requires core__connectorQueues_alwaysAllocatedTickets(s)
  requires left in s.entries && right in s.entries && left.ticket == right.ticket
  ensures left == right
{
  var sameTicket := (entry: core__connectorQueues_QueueEntry) => entry.ticket == left.ticket;
  var matches := ProofLib.Filter(sameTicket, s.entries);
  ProofLib.FilterMember(sameTicket, s.entries, left);
  ProofLib.FilterMember(sameTicket, s.entries, right);
  assert |matches| == 1 && matches[0] == left && matches[0] == right;
}

lemma AcquireStartsUntimedTicket(s: Reconciliations, id: int)
  requires inv(s) && canAcquireKey(s, id)
  ensures var call := callAt(s, id);
    0 < call.waiting && 0 <= call.position < |call.recordKeys| &&
    (exists entry :: entry in s.queue.entries && entry.ticket == call.waiting && !entry.running &&
      !entry.complete && entry.scope.owner == call.adapter && entry.scope.provider == call.recordKeys[call.position].key) &&
    (forall timer | timer in s.timers :: timer.ticket != call.waiting) &&
    (forall ticket | ticket in s.cleanupPending :: ticket != call.waiting)
{
  AcquiringCallLookup(s, id);
  reveal canAcquireKey();
  var call := callAt(s, id);
  assert 0 <= call.position < |call.recordKeys|;
  var entry :| entry in s.queue.entries && entry.ticket == call.waiting && !entry.running &&
    !entry.complete && entry.scope.owner == call.adapter && entry.scope.provider == call.recordKeys[call.position].key;
  forall timer | timer in s.timers
    ensures timer.ticket != call.waiting
  {
    if timer.ticket == call.waiting {
      var timerEntry :| timerEntry in s.queue.entries && timerEntry.ticket == timer.ticket &&
        timerEntry.running == !timer.cleared && timerEntry.complete == timer.cleared &&
        timerEntry.scope.owner == timer.adapter && timerEntry.scope.provider == timer.recordKey;
      QueueEntryTicketIdentifies(s.queue, entry, timerEntry);
    }
  }
  forall ticket | ticket in s.cleanupPending
    ensures ticket != call.waiting
  {
    if ticket == call.waiting {
      var settled :| settled in s.queue.entries && settled.ticket == ticket && settled.complete;
      QueueEntryTicketIdentifies(s.queue, entry, settled);
    }
  }
}

lemma AcquireKeyFrame(s: Reconciliations, id: int, armedAt: int)
  requires inv(s) && canAcquireKey(s, id)
  ensures var after := acquireKey(s, id, armedAt);
    var call := callAt(s, id);
    0 <= call.position < |call.recordKeys| &&
    after.cleanupPending == s.cleanupPending &&
    after.queue == core__connectorQueues_begin(s.queue, call.waiting) &&
    after.timers == s.timers + [WarningTimer(call.waiting, id, call.adapter, call.recordKeys[call.position].key, armedAt, false, false, 0)] &&
    |after.calls| == |s.calls| && |after.queue.entries| == |s.queue.entries| &&
    (forall i | 0 <= i < |s.calls| ::
      var prior := s.calls[i];
      after.calls[i] ==
        (if prior.id == id then call.(held := call.held + [call.waiting], waiting := 0,
          position := call.position + 1, phase := if call.position + 1 == |call.recordKeys|
              then ReconcilePhase.ExecutingRecords else ReconcilePhase.AcquiringRecords)
         else prior)) &&
    (forall j | 0 <= j < |s.queue.entries| ::
      var prior := s.queue.entries[j];
      after.queue.entries[j] == (if prior.ticket == call.waiting then prior.(running := true) else prior))
{
  AcquiringCallLookup(s, id);
  reveal canAcquireKey(), acquireKey(), core__connectorQueues_begin();
  var after := acquireKey(s, id, armedAt);
  forall i | 0 <= i < |s.calls|
    ensures var prior := s.calls[i];
      var call := callAt(s, id);
      after.calls[i] ==
        (if prior.id == id then call.(held := call.held + [call.waiting], waiting := 0,
          position := call.position + 1, phase := if call.position + 1 == |call.recordKeys|
              then ReconcilePhase.ExecutingRecords else ReconcilePhase.AcquiringRecords)
         else prior)
  {
    assert s.calls[i] in s.calls;
  }
}

lemma StartedQueueEntry(s: Reconciliations, id: int, entry: core__connectorQueues_QueueEntry, armedAt: int)
  requires inv(s) && canAcquireKey(s, id) && entry in s.queue.entries
  ensures var started := (if entry.ticket == callAt(s, id).waiting then entry.(running := true) else entry);
    started in acquireKey(s, id, armedAt).queue.entries
{
  AcquireKeyFrame(s, id, armedAt);
  var k :| 0 <= k < |s.queue.entries| && s.queue.entries[k] == entry;
  assert acquireKey(s, id, armedAt).queue.entries[k] in acquireKey(s, id, armedAt).queue.entries;
}

lemma AcquiredCallEntry(s: Reconciliations, id: int, prior: Reconciliation, armedAt: int)
  requires inv(s) && canAcquireKey(s, id) && prior in s.calls
  ensures var after := acquireKey(s, id, armedAt);
    exists next :: next in after.calls && next.id == prior.id && next.adapter == prior.adapter &&
      next.held == (if prior.id == id then prior.held + [prior.waiting] else prior.held)
{
  AcquireKeyFrame(s, id, armedAt);
  var i :| 0 <= i < |s.calls| && s.calls[i] == prior;
  assert acquireKey(s, id, armedAt).calls[i] in acquireKey(s, id, armedAt).calls;
}

lemma AcquireKeepsTimerQueueOwners(s: Reconciliations, id: int, armedAt: int)
  requires inv(s) && canAcquireKey(s, id)
  ensures alwaysTimersOwnTheirQueueTicket(acquireKey(s, id, armedAt))
{
  AcquireKeyFrame(s, id, armedAt);
  AcquireStartsUntimedTicket(s, id);
  var call := callAt(s, id);
  var after := acquireKey(s, id, armedAt);
  var armed := after.timers[|s.timers|];
  forall timer | timer in after.timers
    ensures (
      exists entry ::
        entry in after.queue.entries && entry.ticket == timer.ticket &&
        entry.scope.owner == timer.adapter && entry.scope.provider == timer.recordKey &&
        entry.running == !timer.cleared && entry.complete == timer.cleared
    )
  {
    if timer == armed {
      var prior :| prior in s.queue.entries && prior.ticket == call.waiting && !prior.running &&
        !prior.complete && prior.scope.owner == call.adapter &&
        prior.scope.provider == call.recordKeys[call.position].key;
      StartedQueueEntry(s, id, prior, armedAt);
    } else {
      assert timer in s.timers;
      var prior :| prior in s.queue.entries && prior.ticket == timer.ticket &&
        prior.scope.owner == timer.adapter && prior.scope.provider == timer.recordKey &&
        prior.running == !timer.cleared && prior.complete == timer.cleared;
      assert prior.ticket != call.waiting;
      StartedQueueEntry(s, id, prior, armedAt);
    }
  }
}

lemma AcquireKeepsOneTimerPerTicket(s: Reconciliations, id: int, armedAt: int)
  requires inv(s) && canAcquireKey(s, id)
  ensures alwaysOneTimerPerAcquiredTicket(acquireKey(s, id, armedAt))
{
  AcquiringCallLookup(s, id);
  AcquireKeyFrame(s, id, armedAt);
  AcquireStartsUntimedTicket(s, id);
  var call := callAt(s, id);
  var after := acquireKey(s, id, armedAt);
  var armed := after.timers[|s.timers|];
  assert after.timers == s.timers + [armed];
  forall timer | timer in after.timers
    ensures |ProofLib.Filter((other: WarningTimer) => other.ticket == timer.ticket, after.timers)| == 1
    ensures !timer.cleared ==> (
      exists owner ::
        owner in after.calls && owner.id == timer.callId &&
        owner.adapter == timer.adapter && timer.ticket in owner.held
    )
  {
    var sameTicket := (other: WarningTimer) => other.ticket == timer.ticket;
    ProofLib.FilterAppend(sameTicket, s.timers, armed);
    if timer == armed {
      ProofLib.FilterNone(sameTicket, s.timers);
      AcquiredCallEntry(s, id, call, armedAt);
    } else {
      assert timer in s.timers && timer.ticket != armed.ticket;
      if !timer.cleared {
        var prior :| prior in s.calls && prior.id == timer.callId &&
          prior.adapter == timer.adapter && timer.ticket in prior.held;
        AcquiredCallEntry(s, id, prior, armedAt);
      }
    }
  }
}

lemma AcquireKeepsHeldTicketTimers(s: Reconciliations, id: int, armedAt: int)
  requires inv(s) && canAcquireKey(s, id)
  ensures alwaysEachHeldTicketOwnsTimer(acquireKey(s, id, armedAt))
{
  AcquireKeyFrame(s, id, armedAt);
  AcquiringCallLookup(s, id);
  var after := acquireKey(s, id, armedAt);
  var armed := after.timers[|s.timers|];
  assert armed in after.timers;
  forall call | call in after.calls
    ensures forall ticket | ticket in call.held ::
      exists timer :: timer in after.timers && timer.ticket == ticket && timer.callId == call.id &&
        timer.adapter == call.adapter && !timer.cleared
  {
    var i :| 0 <= i < |after.calls| && after.calls[i] == call;
    var prior := s.calls[i];
    assert prior in s.calls && prior.id == call.id && prior.adapter == call.adapter;
    forall ticket | ticket in call.held
      ensures (
        exists timer ::
          timer in after.timers && timer.ticket == ticket && timer.callId == call.id &&
          timer.adapter == call.adapter && !timer.cleared
      )
    {
      if ticket in prior.held {
        var timer :| timer in s.timers && timer.ticket == ticket && timer.callId == prior.id &&
          timer.adapter == prior.adapter && !timer.cleared;
        assert timer in after.timers;
      } else {
        assert prior.id == id && ticket == prior.waiting;
      }
    }
  }
}

lemma AcquireKeepsQueueInvariants(s: Reconciliations, id: int, armedAt: int)
  requires inv(s) && canAcquireKey(s, id)
  ensures alwaysQueueMutualExclusion(acquireKey(s, id, armedAt))
  ensures alwaysCleanupOwnsSettledTicket(acquireKey(s, id, armedAt))
{
  reveal canAcquireKey();
  var after := acquireKey(s, id, armedAt);
  var acquired := callAt(s, id).waiting;
  AcquireKeyFrame(s, id, armedAt);
  AcquireStartsUntimedTicket(s, id);
  core__connectorQueues_begin_ensures(s.queue, acquired);
  forall ticket | ticket in after.cleanupPending
    ensures core__connectorQueues_canCleanup(after.queue, ticket)
  {
    assert ticket in s.cleanupPending && ticket != acquired;
    var settled :| settled in s.queue.entries && settled.ticket == ticket && settled.complete;
    StartedQueueEntry(s, id, settled, armedAt);
  }
}

lemma AcquireKeepsHeldEntriesRunning(s: Reconciliations, id: int, armedAt: int)
  requires inv(s) && canAcquireKey(s, id)
  ensures alwaysHeldTicketsAreRunning(acquireKey(s, id, armedAt))
{
  AcquireKeyFrame(s, id, armedAt);
  AcquiringCallLookup(s, id);
  AcquireStartsUntimedTicket(s, id);
  var after := acquireKey(s, id, armedAt);
  var selected := callAt(s, id);
  forall call | call in after.calls
    ensures forall ticket | ticket in call.held ::
      (exists entry :: entry in after.queue.entries && entry.ticket == ticket && entry.running)
  {
    var i :| 0 <= i < |after.calls| && after.calls[i] == call;
    var prior := s.calls[i];
    assert prior in s.calls;
    forall ticket | ticket in call.held
      ensures (exists entry :: entry in after.queue.entries && entry.ticket == ticket && entry.running)
    {
      if ticket in prior.held {
        var previous :| previous in s.queue.entries && previous.ticket == ticket && previous.running;
        StartedQueueEntry(s, id, previous, armedAt);
      } else {
        assert prior.id == id && selected == prior && selected.waiting == ticket;
        var previous :| previous in s.queue.entries && previous.ticket == ticket &&
          !previous.running && !previous.complete && previous.scope.owner == selected.adapter &&
          previous.scope.provider == selected.recordKeys[selected.position].key;
        StartedQueueEntry(s, id, previous, armedAt);
      }
    }
  }
}

lemma AcquireKeepsOtherWaitingEntries(s: Reconciliations, id: int, armedAt: int)
  requires inv(s) && canAcquireKey(s, id)
  ensures alwaysWaitingTicketIsQueued(acquireKey(s, id, armedAt))
{
  AcquireKeyFrame(s, id, armedAt);
  AcquiringCallLookup(s, id);
  var after := acquireKey(s, id, armedAt);
  var selected := callAt(s, id);
  forall call | call in after.calls
    ensures call.waiting >= 0
    ensures call.waiting > 0 ==> (
      call.phase.AcquiringRecords? &&
      (exists entry :: entry in after.queue.entries && entry.ticket == call.waiting &&
        entry.scope.owner == call.adapter && !entry.running && !entry.complete &&
        entry.scope.provider == (if 0 <= call.position < |call.recordKeys|
          then call.recordKeys[call.position] else noKey).key)
    )
  {
    var i :| 0 <= i < |after.calls| && after.calls[i] == call;
    var prior := s.calls[i];
    assert prior in s.calls;
    if prior.id != id && call.waiting > 0 {
      assert call == prior;
      assert selected in s.calls && selected.id == id && selected.waiting != call.waiting;
      var record := if 0 <= call.position < |call.recordKeys| then call.recordKeys[call.position] else noKey;
      var queued :| queued in s.queue.entries && queued.ticket == call.waiting &&
        queued.scope.owner == call.adapter && queued.scope.provider == record.key &&
        !queued.running && !queued.complete;
      assert queued.ticket != selected.waiting;
      StartedQueueEntry(s, id, queued, armedAt);
    }
  }
}

lemma AcquireKeepsCallIdentities(s: Reconciliations, id: int, armedAt: int)
  requires inv(s) && canAcquireKey(s, id)
  ensures alwaysCallIdentitiesUnique(acquireKey(s, id, armedAt))
{
  AcquireKeyFrame(s, id, armedAt);
  var after := acquireKey(s, id, armedAt);
  forall call | call in after.calls
    ensures call.id > 0 && |ProofLib.Filter((row: Reconciliation) => row.id == call.id, after.calls)| == 1
  {
    var i :| 0 <= i < |after.calls| && after.calls[i] == call;
    assert s.calls[i] in s.calls;
    var byId := (row: Reconciliation) => row.id == call.id;
    ProofLib.FilterLengthPointwise(byId, byId, s.calls, after.calls);
  }
}

lemma AcquireKeepsCallProgress(s: Reconciliations, id: int, armedAt: int)
  requires inv(s) && canAcquireKey(s, id)
  ensures alwaysAcquisitionCursor(acquireKey(s, id, armedAt))
  ensures alwaysCallbackOwnsEveryKey(acquireKey(s, id, armedAt))
{
  reveal canAcquireKey();
  AcquireKeyFrame(s, id, armedAt);
  AcquiringCallLookup(s, id);
  var after := acquireKey(s, id, armedAt);
  var selected := callAt(s, id);
  assert selected in s.calls && selected.phase.AcquiringRecords?;
  forall call | call in after.calls
    ensures 0 <= call.position <= |call.recordKeys|
    ensures call.phase.AcquiringRecords? ==> call.position < |call.recordKeys|
    ensures call.phase.AcquiringRecords? || call.phase.ExecutingRecords? ==> |call.held| == call.position
    ensures call.phase.ExecutingRecords? ==> |call.held| == |call.recordKeys|
  {
    var i :| 0 <= i < |after.calls| && after.calls[i] == call;
    var prior := s.calls[i];
    assert prior in s.calls;
    if prior.id == id {
      assert prior == selected && |prior.held| == prior.position && prior.position < |prior.recordKeys|;
    } else {
      assert call == prior;
    }
  }
}

lemma AcquireMovesWaitingTicketOnlyOnce(s: Reconciliations, id: int, armedAt: int, i: int)
  requires inv(s) && canAcquireKey(s, id)
  requires 0 <= i < |s.calls|
  ensures var call := acquireKey(s, id, armedAt).calls[i];
    forall ticket | ticket in call.held ::
      ticket > 0 && ticket != call.waiting &&
      |ProofLib.Filter((other: int) => other == ticket, call.held)| == 1
{
  reveal canAcquireKey();
  AcquireKeyFrame(s, id, armedAt);
  AcquiringCallLookup(s, id);
  var prior := s.calls[i];
  var call := acquireKey(s, id, armedAt).calls[i];
  assert prior in s.calls;
  if prior.id == id {
    assert prior == callAt(s, id) && prior.waiting > 0;
    assert prior.waiting !in prior.held;
    forall ticket | ticket in call.held
      ensures ticket > 0 && ticket != call.waiting &&
        |ProofLib.Filter((other: int) => other == ticket, call.held)| == 1
    {
      var sameTicket := (other: int) => other == ticket;
      ProofLib.FilterAppend(sameTicket, prior.held, prior.waiting);
      if ticket == prior.waiting {
        ProofLib.FilterNone(sameTicket, prior.held);
      } else {
        assert ticket in prior.held;
      }
    }
  }
}

lemma AcquireOtherCallKeepsItsTickets(s: Reconciliations, id: int, armedAt: int, i: int, j: int)
  requires inv(s) && canAcquireKey(s, id)
  requires 0 <= i < |s.calls| && 0 <= j < |s.calls|
  requires s.calls[i].id != s.calls[j].id
  ensures var after := acquireKey(s, id, armedAt);
    var call := after.calls[i];
    var other := after.calls[j];
    (call.waiting == 0 || (other.waiting != call.waiting && call.waiting !in other.held)) &&
    (forall ticket | ticket in call.held :: other.waiting != ticket && ticket !in other.held)
{
  reveal canAcquireKey();
  AcquireKeyFrame(s, id, armedAt);
  AcquiringCallLookup(s, id);
  var after := acquireKey(s, id, armedAt);
  var prior := s.calls[i];
  var peer := s.calls[j];
  var call := after.calls[i];
  var other := after.calls[j];
  assert prior in s.calls && peer in s.calls;
  if call.waiting > 0 {
    assert call == prior;
    assert prior.waiting != peer.waiting && prior.waiting !in peer.held;
  }
  forall ticket | ticket in call.held
    ensures other.waiting != ticket && ticket !in other.held
  {
    if ticket in prior.held {
      CallbackOtherTicket(s, prior, peer, ticket);
      assert ticket > 0;
    } else {
      assert prior.id == id && prior == callAt(s, id) && prior.waiting == ticket && ticket > 0;
      assert peer.waiting != ticket && ticket !in peer.held;
    }
  }
}

lemma ConnectionTicketCustodyByIndex(s: Reconciliations)
  requires forall i | 0 <= i < |s.calls| ::
    var call := s.calls[i];
    forall ticket | ticket in call.held ::
      ticket > 0 && ticket != call.waiting &&
      |ProofLib.Filter((other: int) => other == ticket, call.held)| == 1
  requires forall i, j | 0 <= i < |s.calls| && 0 <= j < |s.calls| && s.calls[i].id != s.calls[j].id ::
    var call := s.calls[i];
    var peer := s.calls[j];
    (call.waiting == 0 || (peer.waiting != call.waiting && call.waiting !in peer.held)) &&
    (forall ticket | ticket in call.held :: peer.waiting != ticket && ticket !in peer.held)
  ensures alwaysOneCallOwnsEachTicket(s)
{
  reveal alwaysOneCallOwnsEachTicket();
  forall call | call in s.calls
    ensures forall ticket | ticket in call.held ::
      ticket > 0 && ticket != call.waiting &&
      |ProofLib.Filter((other: int) => other == ticket, call.held)| == 1
  {
    var i :| 0 <= i < |s.calls| && s.calls[i] == call;
  }
  forall call, peer | call in s.calls && peer in s.calls && call.id != peer.id
    ensures (call.waiting == 0 || (peer.waiting != call.waiting && call.waiting !in peer.held)) &&
      (forall ticket | ticket in call.held :: peer.waiting != ticket && ticket !in peer.held)
  {
    var i :| 0 <= i < |s.calls| && s.calls[i] == call;
    var j :| 0 <= j < |s.calls| && s.calls[j] == peer;
  }
}

lemma AcquireKeepsExclusiveTicketCustody(s: Reconciliations, id: int, armedAt: int)
  requires inv(s) && canAcquireKey(s, id)
  ensures alwaysOneCallOwnsEachTicket(acquireKey(s, id, armedAt))
{
  AcquireKeyFrame(s, id, armedAt);
  var after := acquireKey(s, id, armedAt);
  forall i | 0 <= i < |after.calls|
    ensures var call := after.calls[i];
      forall ticket | ticket in call.held ::
        ticket > 0 && ticket != call.waiting &&
        |ProofLib.Filter((other: int) => other == ticket, call.held)| == 1
  {
    AcquireMovesWaitingTicketOnlyOnce(s, id, armedAt, i);
  }
  forall i, j | 0 <= i < |after.calls| && 0 <= j < |after.calls| && after.calls[i].id != after.calls[j].id
    ensures var call := after.calls[i];
      var peer := after.calls[j];
      (call.waiting == 0 || (peer.waiting != call.waiting && call.waiting !in peer.held)) &&
      (forall ticket | ticket in call.held :: peer.waiting != ticket && ticket !in peer.held)
  {
    assert s.calls[i].id == after.calls[i].id && s.calls[j].id == after.calls[j].id;
    AcquireOtherCallKeepsItsTickets(s, id, armedAt, i, j);
  }
  ConnectionTicketCustodyByIndex(after);
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
    ReleaseKeepsQueueAndCleanupCustody(s, id);
    ReleaseKeepsTimerQueueOwners(s, id);
    ReleaseKeepsHeldEntriesRunning(s, id);
    ReleaseKeepsOtherWaitingEntries(s, id);
    ReleaseKeepsRemainingTimerOwners(s, id);
    ReleaseKeepsOtherHeldTimers(s, id);
    ReleaseKeepsCallIdentities(s, id);
    ReleaseKeepsExclusiveTickets(s, id);
  }
}
lemma ReleasingCallLookup(s: Reconciliations, id: int)
  requires alwaysCallIdentitiesUnique(s) && canReleaseKey(s, id)
  ensures var selected := callAt(s, id);
    selected in s.calls && selected.id == id && selected.phase.ReleasingRecords? && |selected.held| > 0
  ensures forall call | call in s.calls && call.id == id :: call == callAt(s, id)
{
  reveal canReleaseKey(), callAt();
  var sameId := (call: Reconciliation) => call.id == id;
  var matches := ProofLib.Filter(sameId, s.calls);
  var selected := callAt(s, id);
  assert noCall.held == [] && |matches| > 0 && matches[0] == selected;
  ProofLib.FilterMember(sameId, s.calls, selected);
  assert |matches| == 1;
  forall call | call in s.calls && call.id == id
    ensures call == selected
  {
    ProofLib.FilterMember(sameId, s.calls, call);
    assert call in matches;
  }
}

lemma ReleasingTicketHasLiveOwners(s: Reconciliations, id: int)
  requires inv(s) && canReleaseKey(s, id)
  ensures var call := callAt(s, id);
    var ticket := call.held[|call.held|-1];
    0 < |call.held| && 0 < ticket && ticket in call.held &&
    core__connectorQueues_canFinish(s.queue, ticket) &&
    (exists timer :: timer in s.timers && timer.ticket == ticket && !timer.cleared && timer.callId == id && timer.adapter == call.adapter)
{
  ReleasingCallLookup(s, id);
  var call := callAt(s, id);
  var ticket := call.held[|call.held|-1];
  assert ticket in call.held;
  var entry :| entry in s.queue.entries && entry.ticket == ticket && entry.running;
  assert !entry.complete;
}

lemma ReleaseKeyFrame(s: Reconciliations, id: int)
  requires inv(s) && canReleaseKey(s, id)
  ensures var after := releaseKey(s, id);
    var call := callAt(s, id);
    0 < |call.held| &&
    (var ticket := call.held[|call.held|-1];
      after.queue == core__connectorQueues_finish(s.queue, ticket, !call.failed) &&
      |after.calls| == |s.calls| && |after.queue.entries| == |s.queue.entries| && |after.timers| == |s.timers| &&
      (forall i | 0 <= i < |s.calls| ::
        var prior := s.calls[i];
        after.calls[i] == (
          if prior.id != id then prior
          else prior.(held := ProofLib.Filter((number: int) => number != ticket, prior.held),
            phase := if |prior.held| == 1 then ReconcilePhase.Reconciled else ReconcilePhase.ReleasingRecords)
        )) &&
      (forall j | 0 <= j < |s.queue.entries| ::
        var prior := s.queue.entries[j];
        after.queue.entries[j] == (
          if prior.ticket != ticket then prior
          else prior.(running := false, complete := true, failed := call.failed)
        )) &&
      (forall k | 0 <= k < |s.timers| ::
        var prior := s.timers[k];
        after.timers[k] == (if prior.ticket != ticket then prior else prior.(cleared := true))) &&
      (forall number :: number in after.cleanupPending <==> number in s.cleanupPending || number == ticket))
{
  ReleasingCallLookup(s, id);
  reveal releaseKey(), core__connectorQueues_finish();
  var after := releaseKey(s, id);
  var call := callAt(s, id);
  var ticket := call.held[|call.held|-1];
  var add := (number: int) => number !in s.cleanupPending;
  var appended := ProofLib.Filter(add, [ticket]);
  assert after.cleanupPending == s.cleanupPending + appended;
  forall number: int
    ensures number in after.cleanupPending <==> number in s.cleanupPending || number == ticket
  {
    ProofLib.FilterMember(add, [ticket], number);
    assert number in appended <==> number == ticket && add(number);
  }
}

lemma ReleaseRetainsFilteredTicket(held: seq<int>, released: int, ticket: int)
  requires ticket != released
  ensures ticket in ProofLib.Filter((number: int) => number != released, held) <==> ticket in held
  ensures |ProofLib.Filter((other: int) => other == ticket,
      ProofLib.Filter((number: int) => number != released, held))| ==
    |ProofLib.Filter((other: int) => other == ticket, held)|
  decreases |held|
{
  var keep := (number: int) => number != released;
  var lookup := (other: int) => other == ticket;
  ProofLib.FilterMember(keep, held, ticket);
  if |held| == 0 {
    ProofLib.FilterNil(keep, held);
    ProofLib.FilterNil(lookup, held);
  } else {
    ProofLib.FilterCons(keep, held);
    ProofLib.FilterCons(lookup, held);
    var tail := held[1..];
    var retained := ProofLib.Filter(keep, held);
    var retainedTail := ProofLib.Filter(keep, tail);
    ReleaseRetainsFilteredTicket(tail, released, ticket);
    if keep(held[0]) {
      assert retained == [held[0]] + retainedTail && retained[0] == held[0];
      ProofLib.FilterCons(lookup, retained);
      assert retained[1..] == retainedTail;
    } else {
      assert held[0] == released && !lookup(held[0]);
      assert retained == retainedTail;
    }
  }
}

lemma ReleaseQueueEntryRemains(s: Reconciliations, id: int, prior: core__connectorQueues_QueueEntry)
  requires inv(s) && canReleaseKey(s, id) && prior in s.queue.entries
  ensures var call := callAt(s, id);
    var ticket := call.held[|call.held|-1];
    var next := if prior.ticket == ticket then prior.(running := false, complete := true, failed := call.failed) else prior;
    next in releaseKey(s, id).queue.entries
{
  ReleaseKeyFrame(s, id);
  var i :| 0 <= i < |s.queue.entries| && s.queue.entries[i] == prior;
  assert releaseKey(s, id).queue.entries[i] in releaseKey(s, id).queue.entries;
}

lemma ReleaseKeepsQueueAndCleanupCustody(s: Reconciliations, id: int)
  requires inv(s) && canReleaseKey(s, id)
  ensures alwaysQueueMutualExclusion(releaseKey(s, id))
  ensures alwaysCleanupOwnsSettledTicket(releaseKey(s, id))
{
  var call := callAt(s, id);
  var ticket := call.held[|call.held|-1];
  var after := releaseKey(s, id);
  ReleaseKeyFrame(s, id);
  ReleasingTicketHasLiveOwners(s, id);
  core__connectorQueues_finish_ensures(s.queue, ticket, !call.failed);
  forall pending | pending in after.cleanupPending
    ensures core__connectorQueues_canCleanup(after.queue, pending)
  {
    if pending == ticket {
      var prior :| prior in s.queue.entries && prior.ticket == ticket && prior.running && !prior.complete;
      ReleaseQueueEntryRemains(s, id, prior);
    } else {
      assert pending in s.cleanupPending;
      var prior :| prior in s.queue.entries && prior.ticket == pending && prior.complete;
      ReleaseQueueEntryRemains(s, id, prior);
    }
  }
}

lemma ReleaseKeepsTimerQueueOwners(s: Reconciliations, id: int)
  requires inv(s) && canReleaseKey(s, id)
  ensures alwaysTimersOwnTheirQueueTicket(releaseKey(s, id))
{
  var call := callAt(s, id);
  var ticket := call.held[|call.held|-1];
  var after := releaseKey(s, id);
  ReleaseKeyFrame(s, id);
  forall timer | timer in after.timers
    ensures (
      exists entry ::
        entry in after.queue.entries && entry.ticket == timer.ticket &&
        entry.scope.owner == timer.adapter && entry.scope.provider == timer.recordKey &&
        entry.running == !timer.cleared && entry.complete == timer.cleared
    )
  {
    var k :| 0 <= k < |after.timers| && after.timers[k] == timer;
    var prior := s.timers[k];
    assert prior in s.timers && prior.ticket == timer.ticket;
    var entry :| entry in s.queue.entries && entry.ticket == prior.ticket &&
      entry.scope.owner == prior.adapter && entry.scope.provider == prior.recordKey &&
      entry.running == !prior.cleared && entry.complete == prior.cleared;
    ReleaseQueueEntryRemains(s, id, entry);
    if prior.ticket == ticket {
      assert timer.cleared;
    } else {
      assert timer == prior;
    }
  }
}

lemma ReleaseOtherCallsCannotHoldReleasedTicket(s: Reconciliations, id: int, other: Reconciliation)
  requires inv(s) && canReleaseKey(s, id)
  requires other in s.calls && other.id != id
  ensures var selected := callAt(s, id);
    var ticket := selected.held[|selected.held|-1];
    other.waiting != ticket && ticket !in other.held
{
  ReleasingCallLookup(s, id);
  var selected := callAt(s, id);
  var ticket := selected.held[|selected.held|-1];
  assert ticket in selected.held;
  CallbackOtherTicket(s, selected, other, ticket);
}

lemma ReleaseKeepsHeldEntriesRunning(s: Reconciliations, id: int)
  requires inv(s) && canReleaseKey(s, id)
  ensures alwaysHeldTicketsAreRunning(releaseKey(s, id))
{
  var after := releaseKey(s, id);
  var call := callAt(s, id);
  var released := call.held[|call.held|-1];
  ReleaseKeyFrame(s, id);
  forall current | current in after.calls
    ensures forall ticket | ticket in current.held ::
      (exists entry :: entry in after.queue.entries && entry.ticket == ticket && entry.running)
  {
    var i :| 0 <= i < |after.calls| && after.calls[i] == current;
    var prior := s.calls[i];
    assert prior in s.calls;
    if prior.id != id {
      ReleaseOtherCallsCannotHoldReleasedTicket(s, id, prior);
    }
    forall ticket | ticket in current.held
      ensures (exists entry :: entry in after.queue.entries && entry.ticket == ticket && entry.running)
    {
      if prior.id == id {
        ProofLib.FilterMember((number: int) => number != released, prior.held, ticket);
      }
      assert ticket in prior.held && ticket != released;
      var entry :| entry in s.queue.entries && entry.ticket == ticket && entry.running;
      ReleaseQueueEntryRemains(s, id, entry);
    }
  }
}

lemma ReleaseKeepsOtherWaitingEntries(s: Reconciliations, id: int)
  requires inv(s) && canReleaseKey(s, id)
  ensures alwaysWaitingTicketIsQueued(releaseKey(s, id))
{
  var after := releaseKey(s, id);
  var selected := callAt(s, id);
  var released := selected.held[|selected.held|-1];
  ReleaseKeyFrame(s, id);
  ReleasingCallLookup(s, id);
  assert selected.waiting == 0;
  forall call | call in after.calls
    ensures call.waiting >= 0
    ensures call.waiting > 0 ==> (
      call.phase.AcquiringRecords? &&
      (exists entry :: entry in after.queue.entries && entry.ticket == call.waiting &&
        entry.scope.owner == call.adapter && !entry.running && !entry.complete &&
        entry.scope.provider == (if 0 <= call.position < |call.recordKeys|
          then call.recordKeys[call.position] else noKey).key)
    )
  {
    var i :| 0 <= i < |after.calls| && after.calls[i] == call;
    var prior := s.calls[i];
    assert prior in s.calls;
    if prior.id != id && call.waiting > 0 {
      assert call == prior;
      ReleaseOtherCallsCannotHoldReleasedTicket(s, id, prior);
      var record := if 0 <= call.position < |call.recordKeys| then call.recordKeys[call.position] else noKey;
      var queued :| queued in s.queue.entries && queued.ticket == call.waiting &&
        queued.scope.owner == call.adapter && queued.scope.provider == record.key &&
        !queued.running && !queued.complete;
      assert queued.ticket != released;
      ReleaseQueueEntryRemains(s, id, queued);
    }
  }
}

lemma ReleaseRetainsOtherHeldTickets(s: Reconciliations, id: int, i: int, ticket: int)
  requires inv(s) && canReleaseKey(s, id) && 0 <= i < |s.calls|
  requires var selected := callAt(s, id); ticket != selected.held[|selected.held|-1]
  ensures ticket in releaseKey(s, id).calls[i].held <==> ticket in s.calls[i].held
  ensures |ProofLib.Filter((number: int) => number == ticket, releaseKey(s, id).calls[i].held)| ==
    |ProofLib.Filter((number: int) => number == ticket, s.calls[i].held)|
{
  ReleaseKeyFrame(s, id);
  var selected := callAt(s, id);
  if s.calls[i].id == id {
    ReleaseRetainsFilteredTicket(s.calls[i].held, selected.held[|selected.held|-1], ticket);
  }
}

lemma ReleaseKeepsOtherHeldTimers(s: Reconciliations, id: int)
  requires inv(s) && canReleaseKey(s, id)
  ensures alwaysEachHeldTicketOwnsTimer(releaseKey(s, id))
{
  var after := releaseKey(s, id);
  forall call | call in after.calls
    ensures forall ticket | ticket in call.held ::
      (exists timer :: timer in after.timers && timer.ticket == ticket && timer.callId == call.id &&
        timer.adapter == call.adapter && !timer.cleared)
  {
    var i :| 0 <= i < |after.calls| && after.calls[i] == call;
    forall ticket | ticket in call.held
      ensures (
        exists timer :: timer in after.timers && timer.ticket == ticket && timer.callId == call.id &&
          timer.adapter == call.adapter && !timer.cleared
      )
    {
      ReleaseUnreleasedHeldTimer(s, id, i, ticket);
    }
  }
}

lemma ReleaseKeepsCallIdentities(s: Reconciliations, id: int)
  requires inv(s) && canReleaseKey(s, id)
  ensures alwaysCallIdentitiesUnique(releaseKey(s, id))
{
  ReleaseKeyFrame(s, id);
  var after := releaseKey(s, id);
  forall call | call in after.calls
    ensures call.id > 0 && |ProofLib.Filter((row: Reconciliation) => row.id == call.id, after.calls)| == 1
  {
    var i :| 0 <= i < |after.calls| && after.calls[i] == call;
    assert s.calls[i] in s.calls && s.calls[i].id == call.id;
    var byId := (row: Reconciliation) => row.id == call.id;
    ProofLib.FilterLengthPointwise(byId, byId, s.calls, after.calls);
  }
}

lemma ReleaseHeldTicketsOnlyShrink(s: Reconciliations, id: int, i: int)
  requires inv(s) && canReleaseKey(s, id) && 0 <= i < |s.calls|
  ensures var after := releaseKey(s, id).calls[i];
    after.id == s.calls[i].id && after.waiting == s.calls[i].waiting &&
    (forall ticket | ticket in after.held :: ticket in s.calls[i].held) &&
    (forall ticket | ticket in after.held ::
      ticket > 0 && ticket != after.waiting &&
      |ProofLib.Filter((number: int) => number == ticket, after.held)| == 1)
{
  ReleaseKeyFrame(s, id);
  var prior := s.calls[i];
  var call := releaseKey(s, id).calls[i];
  var selected := callAt(s, id);
  var released := selected.held[|selected.held|-1];
  assert prior in s.calls;
  forall ticket | ticket in call.held
    ensures ticket in prior.held && ticket > 0 && ticket != call.waiting &&
      |ProofLib.Filter((number: int) => number == ticket, call.held)| == 1
  {
    if prior.id == id {
      ProofLib.FilterMember((number: int) => number != released, prior.held, ticket);
      assert ticket != released;
      ReleaseRetainsOtherHeldTickets(s, id, i, ticket);
    }
  }
}

lemma ReleasePeersContinueToOwnDistinctTickets(s: Reconciliations, id: int, i: int, j: int)
  requires inv(s) && canReleaseKey(s, id)
  requires 0 <= i < |s.calls| && 0 <= j < |s.calls| && s.calls[i].id != s.calls[j].id
  ensures var call := releaseKey(s, id).calls[i];
    var peer := releaseKey(s, id).calls[j];
    (call.waiting == 0 || (peer.waiting != call.waiting && call.waiting !in peer.held)) &&
    (forall ticket | ticket in call.held :: peer.waiting != ticket && ticket !in peer.held)
{
  ReleaseHeldTicketsOnlyShrink(s, id, i);
  ReleaseHeldTicketsOnlyShrink(s, id, j);
  var prior := s.calls[i];
  var peer := s.calls[j];
  assert prior in s.calls && peer in s.calls;
  forall ticket | ticket in releaseKey(s, id).calls[i].held
    ensures releaseKey(s, id).calls[j].waiting != ticket && ticket !in releaseKey(s, id).calls[j].held
  {
    CallbackOtherTicket(s, prior, peer, ticket);
  }
}

lemma ReleaseKeepsExclusiveTickets(s: Reconciliations, id: int)
  requires inv(s) && canReleaseKey(s, id)
  ensures alwaysOneCallOwnsEachTicket(releaseKey(s, id))
{
  ReleaseKeyFrame(s, id);
  var after := releaseKey(s, id);
  forall i | 0 <= i < |after.calls|
    ensures var call := after.calls[i];
      forall ticket | ticket in call.held ::
        ticket > 0 && ticket != call.waiting &&
        |ProofLib.Filter((other: int) => other == ticket, call.held)| == 1
  {
    ReleaseHeldTicketsOnlyShrink(s, id, i);
  }
  forall i, j | 0 <= i < |after.calls| && 0 <= j < |after.calls| && after.calls[i].id != after.calls[j].id
    ensures var call := after.calls[i];
      var peer := after.calls[j];
      (call.waiting == 0 || (peer.waiting != call.waiting && call.waiting !in peer.held)) &&
      (forall ticket | ticket in call.held :: peer.waiting != ticket && ticket !in peer.held)
  {
    assert s.calls[i].id == after.calls[i].id && s.calls[j].id == after.calls[j].id;
    ReleasePeersContinueToOwnDistinctTickets(s, id, i, j);
  }
  ConnectionTicketCustodyByIndex(after);
}

lemma ReleaseUnreleasedHeldTicket(s: Reconciliations, id: int, i: int, ticket: int)
  requires inv(s) && canReleaseKey(s, id) && 0 <= i < |releaseKey(s, id).calls|
  requires ticket in releaseKey(s, id).calls[i].held
  ensures var selected := callAt(s, id);
    ticket in s.calls[i].held && ticket != selected.held[|selected.held|-1]
{
  ReleaseKeyFrame(s, id);
  var selected := callAt(s, id);
  var released := selected.held[|selected.held|-1];
  var prior := s.calls[i];
  assert prior in s.calls;
  if prior.id != id {
    ReleaseOtherCallsCannotHoldReleasedTicket(s, id, prior);
  } else {
    ProofLib.FilterMember((number: int) => number != released, prior.held, ticket);
  }
}

lemma ReleaseUnreleasedHeldTimer(s: Reconciliations, id: int, i: int, ticket: int)
  requires inv(s) && canReleaseKey(s, id) && 0 <= i < |releaseKey(s, id).calls|
  requires ticket in releaseKey(s, id).calls[i].held
  ensures var after := releaseKey(s, id);
    var call := after.calls[i];
    (exists timer :: timer in after.timers && timer.ticket == ticket && timer.callId == call.id &&
      timer.adapter == call.adapter && !timer.cleared)
{
  ReleaseKeyFrame(s, id);
  ReleaseUnreleasedHeldTicket(s, id, i, ticket);
  var after := releaseKey(s, id);
  var prior := s.calls[i];
  assert prior in s.calls;
  var timer :| timer in s.timers && timer.ticket == ticket && timer.callId == prior.id &&
    timer.adapter == prior.adapter && !timer.cleared;
  ReleaseTimerIndexRemains(s, id, timer);
}


lemma ReleaseTimerIndexRemains(s: Reconciliations, id: int, timer: WarningTimer)
  requires inv(s) && canReleaseKey(s, id) && timer in s.timers
  requires var call := callAt(s, id); timer.ticket != call.held[|call.held|-1]
  ensures timer in releaseKey(s, id).timers
{
  ReleaseKeyFrame(s, id);
  var after := releaseKey(s, id);
  var k :| 0 <= k < |s.timers| && s.timers[k] == timer;
  assert after.timers[k] == timer && after.timers[k] in after.timers;
}

lemma LiveTimerOwnerIndex(s: Reconciliations, timer: WarningTimer)
  requires alwaysOneTimerPerAcquiredTicket(s) && timer in s.timers && !timer.cleared
  ensures (
    exists i :: 0 <= i < |s.calls| && s.calls[i].id == timer.callId &&
      s.calls[i].adapter == timer.adapter && timer.ticket in s.calls[i].held
  )
{
  var owner :| owner in s.calls && owner.id == timer.callId && owner.adapter == timer.adapter && timer.ticket in owner.held;
  var i :| 0 <= i < |s.calls| && s.calls[i] == owner;
}

lemma ReleaseLiveTimerRetainsOwner(s: Reconciliations, id: int, k: int)
  requires inv(s) && canReleaseKey(s, id) && 0 <= k < |releaseKey(s, id).timers|
  requires !releaseKey(s, id).timers[k].cleared
  ensures var after := releaseKey(s, id);
    var timer := after.timers[k];
    (exists call :: call in after.calls && call.id == timer.callId && call.adapter == timer.adapter && timer.ticket in call.held)
{
  ReleaseKeyFrame(s, id);
  var after := releaseKey(s, id);
  var selected := callAt(s, id);
  var timer := after.timers[k];
  assert timer == s.timers[k] && timer in s.timers;
  assert timer.ticket != selected.held[|selected.held|-1];
  LiveTimerOwnerIndex(s, timer);
  var i :| 0 <= i < |s.calls| && s.calls[i].id == timer.callId &&
    s.calls[i].adapter == timer.adapter && timer.ticket in s.calls[i].held;
  ReleaseRetainsOtherHeldTickets(s, id, i, timer.ticket);
  assert after.calls[i] in after.calls &&
    after.calls[i].id == timer.callId && after.calls[i].adapter == timer.adapter;
}

lemma MappedTimerRetainsCount(before: Reconciliations, after: Reconciliations, k: int)
  requires alwaysOneTimerPerAcquiredTicket(before)
  requires |before.timers| == |after.timers| && 0 <= k < |after.timers|
  requires forall i | 0 <= i < |before.timers| :: before.timers[i].ticket == after.timers[i].ticket
  ensures |ProofLib.Filter((t: WarningTimer) => t.ticket == after.timers[k].ticket, after.timers)| == 1
{
  var prior := before.timers[k];
  var sameTicket := (t: WarningTimer) => t.ticket == after.timers[k].ticket;
  assert prior in before.timers && prior.ticket == after.timers[k].ticket;
  ProofLib.FilterLengthPointwise(sameTicket, sameTicket, before.timers, after.timers);
}

lemma TimerOwnershipByIndex(s: Reconciliations)
  requires forall k | 0 <= k < |s.timers| ::
    var timer := s.timers[k];
    |ProofLib.Filter((other: WarningTimer) => other.ticket == timer.ticket, s.timers)| == 1 &&
      (!timer.cleared ==> (
        exists call :: call in s.calls && call.id == timer.callId && call.adapter == timer.adapter &&
          timer.ticket in call.held
      ))
  ensures alwaysOneTimerPerAcquiredTicket(s)
{
  reveal alwaysOneTimerPerAcquiredTicket();
  forall timer | timer in s.timers
    ensures |ProofLib.Filter((other: WarningTimer) => other.ticket == timer.ticket, s.timers)| == 1
    ensures !timer.cleared ==> (
      exists call :: call in s.calls && call.id == timer.callId && call.adapter == timer.adapter &&
        timer.ticket in call.held
    )
  {
    var k :| 0 <= k < |s.timers| && s.timers[k] == timer;
  }
}

lemma ReleaseKeepsRemainingTimerOwners(s: Reconciliations, id: int)
  requires inv(s) && canReleaseKey(s, id)
  ensures alwaysOneTimerPerAcquiredTicket(releaseKey(s, id))
{
  ReleaseKeyFrame(s, id);
  var after := releaseKey(s, id);
  forall k | 0 <= k < |after.timers|
    ensures var timer := after.timers[k];
      |ProofLib.Filter((other: WarningTimer) => other.ticket == timer.ticket, after.timers)| == 1 &&
        (!timer.cleared ==> (
          exists call :: call in after.calls && call.id == timer.callId && call.adapter == timer.adapter &&
            timer.ticket in call.held
        ))
  {
    MappedTimerRetainsCount(s, after, k);
    if !after.timers[k].cleared {
      ReleaseLiveTimerRetainsOwner(s, id, k);
    }
  }
  TimerOwnershipByIndex(after);
}
