lemma ActionCallbackIdentityFilter(s: ActionReceipts)
  ensures alwaysCallbackIdsUnique(s) == (forall c :: c in s.callbacks ==> c.id > 0 && |ProofLib.Filter((other: ActionCallback) => (other.id == c.id), s.callbacks)| == 1)
{}

lemma ActionDeliveryKeyFilter(s: ActionReceipts)
  ensures alwaysDeliveryKeysUnique(s) == (forall k :: k in s.keys ==> |ProofLib.Filter((other: DeliveryKey) => (other == k), s.keys)| == 1)
{}

lemma ActionCallbackMapIds(s: ActionReceipts, after: ActionReceipts)
  requires alwaysCallbackIdsUnique(s)
  requires |s.callbacks| == |after.callbacks|
  requires forall i :: 0 <= i < |s.callbacks| ==> s.callbacks[i].id == after.callbacks[i].id
  ensures alwaysCallbackIdsUnique(after)
{
  ActionCallbackIdentityFilter(s); ActionCallbackIdentityFilter(after);
  forall c | c in after.callbacks ensures c.id > 0 && |ProofLib.Filter((other: ActionCallback) => (other.id == c.id), after.callbacks)| == 1
  {
    var i :| 0 <= i < |after.callbacks| && after.callbacks[i] == c;
    assert s.callbacks[i] in s.callbacks;
    ProofLib.FilterLengthPointwise((other: ActionCallback) => (other.id == c.id), (other: ActionCallback) => (other.id == c.id), s.callbacks, after.callbacks);
  }
}

lemma ActionAppendDeliveryKey(s: ActionReceipts, after: ActionReceipts, added: DeliveryKey)
  requires alwaysDeliveryKeysUnique(s)
  requires after.keys == s.keys || (after.keys == s.keys + [added] && added !in s.keys)
  ensures alwaysDeliveryKeysUnique(after)
{
  if after.keys != s.keys {
    ActionDeliveryKeyFilter(s); ActionDeliveryKeyFilter(after);
    forall k | k in after.keys ensures |ProofLib.Filter((other: DeliveryKey) => (other == k), after.keys)| == 1
    {
      ProofLib.FilterAppend((other: DeliveryKey) => (other == k), s.keys, added);
      if k == added { ProofLib.FilterNone((other: DeliveryKey) => (other == k), s.keys); }
      else { assert k in s.keys; }
    }
  }
}

lemma ActionQueueInvariant(s: ActionReceipts)
  requires inv(s)
  ensures core__execution_inv(s.queue)
{}

lemma UntouchedActionCallbacks(s: ActionReceipts)
  requires inv(s)
  requires !(s.queue.phase.Settled? || s.queue.phase.SettlementDone?)
  ensures forall c :: c in s.callbacks ==> c.phase.CallbackQueued? && !c.confirms && !c.applied
{
  assert s.queue.delivered == 0;
}

lemma admitAction_ensures(s: ActionReceipts, allowed: bool, mutation: bool, actionName: string)
  ensures (inv(s) ==> canAdmitAction(s, allowed, mutation, actionName) ==> alwaysSettlementRules(admitAction(s, allowed, mutation, actionName)))
  ensures (inv(s) ==> canAdmitAction(s, allowed, mutation, actionName) ==> alwaysConcreteQueueMode(admitAction(s, allowed, mutation, actionName)))
  ensures (inv(s) ==> canAdmitAction(s, allowed, mutation, actionName) ==> alwaysCallbackIdsUnique(admitAction(s, allowed, mutation, actionName)))
  ensures (inv(s) ==> canAdmitAction(s, allowed, mutation, actionName) ==> alwaysCallbackQueueAgrees(admitAction(s, allowed, mutation, actionName)))
  ensures (inv(s) ==> canAdmitAction(s, allowed, mutation, actionName) ==> alwaysPendingCallbackUnprocessed(admitAction(s, allowed, mutation, actionName)))
  ensures (inv(s) ==> canAdmitAction(s, allowed, mutation, actionName) ==> alwaysPendingSuffixIsQueued(admitAction(s, allowed, mutation, actionName)))
  ensures (inv(s) ==> canAdmitAction(s, allowed, mutation, actionName) ==> alwaysMutationInvocationBound(admitAction(s, allowed, mutation, actionName)))
  ensures (inv(s) ==> canAdmitAction(s, allowed, mutation, actionName) ==> alwaysDeliveryKeysUnique(admitAction(s, allowed, mutation, actionName)))
  ensures (inv(s) ==> canAdmitAction(s, allowed, mutation, actionName) ==> alwaysAppliedCallbackKeepsReceipt(admitAction(s, allowed, mutation, actionName)))
  ensures (inv(s) ==> canAdmitAction(s, allowed, mutation, actionName) ==> alwaysConfirmationGrounded(admitAction(s, allowed, mutation, actionName)))
{
  if inv(s) && canAdmitAction(s, allowed, mutation, actionName) {
    ActionQueueInvariant(s);
    core__execution_admitAction_ensures(s.queue, allowed, false);
    UntouchedActionCallbacks(s);
  }
}

lemma returnAction_ensures(s: ActionReceipts, resultKind: core__execution_HandlerOutcome, verified: bool, canonicalText: string, receipts: seq<NamedReceipt>, selectedIds: seq<string>)
  ensures (inv(s) ==> canReturnAction(s, resultKind, verified, canonicalText, receipts, selectedIds) ==> alwaysSettlementRules(returnAction(s, resultKind, verified, canonicalText, receipts, selectedIds)))
  ensures (inv(s) ==> canReturnAction(s, resultKind, verified, canonicalText, receipts, selectedIds) ==> alwaysConcreteQueueMode(returnAction(s, resultKind, verified, canonicalText, receipts, selectedIds)))
  ensures (inv(s) ==> canReturnAction(s, resultKind, verified, canonicalText, receipts, selectedIds) ==> alwaysCallbackIdsUnique(returnAction(s, resultKind, verified, canonicalText, receipts, selectedIds)))
  ensures (inv(s) ==> canReturnAction(s, resultKind, verified, canonicalText, receipts, selectedIds) ==> alwaysCallbackQueueAgrees(returnAction(s, resultKind, verified, canonicalText, receipts, selectedIds)))
  ensures (inv(s) ==> canReturnAction(s, resultKind, verified, canonicalText, receipts, selectedIds) ==> alwaysPendingCallbackUnprocessed(returnAction(s, resultKind, verified, canonicalText, receipts, selectedIds)))
  ensures (inv(s) ==> canReturnAction(s, resultKind, verified, canonicalText, receipts, selectedIds) ==> alwaysPendingSuffixIsQueued(returnAction(s, resultKind, verified, canonicalText, receipts, selectedIds)))
  ensures (inv(s) ==> canReturnAction(s, resultKind, verified, canonicalText, receipts, selectedIds) ==> alwaysMutationInvocationBound(returnAction(s, resultKind, verified, canonicalText, receipts, selectedIds)))
  ensures (inv(s) ==> canReturnAction(s, resultKind, verified, canonicalText, receipts, selectedIds) ==> alwaysDeliveryKeysUnique(returnAction(s, resultKind, verified, canonicalText, receipts, selectedIds)))
  ensures (inv(s) ==> canReturnAction(s, resultKind, verified, canonicalText, receipts, selectedIds) ==> alwaysAppliedCallbackKeepsReceipt(returnAction(s, resultKind, verified, canonicalText, receipts, selectedIds)))
  ensures (inv(s) ==> canReturnAction(s, resultKind, verified, canonicalText, receipts, selectedIds) ==> alwaysConfirmationGrounded(returnAction(s, resultKind, verified, canonicalText, receipts, selectedIds)))
{
  if inv(s) && canReturnAction(s, resultKind, verified, canonicalText, receipts, selectedIds) {
    ActionQueueInvariant(s);
    core__execution_returnHandler_ensures(s.queue, resultKind, false, false);
    UntouchedActionCallbacks(s);
  }
}

lemma emitCallback_ensures(s: ActionReceipts, callbackId: int, actionName: string, text: string, suppliedIds: seq<string>)
  ensures (inv(s) ==> canEmitCallback(s, callbackId, actionName, text, suppliedIds) ==> alwaysSettlementRules(emitCallback(s, callbackId, actionName, text, suppliedIds)))
  ensures (inv(s) ==> canEmitCallback(s, callbackId, actionName, text, suppliedIds) ==> alwaysConcreteQueueMode(emitCallback(s, callbackId, actionName, text, suppliedIds)))
  ensures (inv(s) ==> canEmitCallback(s, callbackId, actionName, text, suppliedIds) ==> alwaysCallbackIdsUnique(emitCallback(s, callbackId, actionName, text, suppliedIds)))
  ensures (inv(s) ==> canEmitCallback(s, callbackId, actionName, text, suppliedIds) ==> alwaysCallbackQueueAgrees(emitCallback(s, callbackId, actionName, text, suppliedIds)))
  ensures (inv(s) ==> canEmitCallback(s, callbackId, actionName, text, suppliedIds) ==> alwaysPendingCallbackUnprocessed(emitCallback(s, callbackId, actionName, text, suppliedIds)))
  ensures (inv(s) ==> canEmitCallback(s, callbackId, actionName, text, suppliedIds) ==> alwaysPendingSuffixIsQueued(emitCallback(s, callbackId, actionName, text, suppliedIds)))
  ensures (inv(s) ==> canEmitCallback(s, callbackId, actionName, text, suppliedIds) ==> alwaysMutationInvocationBound(emitCallback(s, callbackId, actionName, text, suppliedIds)))
  ensures (inv(s) ==> canEmitCallback(s, callbackId, actionName, text, suppliedIds) ==> alwaysDeliveryKeysUnique(emitCallback(s, callbackId, actionName, text, suppliedIds)))
  ensures (inv(s) ==> canEmitCallback(s, callbackId, actionName, text, suppliedIds) ==> alwaysAppliedCallbackKeepsReceipt(emitCallback(s, callbackId, actionName, text, suppliedIds)))
  ensures (inv(s) ==> canEmitCallback(s, callbackId, actionName, text, suppliedIds) ==> alwaysConfirmationGrounded(emitCallback(s, callbackId, actionName, text, suppliedIds)))
{
  if inv(s) && canEmitCallback(s, callbackId, actionName, text, suppliedIds) {
    ActionQueueInvariant(s);
    core__execution_emitCallback_ensures(s.queue);
    var after := emitCallback(s, callbackId, actionName, text, suppliedIds);
    ActionCallbackIdentityFilter(s); ActionCallbackIdentityFilter(after);
    var added := after.callbacks[|s.callbacks|];
    ActionSuffixEquivalent(s); ActionSuffixEquivalent(after);
    forall i | 0 <= i < |after.callbacks| && after.queue.delivered <= i
      ensures after.callbacks[i].phase.CallbackQueued? && !after.callbacks[i].confirms
    {
      if i < |s.callbacks| { assert after.callbacks[i] == s.callbacks[i]; }
      else { assert after.callbacks[i] == added; }
    }
    forall c | c in after.callbacks ensures c.id > 0 && |ProofLib.Filter((other: ActionCallback) => (other.id == c.id), after.callbacks)| == 1
    {
      ProofLib.FilterAppend((other: ActionCallback) => (other.id == c.id), s.callbacks, added);
      if c == added { ProofLib.FilterNone((other: ActionCallback) => (other.id == c.id), s.callbacks); }
      else { assert c in s.callbacks; }
    }
    forall c | c in after.callbacks && c.phase.CallbackSending?
      ensures after.queue.busy && c.id == sendingCallback(after)
    {
      assert c in s.callbacks;
      var index := s.queue.delivered - 1;
      assert s.queue.busy && s.queue.successfulDeliveries >= 0 && s.queue.successfulDeliveries < s.queue.delivered;
      assert 0 <= index < |s.callbacks| && after.callbacks[index] == s.callbacks[index];
    }
  }
}

lemma transformCallback_ensures(s: ActionReceipts, callbackId: int, visibleText: string, visibleIds: seq<string>)
  ensures (inv(s) ==> canTransformCallback(s, callbackId, visibleText, visibleIds) ==> alwaysSettlementRules(transformCallback(s, callbackId, visibleText, visibleIds)))
  ensures (inv(s) ==> canTransformCallback(s, callbackId, visibleText, visibleIds) ==> alwaysConcreteQueueMode(transformCallback(s, callbackId, visibleText, visibleIds)))
  ensures (inv(s) ==> canTransformCallback(s, callbackId, visibleText, visibleIds) ==> alwaysCallbackIdsUnique(transformCallback(s, callbackId, visibleText, visibleIds)))
  ensures (inv(s) ==> canTransformCallback(s, callbackId, visibleText, visibleIds) ==> alwaysCallbackQueueAgrees(transformCallback(s, callbackId, visibleText, visibleIds)))
  ensures (inv(s) ==> canTransformCallback(s, callbackId, visibleText, visibleIds) ==> alwaysPendingCallbackUnprocessed(transformCallback(s, callbackId, visibleText, visibleIds)))
  ensures (inv(s) ==> canTransformCallback(s, callbackId, visibleText, visibleIds) ==> alwaysPendingSuffixIsQueued(transformCallback(s, callbackId, visibleText, visibleIds)))
  ensures (inv(s) ==> canTransformCallback(s, callbackId, visibleText, visibleIds) ==> alwaysMutationInvocationBound(transformCallback(s, callbackId, visibleText, visibleIds)))
  ensures (inv(s) ==> canTransformCallback(s, callbackId, visibleText, visibleIds) ==> alwaysDeliveryKeysUnique(transformCallback(s, callbackId, visibleText, visibleIds)))
  ensures (inv(s) ==> canTransformCallback(s, callbackId, visibleText, visibleIds) ==> alwaysAppliedCallbackKeepsReceipt(transformCallback(s, callbackId, visibleText, visibleIds)))
  ensures (inv(s) ==> canTransformCallback(s, callbackId, visibleText, visibleIds) ==> alwaysConfirmationGrounded(transformCallback(s, callbackId, visibleText, visibleIds)))
{
  if inv(s) && canTransformCallback(s, callbackId, visibleText, visibleIds) {
    var after := transformCallback(s, callbackId, visibleText, visibleIds);
    ActionCallbackMapIds(s, after);
    var claimed :| claimed in s.callbacks && claimed.id == callbackId && claimed.phase.CallbackSending?;
    ActionSuffixEquivalent(s);
    forall i | 0 <= i < |s.callbacks| && after.queue.delivered <= i
      ensures s.callbacks[i].id != callbackId && after.callbacks[i] == s.callbacks[i]
    {
      var prior := s.callbacks[i];
      assert prior in s.callbacks && prior.phase.CallbackQueued?;
      if prior.id == callbackId { ActionSameCallbackId(s, prior, claimed); }
    }
    ActionMappedSuffix(s, after, callbackId);
    forall c | c in after.callbacks && c.confirms
      ensures c.phase.CallbackDelivered? && c.coreBound && c.applied && c.visibleText == after.canonicalText && c.visibleIds == c.boundIds && bindingApplied(after)
    {
      var i :| 0 <= i < |after.callbacks| && after.callbacks[i] == c;
      var prior := s.callbacks[i];
      assert prior in s.callbacks && prior.confirms;
      if c.id == callbackId {
        var sending :| sending in s.callbacks && sending.id == callbackId && sending.phase.CallbackSending?;
        ActionSameCallbackId(s, prior, sending);
      }
    }
  }
}

lemma acknowledgeCallback_ensures(s: ActionReceipts, callbackId: int, accepted: bool)
  ensures (inv(s) ==> canAcknowledgeCallback(s, callbackId, accepted) ==> alwaysSettlementRules(acknowledgeCallback(s, callbackId, accepted)))
  ensures (inv(s) ==> canAcknowledgeCallback(s, callbackId, accepted) ==> alwaysConcreteQueueMode(acknowledgeCallback(s, callbackId, accepted)))
  ensures (inv(s) ==> canAcknowledgeCallback(s, callbackId, accepted) ==> alwaysCallbackIdsUnique(acknowledgeCallback(s, callbackId, accepted)))
  ensures (inv(s) ==> canAcknowledgeCallback(s, callbackId, accepted) ==> alwaysCallbackQueueAgrees(acknowledgeCallback(s, callbackId, accepted)))
  ensures (inv(s) ==> canAcknowledgeCallback(s, callbackId, accepted) ==> alwaysPendingCallbackUnprocessed(acknowledgeCallback(s, callbackId, accepted)))
  ensures (inv(s) ==> canAcknowledgeCallback(s, callbackId, accepted) ==> alwaysPendingSuffixIsQueued(acknowledgeCallback(s, callbackId, accepted)))
  ensures (inv(s) ==> canAcknowledgeCallback(s, callbackId, accepted) ==> alwaysMutationInvocationBound(acknowledgeCallback(s, callbackId, accepted)))
  ensures (inv(s) ==> canAcknowledgeCallback(s, callbackId, accepted) ==> alwaysDeliveryKeysUnique(acknowledgeCallback(s, callbackId, accepted)))
  ensures (inv(s) ==> canAcknowledgeCallback(s, callbackId, accepted) ==> alwaysAppliedCallbackKeepsReceipt(acknowledgeCallback(s, callbackId, accepted)))
  ensures (inv(s) ==> canAcknowledgeCallback(s, callbackId, accepted) ==> alwaysConfirmationGrounded(acknowledgeCallback(s, callbackId, accepted)))
{
  if inv(s) && canAcknowledgeCallback(s, callbackId, accepted) {
    ActionQueueInvariant(s);
    core__execution_settleTransport_ensures(s.queue, accepted);
    var claimed :| claimed in s.callbacks && claimed.id == callbackId && claimed.phase.CallbackSending?;
    var after := acknowledgeCallback(s, callbackId, accepted);
    ActionCallbackMapIds(s, after);
    ActionSuffixEquivalent(s);
    forall i | 0 <= i < |s.callbacks| && after.queue.delivered <= i
      ensures s.callbacks[i].id != callbackId && after.callbacks[i] == s.callbacks[i]
    {
      var prior := s.callbacks[i];
      assert prior in s.callbacks && prior.phase.CallbackQueued?;
      if prior.id == callbackId { ActionSameCallbackId(s, prior, claimed); }
    }
    ActionMappedSuffix(s, after, callbackId);
    forall c | c in after.callbacks
      ensures !c.phase.CallbackSending?
      ensures c.confirms ==> c.phase.CallbackDelivered? && c.coreBound && c.applied && c.visibleText == after.canonicalText && c.visibleIds == c.boundIds && bindingApplied(after)
      ensures after.mutation && (c.phase.CallbackSending? || c.phase.CallbackDelivered? || c.phase.CallbackFailed?) ==> c.coreBound && c.text == after.canonicalText && c.boundIds == after.selectedIds
    {
      var i :| 0 <= i < |after.callbacks| && after.callbacks[i] == c;
      var prior := s.callbacks[i];
      assert prior in s.callbacks;
      if prior.phase.CallbackSending? { assert prior.id == claimed.id; }
      if prior.id == callbackId {
        ActionSameCallbackId(s, prior, claimed);
        if c.confirms && !bindingApplied(s) { assert !claimed.applied; }
      }
    }
  }
}

lemma processCallback_ensures(s: ActionReceipts)
  ensures (inv(s) ==> canProcessCallback(s) ==> alwaysSettlementRules(processCallback(s)))
  ensures (inv(s) ==> canProcessCallback(s) ==> alwaysConcreteQueueMode(processCallback(s)))
  ensures (inv(s) ==> canProcessCallback(s) ==> alwaysCallbackIdsUnique(processCallback(s)))
  ensures (inv(s) ==> canProcessCallback(s) ==> alwaysCallbackQueueAgrees(processCallback(s)))
  ensures (inv(s) ==> canProcessCallback(s) ==> alwaysPendingCallbackUnprocessed(processCallback(s)))
  ensures (inv(s) ==> canProcessCallback(s) ==> alwaysPendingSuffixIsQueued(processCallback(s)))
  ensures (inv(s) ==> canProcessCallback(s) ==> alwaysMutationInvocationBound(processCallback(s)))
  ensures (inv(s) ==> canProcessCallback(s) ==> alwaysDeliveryKeysUnique(processCallback(s)))
  ensures (inv(s) ==> canProcessCallback(s) ==> alwaysAppliedCallbackKeepsReceipt(processCallback(s)))
  ensures (inv(s) ==> canProcessCallback(s) ==> alwaysConfirmationGrounded(processCallback(s)))
{
  if inv(s) && canProcessCallback(s) {
    ActionQueueInvariant(s);
    core__execution_deliverCallback_ensures(s.queue);
    var current := nextCallback(s);
    var after := processCallback(s);
    assert 0 <= s.queue.delivered < |s.callbacks| && current == s.callbacks[s.queue.delivered];
    assert current in s.callbacks;
    ActionCallbackMapIds(s, after);
    ActionSuffixEquivalent(s);
    forall i | 0 <= i < |s.callbacks| && after.queue.delivered <= i
      ensures s.callbacks[i].id != current.id && after.callbacks[i] == s.callbacks[i]
    {
      var prior := s.callbacks[i];
      assert prior in s.callbacks;
      if prior.id == current.id {
        ActionSameCallbackId(s, prior, current);
        ProofLib.FilterTwo((other: ActionCallback) => (other.id == current.id), s.callbacks, s.queue.delivered, i);
        ActionCallbackIdentityFilter(s);
      }
    }
    ActionMappedSuffix(s, after, current.id);
    ActionAppendDeliveryKey(s, after, DeliveryKey(current.actionName, s.canonicalText, s.selectedIds));
    forall c | c in after.callbacks
      ensures c.phase.CallbackSending? ==> c.id == sendingCallback(after)
      ensures c.confirms ==> c.phase.CallbackDelivered? && c.coreBound && c.applied && c.visibleText == after.canonicalText && c.visibleIds == c.boundIds && bindingApplied(after)
      ensures after.mutation && (c.phase.CallbackSending? || c.phase.CallbackDelivered? || c.phase.CallbackFailed?) ==> c.coreBound && c.text == after.canonicalText && c.boundIds == after.selectedIds
    {
      var i :| 0 <= i < |after.callbacks| && after.callbacks[i] == c;
      var prior := s.callbacks[i];
      assert prior in s.callbacks;
      if prior.id == current.id {
        ActionSameCallbackId(s, prior, current);
        assert prior.phase.CallbackQueued? && !prior.confirms;
      }
    }
  }
}

lemma acknowledgeNextCallback_ensures(s: ActionReceipts, accepted: bool)
  ensures (inv(s) ==> canAcknowledgeNextCallback(s, accepted) ==> alwaysSettlementRules(acknowledgeNextCallback(s, accepted)))
  ensures (inv(s) ==> canAcknowledgeNextCallback(s, accepted) ==> alwaysConcreteQueueMode(acknowledgeNextCallback(s, accepted)))
  ensures (inv(s) ==> canAcknowledgeNextCallback(s, accepted) ==> alwaysCallbackIdsUnique(acknowledgeNextCallback(s, accepted)))
  ensures (inv(s) ==> canAcknowledgeNextCallback(s, accepted) ==> alwaysCallbackQueueAgrees(acknowledgeNextCallback(s, accepted)))
  ensures (inv(s) ==> canAcknowledgeNextCallback(s, accepted) ==> alwaysPendingCallbackUnprocessed(acknowledgeNextCallback(s, accepted)))
  ensures (inv(s) ==> canAcknowledgeNextCallback(s, accepted) ==> alwaysPendingSuffixIsQueued(acknowledgeNextCallback(s, accepted)))
  ensures (inv(s) ==> canAcknowledgeNextCallback(s, accepted) ==> alwaysMutationInvocationBound(acknowledgeNextCallback(s, accepted)))
  ensures (inv(s) ==> canAcknowledgeNextCallback(s, accepted) ==> alwaysDeliveryKeysUnique(acknowledgeNextCallback(s, accepted)))
  ensures (inv(s) ==> canAcknowledgeNextCallback(s, accepted) ==> alwaysAppliedCallbackKeepsReceipt(acknowledgeNextCallback(s, accepted)))
  ensures (inv(s) ==> canAcknowledgeNextCallback(s, accepted) ==> alwaysConfirmationGrounded(acknowledgeNextCallback(s, accepted)))
{
  if inv(s) && canAcknowledgeNextCallback(s, accepted) {
    acknowledgeCallback_ensures(s, sendingCallback(s), accepted);
  }
}

lemma ActionSameCallbackId(s: ActionReceipts, first: ActionCallback, second: ActionCallback)
  requires alwaysCallbackIdsUnique(s) && first in s.callbacks && second in s.callbacks && first.id == second.id
  ensures first == second
{
  ActionCallbackIdentityFilter(s);
  ProofLib.FilterMember((other: ActionCallback) => (other.id == first.id), s.callbacks, first);
  ProofLib.FilterMember((other: ActionCallback) => (other.id == first.id), s.callbacks, second);
}


lemma CallbackSuffixFacts(callbacks: seq<ActionCallback>, count: int, valid: bool)
  ensures Std.Collections.Seq.FoldLeft((position: CallbackCursor, c: ActionCallback) => advanceCallbackCursor(position, c), CallbackCursor(count, valid), callbacks).valid ==
    (valid && (forall i :: 0 <= i < |callbacks| && count <= i ==> callbacks[i].phase.CallbackQueued? && !callbacks[i].confirms))
  decreases |callbacks|
{
  var start := CallbackCursor(count, valid);
  var advance := (position: CallbackCursor, c: ActionCallback) => advanceCallbackCursor(position, c);
  if |callbacks| > 0 {
    var nextCursor := advanceCallbackCursor(start, callbacks[0]);
    assert nextCursor.remaining == count - 1;
    CallbackSuffixFacts(callbacks[1..], nextCursor.remaining, nextCursor.valid);
    assert forall i :: 0 <= i < |callbacks[1..]| ==> callbacks[1..][i] == callbacks[i+1];
    assert Std.Collections.Seq.FoldLeft(advance, start, callbacks) == Std.Collections.Seq.FoldLeft(advance, nextCursor, callbacks[1..]);
    if valid && (forall i :: 0 <= i < |callbacks| && count <= i ==> callbacks[i].phase.CallbackQueued? && !callbacks[i].confirms) {
      forall i | 0 <= i < |callbacks[1..]| && nextCursor.remaining <= i
        ensures callbacks[1..][i].phase.CallbackQueued? && !callbacks[1..][i].confirms
      { assert callbacks[1..][i] == callbacks[i+1]; }
    } else if Std.Collections.Seq.FoldLeft(advance, start, callbacks).valid {
      forall i | 0 <= i < |callbacks| && count <= i
        ensures callbacks[i].phase.CallbackQueued? && !callbacks[i].confirms
      {
        if i == 0 { assert nextCursor.valid; }
        else { assert callbacks[1..][i-1] == callbacks[i]; }
      }
    }
  }
}

lemma ActionSuffixEquivalent(s: ActionReceipts)
  ensures alwaysPendingSuffixIsQueued(s) ==
    (forall i :: 0 <= i < |s.callbacks| && s.queue.delivered <= i ==> s.callbacks[i].phase.CallbackQueued? && !s.callbacks[i].confirms)
{
  CallbackSuffixFacts(s.callbacks, s.queue.delivered, true);
}

lemma ActionMappedSuffix(s: ActionReceipts, after: ActionReceipts, callbackId: int)
  requires alwaysPendingSuffixIsQueued(s)
  requires |s.callbacks| == |after.callbacks| && s.queue.delivered <= after.queue.delivered
  requires forall i :: 0 <= i < |s.callbacks| && after.queue.delivered <= i ==> s.callbacks[i].id != callbackId && after.callbacks[i] == s.callbacks[i]
  ensures alwaysPendingSuffixIsQueued(after)
{
  ActionSuffixEquivalent(s); ActionSuffixEquivalent(after);
}

lemma finishSuppressed_ensures(s: ActionReceipts)
  ensures (inv(s) ==> canFinishSuppressed(s) ==> alwaysSettlementRules(finishSuppressed(s)))
  ensures (inv(s) ==> canFinishSuppressed(s) ==> alwaysConcreteQueueMode(finishSuppressed(s)))
  ensures (inv(s) ==> canFinishSuppressed(s) ==> alwaysCallbackIdsUnique(finishSuppressed(s)))
  ensures (inv(s) ==> canFinishSuppressed(s) ==> alwaysCallbackQueueAgrees(finishSuppressed(s)))
  ensures (inv(s) ==> canFinishSuppressed(s) ==> alwaysPendingCallbackUnprocessed(finishSuppressed(s)))
  ensures (inv(s) ==> canFinishSuppressed(s) ==> alwaysPendingSuffixIsQueued(finishSuppressed(s)))
  ensures (inv(s) ==> canFinishSuppressed(s) ==> alwaysMutationInvocationBound(finishSuppressed(s)))
  ensures (inv(s) ==> canFinishSuppressed(s) ==> alwaysDeliveryKeysUnique(finishSuppressed(s)))
  ensures (inv(s) ==> canFinishSuppressed(s) ==> alwaysAppliedCallbackKeepsReceipt(finishSuppressed(s)))
  ensures (inv(s) ==> canFinishSuppressed(s) ==> alwaysConfirmationGrounded(finishSuppressed(s)))
{
  if inv(s) && canFinishSuppressed(s) {
    ActionQueueInvariant(s);
    core__execution_settleTransport_ensures(s.queue, true);
    var index := s.queue.delivered - 1;
    assert 0 <= index < |s.callbacks|;
    var suppressed := s.callbacks[index];
    assert suppressed in s.callbacks && suppressed.phase.CallbackSuppressed?;
    forall c | c in s.callbacks ensures !c.phase.CallbackSending?
    {
      if c.phase.CallbackSending? {
        assert c.id == suppressed.id;
        ActionSameCallbackId(s, c, suppressed);
      }
    }
  }
}
