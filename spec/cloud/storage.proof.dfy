lemma claimPut_ensures(o: StoredObjects, worker: int, recovery: bool)
  ensures (inv(o) ==> canClaimPut(o, worker, recovery) ==> alwaysCatalogMeansCommitted(claimPut(o, worker, recovery)))
  ensures (inv(o) ==> canClaimPut(o, worker, recovery) ==> alwaysQuotaHeldUntilRefund(claimPut(o, worker, recovery)))
  ensures (inv(o) ==> canClaimPut(o, worker, recovery) ==> alwaysCommittedObjectIsSettled(claimPut(o, worker, recovery)))
  ensures (inv(o) ==> canClaimPut(o, worker, recovery) ==> alwaysRefundHoldsNoCredit(claimPut(o, worker, recovery)))
  ensures (inv(o) ==> canClaimPut(o, worker, recovery) ==> alwaysReceiptExactlyWhenTerminal(claimPut(o, worker, recovery)))
  ensures (inv(o) ==> canClaimPut(o, worker, recovery) ==> alwaysUnreservedUploadHoldsNoCredit(claimPut(o, worker, recovery)))
  ensures (inv(o) ==> canClaimPut(o, worker, recovery) ==> alwaysLeasedUploadHasAToken(claimPut(o, worker, recovery)))
  ensures (inv(o) ==> canClaimPut(o, worker, recovery) ==> alwaysWorkersHoldNoFutureToken(claimPut(o, worker, recovery)))
  ensures (inv(o) ==> canClaimPut(o, worker, recovery) ==> alwaysEachWorkerKeepsItsSlot(claimPut(o, worker, recovery)))
  ensures (inv(o) ==> canClaimPut(o, worker, recovery) ==> alwaysOnlyAWriterSends(claimPut(o, worker, recovery)))
  ensures (inv(o) ==> canClaimPut(o, worker, recovery) ==> alwaysAtMostOneWorkerOwnsTheLease(claimPut(o, worker, recovery)))
  ensures (inv(o) ==> canClaimPut(o, worker, recovery) ==> alwaysAbsenceOnlyForASentUpload(claimPut(o, worker, recovery)))
  ensures (inv(o) ==> canClaimPut(o, worker, recovery) ==> alwaysUnsentRecoveryIsReconciling(claimPut(o, worker, recovery)))
  ensures (inv(o) ==> canClaimPut(o, worker, recovery) ==> alwaysSentRefundSawTwoAbsences(claimPut(o, worker, recovery)))
  ensures (inv(o) ==> canClaimPut(o, worker, recovery) ==> alwaysSeenObjectIsAtTheProvider(claimPut(o, worker, recovery)))
  ensures (inv(o) ==> canClaimPut(o, worker, recovery) ==> alwaysDocumentIsWhole(claimPut(o, worker, recovery)))
  ensures (inv(o) ==> canClaimPut(o, worker, recovery) ==> alwaysDeletedDocumentIsGone(claimPut(o, worker, recovery)))
  ensures (inv(o) ==> canClaimPut(o, worker, recovery) ==> alwaysCreatingDocumentIsNotDeleted(claimPut(o, worker, recovery)))
  ensures (inv(o) ==> canClaimPut(o, worker, recovery) ==> stepTerminalUploadIsFinal(o, claimPut(o, worker, recovery)))
{
  if inv(o) && canClaimPut(o, worker, recovery) {
    var a := claimPut(o, worker, recovery);
    assert alwaysEachWorkerKeepsItsSlot(a);
    Slots(o, worker);
    Slots(a, worker);
  }
}

lemma observeHead_ensures(o: StoredObjects, worker: int)
  ensures (inv(o) ==> canObserveHead(o, worker) ==> alwaysCatalogMeansCommitted(observeHead(o, worker)))
  ensures (inv(o) ==> canObserveHead(o, worker) ==> alwaysQuotaHeldUntilRefund(observeHead(o, worker)))
  ensures (inv(o) ==> canObserveHead(o, worker) ==> alwaysCommittedObjectIsSettled(observeHead(o, worker)))
  ensures (inv(o) ==> canObserveHead(o, worker) ==> alwaysRefundHoldsNoCredit(observeHead(o, worker)))
  ensures (inv(o) ==> canObserveHead(o, worker) ==> alwaysReceiptExactlyWhenTerminal(observeHead(o, worker)))
  ensures (inv(o) ==> canObserveHead(o, worker) ==> alwaysUnreservedUploadHoldsNoCredit(observeHead(o, worker)))
  ensures (inv(o) ==> canObserveHead(o, worker) ==> alwaysLeasedUploadHasAToken(observeHead(o, worker)))
  ensures (inv(o) ==> canObserveHead(o, worker) ==> alwaysWorkersHoldNoFutureToken(observeHead(o, worker)))
  ensures (inv(o) ==> canObserveHead(o, worker) ==> alwaysEachWorkerKeepsItsSlot(observeHead(o, worker)))
  ensures (inv(o) ==> canObserveHead(o, worker) ==> alwaysOnlyAWriterSends(observeHead(o, worker)))
  ensures (inv(o) ==> canObserveHead(o, worker) ==> alwaysAtMostOneWorkerOwnsTheLease(observeHead(o, worker)))
  ensures (inv(o) ==> canObserveHead(o, worker) ==> alwaysAbsenceOnlyForASentUpload(observeHead(o, worker)))
  ensures (inv(o) ==> canObserveHead(o, worker) ==> alwaysUnsentRecoveryIsReconciling(observeHead(o, worker)))
  ensures (inv(o) ==> canObserveHead(o, worker) ==> alwaysSentRefundSawTwoAbsences(observeHead(o, worker)))
  ensures (inv(o) ==> canObserveHead(o, worker) ==> alwaysSeenObjectIsAtTheProvider(observeHead(o, worker)))
  ensures (inv(o) ==> canObserveHead(o, worker) ==> alwaysDocumentIsWhole(observeHead(o, worker)))
  ensures (inv(o) ==> canObserveHead(o, worker) ==> alwaysDeletedDocumentIsGone(observeHead(o, worker)))
  ensures (inv(o) ==> canObserveHead(o, worker) ==> alwaysCreatingDocumentIsNotDeleted(observeHead(o, worker)))
  ensures (inv(o) ==> canObserveHead(o, worker) ==> stepTerminalUploadIsFinal(o, observeHead(o, worker)))
{
  if inv(o) && canObserveHead(o, worker) {
    var a := observeHead(o, worker);
    assert alwaysEachWorkerKeepsItsSlot(a);
    Slots(o, worker);
    Slots(a, worker);
  }
}

lemma abandonWork_ensures(o: StoredObjects, worker: int)
  ensures (inv(o) ==> canAbandonWork(o, worker) ==> alwaysCatalogMeansCommitted(abandonWork(o, worker)))
  ensures (inv(o) ==> canAbandonWork(o, worker) ==> alwaysQuotaHeldUntilRefund(abandonWork(o, worker)))
  ensures (inv(o) ==> canAbandonWork(o, worker) ==> alwaysCommittedObjectIsSettled(abandonWork(o, worker)))
  ensures (inv(o) ==> canAbandonWork(o, worker) ==> alwaysRefundHoldsNoCredit(abandonWork(o, worker)))
  ensures (inv(o) ==> canAbandonWork(o, worker) ==> alwaysReceiptExactlyWhenTerminal(abandonWork(o, worker)))
  ensures (inv(o) ==> canAbandonWork(o, worker) ==> alwaysUnreservedUploadHoldsNoCredit(abandonWork(o, worker)))
  ensures (inv(o) ==> canAbandonWork(o, worker) ==> alwaysLeasedUploadHasAToken(abandonWork(o, worker)))
  ensures (inv(o) ==> canAbandonWork(o, worker) ==> alwaysWorkersHoldNoFutureToken(abandonWork(o, worker)))
  ensures (inv(o) ==> canAbandonWork(o, worker) ==> alwaysEachWorkerKeepsItsSlot(abandonWork(o, worker)))
  ensures (inv(o) ==> canAbandonWork(o, worker) ==> alwaysOnlyAWriterSends(abandonWork(o, worker)))
  ensures (inv(o) ==> canAbandonWork(o, worker) ==> alwaysAtMostOneWorkerOwnsTheLease(abandonWork(o, worker)))
  ensures (inv(o) ==> canAbandonWork(o, worker) ==> alwaysAbsenceOnlyForASentUpload(abandonWork(o, worker)))
  ensures (inv(o) ==> canAbandonWork(o, worker) ==> alwaysUnsentRecoveryIsReconciling(abandonWork(o, worker)))
  ensures (inv(o) ==> canAbandonWork(o, worker) ==> alwaysSentRefundSawTwoAbsences(abandonWork(o, worker)))
  ensures (inv(o) ==> canAbandonWork(o, worker) ==> alwaysSeenObjectIsAtTheProvider(abandonWork(o, worker)))
  ensures (inv(o) ==> canAbandonWork(o, worker) ==> alwaysDocumentIsWhole(abandonWork(o, worker)))
  ensures (inv(o) ==> canAbandonWork(o, worker) ==> alwaysDeletedDocumentIsGone(abandonWork(o, worker)))
  ensures (inv(o) ==> canAbandonWork(o, worker) ==> alwaysCreatingDocumentIsNotDeleted(abandonWork(o, worker)))
  ensures (inv(o) ==> canAbandonWork(o, worker) ==> stepTerminalUploadIsFinal(o, abandonWork(o, worker)))
{
  if inv(o) && canAbandonWork(o, worker) {
    var a := abandonWork(o, worker);
    assert alwaysEachWorkerKeepsItsSlot(a);
    Slots(o, worker);
    Slots(a, worker);
  }
}

lemma deferAbsence_ensures(o: StoredObjects, worker: int)
  ensures (inv(o) ==> canDeferAbsence(o, worker) ==> alwaysCatalogMeansCommitted(deferAbsence(o, worker)))
  ensures (inv(o) ==> canDeferAbsence(o, worker) ==> alwaysQuotaHeldUntilRefund(deferAbsence(o, worker)))
  ensures (inv(o) ==> canDeferAbsence(o, worker) ==> alwaysCommittedObjectIsSettled(deferAbsence(o, worker)))
  ensures (inv(o) ==> canDeferAbsence(o, worker) ==> alwaysRefundHoldsNoCredit(deferAbsence(o, worker)))
  ensures (inv(o) ==> canDeferAbsence(o, worker) ==> alwaysReceiptExactlyWhenTerminal(deferAbsence(o, worker)))
  ensures (inv(o) ==> canDeferAbsence(o, worker) ==> alwaysUnreservedUploadHoldsNoCredit(deferAbsence(o, worker)))
  ensures (inv(o) ==> canDeferAbsence(o, worker) ==> alwaysLeasedUploadHasAToken(deferAbsence(o, worker)))
  ensures (inv(o) ==> canDeferAbsence(o, worker) ==> alwaysWorkersHoldNoFutureToken(deferAbsence(o, worker)))
  ensures (inv(o) ==> canDeferAbsence(o, worker) ==> alwaysEachWorkerKeepsItsSlot(deferAbsence(o, worker)))
  ensures (inv(o) ==> canDeferAbsence(o, worker) ==> alwaysOnlyAWriterSends(deferAbsence(o, worker)))
  ensures (inv(o) ==> canDeferAbsence(o, worker) ==> alwaysAtMostOneWorkerOwnsTheLease(deferAbsence(o, worker)))
  ensures (inv(o) ==> canDeferAbsence(o, worker) ==> alwaysAbsenceOnlyForASentUpload(deferAbsence(o, worker)))
  ensures (inv(o) ==> canDeferAbsence(o, worker) ==> alwaysUnsentRecoveryIsReconciling(deferAbsence(o, worker)))
  ensures (inv(o) ==> canDeferAbsence(o, worker) ==> alwaysSentRefundSawTwoAbsences(deferAbsence(o, worker)))
  ensures (inv(o) ==> canDeferAbsence(o, worker) ==> alwaysSeenObjectIsAtTheProvider(deferAbsence(o, worker)))
  ensures (inv(o) ==> canDeferAbsence(o, worker) ==> alwaysDocumentIsWhole(deferAbsence(o, worker)))
  ensures (inv(o) ==> canDeferAbsence(o, worker) ==> alwaysDeletedDocumentIsGone(deferAbsence(o, worker)))
  ensures (inv(o) ==> canDeferAbsence(o, worker) ==> alwaysCreatingDocumentIsNotDeleted(deferAbsence(o, worker)))
  ensures (inv(o) ==> canDeferAbsence(o, worker) ==> stepTerminalUploadIsFinal(o, deferAbsence(o, worker)))
{
  if inv(o) && canDeferAbsence(o, worker) {
    var a := deferAbsence(o, worker);
    assert alwaysEachWorkerKeepsItsSlot(a);
    Slots(o, worker);
    Slots(a, worker);
  }
}

lemma commitPut_ensures(o: StoredObjects, worker: int)
  ensures (inv(o) ==> canCommitPut(o, worker) ==> alwaysCatalogMeansCommitted(commitPut(o, worker)))
  ensures (inv(o) ==> canCommitPut(o, worker) ==> alwaysQuotaHeldUntilRefund(commitPut(o, worker)))
  ensures (inv(o) ==> canCommitPut(o, worker) ==> alwaysCommittedObjectIsSettled(commitPut(o, worker)))
  ensures (inv(o) ==> canCommitPut(o, worker) ==> alwaysRefundHoldsNoCredit(commitPut(o, worker)))
  ensures (inv(o) ==> canCommitPut(o, worker) ==> alwaysReceiptExactlyWhenTerminal(commitPut(o, worker)))
  ensures (inv(o) ==> canCommitPut(o, worker) ==> alwaysUnreservedUploadHoldsNoCredit(commitPut(o, worker)))
  ensures (inv(o) ==> canCommitPut(o, worker) ==> alwaysLeasedUploadHasAToken(commitPut(o, worker)))
  ensures (inv(o) ==> canCommitPut(o, worker) ==> alwaysWorkersHoldNoFutureToken(commitPut(o, worker)))
  ensures (inv(o) ==> canCommitPut(o, worker) ==> alwaysEachWorkerKeepsItsSlot(commitPut(o, worker)))
  ensures (inv(o) ==> canCommitPut(o, worker) ==> alwaysOnlyAWriterSends(commitPut(o, worker)))
  ensures (inv(o) ==> canCommitPut(o, worker) ==> alwaysAtMostOneWorkerOwnsTheLease(commitPut(o, worker)))
  ensures (inv(o) ==> canCommitPut(o, worker) ==> alwaysAbsenceOnlyForASentUpload(commitPut(o, worker)))
  ensures (inv(o) ==> canCommitPut(o, worker) ==> alwaysUnsentRecoveryIsReconciling(commitPut(o, worker)))
  ensures (inv(o) ==> canCommitPut(o, worker) ==> alwaysSentRefundSawTwoAbsences(commitPut(o, worker)))
  ensures (inv(o) ==> canCommitPut(o, worker) ==> alwaysSeenObjectIsAtTheProvider(commitPut(o, worker)))
  ensures (inv(o) ==> canCommitPut(o, worker) ==> alwaysDocumentIsWhole(commitPut(o, worker)))
  ensures (inv(o) ==> canCommitPut(o, worker) ==> alwaysDeletedDocumentIsGone(commitPut(o, worker)))
  ensures (inv(o) ==> canCommitPut(o, worker) ==> alwaysCreatingDocumentIsNotDeleted(commitPut(o, worker)))
  ensures (inv(o) ==> canCommitPut(o, worker) ==> stepTerminalUploadIsFinal(o, commitPut(o, worker)))
{
  if inv(o) && canCommitPut(o, worker) {
    var a := commitPut(o, worker);
    assert alwaysEachWorkerKeepsItsSlot(a);
    Slots(o, worker);
    Slots(a, worker);
  }
}

lemma refundPut_ensures(o: StoredObjects, worker: int)
  ensures (inv(o) ==> canRefundPut(o, worker) ==> alwaysCatalogMeansCommitted(refundPut(o, worker)))
  ensures (inv(o) ==> canRefundPut(o, worker) ==> alwaysQuotaHeldUntilRefund(refundPut(o, worker)))
  ensures (inv(o) ==> canRefundPut(o, worker) ==> alwaysCommittedObjectIsSettled(refundPut(o, worker)))
  ensures (inv(o) ==> canRefundPut(o, worker) ==> alwaysRefundHoldsNoCredit(refundPut(o, worker)))
  ensures (inv(o) ==> canRefundPut(o, worker) ==> alwaysReceiptExactlyWhenTerminal(refundPut(o, worker)))
  ensures (inv(o) ==> canRefundPut(o, worker) ==> alwaysUnreservedUploadHoldsNoCredit(refundPut(o, worker)))
  ensures (inv(o) ==> canRefundPut(o, worker) ==> alwaysLeasedUploadHasAToken(refundPut(o, worker)))
  ensures (inv(o) ==> canRefundPut(o, worker) ==> alwaysWorkersHoldNoFutureToken(refundPut(o, worker)))
  ensures (inv(o) ==> canRefundPut(o, worker) ==> alwaysEachWorkerKeepsItsSlot(refundPut(o, worker)))
  ensures (inv(o) ==> canRefundPut(o, worker) ==> alwaysOnlyAWriterSends(refundPut(o, worker)))
  ensures (inv(o) ==> canRefundPut(o, worker) ==> alwaysAtMostOneWorkerOwnsTheLease(refundPut(o, worker)))
  ensures (inv(o) ==> canRefundPut(o, worker) ==> alwaysAbsenceOnlyForASentUpload(refundPut(o, worker)))
  ensures (inv(o) ==> canRefundPut(o, worker) ==> alwaysUnsentRecoveryIsReconciling(refundPut(o, worker)))
  ensures (inv(o) ==> canRefundPut(o, worker) ==> alwaysSentRefundSawTwoAbsences(refundPut(o, worker)))
  ensures (inv(o) ==> canRefundPut(o, worker) ==> alwaysSeenObjectIsAtTheProvider(refundPut(o, worker)))
  ensures (inv(o) ==> canRefundPut(o, worker) ==> alwaysDocumentIsWhole(refundPut(o, worker)))
  ensures (inv(o) ==> canRefundPut(o, worker) ==> alwaysDeletedDocumentIsGone(refundPut(o, worker)))
  ensures (inv(o) ==> canRefundPut(o, worker) ==> alwaysCreatingDocumentIsNotDeleted(refundPut(o, worker)))
  ensures (inv(o) ==> canRefundPut(o, worker) ==> stepTerminalUploadIsFinal(o, refundPut(o, worker)))
{
  if inv(o) && canRefundPut(o, worker) {
    var a := refundPut(o, worker);
    assert alwaysEachWorkerKeepsItsSlot(a);
    Slots(o, worker);
    Slots(a, worker);
  }
}

lemma Slots(o: StoredObjects, worker: int)
  requires alwaysEachWorkerKeepsItsSlot(o)
  ensures slotOf(o, worker) == (if worker == 1 then o.slots[0] else if worker == 2 then o.slots[1] else idleSlot(0))
  ensures slotOf(o, 1) == o.slots[0] && slotOf(o, 2) == o.slots[1]
  ensures alwaysWorkersHoldNoFutureToken(o) == (o.slots[0].token <= o.token && o.slots[1].token <= o.token)
{
  SlotOf(o, worker);
  SlotOf(o, 1);
  SlotOf(o, 2);
  var f := (ok: bool, slot: WorkSlot) => (ok && (slot.token <= o.token));
  assert o.slots[1..][1..] == [];
  assert Std.Collections.Seq.FoldLeft(f, true, o.slots) == Std.Collections.Seq.FoldLeft(f, f(true, o.slots[0]), o.slots[1..]);
  assert Std.Collections.Seq.FoldLeft(f, f(true, o.slots[0]), o.slots[1..]) == Std.Collections.Seq.FoldLeft(f, f(f(true, o.slots[0]), o.slots[1]), o.slots[1..][1..]);
}

lemma SlotOf(o: StoredObjects, worker: int)
  requires alwaysEachWorkerKeepsItsSlot(o)
  ensures slotOf(o, worker) == (if worker == 1 then o.slots[0] else if worker == 2 then o.slots[1] else idleSlot(0))
{
  ProofLib.FilterCons((slot: WorkSlot) => (slot.worker == worker), o.slots);
  ProofLib.FilterCons((slot: WorkSlot) => (slot.worker == worker), o.slots[1..]);
  ProofLib.FilterNil((slot: WorkSlot) => (slot.worker == worker), o.slots[1..][1..]);
}
