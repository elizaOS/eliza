lemma configure_ensures(s: PairingAdmission, maximum: int, ttl: int)
  ensures (inv(s) ==> canConfigure(s) ==> alwaysUniquePendingIds(configure(s, maximum, ttl)))
  ensures (inv(s) ==> canConfigure(s) ==> alwaysCreatingHasFreeCapacity(configure(s, maximum, ttl)))
  ensures (inv(s) ==> canConfigure(s) ==> alwaysUpdatingOwnsCapturedPrior(configure(s, maximum, ttl)))
  ensures (inv(s) ==> canConfigure(s) ==> alwaysReceiptHasIdentity(configure(s, maximum, ttl)))
  ensures (inv(s) ==> canConfigure(s) ==> alwaysUnconfiguredHasNoCall(configure(s, maximum, ttl)))
  ensures (inv(s) ==> canConfigure(s) ==> alwaysActiveOwnerAgreesWithPhase(configure(s, maximum, ttl)))
  ensures (inv(s) ==> canConfigure(s) ==> alwaysTicketFrontier(configure(s, maximum, ttl)))
  ensures (inv(s) ==> canConfigure(s) ==> alwaysTicketOrder(configure(s, maximum, ttl)))
  ensures (inv(s) ==> canConfigure(s) ==> stepOnlyHeadEnters(s, "configure", configure(s, maximum, ttl)))
  ensures (inv(s) ==> canConfigure(s) ==> stepReceiptsNameActiveCall(s, "configure", configure(s, maximum, ttl)))
  ensures (inv(s) ==> canConfigure(s) ==> stepExistingRequestKeepsIdentity(s, "configure", configure(s, maximum, ttl)))
  ensures (inv(s) ==> canConfigure(s) ==> stepNewRowHasFreeCapacity(s, "configure", configure(s, maximum, ttl)))
{
  if inv(s) && canConfigure(s) {
    assert s.phase.AdmissionIdle?;
  }
}

lemma enqueueAdmission_ensures(s: PairingAdmission, input: AdmissionInput)
  ensures (inv(s) ==> canEnqueueAdmission(s, input) ==> alwaysUniquePendingIds(enqueueAdmission(s, input)))
  ensures (inv(s) ==> canEnqueueAdmission(s, input) ==> alwaysCreatingHasFreeCapacity(enqueueAdmission(s, input)))
  ensures (inv(s) ==> canEnqueueAdmission(s, input) ==> alwaysUpdatingOwnsCapturedPrior(enqueueAdmission(s, input)))
  ensures (inv(s) ==> canEnqueueAdmission(s, input) ==> alwaysReceiptHasIdentity(enqueueAdmission(s, input)))
  ensures (inv(s) ==> canEnqueueAdmission(s, input) ==> alwaysUnconfiguredHasNoCall(enqueueAdmission(s, input)))
  ensures (inv(s) ==> canEnqueueAdmission(s, input) ==> alwaysActiveOwnerAgreesWithPhase(enqueueAdmission(s, input)))
  ensures (inv(s) ==> canEnqueueAdmission(s, input) ==> alwaysTicketFrontier(enqueueAdmission(s, input)))
  ensures (inv(s) ==> canEnqueueAdmission(s, input) ==> alwaysTicketOrder(enqueueAdmission(s, input)))
  ensures (inv(s) ==> canEnqueueAdmission(s, input) ==> stepOnlyHeadEnters(s, "enqueueAdmission", enqueueAdmission(s, input)))
  ensures (inv(s) ==> canEnqueueAdmission(s, input) ==> stepReceiptsNameActiveCall(s, "enqueueAdmission", enqueueAdmission(s, input)))
  ensures (inv(s) ==> canEnqueueAdmission(s, input) ==> stepExistingRequestKeepsIdentity(s, "enqueueAdmission", enqueueAdmission(s, input)))
  ensures (inv(s) ==> canEnqueueAdmission(s, input) ==> stepNewRowHasFreeCapacity(s, "enqueueAdmission", enqueueAdmission(s, input)))
{
  if inv(s) && canEnqueueAdmission(s, input) {
    reveal alwaysTicketOrder(), alwaysTicketFrontier();
    var after := enqueueAdmission(s, input);
    var preceding := waitingIds(s.waiting);
    assert waitingIds(after.waiting) == preceding + [s.nextTicket] by {
      forall i | 0 <= i < |after.waiting| ensures waitingIds(after.waiting)[i] == (preceding + [s.nextTicket])[i] {
        if i < |s.waiting| { assert after.waiting[i] == s.waiting[i]; }
      }
    }
    AdmissionConsecutiveAppend(preceding, occupiedTickets(s) + 1, s.nextTicket);
  }
}

lemma enterAdmission_ensures(s: PairingAdmission, enteredAt: int)
  ensures (inv(s) ==> canEnterAdmission(s) ==> alwaysUniquePendingIds(enterAdmission(s, enteredAt)))
  ensures (inv(s) ==> canEnterAdmission(s) ==> alwaysCreatingHasFreeCapacity(enterAdmission(s, enteredAt)))
  ensures (inv(s) ==> canEnterAdmission(s) ==> alwaysUpdatingOwnsCapturedPrior(enterAdmission(s, enteredAt)))
  ensures (inv(s) ==> canEnterAdmission(s) ==> alwaysReceiptHasIdentity(enterAdmission(s, enteredAt)))
  ensures (inv(s) ==> canEnterAdmission(s) ==> alwaysUnconfiguredHasNoCall(enterAdmission(s, enteredAt)))
  ensures (inv(s) ==> canEnterAdmission(s) ==> alwaysActiveOwnerAgreesWithPhase(enterAdmission(s, enteredAt)))
  ensures (inv(s) ==> canEnterAdmission(s) ==> alwaysTicketFrontier(enterAdmission(s, enteredAt)))
  ensures (inv(s) ==> canEnterAdmission(s) ==> alwaysTicketOrder(enterAdmission(s, enteredAt)))
  ensures (inv(s) ==> canEnterAdmission(s) ==> stepOnlyHeadEnters(s, "enterAdmission", enterAdmission(s, enteredAt)))
  ensures (inv(s) ==> canEnterAdmission(s) ==> stepReceiptsNameActiveCall(s, "enterAdmission", enterAdmission(s, enteredAt)))
  ensures (inv(s) ==> canEnterAdmission(s) ==> stepExistingRequestKeepsIdentity(s, "enterAdmission", enterAdmission(s, enteredAt)))
  ensures (inv(s) ==> canEnterAdmission(s) ==> stepNewRowHasFreeCapacity(s, "enterAdmission", enterAdmission(s, enteredAt)))
{
  if inv(s) && canEnterAdmission(s) {
    reveal alwaysTicketOrder(), alwaysTicketFrontier();
    reveal alwaysUnconfiguredHasNoCall();
    var after := enterAdmission(s, enteredAt);
    var preceding := waitingIds(s.waiting);
    assert preceding[0] == queuedFirst(s).ticket;
    assert waitingIds(after.waiting) == preceding[1..] by {
      forall i | 0 <= i < |after.waiting| ensures waitingIds(after.waiting)[i] == preceding[1..][i] {
        assert after.waiting[i] == s.waiting[i + 1];
      }
    }
    AdmissionConsecutiveTail(preceding, occupiedTickets(s) + 1);
    assert after.activeTicket == completedTickets(s) + 1;
  }
}

lemma writePending_ensures(s: PairingAdmission, writeResult: WriteOutcome)
  ensures (inv(s) ==> canWritePending(s, writeResult) ==> alwaysUniquePendingIds(writePending(s, writeResult)))
  ensures (inv(s) ==> canWritePending(s, writeResult) ==> alwaysCreatingHasFreeCapacity(writePending(s, writeResult)))
  ensures (inv(s) ==> canWritePending(s, writeResult) ==> alwaysUpdatingOwnsCapturedPrior(writePending(s, writeResult)))
  ensures (inv(s) ==> canWritePending(s, writeResult) ==> alwaysReceiptHasIdentity(writePending(s, writeResult)))
  ensures (inv(s) ==> canWritePending(s, writeResult) ==> alwaysUnconfiguredHasNoCall(writePending(s, writeResult)))
  ensures (inv(s) ==> canWritePending(s, writeResult) ==> alwaysActiveOwnerAgreesWithPhase(writePending(s, writeResult)))
  ensures (inv(s) ==> canWritePending(s, writeResult) ==> alwaysTicketFrontier(writePending(s, writeResult)))
  ensures (inv(s) ==> canWritePending(s, writeResult) ==> alwaysTicketOrder(writePending(s, writeResult)))
  ensures (inv(s) ==> canWritePending(s, writeResult) ==> stepOnlyHeadEnters(s, "writePending", writePending(s, writeResult)))
  ensures (inv(s) ==> canWritePending(s, writeResult) ==> stepReceiptsNameActiveCall(s, "writePending", writePending(s, writeResult)))
  ensures (inv(s) ==> canWritePending(s, writeResult) ==> stepExistingRequestKeepsIdentity(s, "writePending", writePending(s, writeResult)))
  ensures (inv(s) ==> canWritePending(s, writeResult) ==> stepNewRowHasFreeCapacity(s, "writePending", writePending(s, writeResult)))
{
  if inv(s) && canWritePending(s, writeResult) {
    var after := writePending(s, writeResult);
    var receipt := lastReceipt(after);
    if writeResult.kind.RepeatedWrite? {
      var updated := refreshedRow(s.prior, s.request);
      assert exists row :: row in s.rows && row.id == s.prior.id && row == s.prior;
      assert s.prior in s.rows;
      AdmissionPendingFacts(s);
      assert s.prior.code != "";
      AdmissionRefreshRows(s, after, updated);
    } else if writeResult.kind.FreshWrite? {
      var added := newRow(s.request, writeResult.generated);
      reveal writePending(), finishAdmission(), ProofLib.Filter();
      AdmissionAppendIssues(s, after, added);
      AdmissionAddRows(s, after, added);
    }
    if writeResult.kind.WriteFailure? {
      AdmissionFinishOrder(s, noReceipt.(ticket := s.activeTicket, resultKind := AdmissionResult.AdmissionFailed));
    } else {
      var based := s.(rows := after.rows, issuedIds := after.issuedIds);
      assert after == finishAdmission(receipt, based);
      AdmissionFinishOrder(based, receipt);
    }
  }
}

lemma rejectFull_ensures(s: PairingAdmission)
  ensures (inv(s) ==> canRejectFull(s) ==> alwaysUniquePendingIds(rejectFull(s)))
  ensures (inv(s) ==> canRejectFull(s) ==> alwaysCreatingHasFreeCapacity(rejectFull(s)))
  ensures (inv(s) ==> canRejectFull(s) ==> alwaysUpdatingOwnsCapturedPrior(rejectFull(s)))
  ensures (inv(s) ==> canRejectFull(s) ==> alwaysReceiptHasIdentity(rejectFull(s)))
  ensures (inv(s) ==> canRejectFull(s) ==> alwaysUnconfiguredHasNoCall(rejectFull(s)))
  ensures (inv(s) ==> canRejectFull(s) ==> alwaysActiveOwnerAgreesWithPhase(rejectFull(s)))
  ensures (inv(s) ==> canRejectFull(s) ==> alwaysTicketFrontier(rejectFull(s)))
  ensures (inv(s) ==> canRejectFull(s) ==> alwaysTicketOrder(rejectFull(s)))
  ensures (inv(s) ==> canRejectFull(s) ==> stepOnlyHeadEnters(s, "rejectFull", rejectFull(s)))
  ensures (inv(s) ==> canRejectFull(s) ==> stepReceiptsNameActiveCall(s, "rejectFull", rejectFull(s)))
  ensures (inv(s) ==> canRejectFull(s) ==> stepExistingRequestKeepsIdentity(s, "rejectFull", rejectFull(s)))
  ensures (inv(s) ==> canRejectFull(s) ==> stepNewRowHasFreeCapacity(s, "rejectFull", rejectFull(s)))
{
  if inv(s) && canRejectFull(s) {
    AdmissionFinishOrder(s, noReceipt.(ticket := s.activeTicket, resultKind := AdmissionResult.AdmissionFull));
  }
}

lemma readFailed_ensures(s: PairingAdmission)
  ensures (inv(s) ==> canReadFailed(s) ==> alwaysUniquePendingIds(readFailed(s)))
  ensures (inv(s) ==> canReadFailed(s) ==> alwaysCreatingHasFreeCapacity(readFailed(s)))
  ensures (inv(s) ==> canReadFailed(s) ==> alwaysUpdatingOwnsCapturedPrior(readFailed(s)))
  ensures (inv(s) ==> canReadFailed(s) ==> alwaysReceiptHasIdentity(readFailed(s)))
  ensures (inv(s) ==> canReadFailed(s) ==> alwaysUnconfiguredHasNoCall(readFailed(s)))
  ensures (inv(s) ==> canReadFailed(s) ==> alwaysActiveOwnerAgreesWithPhase(readFailed(s)))
  ensures (inv(s) ==> canReadFailed(s) ==> alwaysTicketFrontier(readFailed(s)))
  ensures (inv(s) ==> canReadFailed(s) ==> alwaysTicketOrder(readFailed(s)))
  ensures (inv(s) ==> canReadFailed(s) ==> stepOnlyHeadEnters(s, "readFailed", readFailed(s)))
  ensures (inv(s) ==> canReadFailed(s) ==> stepReceiptsNameActiveCall(s, "readFailed", readFailed(s)))
  ensures (inv(s) ==> canReadFailed(s) ==> stepExistingRequestKeepsIdentity(s, "readFailed", readFailed(s)))
  ensures (inv(s) ==> canReadFailed(s) ==> stepNewRowHasFreeCapacity(s, "readFailed", readFailed(s)))
{
  if inv(s) && canReadFailed(s) {
    AdmissionFinishOrder(s, noReceipt.(ticket := s.activeTicket, resultKind := AdmissionResult.AdmissionFailed));
  }
}

lemma readPending_ensures(s: PairingAdmission, readAt: int)
  ensures (inv(s) ==> canReadPending(s) ==> alwaysUniquePendingIds(readPending(s, readAt)))
  ensures (inv(s) ==> canReadPending(s) ==> alwaysCreatingHasFreeCapacity(readPending(s, readAt)))
  ensures (inv(s) ==> canReadPending(s) ==> alwaysUpdatingOwnsCapturedPrior(readPending(s, readAt)))
  ensures (inv(s) ==> canReadPending(s) ==> alwaysReceiptHasIdentity(readPending(s, readAt)))
  ensures (inv(s) ==> canReadPending(s) ==> alwaysUnconfiguredHasNoCall(readPending(s, readAt)))
  ensures (inv(s) ==> canReadPending(s) ==> alwaysActiveOwnerAgreesWithPhase(readPending(s, readAt)))
  ensures (inv(s) ==> canReadPending(s) ==> alwaysTicketFrontier(readPending(s, readAt)))
  ensures (inv(s) ==> canReadPending(s) ==> alwaysTicketOrder(readPending(s, readAt)))
  ensures (inv(s) ==> canReadPending(s) ==> stepOnlyHeadEnters(s, "readPending", readPending(s, readAt)))
  ensures (inv(s) ==> canReadPending(s) ==> stepReceiptsNameActiveCall(s, "readPending", readPending(s, readAt)))
  ensures (inv(s) ==> canReadPending(s) ==> stepExistingRequestKeepsIdentity(s, "readPending", readPending(s, readAt)))
  ensures (inv(s) ==> canReadPending(s) ==> stepNewRowHasFreeCapacity(s, "readPending", readPending(s, readAt)))
{
  if inv(s) && canReadPending(s) {
    reveal alwaysUnconfiguredHasNoCall();
    var after := readPending(s, readAt);
    if after.phase.AdmissionUpdating? {
      var matches := ProofLib.Filter((row: PendingRow) => row.scope == s.request.scope, after.captured);
      reveal readPending(), ProofLib.Filter(), oldestPending();
      AdmissionOldestMember(emptyRow, matches);
      assert after.prior != emptyRow;
      ProofLib.FilterMember((row: PendingRow) => row.scope == s.request.scope, after.captured, after.prior);
    }
  }
}

lemma restorePending_ensures(s: PairingAdmission, row: PendingRow)
  ensures (inv(s) ==> canRestorePending(s, row) ==> alwaysUniquePendingIds(restorePending(s, row)))
  ensures (inv(s) ==> canRestorePending(s, row) ==> alwaysCreatingHasFreeCapacity(restorePending(s, row)))
  ensures (inv(s) ==> canRestorePending(s, row) ==> alwaysUpdatingOwnsCapturedPrior(restorePending(s, row)))
  ensures (inv(s) ==> canRestorePending(s, row) ==> alwaysReceiptHasIdentity(restorePending(s, row)))
  ensures (inv(s) ==> canRestorePending(s, row) ==> alwaysUnconfiguredHasNoCall(restorePending(s, row)))
  ensures (inv(s) ==> canRestorePending(s, row) ==> alwaysActiveOwnerAgreesWithPhase(restorePending(s, row)))
  ensures (inv(s) ==> canRestorePending(s, row) ==> alwaysTicketFrontier(restorePending(s, row)))
  ensures (inv(s) ==> canRestorePending(s, row) ==> alwaysTicketOrder(restorePending(s, row)))
  ensures (inv(s) ==> canRestorePending(s, row) ==> stepOnlyHeadEnters(s, "restorePending", restorePending(s, row)))
  ensures (inv(s) ==> canRestorePending(s, row) ==> stepReceiptsNameActiveCall(s, "restorePending", restorePending(s, row)))
  ensures (inv(s) ==> canRestorePending(s, row) ==> stepExistingRequestKeepsIdentity(s, "restorePending", restorePending(s, row)))
  ensures (inv(s) ==> canRestorePending(s, row) ==> stepNewRowHasFreeCapacity(s, "restorePending", restorePending(s, row)))
{
  if inv(s) && canRestorePending(s, row) {
    var after := restorePending(s, row);
    reveal restorePending(), ProofLib.Filter();
    AdmissionAppendIssues(s, after, row);
    AdmissionAddRows(s, after, row);
  }
}

lemma settleCleanup_ensures(s: PairingAdmission, id: string, success: bool)
  ensures (inv(s) ==> canSettleCleanup(s, id) ==> alwaysUniquePendingIds(settleCleanup(s, id, success)))
  ensures (inv(s) ==> canSettleCleanup(s, id) ==> alwaysCreatingHasFreeCapacity(settleCleanup(s, id, success)))
  ensures (inv(s) ==> canSettleCleanup(s, id) ==> alwaysUpdatingOwnsCapturedPrior(settleCleanup(s, id, success)))
  ensures (inv(s) ==> canSettleCleanup(s, id) ==> alwaysReceiptHasIdentity(settleCleanup(s, id, success)))
  ensures (inv(s) ==> canSettleCleanup(s, id) ==> alwaysUnconfiguredHasNoCall(settleCleanup(s, id, success)))
  ensures (inv(s) ==> canSettleCleanup(s, id) ==> alwaysActiveOwnerAgreesWithPhase(settleCleanup(s, id, success)))
  ensures (inv(s) ==> canSettleCleanup(s, id) ==> alwaysTicketFrontier(settleCleanup(s, id, success)))
  ensures (inv(s) ==> canSettleCleanup(s, id) ==> alwaysTicketOrder(settleCleanup(s, id, success)))
  ensures (inv(s) ==> canSettleCleanup(s, id) ==> stepOnlyHeadEnters(s, "settleCleanup", settleCleanup(s, id, success)))
  ensures (inv(s) ==> canSettleCleanup(s, id) ==> stepReceiptsNameActiveCall(s, "settleCleanup", settleCleanup(s, id, success)))
  ensures (inv(s) ==> canSettleCleanup(s, id) ==> stepExistingRequestKeepsIdentity(s, "settleCleanup", settleCleanup(s, id, success)))
  ensures (inv(s) ==> canSettleCleanup(s, id) ==> stepNewRowHasFreeCapacity(s, "settleCleanup", settleCleanup(s, id, success)))
{
  if inv(s) && canSettleCleanup(s, id) && success {
    var after := settleCleanup(s, id, success);
    var p := (row: PendingRow) => row.id != id;
    var k := (row: PendingRow) => row.id;
    reveal settleCleanup(), ProofLib.Filter();
    AdmissionPendingFacts(s);
    ProofLib.FilterKeepsDistinctBy(p, s.rows, k);
    forall row | row in after.rows ensures row.id != "" && row.code != "" && row.id in after.issuedIds {
      ProofLib.FilterMember(p, s.rows, row);
    }
    AdmissionRowsUnique(after);
  }
}

lemma AdmissionConsecutiveTail(preceding: seq<int>, first: int)
  requires |preceding| > 0
  requires consecutiveTickets(preceding, first)
  ensures preceding[0] == first
  ensures consecutiveTickets(preceding[1..], first + 1)
{
  var f := (walk: TicketWalk, ticket: int) => walkTicket(walk, ticket);
  var afterFirst := f(TicketWalk(true, first), preceding[0]);
  reveal consecutiveTickets(), Std.Collections.Seq.FoldLeft();
  assert Std.Collections.Seq.FoldLeft(f, TicketWalk(true, first), preceding) == Std.Collections.Seq.FoldLeft(f, afterFirst, preceding[1..]);
  AdmissionIllegalWalk(f, afterFirst, preceding[1..]);
  assert afterFirst.valid;
}

lemma AdmissionIllegalWalk(f: (TicketWalk, int) -> TicketWalk, walk: TicketWalk, tickets: seq<int>)
  requires forall w, i :: f(w, i) == walkTicket(w, i)
  ensures !walk.valid ==> !Std.Collections.Seq.FoldLeft(f, walk, tickets).valid
  decreases |tickets|
{
  reveal Std.Collections.Seq.FoldLeft();
  if |tickets| > 0 && !walk.valid {
    var reduced := f(walk, tickets[0]);
    assert reduced == walkTicket(walk, tickets[0]);
    assert !reduced.valid;
    assert Std.Collections.Seq.FoldLeft(f, walk, tickets) == Std.Collections.Seq.FoldLeft(f, reduced, tickets[1..]);
    AdmissionIllegalWalk(f, reduced, tickets[1..]);
  }
}

lemma AdmissionConsecutiveAppend(preceding: seq<int>, first: int, ticket: int)
  requires consecutiveTickets(preceding, first)
  requires ticket == first + |preceding|
  ensures consecutiveTickets(preceding + [ticket], first)
{
  var f := (walk: TicketWalk, ticket: int) => walkTicket(walk, ticket);
  var start := TicketWalk(true, first);
  reveal consecutiveTickets();
  AdmissionWalkLength(f, start, preceding);
  ProofLib.FoldLeftAppend(f, start, preceding, ticket);
}

lemma AdmissionWalkLength(f: (TicketWalk, int) -> TicketWalk, walk: TicketWalk, tickets: seq<int>)
  requires forall w, i :: f(w, i) == walkTicket(w, i)
  ensures Std.Collections.Seq.FoldLeft(f, walk, tickets).expected == walk.expected + |tickets|
  decreases |tickets|
{
  reveal Std.Collections.Seq.FoldLeft();
  if |tickets| > 0 {
    var reduced := f(walk, tickets[0]);
    assert reduced == walkTicket(walk, tickets[0]);
    assert reduced.expected == walk.expected + 1;
    assert Std.Collections.Seq.FoldLeft(f, walk, tickets) == Std.Collections.Seq.FoldLeft(f, reduced, tickets[1..]);
    AdmissionWalkLength(f, reduced, tickets[1..]);
  }
}

lemma AdmissionFinishOrder(s: PairingAdmission, receipt: AdmissionReceipt)
  requires alwaysTicketOrder(s) && alwaysTicketFrontier(s)
  requires s.activeTicket != 0 && receipt.ticket == s.activeTicket
  ensures alwaysTicketOrder(finishAdmission(receipt, s))
{
  var after := finishAdmission(receipt, s);
  var ids := receiptIds(s.receipts);
  reveal alwaysTicketOrder();
  assert receiptIds(after.receipts) == ids + [s.activeTicket] by {
    forall i | 0 <= i < |after.receipts| ensures receiptIds(after.receipts)[i] == (ids + [s.activeTicket])[i] {
      if i < |s.receipts| { assert after.receipts[i] == s.receipts[i]; }
    }
  }
  AdmissionConsecutiveAppend(ids, 1, s.activeTicket);
  assert occupiedTickets(after) == occupiedTickets(s);
}

lemma AdmissionPendingFacts(s: PairingAdmission)
  requires alwaysUniquePendingIds(s)
  ensures ProofLib.DistinctBy(s.rows, (row: PendingRow) => row.id)
  ensures forall row :: row in s.rows ==> row.id != "" && row.code != "" && row.id in s.issuedIds
{
  var rows := s.rows;
  reveal alwaysUniquePendingIds(), ProofLib.DistinctBy(), ProofLib.Filter();
  forall i | 0 <= i < |rows|
    ensures forall j :: 0 <= j < |rows| && j != i ==> rows[j].id != rows[i].id
  {
    var selected := rows[i];
    var p := (other: PendingRow) => other.id == selected.id;
    assert selected in s.rows;
    assert |rowsForId(s.rows, selected.id)| == 1;
    AdmissionIdFilter(s.rows, selected.id);
    assert |ProofLib.Filter(p, rows)| == 1;
    ProofLib.FilterCountOneIffUnique(p, rows, (other: PendingRow) => other.id, i);
  }
}

lemma AdmissionRowsUnique(s: PairingAdmission)
  requires ProofLib.DistinctBy(s.rows, (row: PendingRow) => row.id)
  requires forall row :: row in s.rows ==> row.id != "" && row.code != "" && row.id in s.issuedIds
  ensures alwaysUniquePendingIds(s)
{
  reveal alwaysUniquePendingIds(), ProofLib.DistinctBy(), ProofLib.Filter();
  forall row | row in s.rows
    ensures row.id != "" && row.code != "" && row.id in s.issuedIds && |rowsForId(s.rows, row.id)| == 1
  {
    var i :| 0 <= i < |s.rows| && s.rows[i] == row;
    ProofLib.FilterCountOneIffUnique((other: PendingRow) => other.id == row.id, s.rows, (other: PendingRow) => other.id, i);
    AdmissionIdFilter(s.rows, row.id);
  }
}

lemma AdmissionAppendIssues(s: PairingAdmission, after: PairingAdmission, row: PendingRow)
  requires row.id !in s.issuedIds
  requires after.issuedIds == s.issuedIds + ProofLib.Filter((set_x: string) => set_x !in s.issuedIds, [row.id])
  ensures row.id in after.issuedIds
  ensures forall id :: id in s.issuedIds ==> id in after.issuedIds
{
  ProofLib.FilterMember((set_x: string) => set_x !in s.issuedIds, [row.id], row.id);
}

lemma AdmissionAddRows(s: PairingAdmission, after: PairingAdmission, added: PendingRow)
  requires alwaysUniquePendingIds(s)
  requires added.id != "" && added.code != "" && added.id !in s.issuedIds
  requires after.rows == s.rows + [added]
  requires added.id in after.issuedIds && forall id :: id in s.issuedIds ==> id in after.issuedIds
  ensures alwaysUniquePendingIds(after)
{
  AdmissionPendingFacts(s);
  var k := (row: PendingRow) => row.id;
  ProofLib.DistinctByConcat(s.rows, [added], k);
  assert forall row :: row in after.rows ==> row in s.rows || row == added;
  AdmissionRowsUnique(after);
}

lemma AdmissionRefreshRows(s: PairingAdmission, after: PairingAdmission, updated: PendingRow)
  requires alwaysUniquePendingIds(s)
  requires updated.id != "" && updated.code != "" && updated.id in s.issuedIds
  requires s.issuedIds == after.issuedIds
  requires after.rows == seq(|s.rows|, i requires 0 <= i < |s.rows| =>
    if s.rows[i].id == updated.id then updated else s.rows[i])
  ensures alwaysUniquePendingIds(after)
{
  AdmissionPendingFacts(s);
  reveal ProofLib.DistinctBy();
  forall i | 0 <= i < |after.rows| ensures after.rows[i].id == s.rows[i].id {}
  forall row | row in after.rows ensures row.id != "" && row.code != "" && row.id in after.issuedIds {
    var i :| 0 <= i < |after.rows| && after.rows[i] == row;
    assert row == updated || row == s.rows[i];
  }
  AdmissionRowsUnique(after);
}

lemma AdmissionOldestMember(first: PendingRow, rows: seq<PendingRow>)
  ensures var selected := Std.Collections.Seq.FoldLeft((a: PendingRow, b: PendingRow) => earlierPending(a, b), first, rows);
      selected == first || selected in rows
  decreases |rows|
{
  reveal Std.Collections.Seq.FoldLeft();
  if |rows| > 0 {
    var nextRow := earlierPending(first, rows[0]);
    assert nextRow == first || nextRow == rows[0];
    assert rows[0] in rows;
    AdmissionOldestMember(nextRow, rows[1..]);
  }
}


lemma AdmissionIdFilter(rows: seq<PendingRow>, id: string)
  ensures rowsForId(rows, id) == ProofLib.Filter((row: PendingRow) => row.id == id, rows)
{
  reveal rowsForId(), ProofLib.Filter();
}
