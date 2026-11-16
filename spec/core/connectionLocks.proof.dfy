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
