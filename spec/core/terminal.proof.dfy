// Terminal ownership: exact identity preservation and snapshot/settlement witnesses.

lemma observeReceipt_ensures(s: TerminalState, effects: seq<EffectEntry>)
  ensures (inv(s) ==> canObserveReceipt(s, effects) ==> alwaysDeliveryIdentitiesUnique(observeReceipt(s, effects)))
  ensures (inv(s) ==> canObserveReceipt(s, effects) ==> alwaysEffectIdsUnique(observeReceipt(s, effects)))
  ensures (inv(s) ==> canObserveReceipt(s, effects) ==> alwaysWorkDeliveryCaptured(observeReceipt(s, effects)))
  ensures (inv(s) ==> canObserveReceipt(s, effects) ==> alwaysWorkIdentitiesUnique(observeReceipt(s, effects)))
  ensures (inv(s) ==> canObserveReceipt(s, effects) ==> alwaysDeliveryGatesWork(observeReceipt(s, effects)))
  ensures (inv(s) ==> canObserveReceipt(s, effects) ==> alwaysFailedDeliverySkipsWork(observeReceipt(s, effects)))
  ensures (inv(s) ==> canObserveReceipt(s, effects) ==> alwaysEmitsAfterOwnedWork(observeReceipt(s, effects)))
  ensures (inv(s) ==> canObserveReceipt(s, effects) ==> alwaysCapturedWorkComplete(observeReceipt(s, effects)))
  ensures (inv(s) ==> canObserveReceipt(s, effects) ==> alwaysSubscriberIdentitiesUnique(observeReceipt(s, effects)))
  ensures (inv(s) ==> canObserveReceipt(s, effects) ==> alwaysSubscriberIdentitiesPositive(observeReceipt(s, effects)))
  ensures (inv(s) ==> canObserveReceipt(s, effects) ==> alwaysSubscriberFailuresRecorded(observeReceipt(s, effects)))
  ensures (inv(s) ==> canObserveReceipt(s, effects) ==> alwaysJoinsAllSubscribers(observeReceipt(s, effects)))
  ensures (inv(s) ==> canObserveReceipt(s, effects) ==> alwaysFirstFailureIsReal(observeReceipt(s, effects)))
  ensures (inv(s) ==> canObserveReceipt(s, effects) ==> alwaysReportsEmissionFailure(observeReceipt(s, effects)))
  ensures (inv(s) ==> canObserveReceipt(s, effects) ==> stepFirstTerminalRequestStays(s, "observeReceipt", observeReceipt(s, effects)))
  ensures (inv(s) ==> canObserveReceipt(s, effects) ==> stepFirstFailureStays(s, observeReceipt(s, effects)))
{
  if inv(s) && canObserveReceipt(s, effects) {
    TerminalEffectInvariant(s);
    TerminalEffectsDistinct(s.effects);
    TerminalMergeUnique(s.effects, effects);
    TerminalEffectInvariant(observeReceipt(s, effects));
  }
}

lemma captureDelivery_ensures(s: TerminalState, deliveryId: int, deliveryPhase: Delivery)
  ensures (inv(s) ==> canCaptureDelivery(s, deliveryId, deliveryPhase) ==> alwaysDeliveryIdentitiesUnique(captureDelivery(s, deliveryId, deliveryPhase)))
  ensures (inv(s) ==> canCaptureDelivery(s, deliveryId, deliveryPhase) ==> alwaysEffectIdsUnique(captureDelivery(s, deliveryId, deliveryPhase)))
  ensures (inv(s) ==> canCaptureDelivery(s, deliveryId, deliveryPhase) ==> alwaysWorkDeliveryCaptured(captureDelivery(s, deliveryId, deliveryPhase)))
  ensures (inv(s) ==> canCaptureDelivery(s, deliveryId, deliveryPhase) ==> alwaysWorkIdentitiesUnique(captureDelivery(s, deliveryId, deliveryPhase)))
  ensures (inv(s) ==> canCaptureDelivery(s, deliveryId, deliveryPhase) ==> alwaysDeliveryGatesWork(captureDelivery(s, deliveryId, deliveryPhase)))
  ensures (inv(s) ==> canCaptureDelivery(s, deliveryId, deliveryPhase) ==> alwaysFailedDeliverySkipsWork(captureDelivery(s, deliveryId, deliveryPhase)))
  ensures (inv(s) ==> canCaptureDelivery(s, deliveryId, deliveryPhase) ==> alwaysEmitsAfterOwnedWork(captureDelivery(s, deliveryId, deliveryPhase)))
  ensures (inv(s) ==> canCaptureDelivery(s, deliveryId, deliveryPhase) ==> alwaysCapturedWorkComplete(captureDelivery(s, deliveryId, deliveryPhase)))
  ensures (inv(s) ==> canCaptureDelivery(s, deliveryId, deliveryPhase) ==> alwaysSubscriberIdentitiesUnique(captureDelivery(s, deliveryId, deliveryPhase)))
  ensures (inv(s) ==> canCaptureDelivery(s, deliveryId, deliveryPhase) ==> alwaysSubscriberIdentitiesPositive(captureDelivery(s, deliveryId, deliveryPhase)))
  ensures (inv(s) ==> canCaptureDelivery(s, deliveryId, deliveryPhase) ==> alwaysSubscriberFailuresRecorded(captureDelivery(s, deliveryId, deliveryPhase)))
  ensures (inv(s) ==> canCaptureDelivery(s, deliveryId, deliveryPhase) ==> alwaysJoinsAllSubscribers(captureDelivery(s, deliveryId, deliveryPhase)))
  ensures (inv(s) ==> canCaptureDelivery(s, deliveryId, deliveryPhase) ==> alwaysFirstFailureIsReal(captureDelivery(s, deliveryId, deliveryPhase)))
  ensures (inv(s) ==> canCaptureDelivery(s, deliveryId, deliveryPhase) ==> alwaysReportsEmissionFailure(captureDelivery(s, deliveryId, deliveryPhase)))
  ensures (inv(s) ==> canCaptureDelivery(s, deliveryId, deliveryPhase) ==> stepFirstTerminalRequestStays(s, "captureDelivery", captureDelivery(s, deliveryId, deliveryPhase)))
  ensures (inv(s) ==> canCaptureDelivery(s, deliveryId, deliveryPhase) ==> stepFirstFailureStays(s, captureDelivery(s, deliveryId, deliveryPhase)))
{
  if inv(s) && canCaptureDelivery(s, deliveryId, deliveryPhase) {
    var after := captureDelivery(s, deliveryId, deliveryPhase);
    TerminalDeliveryInvariant(s);
    TerminalDeliveryDistinct(s.deliveries);
    ProofLib.DistinctByConcat(s.deliveries, [DeliveryPromise(deliveryId, deliveryPhase)], (entry: DeliveryPromise) => entry.id);
    TerminalDeliveryDistinct(after.deliveries);
    TerminalDeliveryInvariant(after);
    forall w | w in s.works && w.afterDelivery ensures deliveryState(after, w.deliveryId) == deliveryState(s, w.deliveryId) {
      var d :| d in s.deliveries && d.id == w.deliveryId;
      TerminalDeliveryLookup(s, w.deliveryId, d);
      TerminalDeliveryLookup(after, w.deliveryId, d);
    }
  }
}

lemma admitTerminalWork_ensures(s: TerminalState, workId: int, label_: string, afterDelivery: bool, deliveryId: int)
  ensures (inv(s) ==> canAdmitTerminalWork(s, workId, label_, afterDelivery, deliveryId) ==> alwaysDeliveryIdentitiesUnique(admitTerminalWork(s, workId, label_, afterDelivery, deliveryId)))
  ensures (inv(s) ==> canAdmitTerminalWork(s, workId, label_, afterDelivery, deliveryId) ==> alwaysEffectIdsUnique(admitTerminalWork(s, workId, label_, afterDelivery, deliveryId)))
  ensures (inv(s) ==> canAdmitTerminalWork(s, workId, label_, afterDelivery, deliveryId) ==> alwaysWorkDeliveryCaptured(admitTerminalWork(s, workId, label_, afterDelivery, deliveryId)))
  ensures (inv(s) ==> canAdmitTerminalWork(s, workId, label_, afterDelivery, deliveryId) ==> alwaysWorkIdentitiesUnique(admitTerminalWork(s, workId, label_, afterDelivery, deliveryId)))
  ensures (inv(s) ==> canAdmitTerminalWork(s, workId, label_, afterDelivery, deliveryId) ==> alwaysDeliveryGatesWork(admitTerminalWork(s, workId, label_, afterDelivery, deliveryId)))
  ensures (inv(s) ==> canAdmitTerminalWork(s, workId, label_, afterDelivery, deliveryId) ==> alwaysFailedDeliverySkipsWork(admitTerminalWork(s, workId, label_, afterDelivery, deliveryId)))
  ensures (inv(s) ==> canAdmitTerminalWork(s, workId, label_, afterDelivery, deliveryId) ==> alwaysEmitsAfterOwnedWork(admitTerminalWork(s, workId, label_, afterDelivery, deliveryId)))
  ensures (inv(s) ==> canAdmitTerminalWork(s, workId, label_, afterDelivery, deliveryId) ==> alwaysCapturedWorkComplete(admitTerminalWork(s, workId, label_, afterDelivery, deliveryId)))
  ensures (inv(s) ==> canAdmitTerminalWork(s, workId, label_, afterDelivery, deliveryId) ==> alwaysSubscriberIdentitiesUnique(admitTerminalWork(s, workId, label_, afterDelivery, deliveryId)))
  ensures (inv(s) ==> canAdmitTerminalWork(s, workId, label_, afterDelivery, deliveryId) ==> alwaysSubscriberIdentitiesPositive(admitTerminalWork(s, workId, label_, afterDelivery, deliveryId)))
  ensures (inv(s) ==> canAdmitTerminalWork(s, workId, label_, afterDelivery, deliveryId) ==> alwaysSubscriberFailuresRecorded(admitTerminalWork(s, workId, label_, afterDelivery, deliveryId)))
  ensures (inv(s) ==> canAdmitTerminalWork(s, workId, label_, afterDelivery, deliveryId) ==> alwaysJoinsAllSubscribers(admitTerminalWork(s, workId, label_, afterDelivery, deliveryId)))
  ensures (inv(s) ==> canAdmitTerminalWork(s, workId, label_, afterDelivery, deliveryId) ==> alwaysFirstFailureIsReal(admitTerminalWork(s, workId, label_, afterDelivery, deliveryId)))
  ensures (inv(s) ==> canAdmitTerminalWork(s, workId, label_, afterDelivery, deliveryId) ==> alwaysReportsEmissionFailure(admitTerminalWork(s, workId, label_, afterDelivery, deliveryId)))
  ensures (inv(s) ==> canAdmitTerminalWork(s, workId, label_, afterDelivery, deliveryId) ==> stepFirstTerminalRequestStays(s, "admitTerminalWork", admitTerminalWork(s, workId, label_, afterDelivery, deliveryId)))
  ensures (inv(s) ==> canAdmitTerminalWork(s, workId, label_, afterDelivery, deliveryId) ==> stepFirstFailureStays(s, admitTerminalWork(s, workId, label_, afterDelivery, deliveryId)))
{
  if inv(s) && canAdmitTerminalWork(s, workId, label_, afterDelivery, deliveryId) {
    var after := admitTerminalWork(s, workId, label_, afterDelivery, deliveryId);
    TerminalWorkInvariant(s);
    TerminalWorkDistinct(s.works);
    var added := OwnedWork(workId, label_, afterDelivery, (if afterDelivery then deliveryId else 0), OwnedWorkPhase.WorkScheduled, true, "");
    ProofLib.DistinctByConcat(s.works, [added], (entry: OwnedWork) => entry.id);
    TerminalWorkDistinct(after.works);
    TerminalWorkInvariant(after);
  }
}

lemma startOwnedWork_ensures(s: TerminalState, workId: int)
  ensures (inv(s) ==> canStartOwnedWork(s, workId) ==> alwaysDeliveryIdentitiesUnique(startOwnedWork(s, workId)))
  ensures (inv(s) ==> canStartOwnedWork(s, workId) ==> alwaysEffectIdsUnique(startOwnedWork(s, workId)))
  ensures (inv(s) ==> canStartOwnedWork(s, workId) ==> alwaysWorkDeliveryCaptured(startOwnedWork(s, workId)))
  ensures (inv(s) ==> canStartOwnedWork(s, workId) ==> alwaysWorkIdentitiesUnique(startOwnedWork(s, workId)))
  ensures (inv(s) ==> canStartOwnedWork(s, workId) ==> alwaysDeliveryGatesWork(startOwnedWork(s, workId)))
  ensures (inv(s) ==> canStartOwnedWork(s, workId) ==> alwaysFailedDeliverySkipsWork(startOwnedWork(s, workId)))
  ensures (inv(s) ==> canStartOwnedWork(s, workId) ==> alwaysEmitsAfterOwnedWork(startOwnedWork(s, workId)))
  ensures (inv(s) ==> canStartOwnedWork(s, workId) ==> alwaysCapturedWorkComplete(startOwnedWork(s, workId)))
  ensures (inv(s) ==> canStartOwnedWork(s, workId) ==> alwaysSubscriberIdentitiesUnique(startOwnedWork(s, workId)))
  ensures (inv(s) ==> canStartOwnedWork(s, workId) ==> alwaysSubscriberIdentitiesPositive(startOwnedWork(s, workId)))
  ensures (inv(s) ==> canStartOwnedWork(s, workId) ==> alwaysSubscriberFailuresRecorded(startOwnedWork(s, workId)))
  ensures (inv(s) ==> canStartOwnedWork(s, workId) ==> alwaysJoinsAllSubscribers(startOwnedWork(s, workId)))
  ensures (inv(s) ==> canStartOwnedWork(s, workId) ==> alwaysFirstFailureIsReal(startOwnedWork(s, workId)))
  ensures (inv(s) ==> canStartOwnedWork(s, workId) ==> alwaysReportsEmissionFailure(startOwnedWork(s, workId)))
  ensures (inv(s) ==> canStartOwnedWork(s, workId) ==> stepFirstTerminalRequestStays(s, "startOwnedWork", startOwnedWork(s, workId)))
  ensures (inv(s) ==> canStartOwnedWork(s, workId) ==> stepFirstFailureStays(s, startOwnedWork(s, workId)))
{
  if inv(s) && canStartOwnedWork(s, workId) {
    var after := startOwnedWork(s, workId);
    TerminalWorkInvariant(s);
    TerminalWorkDistinct(s.works);
    TerminalWorkMapIds(s.works, after.works);
    TerminalWorkDistinct(after.works);
    TerminalWorkInvariant(after);
  }
}

lemma finishOwnedWork_ensures(s: TerminalState, workId: int, errorId: string)
  ensures (inv(s) ==> canFinishOwnedWork(s, workId, errorId) ==> alwaysDeliveryIdentitiesUnique(finishOwnedWork(s, workId, errorId)))
  ensures (inv(s) ==> canFinishOwnedWork(s, workId, errorId) ==> alwaysEffectIdsUnique(finishOwnedWork(s, workId, errorId)))
  ensures (inv(s) ==> canFinishOwnedWork(s, workId, errorId) ==> alwaysWorkDeliveryCaptured(finishOwnedWork(s, workId, errorId)))
  ensures (inv(s) ==> canFinishOwnedWork(s, workId, errorId) ==> alwaysWorkIdentitiesUnique(finishOwnedWork(s, workId, errorId)))
  ensures (inv(s) ==> canFinishOwnedWork(s, workId, errorId) ==> alwaysDeliveryGatesWork(finishOwnedWork(s, workId, errorId)))
  ensures (inv(s) ==> canFinishOwnedWork(s, workId, errorId) ==> alwaysFailedDeliverySkipsWork(finishOwnedWork(s, workId, errorId)))
  ensures (inv(s) ==> canFinishOwnedWork(s, workId, errorId) ==> alwaysEmitsAfterOwnedWork(finishOwnedWork(s, workId, errorId)))
  ensures (inv(s) ==> canFinishOwnedWork(s, workId, errorId) ==> alwaysCapturedWorkComplete(finishOwnedWork(s, workId, errorId)))
  ensures (inv(s) ==> canFinishOwnedWork(s, workId, errorId) ==> alwaysSubscriberIdentitiesUnique(finishOwnedWork(s, workId, errorId)))
  ensures (inv(s) ==> canFinishOwnedWork(s, workId, errorId) ==> alwaysSubscriberIdentitiesPositive(finishOwnedWork(s, workId, errorId)))
  ensures (inv(s) ==> canFinishOwnedWork(s, workId, errorId) ==> alwaysSubscriberFailuresRecorded(finishOwnedWork(s, workId, errorId)))
  ensures (inv(s) ==> canFinishOwnedWork(s, workId, errorId) ==> alwaysJoinsAllSubscribers(finishOwnedWork(s, workId, errorId)))
  ensures (inv(s) ==> canFinishOwnedWork(s, workId, errorId) ==> alwaysFirstFailureIsReal(finishOwnedWork(s, workId, errorId)))
  ensures (inv(s) ==> canFinishOwnedWork(s, workId, errorId) ==> alwaysReportsEmissionFailure(finishOwnedWork(s, workId, errorId)))
  ensures (inv(s) ==> canFinishOwnedWork(s, workId, errorId) ==> stepFirstTerminalRequestStays(s, "finishOwnedWork", finishOwnedWork(s, workId, errorId)))
  ensures (inv(s) ==> canFinishOwnedWork(s, workId, errorId) ==> stepFirstFailureStays(s, finishOwnedWork(s, workId, errorId)))
{
  if inv(s) && canFinishOwnedWork(s, workId, errorId) {
    var after := finishOwnedWork(s, workId, errorId);
    TerminalWorkInvariant(s);
    TerminalWorkDistinct(s.works);
    TerminalWorkMapIds(s.works, after.works);
    TerminalWorkDistinct(after.works);
    TerminalWorkInvariant(after);
    var running :| running in s.works && running.id == workId && running.phase.WorkRunning?;
    forall w | w in s.works && w.id == workId ensures w == running {
      TerminalWorkSameId(s, w, running);
    }
  }
}

lemma removeOwnedWork_ensures(s: TerminalState, workId: int)
  ensures (inv(s) ==> canRemoveOwnedWork(s, workId) ==> alwaysDeliveryIdentitiesUnique(removeOwnedWork(s, workId)))
  ensures (inv(s) ==> canRemoveOwnedWork(s, workId) ==> alwaysEffectIdsUnique(removeOwnedWork(s, workId)))
  ensures (inv(s) ==> canRemoveOwnedWork(s, workId) ==> alwaysWorkDeliveryCaptured(removeOwnedWork(s, workId)))
  ensures (inv(s) ==> canRemoveOwnedWork(s, workId) ==> alwaysWorkIdentitiesUnique(removeOwnedWork(s, workId)))
  ensures (inv(s) ==> canRemoveOwnedWork(s, workId) ==> alwaysDeliveryGatesWork(removeOwnedWork(s, workId)))
  ensures (inv(s) ==> canRemoveOwnedWork(s, workId) ==> alwaysFailedDeliverySkipsWork(removeOwnedWork(s, workId)))
  ensures (inv(s) ==> canRemoveOwnedWork(s, workId) ==> alwaysEmitsAfterOwnedWork(removeOwnedWork(s, workId)))
  ensures (inv(s) ==> canRemoveOwnedWork(s, workId) ==> alwaysCapturedWorkComplete(removeOwnedWork(s, workId)))
  ensures (inv(s) ==> canRemoveOwnedWork(s, workId) ==> alwaysSubscriberIdentitiesUnique(removeOwnedWork(s, workId)))
  ensures (inv(s) ==> canRemoveOwnedWork(s, workId) ==> alwaysSubscriberIdentitiesPositive(removeOwnedWork(s, workId)))
  ensures (inv(s) ==> canRemoveOwnedWork(s, workId) ==> alwaysSubscriberFailuresRecorded(removeOwnedWork(s, workId)))
  ensures (inv(s) ==> canRemoveOwnedWork(s, workId) ==> alwaysJoinsAllSubscribers(removeOwnedWork(s, workId)))
  ensures (inv(s) ==> canRemoveOwnedWork(s, workId) ==> alwaysFirstFailureIsReal(removeOwnedWork(s, workId)))
  ensures (inv(s) ==> canRemoveOwnedWork(s, workId) ==> alwaysReportsEmissionFailure(removeOwnedWork(s, workId)))
  ensures (inv(s) ==> canRemoveOwnedWork(s, workId) ==> stepFirstTerminalRequestStays(s, "removeOwnedWork", removeOwnedWork(s, workId)))
  ensures (inv(s) ==> canRemoveOwnedWork(s, workId) ==> stepFirstFailureStays(s, removeOwnedWork(s, workId)))
{
  if inv(s) && canRemoveOwnedWork(s, workId) {
    var after := removeOwnedWork(s, workId);
    TerminalWorkInvariant(s);
    TerminalWorkDistinct(s.works);
    TerminalWorkMapIds(s.works, after.works);
    TerminalWorkDistinct(after.works);
    TerminalWorkInvariant(after);
  }
}

lemma finishDelivery_ensures(s: TerminalState, deliveryId: int, saved: bool)
  ensures (inv(s) ==> canFinishDelivery(s, deliveryId, saved) ==> alwaysDeliveryIdentitiesUnique(finishDelivery(s, deliveryId, saved)))
  ensures (inv(s) ==> canFinishDelivery(s, deliveryId, saved) ==> alwaysEffectIdsUnique(finishDelivery(s, deliveryId, saved)))
  ensures (inv(s) ==> canFinishDelivery(s, deliveryId, saved) ==> alwaysWorkDeliveryCaptured(finishDelivery(s, deliveryId, saved)))
  ensures (inv(s) ==> canFinishDelivery(s, deliveryId, saved) ==> alwaysWorkIdentitiesUnique(finishDelivery(s, deliveryId, saved)))
  ensures (inv(s) ==> canFinishDelivery(s, deliveryId, saved) ==> alwaysDeliveryGatesWork(finishDelivery(s, deliveryId, saved)))
  ensures (inv(s) ==> canFinishDelivery(s, deliveryId, saved) ==> alwaysFailedDeliverySkipsWork(finishDelivery(s, deliveryId, saved)))
  ensures (inv(s) ==> canFinishDelivery(s, deliveryId, saved) ==> alwaysEmitsAfterOwnedWork(finishDelivery(s, deliveryId, saved)))
  ensures (inv(s) ==> canFinishDelivery(s, deliveryId, saved) ==> alwaysCapturedWorkComplete(finishDelivery(s, deliveryId, saved)))
  ensures (inv(s) ==> canFinishDelivery(s, deliveryId, saved) ==> alwaysSubscriberIdentitiesUnique(finishDelivery(s, deliveryId, saved)))
  ensures (inv(s) ==> canFinishDelivery(s, deliveryId, saved) ==> alwaysSubscriberIdentitiesPositive(finishDelivery(s, deliveryId, saved)))
  ensures (inv(s) ==> canFinishDelivery(s, deliveryId, saved) ==> alwaysSubscriberFailuresRecorded(finishDelivery(s, deliveryId, saved)))
  ensures (inv(s) ==> canFinishDelivery(s, deliveryId, saved) ==> alwaysJoinsAllSubscribers(finishDelivery(s, deliveryId, saved)))
  ensures (inv(s) ==> canFinishDelivery(s, deliveryId, saved) ==> alwaysFirstFailureIsReal(finishDelivery(s, deliveryId, saved)))
  ensures (inv(s) ==> canFinishDelivery(s, deliveryId, saved) ==> alwaysReportsEmissionFailure(finishDelivery(s, deliveryId, saved)))
  ensures (inv(s) ==> canFinishDelivery(s, deliveryId, saved) ==> stepFirstTerminalRequestStays(s, "finishDelivery", finishDelivery(s, deliveryId, saved)))
  ensures (inv(s) ==> canFinishDelivery(s, deliveryId, saved) ==> stepFirstFailureStays(s, finishDelivery(s, deliveryId, saved)))
{
  if inv(s) && canFinishDelivery(s, deliveryId, saved) {
    var after := finishDelivery(s, deliveryId, saved);
    TerminalWorkInvariant(s);
    TerminalWorkDistinct(s.works);
    TerminalWorkMapIds(s.works, after.works);
    TerminalWorkDistinct(after.works);
    TerminalWorkInvariant(after);
    TerminalDeliveryInvariant(s);
    TerminalDeliveryDistinct(s.deliveries);
    TerminalDeliveryMapIds(s.deliveries, after.deliveries);
    TerminalDeliveryDistinct(after.deliveries);
    TerminalDeliveryInvariant(after);
    var pending :| pending in s.deliveries && pending.id == deliveryId && pending.state.DeliveryHeld?;
    TerminalDeliveryLookup(s, deliveryId, pending);
    forall i | 0 <= i < |s.works| && s.works[i].afterDelivery ensures deliveryState(after, after.works[i].deliveryId) == (if s.works[i].deliveryId == deliveryId then (if saved then Delivery.DeliverySaved else Delivery.DeliveryFailed) else deliveryState(s, s.works[i].deliveryId)) {
      var w := s.works[i];
      var d :| d in s.deliveries && d.id == w.deliveryId;
      var j :| 0 <= j < |s.deliveries| && s.deliveries[j] == d;
      TerminalDeliveryLookup(s, w.deliveryId, d);
      TerminalDeliveryLookup(after, w.deliveryId, after.deliveries[j]);
    }
  }
}

lemma beginTerminalDrain_ensures(s: TerminalState)
  ensures (inv(s) ==> canBeginTerminalDrain(s) ==> alwaysDeliveryIdentitiesUnique(beginTerminalDrain(s)))
  ensures (inv(s) ==> canBeginTerminalDrain(s) ==> alwaysEffectIdsUnique(beginTerminalDrain(s)))
  ensures (inv(s) ==> canBeginTerminalDrain(s) ==> alwaysWorkDeliveryCaptured(beginTerminalDrain(s)))
  ensures (inv(s) ==> canBeginTerminalDrain(s) ==> alwaysWorkIdentitiesUnique(beginTerminalDrain(s)))
  ensures (inv(s) ==> canBeginTerminalDrain(s) ==> alwaysDeliveryGatesWork(beginTerminalDrain(s)))
  ensures (inv(s) ==> canBeginTerminalDrain(s) ==> alwaysFailedDeliverySkipsWork(beginTerminalDrain(s)))
  ensures (inv(s) ==> canBeginTerminalDrain(s) ==> alwaysEmitsAfterOwnedWork(beginTerminalDrain(s)))
  ensures (inv(s) ==> canBeginTerminalDrain(s) ==> alwaysCapturedWorkComplete(beginTerminalDrain(s)))
  ensures (inv(s) ==> canBeginTerminalDrain(s) ==> alwaysSubscriberIdentitiesUnique(beginTerminalDrain(s)))
  ensures (inv(s) ==> canBeginTerminalDrain(s) ==> alwaysSubscriberIdentitiesPositive(beginTerminalDrain(s)))
  ensures (inv(s) ==> canBeginTerminalDrain(s) ==> alwaysSubscriberFailuresRecorded(beginTerminalDrain(s)))
  ensures (inv(s) ==> canBeginTerminalDrain(s) ==> alwaysJoinsAllSubscribers(beginTerminalDrain(s)))
  ensures (inv(s) ==> canBeginTerminalDrain(s) ==> alwaysFirstFailureIsReal(beginTerminalDrain(s)))
  ensures (inv(s) ==> canBeginTerminalDrain(s) ==> alwaysReportsEmissionFailure(beginTerminalDrain(s)))
  ensures (inv(s) ==> canBeginTerminalDrain(s) ==> stepFirstTerminalRequestStays(s, "beginTerminalDrain", beginTerminalDrain(s)))
  ensures (inv(s) ==> canBeginTerminalDrain(s) ==> stepFirstFailureStays(s, beginTerminalDrain(s)))
{
  if inv(s) && canBeginTerminalDrain(s) {
    var after := beginTerminalDrain(s);
    TerminalCapturedShape(s);
    var kept := ProofLib.Filter((w: OwnedWork) => w.active, s.works);
    forall w | w in s.works && w.active ensures w.id in after.capturedWork {
      ProofLib.FilterMember((w: OwnedWork) => w.active, s.works, w);
      var i :| 0 <= i < |kept| && kept[i] == w;
      assert after.capturedWork[i] == w.id;
    }
  }
}

lemma registerSubscriber_ensures(s: TerminalState, subscriber: int)
  ensures (inv(s) ==> canRegisterSubscriber(s, subscriber) ==> alwaysDeliveryIdentitiesUnique(registerSubscriber(s, subscriber)))
  ensures (inv(s) ==> canRegisterSubscriber(s, subscriber) ==> alwaysEffectIdsUnique(registerSubscriber(s, subscriber)))
  ensures (inv(s) ==> canRegisterSubscriber(s, subscriber) ==> alwaysWorkDeliveryCaptured(registerSubscriber(s, subscriber)))
  ensures (inv(s) ==> canRegisterSubscriber(s, subscriber) ==> alwaysWorkIdentitiesUnique(registerSubscriber(s, subscriber)))
  ensures (inv(s) ==> canRegisterSubscriber(s, subscriber) ==> alwaysDeliveryGatesWork(registerSubscriber(s, subscriber)))
  ensures (inv(s) ==> canRegisterSubscriber(s, subscriber) ==> alwaysFailedDeliverySkipsWork(registerSubscriber(s, subscriber)))
  ensures (inv(s) ==> canRegisterSubscriber(s, subscriber) ==> alwaysEmitsAfterOwnedWork(registerSubscriber(s, subscriber)))
  ensures (inv(s) ==> canRegisterSubscriber(s, subscriber) ==> alwaysCapturedWorkComplete(registerSubscriber(s, subscriber)))
  ensures (inv(s) ==> canRegisterSubscriber(s, subscriber) ==> alwaysSubscriberIdentitiesUnique(registerSubscriber(s, subscriber)))
  ensures (inv(s) ==> canRegisterSubscriber(s, subscriber) ==> alwaysSubscriberIdentitiesPositive(registerSubscriber(s, subscriber)))
  ensures (inv(s) ==> canRegisterSubscriber(s, subscriber) ==> alwaysSubscriberFailuresRecorded(registerSubscriber(s, subscriber)))
  ensures (inv(s) ==> canRegisterSubscriber(s, subscriber) ==> alwaysJoinsAllSubscribers(registerSubscriber(s, subscriber)))
  ensures (inv(s) ==> canRegisterSubscriber(s, subscriber) ==> alwaysFirstFailureIsReal(registerSubscriber(s, subscriber)))
  ensures (inv(s) ==> canRegisterSubscriber(s, subscriber) ==> alwaysReportsEmissionFailure(registerSubscriber(s, subscriber)))
  ensures (inv(s) ==> canRegisterSubscriber(s, subscriber) ==> stepFirstTerminalRequestStays(s, "registerSubscriber", registerSubscriber(s, subscriber)))
  ensures (inv(s) ==> canRegisterSubscriber(s, subscriber) ==> stepFirstFailureStays(s, registerSubscriber(s, subscriber)))
{
  if inv(s) && canRegisterSubscriber(s, subscriber) {
    var after := registerSubscriber(s, subscriber);
    TerminalSubscriberInvariant(s);
    TerminalSubscriberDistinct(s.subscribers);
    ProofLib.DistinctByConcat(s.subscribers, [Subscriber(subscriber, 0)], (entry: Subscriber) => entry.id);
    TerminalSubscriberDistinct(after.subscribers);
    TerminalSubscriberInvariant(after);
  }
}

lemma emitTerminal_ensures(s: TerminalState)
  ensures (inv(s) ==> canEmitTerminal(s) ==> alwaysDeliveryIdentitiesUnique(emitTerminal(s)))
  ensures (inv(s) ==> canEmitTerminal(s) ==> alwaysEffectIdsUnique(emitTerminal(s)))
  ensures (inv(s) ==> canEmitTerminal(s) ==> alwaysWorkDeliveryCaptured(emitTerminal(s)))
  ensures (inv(s) ==> canEmitTerminal(s) ==> alwaysWorkIdentitiesUnique(emitTerminal(s)))
  ensures (inv(s) ==> canEmitTerminal(s) ==> alwaysDeliveryGatesWork(emitTerminal(s)))
  ensures (inv(s) ==> canEmitTerminal(s) ==> alwaysFailedDeliverySkipsWork(emitTerminal(s)))
  ensures (inv(s) ==> canEmitTerminal(s) ==> alwaysEmitsAfterOwnedWork(emitTerminal(s)))
  ensures (inv(s) ==> canEmitTerminal(s) ==> alwaysCapturedWorkComplete(emitTerminal(s)))
  ensures (inv(s) ==> canEmitTerminal(s) ==> alwaysSubscriberIdentitiesUnique(emitTerminal(s)))
  ensures (inv(s) ==> canEmitTerminal(s) ==> alwaysSubscriberIdentitiesPositive(emitTerminal(s)))
  ensures (inv(s) ==> canEmitTerminal(s) ==> alwaysSubscriberFailuresRecorded(emitTerminal(s)))
  ensures (inv(s) ==> canEmitTerminal(s) ==> alwaysJoinsAllSubscribers(emitTerminal(s)))
  ensures (inv(s) ==> canEmitTerminal(s) ==> alwaysFirstFailureIsReal(emitTerminal(s)))
  ensures (inv(s) ==> canEmitTerminal(s) ==> alwaysReportsEmissionFailure(emitTerminal(s)))
  ensures (inv(s) ==> canEmitTerminal(s) ==> stepFirstTerminalRequestStays(s, "emitTerminal", emitTerminal(s)))
  ensures (inv(s) ==> canEmitTerminal(s) ==> stepFirstFailureStays(s, emitTerminal(s)))
{
  if inv(s) && canEmitTerminal(s) {
    forall w | w in s.works ensures !w.active {
      if w.active {
        var doneWork :| doneWork in s.works && doneWork.id == w.id && !doneWork.active;
        TerminalWorkSameId(s, w, doneWork);
      }
    }
  }
}

lemma settleSubscriber_ensures(s: TerminalState, subscriber: int, ok: bool)
  ensures (inv(s) ==> canSettleSubscriber(s, subscriber, ok) ==> alwaysDeliveryIdentitiesUnique(settleSubscriber(s, subscriber, ok)))
  ensures (inv(s) ==> canSettleSubscriber(s, subscriber, ok) ==> alwaysEffectIdsUnique(settleSubscriber(s, subscriber, ok)))
  ensures (inv(s) ==> canSettleSubscriber(s, subscriber, ok) ==> alwaysWorkDeliveryCaptured(settleSubscriber(s, subscriber, ok)))
  ensures (inv(s) ==> canSettleSubscriber(s, subscriber, ok) ==> alwaysWorkIdentitiesUnique(settleSubscriber(s, subscriber, ok)))
  ensures (inv(s) ==> canSettleSubscriber(s, subscriber, ok) ==> alwaysDeliveryGatesWork(settleSubscriber(s, subscriber, ok)))
  ensures (inv(s) ==> canSettleSubscriber(s, subscriber, ok) ==> alwaysFailedDeliverySkipsWork(settleSubscriber(s, subscriber, ok)))
  ensures (inv(s) ==> canSettleSubscriber(s, subscriber, ok) ==> alwaysEmitsAfterOwnedWork(settleSubscriber(s, subscriber, ok)))
  ensures (inv(s) ==> canSettleSubscriber(s, subscriber, ok) ==> alwaysCapturedWorkComplete(settleSubscriber(s, subscriber, ok)))
  ensures (inv(s) ==> canSettleSubscriber(s, subscriber, ok) ==> alwaysSubscriberIdentitiesUnique(settleSubscriber(s, subscriber, ok)))
  ensures (inv(s) ==> canSettleSubscriber(s, subscriber, ok) ==> alwaysSubscriberIdentitiesPositive(settleSubscriber(s, subscriber, ok)))
  ensures (inv(s) ==> canSettleSubscriber(s, subscriber, ok) ==> alwaysSubscriberFailuresRecorded(settleSubscriber(s, subscriber, ok)))
  ensures (inv(s) ==> canSettleSubscriber(s, subscriber, ok) ==> alwaysJoinsAllSubscribers(settleSubscriber(s, subscriber, ok)))
  ensures (inv(s) ==> canSettleSubscriber(s, subscriber, ok) ==> alwaysFirstFailureIsReal(settleSubscriber(s, subscriber, ok)))
  ensures (inv(s) ==> canSettleSubscriber(s, subscriber, ok) ==> alwaysReportsEmissionFailure(settleSubscriber(s, subscriber, ok)))
  ensures (inv(s) ==> canSettleSubscriber(s, subscriber, ok) ==> stepFirstTerminalRequestStays(s, "settleSubscriber", settleSubscriber(s, subscriber, ok)))
  ensures (inv(s) ==> canSettleSubscriber(s, subscriber, ok) ==> stepFirstFailureStays(s, settleSubscriber(s, subscriber, ok)))
{
  if inv(s) && canSettleSubscriber(s, subscriber, ok) {
    var after := settleSubscriber(s, subscriber, ok);
    TerminalSubscriberInvariant(s);
    TerminalSubscriberDistinct(s.subscribers);
    TerminalSubscriberMapIds(s.subscribers, after.subscribers);
    TerminalSubscriberDistinct(after.subscribers);
    TerminalSubscriberInvariant(after);
    var pending :| pending in s.subscribers && pending.id == subscriber && pending.result == 0;
    if s.firstFailure != 0 {
      var failed :| failed in s.subscribers && failed.id == s.firstFailure && failed.result == 2;
      if failed.id == subscriber { TerminalSubscriberSameId(s, failed, pending); }
      var i :| 0 <= i < |s.subscribers| && s.subscribers[i] == failed;
      assert after.subscribers[i].id == s.firstFailure && after.subscribers[i].result == 2;
    } else if !ok {
      var i :| 0 <= i < |s.subscribers| && s.subscribers[i] == pending;
      assert after.subscribers[i].id == subscriber && after.subscribers[i].result == 2;
    }
  }
}

lemma TerminalEffectsDistinct(entries: seq<EffectEntry>)
  ensures (forall receipt :: receipt in entries ==> |ProofLib.Filter((other: EffectEntry) => (other.id == receipt.id), entries)| == 1) <==> ProofLib.DistinctBy(entries, (receipt: EffectEntry) => receipt.id)
{
  if forall receipt :: receipt in entries ==> |ProofLib.Filter((other: EffectEntry) => (other.id == receipt.id), entries)| == 1 {
    forall i, j | 0 <= i < |entries| && 0 <= j < |entries| && i != j ensures entries[i].id != entries[j].id {
      ProofLib.FilterCountOneIffUnique((other: EffectEntry) => (other.id == entries[i].id), entries, (receipt: EffectEntry) => receipt.id, i);
    }
  } else if ProofLib.DistinctBy(entries, (receipt: EffectEntry) => receipt.id) {
    forall receipt | receipt in entries ensures |ProofLib.Filter((other: EffectEntry) => (other.id == receipt.id), entries)| == 1 {
      var i :| 0 <= i < |entries| && entries[i] == receipt;
      ProofLib.FilterOne((other: EffectEntry) => (other.id == receipt.id), entries, i);
    }
  }
}

lemma TerminalMergeShape(oldEffects: seq<EffectEntry>, incoming: seq<EffectEntry>)
  ensures mergedEffects(oldEffects, incoming) == oldEffects + ProofLib.Filter((receipt: EffectEntry) => !((exists other :: other in oldEffects && (other.id == receipt.id))), incoming)
  ensures compatibleEffects(oldEffects, incoming) ==> (forall receipt :: receipt in incoming ==> |ProofLib.Filter((other: EffectEntry) => (other.id == receipt.id), incoming)| == 1)
{}

lemma TerminalEffectInvariant(s: TerminalState)
  ensures alwaysEffectIdsUnique(s) == (forall receipt :: receipt in s.effects ==> |ProofLib.Filter((other: EffectEntry) => (other.id == receipt.id), s.effects)| == 1)
{}

lemma TerminalMergeUnique(oldEffects: seq<EffectEntry>, incoming: seq<EffectEntry>)
  requires ProofLib.DistinctBy(oldEffects, (receipt: EffectEntry) => receipt.id)
  requires compatibleEffects(oldEffects, incoming)
  ensures ProofLib.DistinctBy(mergedEffects(oldEffects, incoming), (receipt: EffectEntry) => receipt.id)
  ensures forall receipt :: receipt in mergedEffects(oldEffects, incoming) ==> |ProofLib.Filter((other: EffectEntry) => (other.id == receipt.id), mergedEffects(oldEffects, incoming))| == 1
{
  TerminalMergeShape(oldEffects, incoming);
  TerminalEffectsDistinct(incoming);
  var kept := ProofLib.Filter((receipt: EffectEntry) => !((exists other :: other in oldEffects && (other.id == receipt.id))), incoming);
  ProofLib.FilterKeepsDistinctBy((receipt: EffectEntry) => !((exists other :: other in oldEffects && (other.id == receipt.id))), incoming, (receipt: EffectEntry) => receipt.id);
  forall existing, added | existing in oldEffects && added in kept ensures existing.id != added.id {
    ProofLib.FilterMember((receipt: EffectEntry) => !((exists other :: other in oldEffects && (other.id == receipt.id))), incoming, added);
  }
  ProofLib.DistinctByConcat(oldEffects, kept, (receipt: EffectEntry) => receipt.id);
  TerminalEffectsDistinct(mergedEffects(oldEffects, incoming));
}

lemma TerminalWorkInvariant(s: TerminalState)
  ensures alwaysWorkIdentitiesUnique(s) == (forall w :: w in s.works ==> |ProofLib.Filter((other: OwnedWork) => (other.id == w.id), s.works)| == 1)
{}

lemma TerminalWorkDistinct(entries: seq<OwnedWork>)
  ensures (forall w :: w in entries ==> |ProofLib.Filter((other: OwnedWork) => (other.id == w.id), entries)| == 1) <==> ProofLib.DistinctBy(entries, (entry: OwnedWork) => entry.id)
{
  if forall w :: w in entries ==> |ProofLib.Filter((other: OwnedWork) => (other.id == w.id), entries)| == 1 {
    forall i, j | 0 <= i < |entries| && 0 <= j < |entries| && i != j ensures entries[i].id != entries[j].id {
      ProofLib.FilterCountOneIffUnique((other: OwnedWork) => (other.id == entries[i].id), entries, (entry: OwnedWork) => entry.id, i);
    }
  } else if ProofLib.DistinctBy(entries, (entry: OwnedWork) => entry.id) {
    forall w | w in entries ensures |ProofLib.Filter((other: OwnedWork) => (other.id == w.id), entries)| == 1 {
      var i :| 0 <= i < |entries| && entries[i] == w;
      ProofLib.FilterOne((other: OwnedWork) => (other.id == w.id), entries, i);
    }
  }
}

lemma TerminalWorkMapIds(before: seq<OwnedWork>, after: seq<OwnedWork>)
  requires |before| == |after|
  requires forall i :: 0 <= i < |before| ==> before[i].id == after[i].id
  requires ProofLib.DistinctBy(before, (entry: OwnedWork) => entry.id)
  ensures ProofLib.DistinctBy(after, (entry: OwnedWork) => entry.id)
{
  forall i, j | 0 <= i < |after| && 0 <= j < |after| && i != j ensures after[i].id != after[j].id {}
}

lemma TerminalWorkSameId(s: TerminalState, a: OwnedWork, b: OwnedWork)
  requires alwaysWorkIdentitiesUnique(s)
  requires a in s.works && b in s.works && a.id == b.id
  ensures a == b
{
  TerminalWorkInvariant(s);
  TerminalWorkDistinct(s.works);
  var i :| 0 <= i < |s.works| && s.works[i] == a;
  var j :| 0 <= j < |s.works| && s.works[j] == b;
  assert i == j;
}

lemma TerminalDeliveryInvariant(s: TerminalState)
  ensures alwaysDeliveryIdentitiesUnique(s) == (forall d :: d in s.deliveries ==> |ProofLib.Filter((other: DeliveryPromise) => (other.id == d.id), s.deliveries)| == 1)
{}

lemma TerminalDeliveryDistinct(entries: seq<DeliveryPromise>)
  ensures (forall d :: d in entries ==> |ProofLib.Filter((other: DeliveryPromise) => (other.id == d.id), entries)| == 1) <==> ProofLib.DistinctBy(entries, (entry: DeliveryPromise) => entry.id)
{
  if forall d :: d in entries ==> |ProofLib.Filter((other: DeliveryPromise) => (other.id == d.id), entries)| == 1 {
    forall i, j | 0 <= i < |entries| && 0 <= j < |entries| && i != j ensures entries[i].id != entries[j].id {
      ProofLib.FilterCountOneIffUnique((other: DeliveryPromise) => (other.id == entries[i].id), entries, (entry: DeliveryPromise) => entry.id, i);
    }
  } else if ProofLib.DistinctBy(entries, (entry: DeliveryPromise) => entry.id) {
    forall d | d in entries ensures |ProofLib.Filter((other: DeliveryPromise) => (other.id == d.id), entries)| == 1 {
      var i :| 0 <= i < |entries| && entries[i] == d;
      ProofLib.FilterOne((other: DeliveryPromise) => (other.id == d.id), entries, i);
    }
  }
}

lemma TerminalDeliveryMapIds(before: seq<DeliveryPromise>, after: seq<DeliveryPromise>)
  requires |before| == |after|
  requires forall i :: 0 <= i < |before| ==> before[i].id == after[i].id
  requires ProofLib.DistinctBy(before, (entry: DeliveryPromise) => entry.id)
  ensures ProofLib.DistinctBy(after, (entry: DeliveryPromise) => entry.id)
{
  forall i, j | 0 <= i < |after| && 0 <= j < |after| && i != j ensures after[i].id != after[j].id {}
}

lemma TerminalDeliverySameId(s: TerminalState, a: DeliveryPromise, b: DeliveryPromise)
  requires alwaysDeliveryIdentitiesUnique(s)
  requires a in s.deliveries && b in s.deliveries && a.id == b.id
  ensures a == b
{
  TerminalDeliveryInvariant(s);
  TerminalDeliveryDistinct(s.deliveries);
  var i :| 0 <= i < |s.deliveries| && s.deliveries[i] == a;
  var j :| 0 <= j < |s.deliveries| && s.deliveries[j] == b;
  assert i == j;
}

lemma TerminalSubscriberInvariant(s: TerminalState)
  ensures alwaysSubscriberIdentitiesUnique(s) == (forall h :: h in s.subscribers ==> |ProofLib.Filter((other: Subscriber) => (other.id == h.id), s.subscribers)| == 1)
{}

lemma TerminalSubscriberDistinct(entries: seq<Subscriber>)
  ensures (forall h :: h in entries ==> |ProofLib.Filter((other: Subscriber) => (other.id == h.id), entries)| == 1) <==> ProofLib.DistinctBy(entries, (entry: Subscriber) => entry.id)
{
  if forall h :: h in entries ==> |ProofLib.Filter((other: Subscriber) => (other.id == h.id), entries)| == 1 {
    forall i, j | 0 <= i < |entries| && 0 <= j < |entries| && i != j ensures entries[i].id != entries[j].id {
      ProofLib.FilterCountOneIffUnique((other: Subscriber) => (other.id == entries[i].id), entries, (entry: Subscriber) => entry.id, i);
    }
  } else if ProofLib.DistinctBy(entries, (entry: Subscriber) => entry.id) {
    forall h | h in entries ensures |ProofLib.Filter((other: Subscriber) => (other.id == h.id), entries)| == 1 {
      var i :| 0 <= i < |entries| && entries[i] == h;
      ProofLib.FilterOne((other: Subscriber) => (other.id == h.id), entries, i);
    }
  }
}

lemma TerminalSubscriberMapIds(before: seq<Subscriber>, after: seq<Subscriber>)
  requires |before| == |after|
  requires forall i :: 0 <= i < |before| ==> before[i].id == after[i].id
  requires ProofLib.DistinctBy(before, (entry: Subscriber) => entry.id)
  ensures ProofLib.DistinctBy(after, (entry: Subscriber) => entry.id)
{
  forall i, j | 0 <= i < |after| && 0 <= j < |after| && i != j ensures after[i].id != after[j].id {}
}

lemma TerminalSubscriberSameId(s: TerminalState, a: Subscriber, b: Subscriber)
  requires alwaysSubscriberIdentitiesUnique(s)
  requires a in s.subscribers && b in s.subscribers && a.id == b.id
  ensures a == b
{
  TerminalSubscriberInvariant(s);
  TerminalSubscriberDistinct(s.subscribers);
  var i :| 0 <= i < |s.subscribers| && s.subscribers[i] == a;
  var j :| 0 <= j < |s.subscribers| && s.subscribers[j] == b;
  assert i == j;
}

lemma TerminalDeliveryLookup(s: TerminalState, deliveryId: int, chosen: DeliveryPromise)
  requires alwaysDeliveryIdentitiesUnique(s)
  requires chosen in s.deliveries && chosen.id == deliveryId
  ensures deliveryState(s, deliveryId) == chosen.state
{
  TerminalDeliveryLookupShape(s, deliveryId);
  TerminalDeliveryInvariant(s);
  TerminalDeliveryDistinct(s.deliveries);
  var i :| 0 <= i < |s.deliveries| && s.deliveries[i] == chosen;
  ProofLib.FilterOne((d: DeliveryPromise) => (d.id == deliveryId), s.deliveries, i);
  ProofLib.FilterMember((d: DeliveryPromise) => (d.id == deliveryId), s.deliveries, chosen);
  var selected := ProofLib.Filter((d: DeliveryPromise) => (d.id == deliveryId), s.deliveries);
  assert |selected| == 1 && chosen in selected;
  assert selected[0] == chosen;
}

lemma TerminalDeliveryLookupShape(s: TerminalState, deliveryId: int)
  ensures deliveryState(s, deliveryId) == (if |ProofLib.Filter((d: DeliveryPromise) => (d.id == deliveryId), s.deliveries)| > 0 then ProofLib.Filter((d: DeliveryPromise) => (d.id == deliveryId), s.deliveries)[0].state else Delivery.DeliveryHeld)
{}

lemma TerminalCapturedShape(s: TerminalState)
  ensures beginTerminalDrain(s).capturedWork == seq(|ProofLib.Filter((w: OwnedWork) => w.active, s.works)|, i requires 0 <= i < |ProofLib.Filter((w: OwnedWork) => w.active, s.works)| => ProofLib.Filter((w: OwnedWork) => w.active, s.works)[i].id)
{}
