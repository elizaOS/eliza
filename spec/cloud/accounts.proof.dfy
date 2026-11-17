lemma reserve_ensures(d: Deletion)
  ensures (inv(d) ==> canReserve(d) ==> alwaysRevisionsAgree(reserve(d)))
  ensures (inv(d) ==> canReserve(d) ==> alwaysFencesPublishedTogether(reserve(d)))
  ensures (inv(d) ==> canReserve(d) ==> alwaysExportOnlyDuringRecovery(reserve(d)))
  ensures (inv(d) ==> canReserve(d) ==> alwaysNothingExportedBeforeRequest(reserve(d)))
  ensures (inv(d) ==> canReserve(d) ==> alwaysLateExportStaysFenced(reserve(d)))
  ensures (inv(d) ==> canReserve(d) ==> alwaysRestoredOnlyAfterReceipts(reserve(d)))
  ensures (inv(d) ==> canReserve(d) ==> alwaysIrreversibleCannotRestore(reserve(d)))
  ensures (inv(d) ==> canReserve(d) ==> alwaysSagaOnlyAfterTheWindow(reserve(d)))
  ensures (inv(d) ==> canReserve(d) ==> alwaysSagaIsIrreversible(reserve(d)))
  ensures (inv(d) ==> canReserve(d) ==> alwaysReceiptsStayOrdered(reserve(d)))
  ensures (inv(d) ==> canReserve(d) ==> alwaysLeasesAreBounded(reserve(d)))
  ensures (inv(d) ==> canReserve(d) ==> alwaysPhasesInProviderOrder(reserve(d)))
  ensures (inv(d) ==> canReserve(d) ==> alwaysOnlyTheHeadIsLeased(reserve(d)))
  ensures (inv(d) ==> canReserve(d) ==> alwaysCompletedPhaseHadItsEffect(reserve(d)))
  ensures (inv(d) ==> canReserve(d) ==> alwaysCompletionHasEveryReceipt(reserve(d)))
  ensures (inv(d) ==> canReserve(d) ==> alwaysIdentifiersErasedOnlyOnCompletion(reserve(d)))
  ensures (inv(d) ==> canReserve(d) ==> alwaysIdentityDeletedOnlyAfterDeactivation(reserve(d)))
  ensures (inv(d) ==> canReserve(d) ==> stepGenerationsNeverGoBack(d, reserve(d)))
  ensures (inv(d) ==> canReserve(d) ==> stepCallStartsFromFreshLease(d, reserve(d)))
  ensures (inv(d) ==> canReserve(d) ==> stepOnlyTheLeaseHolderCompletesAPhase(d, "reserve", reserve(d)))
{
  if inv(d) && canReserve(d) {
    assert !d.exportDelivered;
  }
}

lemma expireLease_ensures(d: Deletion, p: ProviderPhase)
  ensures (inv(d) ==> canExpireLease(d, p) ==> alwaysRevisionsAgree(expireLease(d, p)))
  ensures (inv(d) ==> canExpireLease(d, p) ==> alwaysFencesPublishedTogether(expireLease(d, p)))
  ensures (inv(d) ==> canExpireLease(d, p) ==> alwaysExportOnlyDuringRecovery(expireLease(d, p)))
  ensures (inv(d) ==> canExpireLease(d, p) ==> alwaysNothingExportedBeforeRequest(expireLease(d, p)))
  ensures (inv(d) ==> canExpireLease(d, p) ==> alwaysLateExportStaysFenced(expireLease(d, p)))
  ensures (inv(d) ==> canExpireLease(d, p) ==> alwaysRestoredOnlyAfterReceipts(expireLease(d, p)))
  ensures (inv(d) ==> canExpireLease(d, p) ==> alwaysIrreversibleCannotRestore(expireLease(d, p)))
  ensures (inv(d) ==> canExpireLease(d, p) ==> alwaysSagaOnlyAfterTheWindow(expireLease(d, p)))
  ensures (inv(d) ==> canExpireLease(d, p) ==> alwaysSagaIsIrreversible(expireLease(d, p)))
  ensures (inv(d) ==> canExpireLease(d, p) ==> alwaysReceiptsStayOrdered(expireLease(d, p)))
  ensures (inv(d) ==> canExpireLease(d, p) ==> alwaysLeasesAreBounded(expireLease(d, p)))
  ensures (inv(d) ==> canExpireLease(d, p) ==> alwaysPhasesInProviderOrder(expireLease(d, p)))
  ensures (inv(d) ==> canExpireLease(d, p) ==> alwaysOnlyTheHeadIsLeased(expireLease(d, p)))
  ensures (inv(d) ==> canExpireLease(d, p) ==> alwaysCompletedPhaseHadItsEffect(expireLease(d, p)))
  ensures (inv(d) ==> canExpireLease(d, p) ==> alwaysCompletionHasEveryReceipt(expireLease(d, p)))
  ensures (inv(d) ==> canExpireLease(d, p) ==> alwaysIdentifiersErasedOnlyOnCompletion(expireLease(d, p)))
  ensures (inv(d) ==> canExpireLease(d, p) ==> alwaysIdentityDeletedOnlyAfterDeactivation(expireLease(d, p)))
  ensures (inv(d) ==> canExpireLease(d, p) ==> stepGenerationsNeverGoBack(d, expireLease(d, p)))
  ensures (inv(d) ==> canExpireLease(d, p) ==> stepCallStartsFromFreshLease(d, expireLease(d, p)))
  ensures (inv(d) ==> canExpireLease(d, p) ==> stepOnlyTheLeaseHolderCompletesAPhase(d, "expireLease", expireLease(d, p)))
{
  if inv(d) && canExpireLease(d, p) {
    var after := expireLease(d, p);
    AcShape(d);
    AcHasIndex(p);
    var k :| 0 <= k < 6 && providerOrder[k] == p;
    AcRowAt(d, p, k);
    var row := d.phases[k].(owner := 0);
    assert d.phases[k] in d.phases;
    AcWithRow(d, p, row, k);
    AcStep(d, after, k, row);
  }
}

lemma claimPhase_ensures(d: Deletion, w: int)
  ensures (inv(d) ==> canClaimPhase(d, w) ==> alwaysRevisionsAgree(claimPhase(d, w)))
  ensures (inv(d) ==> canClaimPhase(d, w) ==> alwaysFencesPublishedTogether(claimPhase(d, w)))
  ensures (inv(d) ==> canClaimPhase(d, w) ==> alwaysExportOnlyDuringRecovery(claimPhase(d, w)))
  ensures (inv(d) ==> canClaimPhase(d, w) ==> alwaysNothingExportedBeforeRequest(claimPhase(d, w)))
  ensures (inv(d) ==> canClaimPhase(d, w) ==> alwaysLateExportStaysFenced(claimPhase(d, w)))
  ensures (inv(d) ==> canClaimPhase(d, w) ==> alwaysRestoredOnlyAfterReceipts(claimPhase(d, w)))
  ensures (inv(d) ==> canClaimPhase(d, w) ==> alwaysIrreversibleCannotRestore(claimPhase(d, w)))
  ensures (inv(d) ==> canClaimPhase(d, w) ==> alwaysSagaOnlyAfterTheWindow(claimPhase(d, w)))
  ensures (inv(d) ==> canClaimPhase(d, w) ==> alwaysSagaIsIrreversible(claimPhase(d, w)))
  ensures (inv(d) ==> canClaimPhase(d, w) ==> alwaysReceiptsStayOrdered(claimPhase(d, w)))
  ensures (inv(d) ==> canClaimPhase(d, w) ==> alwaysLeasesAreBounded(claimPhase(d, w)))
  ensures (inv(d) ==> canClaimPhase(d, w) ==> alwaysPhasesInProviderOrder(claimPhase(d, w)))
  ensures (inv(d) ==> canClaimPhase(d, w) ==> alwaysOnlyTheHeadIsLeased(claimPhase(d, w)))
  ensures (inv(d) ==> canClaimPhase(d, w) ==> alwaysCompletedPhaseHadItsEffect(claimPhase(d, w)))
  ensures (inv(d) ==> canClaimPhase(d, w) ==> alwaysCompletionHasEveryReceipt(claimPhase(d, w)))
  ensures (inv(d) ==> canClaimPhase(d, w) ==> alwaysIdentifiersErasedOnlyOnCompletion(claimPhase(d, w)))
  ensures (inv(d) ==> canClaimPhase(d, w) ==> alwaysIdentityDeletedOnlyAfterDeactivation(claimPhase(d, w)))
  ensures (inv(d) ==> canClaimPhase(d, w) ==> stepGenerationsNeverGoBack(d, claimPhase(d, w)))
  ensures (inv(d) ==> canClaimPhase(d, w) ==> stepCallStartsFromFreshLease(d, claimPhase(d, w)))
  ensures (inv(d) ==> canClaimPhase(d, w) ==> stepOnlyTheLeaseHolderCompletesAPhase(d, "claimPhase", claimPhase(d, w)))
{
  if inv(d) && canClaimPhase(d, w) {
    var after := claimPhase(d, w);
    var first := headRow(d);
    AcShape(d);
    AcHeadView(d);
    AcFirst(d.phases);
    var k :| 0 <= k < 6 && first == d.phases[k] && !d.phases[k].status.PhaseDone? && forall i :: 0 <= i < k ==> d.phases[i].status.PhaseDone?;
    assert d.phases[k] in d.phases;
    var g := first.generation + 1;
    var reconciling := first.status.PhaseCalling? || first.status.PhaseReconciling?;
    var row := if first.generation >= maxLeases then first.(status := PhaseStatus.PhaseActionNeeded)
      else if reconciling && !first.effect then first.(generation := g, owner := 0, status := PhaseStatus.PhaseRetry)
      else first.(generation := g, owner := w, status := (if reconciling then PhaseStatus.PhaseReconciling else PhaseStatus.PhaseLeased));
    AcWithRow(d, first.phase, row, k);
    assert after.phases == d.phases[k := row];
    AcWorkerIds(d, after, w);
    AcStep(d, after, k, row);
  }
}

lemma callProvider_ensures(d: Deletion, w: int, applied: bool, replyLost: bool)
  ensures (inv(d) ==> canCallProvider(d, w) ==> alwaysRevisionsAgree(callProvider(d, w, applied, replyLost)))
  ensures (inv(d) ==> canCallProvider(d, w) ==> alwaysFencesPublishedTogether(callProvider(d, w, applied, replyLost)))
  ensures (inv(d) ==> canCallProvider(d, w) ==> alwaysExportOnlyDuringRecovery(callProvider(d, w, applied, replyLost)))
  ensures (inv(d) ==> canCallProvider(d, w) ==> alwaysNothingExportedBeforeRequest(callProvider(d, w, applied, replyLost)))
  ensures (inv(d) ==> canCallProvider(d, w) ==> alwaysLateExportStaysFenced(callProvider(d, w, applied, replyLost)))
  ensures (inv(d) ==> canCallProvider(d, w) ==> alwaysRestoredOnlyAfterReceipts(callProvider(d, w, applied, replyLost)))
  ensures (inv(d) ==> canCallProvider(d, w) ==> alwaysIrreversibleCannotRestore(callProvider(d, w, applied, replyLost)))
  ensures (inv(d) ==> canCallProvider(d, w) ==> alwaysSagaOnlyAfterTheWindow(callProvider(d, w, applied, replyLost)))
  ensures (inv(d) ==> canCallProvider(d, w) ==> alwaysSagaIsIrreversible(callProvider(d, w, applied, replyLost)))
  ensures (inv(d) ==> canCallProvider(d, w) ==> alwaysReceiptsStayOrdered(callProvider(d, w, applied, replyLost)))
  ensures (inv(d) ==> canCallProvider(d, w) ==> alwaysLeasesAreBounded(callProvider(d, w, applied, replyLost)))
  ensures (inv(d) ==> canCallProvider(d, w) ==> alwaysPhasesInProviderOrder(callProvider(d, w, applied, replyLost)))
  ensures (inv(d) ==> canCallProvider(d, w) ==> alwaysOnlyTheHeadIsLeased(callProvider(d, w, applied, replyLost)))
  ensures (inv(d) ==> canCallProvider(d, w) ==> alwaysCompletedPhaseHadItsEffect(callProvider(d, w, applied, replyLost)))
  ensures (inv(d) ==> canCallProvider(d, w) ==> alwaysCompletionHasEveryReceipt(callProvider(d, w, applied, replyLost)))
  ensures (inv(d) ==> canCallProvider(d, w) ==> alwaysIdentifiersErasedOnlyOnCompletion(callProvider(d, w, applied, replyLost)))
  ensures (inv(d) ==> canCallProvider(d, w) ==> alwaysIdentityDeletedOnlyAfterDeactivation(callProvider(d, w, applied, replyLost)))
  ensures (inv(d) ==> canCallProvider(d, w) ==> stepGenerationsNeverGoBack(d, callProvider(d, w, applied, replyLost)))
  ensures (inv(d) ==> canCallProvider(d, w) ==> stepCallStartsFromFreshLease(d, callProvider(d, w, applied, replyLost)))
  ensures (inv(d) ==> canCallProvider(d, w) ==> stepOnlyTheLeaseHolderCompletesAPhase(d, "callProvider", callProvider(d, w, applied, replyLost)))
{
  if inv(d) && canCallProvider(d, w) {
    var after := callProvider(d, w, applied, replyLost);
    var worker := workerOf(d, w);
    var lost := replyLost || !applied;
    if holdsLease(d, w) && rowOf(d, worker.phase).status.PhaseLeased? {
      var k := AcHeld(d, w);
      var row := d.phases[k].(status := (if lost then PhaseStatus.PhaseReconciling else PhaseStatus.PhaseCalling), issued := true, effect := (d.phases[k].effect || applied), owner := (if lost then 0 else w));
      AcWithRow(d, worker.phase, row, k);
      assert after == d.(phases := d.phases[k := row], workers := withWorker(d, worker.(step := (if lost then WorkerStep.WorkerIdle else WorkerStep.WorkerConfirm))));
      AcWorkerIds(d, after, w);
      AcStep(d, after, k, row);
      assert rowOf(after, providerOrder[5]) == after.phases[5] && rowOf(d, providerOrder[5]) == d.phases[5];
      AcNotCompleted(d, after, k);
    } else {
      assert after == d.(workers := withWorker(d, worker.(step := WorkerStep.WorkerIdle)));
      AcWorkerIds(d, after, w);
      AcSame(d, after);
    }
    AcFields(d, after);
  }
}

lemma inspectionFails_ensures(d: Deletion, w: int)
  ensures (inv(d) ==> canInspectionFails(d, w) ==> alwaysRevisionsAgree(inspectionFails(d, w)))
  ensures (inv(d) ==> canInspectionFails(d, w) ==> alwaysFencesPublishedTogether(inspectionFails(d, w)))
  ensures (inv(d) ==> canInspectionFails(d, w) ==> alwaysExportOnlyDuringRecovery(inspectionFails(d, w)))
  ensures (inv(d) ==> canInspectionFails(d, w) ==> alwaysNothingExportedBeforeRequest(inspectionFails(d, w)))
  ensures (inv(d) ==> canInspectionFails(d, w) ==> alwaysLateExportStaysFenced(inspectionFails(d, w)))
  ensures (inv(d) ==> canInspectionFails(d, w) ==> alwaysRestoredOnlyAfterReceipts(inspectionFails(d, w)))
  ensures (inv(d) ==> canInspectionFails(d, w) ==> alwaysIrreversibleCannotRestore(inspectionFails(d, w)))
  ensures (inv(d) ==> canInspectionFails(d, w) ==> alwaysSagaOnlyAfterTheWindow(inspectionFails(d, w)))
  ensures (inv(d) ==> canInspectionFails(d, w) ==> alwaysSagaIsIrreversible(inspectionFails(d, w)))
  ensures (inv(d) ==> canInspectionFails(d, w) ==> alwaysReceiptsStayOrdered(inspectionFails(d, w)))
  ensures (inv(d) ==> canInspectionFails(d, w) ==> alwaysLeasesAreBounded(inspectionFails(d, w)))
  ensures (inv(d) ==> canInspectionFails(d, w) ==> alwaysPhasesInProviderOrder(inspectionFails(d, w)))
  ensures (inv(d) ==> canInspectionFails(d, w) ==> alwaysOnlyTheHeadIsLeased(inspectionFails(d, w)))
  ensures (inv(d) ==> canInspectionFails(d, w) ==> alwaysCompletedPhaseHadItsEffect(inspectionFails(d, w)))
  ensures (inv(d) ==> canInspectionFails(d, w) ==> alwaysCompletionHasEveryReceipt(inspectionFails(d, w)))
  ensures (inv(d) ==> canInspectionFails(d, w) ==> alwaysIdentifiersErasedOnlyOnCompletion(inspectionFails(d, w)))
  ensures (inv(d) ==> canInspectionFails(d, w) ==> alwaysIdentityDeletedOnlyAfterDeactivation(inspectionFails(d, w)))
  ensures (inv(d) ==> canInspectionFails(d, w) ==> stepGenerationsNeverGoBack(d, inspectionFails(d, w)))
  ensures (inv(d) ==> canInspectionFails(d, w) ==> stepCallStartsFromFreshLease(d, inspectionFails(d, w)))
  ensures (inv(d) ==> canInspectionFails(d, w) ==> stepOnlyTheLeaseHolderCompletesAPhase(d, "inspectionFails", inspectionFails(d, w)))
{
  if inv(d) && canInspectionFails(d, w) {
    var after := inspectionFails(d, w);
    var worker := workerOf(d, w);
    AcWorkerIds(d, after, w);
    if holdsLease(d, w) {
      var k := AcHeld(d, w);
      var row := d.phases[k].(owner := 0, status := (if d.phases[k].issued then PhaseStatus.PhaseReconciling else PhaseStatus.PhaseRetry));
      AcWithRow(d, worker.phase, row, k);
      AcStep(d, after, k, row);
    } else {
      AcSame(d, after);
    }
  }
}

lemma requireAction_ensures(d: Deletion, w: int)
  ensures (inv(d) ==> canRequireAction(d, w) ==> alwaysRevisionsAgree(requireAction(d, w)))
  ensures (inv(d) ==> canRequireAction(d, w) ==> alwaysFencesPublishedTogether(requireAction(d, w)))
  ensures (inv(d) ==> canRequireAction(d, w) ==> alwaysExportOnlyDuringRecovery(requireAction(d, w)))
  ensures (inv(d) ==> canRequireAction(d, w) ==> alwaysNothingExportedBeforeRequest(requireAction(d, w)))
  ensures (inv(d) ==> canRequireAction(d, w) ==> alwaysLateExportStaysFenced(requireAction(d, w)))
  ensures (inv(d) ==> canRequireAction(d, w) ==> alwaysRestoredOnlyAfterReceipts(requireAction(d, w)))
  ensures (inv(d) ==> canRequireAction(d, w) ==> alwaysIrreversibleCannotRestore(requireAction(d, w)))
  ensures (inv(d) ==> canRequireAction(d, w) ==> alwaysSagaOnlyAfterTheWindow(requireAction(d, w)))
  ensures (inv(d) ==> canRequireAction(d, w) ==> alwaysSagaIsIrreversible(requireAction(d, w)))
  ensures (inv(d) ==> canRequireAction(d, w) ==> alwaysReceiptsStayOrdered(requireAction(d, w)))
  ensures (inv(d) ==> canRequireAction(d, w) ==> alwaysLeasesAreBounded(requireAction(d, w)))
  ensures (inv(d) ==> canRequireAction(d, w) ==> alwaysPhasesInProviderOrder(requireAction(d, w)))
  ensures (inv(d) ==> canRequireAction(d, w) ==> alwaysOnlyTheHeadIsLeased(requireAction(d, w)))
  ensures (inv(d) ==> canRequireAction(d, w) ==> alwaysCompletedPhaseHadItsEffect(requireAction(d, w)))
  ensures (inv(d) ==> canRequireAction(d, w) ==> alwaysCompletionHasEveryReceipt(requireAction(d, w)))
  ensures (inv(d) ==> canRequireAction(d, w) ==> alwaysIdentifiersErasedOnlyOnCompletion(requireAction(d, w)))
  ensures (inv(d) ==> canRequireAction(d, w) ==> alwaysIdentityDeletedOnlyAfterDeactivation(requireAction(d, w)))
  ensures (inv(d) ==> canRequireAction(d, w) ==> stepGenerationsNeverGoBack(d, requireAction(d, w)))
  ensures (inv(d) ==> canRequireAction(d, w) ==> stepCallStartsFromFreshLease(d, requireAction(d, w)))
  ensures (inv(d) ==> canRequireAction(d, w) ==> stepOnlyTheLeaseHolderCompletesAPhase(d, "requireAction", requireAction(d, w)))
{
  if inv(d) && canRequireAction(d, w) {
    var after := requireAction(d, w);
    var worker := workerOf(d, w);
    AcWorkerIds(d, after, w);
    var k := AcHeld(d, w);
    var row := d.phases[k].(status := PhaseStatus.PhaseActionNeeded, owner := 0);
    AcWithRow(d, worker.phase, row, k);
    AcStep(d, after, k, row);
    assert !d.status.DeletionCompleted?;
    assert d.identifiersPresent;
  }
}

lemma confirmPhase_ensures(d: Deletion, w: int)
  ensures (inv(d) ==> canConfirmPhase(d, w) ==> alwaysRevisionsAgree(confirmPhase(d, w)))
  ensures (inv(d) ==> canConfirmPhase(d, w) ==> alwaysFencesPublishedTogether(confirmPhase(d, w)))
  ensures (inv(d) ==> canConfirmPhase(d, w) ==> alwaysExportOnlyDuringRecovery(confirmPhase(d, w)))
  ensures (inv(d) ==> canConfirmPhase(d, w) ==> alwaysNothingExportedBeforeRequest(confirmPhase(d, w)))
  ensures (inv(d) ==> canConfirmPhase(d, w) ==> alwaysLateExportStaysFenced(confirmPhase(d, w)))
  ensures (inv(d) ==> canConfirmPhase(d, w) ==> alwaysRestoredOnlyAfterReceipts(confirmPhase(d, w)))
  ensures (inv(d) ==> canConfirmPhase(d, w) ==> alwaysIrreversibleCannotRestore(confirmPhase(d, w)))
  ensures (inv(d) ==> canConfirmPhase(d, w) ==> alwaysSagaOnlyAfterTheWindow(confirmPhase(d, w)))
  ensures (inv(d) ==> canConfirmPhase(d, w) ==> alwaysSagaIsIrreversible(confirmPhase(d, w)))
  ensures (inv(d) ==> canConfirmPhase(d, w) ==> alwaysReceiptsStayOrdered(confirmPhase(d, w)))
  ensures (inv(d) ==> canConfirmPhase(d, w) ==> alwaysLeasesAreBounded(confirmPhase(d, w)))
  ensures (inv(d) ==> canConfirmPhase(d, w) ==> alwaysPhasesInProviderOrder(confirmPhase(d, w)))
  ensures (inv(d) ==> canConfirmPhase(d, w) ==> alwaysOnlyTheHeadIsLeased(confirmPhase(d, w)))
  ensures (inv(d) ==> canConfirmPhase(d, w) ==> alwaysCompletedPhaseHadItsEffect(confirmPhase(d, w)))
  ensures (inv(d) ==> canConfirmPhase(d, w) ==> alwaysCompletionHasEveryReceipt(confirmPhase(d, w)))
  ensures (inv(d) ==> canConfirmPhase(d, w) ==> alwaysIdentifiersErasedOnlyOnCompletion(confirmPhase(d, w)))
  ensures (inv(d) ==> canConfirmPhase(d, w) ==> alwaysIdentityDeletedOnlyAfterDeactivation(confirmPhase(d, w)))
  ensures (inv(d) ==> canConfirmPhase(d, w) ==> stepGenerationsNeverGoBack(d, confirmPhase(d, w)))
  ensures (inv(d) ==> canConfirmPhase(d, w) ==> stepCallStartsFromFreshLease(d, confirmPhase(d, w)))
  ensures (inv(d) ==> canConfirmPhase(d, w) ==> stepOnlyTheLeaseHolderCompletesAPhase(d, "confirmPhase", confirmPhase(d, w)))
{
  if inv(d) && canConfirmPhase(d, w) {
    var after := confirmPhase(d, w);
    var worker := workerOf(d, w);
    AcWorkerIds(d, after, w);
    if holdsLease(d, w) && rowOf(d, worker.phase).effect && d.authority && (worker.phase.ExportRevokePhase? || d.status.DeletionProcessing?) {
      var k := AcHeld(d, w);
      var row := d.phases[k].(status := PhaseStatus.PhaseDone, owner := 0);
      AcWithRow(d, worker.phase, row, k);
      AcStep(d, after, k, row);
      assert !d.status.DeletionCompleted?;
    } else {
      AcSame(d, after);
    }
  }
}

lemma AcHeadView(d: Deletion)
  ensures headRow(d) == (if 0 < |ProofLib.Filter((r: PhaseRow) => (!r.status.PhaseDone?), d.phases)| then ProofLib.Filter((r: PhaseRow) => (!r.status.PhaseDone?), d.phases)[0] else noRow)
{
}

lemma AcHasIndex(p: ProviderPhase)
  ensures exists k :: 0 <= k < 6 && providerOrder[k] == p
{
  if p.ExportRevokePhase? { assert providerOrder[0] == p; }
  else if p.PaymentsPhase? { assert providerOrder[1] == p; }
  else if p.StoredDataPhase? { assert providerOrder[2] == p; }
  else if p.ComputePhase? { assert providerOrder[3] == p; }
  else if p.CredentialsPhase? { assert providerOrder[4] == p; }
  else { assert providerOrder[5] == p; }
}

lemma AcShape(d: Deletion)
  requires alwaysPhasesInProviderOrder(d)
  ensures |d.phases| == 6
  ensures forall i :: 0 <= i < 6 ==> d.phases[i].phase == providerOrder[i]
  ensures forall i, j :: 0 <= i < 6 && 0 <= j < 6 && providerOrder[i] == providerOrder[j] ==> i == j
  ensures forall x :: x in d.workers ==> x.id > 0
{
  assert |providerOrder| == 6;
}

lemma AcRowAt(d: Deletion, p: ProviderPhase, k: int)
  requires alwaysPhasesInProviderOrder(d)
  requires 0 <= k < 6 && providerOrder[k] == p
  ensures rowOf(d, p) == d.phases[k]
{
  AcShape(d);
  assert rowOf(d, p) == (if 0 < |ProofLib.Filter((r: PhaseRow) => (r.phase == p), d.phases)| then ProofLib.Filter((r: PhaseRow) => (r.phase == p), d.phases)[0] else noRow);
  ProofLib.FilterOne((r: PhaseRow) => (r.phase == p), d.phases, k);
  var f := ProofLib.Filter((r: PhaseRow) => (r.phase == p), d.phases)[0];
  ProofLib.FilterMember((r: PhaseRow) => (r.phase == p), d.phases, f);
  var j :| 0 <= j < 6 && d.phases[j] == f;
}

lemma AcRows(d: Deletion)
  requires alwaysPhasesInProviderOrder(d)
  ensures forall k :: 0 <= k < 6 ==> rowOf(d, providerOrder[k]) == d.phases[k]
{
  forall k | 0 <= k < 6 ensures rowOf(d, providerOrder[k]) == d.phases[k] {
    AcRowAt(d, providerOrder[k], k);
  }
}

lemma AcWithRow(d: Deletion, p: ProviderPhase, row: PhaseRow, k: int)
  requires alwaysPhasesInProviderOrder(d)
  requires 0 <= k < 6 && providerOrder[k] == p
  ensures withRow(d, p, row) == d.phases[k := row]
{
  AcShape(d);
  assert |withRow(d, p, row)| == 6;
  forall i | 0 <= i < 6 ensures withRow(d, p, row)[i] == d.phases[k := row][i] {
  }
}

lemma AcFold(start: OrderCheck, xs: seq<PhaseRow>)
  ensures Std.Collections.Seq.FoldLeft((acc: OrderCheck, r: PhaseRow) => OrderCheck((acc.ok && ((!r.status.PhaseDone?) || acc.allDone)), (acc.allDone && r.status.PhaseDone?)), start, xs).ok <==> (start.ok && forall j :: 0 <= j < |xs| && xs[j].status.PhaseDone? ==> start.allDone && forall i :: 0 <= i < j ==> xs[i].status.PhaseDone?)
  decreases |xs|
{
  if |xs| > 0 {
    var next := OrderCheck((start.ok && ((!xs[0].status.PhaseDone?) || start.allDone)), (start.allDone && xs[0].status.PhaseDone?));
    AcFold(next, xs[1..]);
    assert forall j :: 1 <= j < |xs| ==> xs[j] == xs[1..][j - 1];
  }
}

lemma AcOrdered(d: Deletion)
  ensures alwaysReceiptsStayOrdered(d) <==> forall i, j :: 0 <= i < j < |d.phases| && d.phases[j].status.PhaseDone? ==> d.phases[i].status.PhaseDone?
{
  AcFold(OrderCheck(true, true), d.phases);
}

lemma AcFirst(ps: seq<PhaseRow>)
  ensures (exists r :: r in ps && !r.status.PhaseDone?) ==> 0 < |ProofLib.Filter((r: PhaseRow) => (!r.status.PhaseDone?), ps)| && exists k :: 0 <= k < |ps| && ProofLib.Filter((r: PhaseRow) => (!r.status.PhaseDone?), ps)[0] == ps[k] && !ps[k].status.PhaseDone? && forall i :: 0 <= i < k ==> ps[i].status.PhaseDone?
  decreases |ps|
{
  if |ps| > 0 {
    ProofLib.FilterCons((r: PhaseRow) => (!r.status.PhaseDone?), ps);
    if ps[0].status.PhaseDone? {
      AcFirst(ps[1..]);
      if exists r :: r in ps && !r.status.PhaseDone? {
        var r :| r in ps && !r.status.PhaseDone?;
        var n :| 0 <= n < |ps| && ps[n] == r;
        assert ps[1..][n - 1] == r;
        var k :| 0 <= k < |ps[1..]| && ProofLib.Filter((r: PhaseRow) => (!r.status.PhaseDone?), ps[1..])[0] == ps[1..][k] && !ps[1..][k].status.PhaseDone? && forall i :: 0 <= i < k ==> ps[1..][i].status.PhaseDone?;
        assert ps[k + 1] == ps[1..][k];
        assert forall i :: 1 <= i < k + 1 ==> ps[i] == ps[1..][i - 1];
      }
    }
  }
}

lemma AcHeadAt(d: Deletion, k: int)
  requires 0 <= k < |d.phases| && !d.phases[k].status.PhaseDone?
  requires forall i :: 0 <= i < k ==> d.phases[i].status.PhaseDone?
  ensures headRow(d) == d.phases[k]
{
  AcHeadView(d);
  assert d.phases[k] in d.phases;
  AcFirst(d.phases);
  var m :| 0 <= m < |d.phases| && ProofLib.Filter((r: PhaseRow) => (!r.status.PhaseDone?), d.phases)[0] == d.phases[m] && !d.phases[m].status.PhaseDone? && forall i :: 0 <= i < m ==> d.phases[i].status.PhaseDone?;
  assert m == k;
}

lemma AcHeadIndex(d: Deletion, m: int)
  requires alwaysPhasesInProviderOrder(d)
  requires 0 <= m < 6 && d.phases[m] == headRow(d) && !d.phases[m].status.PhaseDone?
  ensures forall i :: 0 <= i < m ==> d.phases[i].status.PhaseDone?
{
  AcShape(d);
  AcHeadView(d);
  assert d.phases[m] in d.phases;
  AcFirst(d.phases);
  var k :| 0 <= k < |d.phases| && ProofLib.Filter((r: PhaseRow) => (!r.status.PhaseDone?), d.phases)[0] == d.phases[k] && !d.phases[k].status.PhaseDone? && forall i :: 0 <= i < k ==> d.phases[i].status.PhaseDone?;
  assert d.phases[m].phase == d.phases[k].phase;
}

lemma AcWorkerIds(d: Deletion, after: Deletion, w: int)
  requires alwaysPhasesInProviderOrder(d)
  requires |after.workers| == |d.workers|
  requires forall i :: 0 <= i < |d.workers| ==> after.workers[i].id == d.workers[i].id
  ensures forall x :: x in after.workers ==> x.id > 0
{
  AcShape(d);
  forall x | x in after.workers ensures x.id > 0 {
    var i :| 0 <= i < |after.workers| && after.workers[i] == x;
    assert d.workers[i] in d.workers;
  }
}

lemma AcHeld(d: Deletion, w: int) returns (k: int)
  requires inv(d) && holdsLease(d, w)
  ensures 0 <= k < 6 && providerOrder[k] == workerOf(d, w).phase && rowOf(d, workerOf(d, w).phase) == d.phases[k]
  ensures d.phases[k].owner == w && w > 0 && d.irreversible
  ensures !d.phases[k].status.PhasePending? && !d.phases[k].status.PhaseDone?
  ensures forall i :: 0 <= i < k ==> d.phases[i].status.PhaseDone?
{
  var worker := workerOf(d, w);
  AcShape(d);
  assert worker == (if 0 < |ProofLib.Filter((x: Worker) => (x.id == w), d.workers)| then ProofLib.Filter((x: Worker) => (x.id == w), d.workers)[0] else noWorker);
  ProofLib.FilterMember((x: Worker) => (x.id == w), d.workers, worker);
  AcHasIndex(worker.phase);
  k :| 0 <= k < 6 && providerOrder[k] == worker.phase;
  AcRowAt(d, worker.phase, k);
  assert d.phases[k] in d.phases;
  AcHeadIndex(d, k);
}

lemma AcStep(d: Deletion, after: Deletion, k: int, row: PhaseRow)
  requires inv(d)
  requires 0 <= k < 6 && row.phase == providerOrder[k]
  requires after.phases == d.phases[k := row]
  requires forall x :: x in after.workers ==> x.id > 0
  requires after.irreversible == d.irreversible
  requires d.phases[k].status.PhaseDone? ==> row.status.PhaseDone?
  requires row.status.PhaseDone? && !d.phases[k].status.PhaseDone? ==> row.owner == 0 && forall i :: 0 <= i < k ==> d.phases[i].status.PhaseDone?
  requires !row.status.PhasePending? ==> d.irreversible
  requires row.status.PhaseDone? ==> row.effect
  requires 0 <= row.generation <= maxLeases && row.generation >= d.phases[k].generation
  requires row.issued && !d.phases[k].issued ==> d.phases[k].status.PhaseLeased?
  requires row.owner != 0 ==> !row.status.PhasePending? && !row.status.PhaseDone? && forall i :: 0 <= i < k ==> d.phases[i].status.PhaseDone?
  ensures alwaysPhasesInProviderOrder(after)
  ensures forall i :: 0 <= i < 6 ==> rowOf(after, providerOrder[i]) == after.phases[i] && rowOf(d, providerOrder[i]) == d.phases[i]
  ensures forall i :: 0 <= i < 6 && d.phases[i].status.PhaseDone? ==> after.phases[i].status.PhaseDone?
  ensures (forall r :: r in d.phases ==> r.status.PhaseDone?) ==> (forall r :: r in after.phases ==> r.status.PhaseDone?)
  ensures alwaysSagaOnlyAfterTheWindow(after)
  ensures alwaysReceiptsStayOrdered(after) && alwaysLeasesAreBounded(after) && alwaysCompletedPhaseHadItsEffect(after) && alwaysOnlyTheHeadIsLeased(after)
  ensures stepGenerationsNeverGoBack(d, after) && stepCallStartsFromFreshLease(d, after)
  ensures row.status.PhaseDone? == d.phases[k].status.PhaseDone? ==> forall via :: stepOnlyTheLeaseHolderCompletesAPhase(d, via, after)
{
  AcShape(d);
  assert |after.phases| == 6;
  assert forall i :: 0 <= i < 6 ==> after.phases[i] == (if i == k then row else d.phases[i]);
  assert forall i :: 0 <= i < 6 ==> after.phases[i].phase == providerOrder[i];
  AcRows(d);
  AcRows(after);
  AcOrdered(d);
  AcOrdered(after);
  forall i | 0 <= i < 6 ensures d.phases[i] in d.phases { }
  forall r | r in after.phases && r.owner != 0 ensures !r.status.PhasePending? && !r.status.PhaseDone? && r == headRow(after) {
    var m :| 0 <= m < 6 && after.phases[m] == r;
    if m == k {
      AcHeadAt(after, k);
    } else {
      AcHeadIndex(d, m);
      AcHeadAt(after, m);
    }
  }
}

lemma AcFields(d: Deletion, after: Deletion)
  requires inv(d)
  requires after == d.(phases := after.phases, workers := after.workers)
  requires rowOf(d, ProviderPhase.AuthDeletionPhase).status.PhaseDone? ==> rowOf(after, ProviderPhase.AuthDeletionPhase).status.PhaseDone?
  ensures alwaysRevisionsAgree(after) && alwaysFencesPublishedTogether(after) && alwaysExportOnlyDuringRecovery(after) && alwaysNothingExportedBeforeRequest(after) && alwaysLateExportStaysFenced(after)
  ensures alwaysRestoredOnlyAfterReceipts(after) && alwaysIrreversibleCannotRestore(after) && alwaysIdentifiersErasedOnlyOnCompletion(after) && alwaysIdentityDeletedOnlyAfterDeactivation(after)
{
}

lemma AcSame(d: Deletion, after: Deletion)
  requires inv(d)
  requires after.phases == d.phases
  requires after.irreversible == d.irreversible
  requires forall x :: x in after.workers ==> x.id > 0
  ensures alwaysPhasesInProviderOrder(after) && alwaysReceiptsStayOrdered(after) && alwaysLeasesAreBounded(after) && alwaysCompletedPhaseHadItsEffect(after) && alwaysOnlyTheHeadIsLeased(after)
  ensures forall p :: rowOf(after, p) == rowOf(d, p)
  ensures stepGenerationsNeverGoBack(d, after) && stepCallStartsFromFreshLease(d, after)
  ensures forall via :: stepOnlyTheLeaseHolderCompletesAPhase(d, via, after)
{
  AcShape(d);
  assert d.phases[0] in d.phases;
  assert after.phases == d.phases[0 := d.phases[0]];
  AcStep(d, after, 0, d.phases[0]);
}

lemma AcNotCompleted(d: Deletion, after: Deletion, k: int)
  requires alwaysCompletionHasEveryReceipt(d) && 0 <= k < |d.phases| && !d.phases[k].status.PhaseDone?
  requires after.status == d.status
  ensures alwaysCompletionHasEveryReceipt(after)
{
  assert d.phases[k] in d.phases;
}
