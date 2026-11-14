lemma readApproval_ensures(s: ApprovalState, id: int, readAt: int, success: bool)
  ensures (inv(s) ==> canReadApproval(s, id) ==> alwaysRequestOwnerIsStable(readApproval(s, id, readAt, success)))
  ensures (inv(s) ==> canReadApproval(s, id) ==> alwaysGrantMatchesRequest(readApproval(s, id, readAt, success)))
  ensures (inv(s) ==> canReadApproval(s, id) ==> alwaysConsumedExactRequest(readApproval(s, id, readAt, success)))
  ensures (inv(s) ==> canReadApproval(s, id) ==> alwaysStoredRequestHasIssuedId(readApproval(s, id, readAt, success)))
  ensures (inv(s) ==> canReadApproval(s, id) ==> stepExistingGrantIdentityIsStable(s, "readApproval", readApproval(s, id, readAt, success)))
{
  if inv(s) && canReadApproval(s, id) && success {
    var own := getAttempt(s, id);
    reveal alwaysStoredRequestHasIssuedId(), replaceAttempt();
    PairingLookupCapture(s, own.lookup, readAt);
    PairingReplaceMembers(readApproval(s, id, readAt, success).attempts, s.attempts,
      own.(captured := lookupPending(s, own.lookup, readAt), phase := if lookupPending(s, own.lookup, readAt).id == "" then ApprovalPhase.ApprovalNoMatch else ApprovalPhase.ApprovalGranting));
  }
}

lemma consume_ensures(s: ApprovalState, id: int, success: bool)
  ensures (inv(s) ==> canConsume(s, id) ==> alwaysRequestOwnerIsStable(consume(s, id, success)))
  ensures (inv(s) ==> canConsume(s, id) ==> alwaysGrantMatchesRequest(consume(s, id, success)))
  ensures (inv(s) ==> canConsume(s, id) ==> alwaysConsumedExactRequest(consume(s, id, success)))
  ensures (inv(s) ==> canConsume(s, id) ==> alwaysStoredRequestHasIssuedId(consume(s, id, success)))
  ensures (inv(s) ==> canConsume(s, id) ==> stepExistingGrantIdentityIsStable(s, "consume", consume(s, id, success)))
{
  if inv(s) && canConsume(s, id) {
    var own := getAttempt(s, id);
    PairingAttemptLookup(s, id);
    reveal replaceAttempt(), core__pairingAdmission_dropPending(), ProofLib.Filter();
    var updated := own.(phase := if success then ApprovalPhase.ApprovalAccepted else ApprovalPhase.ApprovalConsumeFailed);
    var after := consume(s, id, success);
    PairingReplaceMembers(after.attempts, s.attempts, updated);
    if success {
      PairingDropRows(s.requests, after.requests, own.captured.id);
    }
  }
}

lemma grant_ensures(s: ApprovalState, id: int, grantInput: GrantAttempt)
  ensures (inv(s) ==> canGrant(s, id, grantInput) ==> alwaysRequestOwnerIsStable(grant(s, id, grantInput)))
  ensures (inv(s) ==> canGrant(s, id, grantInput) ==> alwaysGrantMatchesRequest(grant(s, id, grantInput)))
  ensures (inv(s) ==> canGrant(s, id, grantInput) ==> alwaysConsumedExactRequest(grant(s, id, grantInput)))
  ensures (inv(s) ==> canGrant(s, id, grantInput) ==> alwaysStoredRequestHasIssuedId(grant(s, id, grantInput)))
  ensures (inv(s) ==> canGrant(s, id, grantInput) ==> stepExistingGrantIdentityIsStable(s, "grant", grant(s, id, grantInput)))
{
  if inv(s) && canGrant(s, id, grantInput) {
    var own := getAttempt(s, id);
    PairingAttemptLookup(s, id);
    reveal replaceAttempt();
    var grants := core__pairingGrants_writeGrant(s.grants, writeFor(own, grantInput));
    var updated := own.(phase := if grants.status.GrantRetained? then ApprovalPhase.ApprovalConsuming else ApprovalPhase.ApprovalGrantFailed, retained := grants.reported);
    PairingReplaceMembers(grant(s, id, grantInput).attempts, s.attempts, updated);
  }
}

lemma settleCleanup_ensures(s: ApprovalState, requestId: string, success: bool)
  ensures (inv(s) ==> canSettleCleanup(s, requestId) ==> alwaysRequestOwnerIsStable(settleCleanup(s, requestId, success)))
  ensures (inv(s) ==> canSettleCleanup(s, requestId) ==> alwaysGrantMatchesRequest(settleCleanup(s, requestId, success)))
  ensures (inv(s) ==> canSettleCleanup(s, requestId) ==> alwaysConsumedExactRequest(settleCleanup(s, requestId, success)))
  ensures (inv(s) ==> canSettleCleanup(s, requestId) ==> alwaysStoredRequestHasIssuedId(settleCleanup(s, requestId, success)))
  ensures (inv(s) ==> canSettleCleanup(s, requestId) ==> stepExistingGrantIdentityIsStable(s, "settleCleanup", settleCleanup(s, requestId, success)))
{
  if inv(s) && canSettleCleanup(s, requestId) && success {
    reveal settleCleanup(), core__pairingAdmission_settleCleanup(), ProofLib.Filter();
    PairingDropRows(s.requests, settleCleanup(s, requestId, success).requests, requestId);
  }
}

lemma advanceApproval_ensures(s: ApprovalState, grantInput: GrantAttempt, readAt: int, success: bool)
  ensures (inv(s) ==> canAdvanceApproval(s, grantInput) ==> alwaysRequestOwnerIsStable(advanceApproval(s, grantInput, readAt, success)))
  ensures (inv(s) ==> canAdvanceApproval(s, grantInput) ==> alwaysGrantMatchesRequest(advanceApproval(s, grantInput, readAt, success)))
  ensures (inv(s) ==> canAdvanceApproval(s, grantInput) ==> alwaysConsumedExactRequest(advanceApproval(s, grantInput, readAt, success)))
  ensures (inv(s) ==> canAdvanceApproval(s, grantInput) ==> alwaysStoredRequestHasIssuedId(advanceApproval(s, grantInput, readAt, success)))
  ensures (inv(s) ==> canAdvanceApproval(s, grantInput) ==> stepExistingGrantIdentityIsStable(s, "advanceApproval", advanceApproval(s, grantInput, readAt, success)))
{
  if inv(s) && canAdvanceApproval(s, grantInput) {
    var id := oldestApproval(s).id;
    if canReadApproval(s, id) {
      readApproval_ensures(s, id, readAt, success);
    } else if canGrant(s, id, grantInput) {
      grant_ensures(s, id, grantInput);
    } else {
      consume_ensures(s, id, success);
    }
  }
}

lemma PairingDropRows(before: core__pairingAdmission_PairingAdmission, after: core__pairingAdmission_PairingAdmission, key: string)
  requires after.rows == ProofLib.Filter((row: core__pairingAdmission_PendingRow) => row.id != key, before.rows)
  ensures forall row :: row in after.rows ==> row in before.rows && row.id != key
{
  forall row | row in after.rows ensures row in before.rows && row.id != key {
    ProofLib.FilterMember((row: core__pairingAdmission_PendingRow) => row.id != key, before.rows, row);
  }
}

lemma PairingReplaceMembers(after: seq<Approval>, before: seq<Approval>, updated: Approval)
  requires after == seq(|before|, i requires 0 <= i < |before| => if before[i].id == updated.id then updated else before[i])
  ensures forall entry :: entry in after ==> entry == updated || entry in before
{
  forall entry | entry in after ensures entry == updated || entry in before {
    var i :| 0 <= i < |after| && after[i] == entry;
    assert after[i] == (if before[i].id == updated.id then updated else before[i]);
  }
}

lemma PairingAttemptLookup(s: ApprovalState, id: int)
  ensures getAttempt(s, id) != noAttempt ==> getAttempt(s, id) in s.attempts && getAttempt(s, id).id == id
{
  var p := (entry: Approval) => entry.id == id;
  var entries := ProofLib.Filter(p, s.attempts);
  reveal getAttempt(), ProofLib.Filter();
  if |entries| > 0 {
    assert entries[0] in entries;
    ProofLib.FilterMember(p, s.attempts, entries[0]);
  }
}

lemma PairingOldestMember(first: core__pairingAdmission_PendingRow, rows: seq<core__pairingAdmission_PendingRow>)
  ensures var selected := Std.Collections.Seq.FoldLeft((a: core__pairingAdmission_PendingRow, b: core__pairingAdmission_PendingRow) => core__pairingAdmission_earlierPending(a, b), first, rows);
      selected == first || selected in rows
  decreases |rows|
{
  if |rows| > 0 {
    var nextRow := core__pairingAdmission_earlierPending(first, rows[0]);
    reveal core__pairingAdmission_earlierPending();
    assert nextRow == first || nextRow == rows[0];
    assert rows[0] in rows;
    PairingOldestMember(nextRow, rows[1..]);
  }
}

lemma PairingLookupCapture(s: ApprovalState, key: ApprovalKey, readAt: int)
  requires forall row :: row in s.requests.rows ==> row.id in s.requests.issuedIds
  ensures lookupPending(s, key, readAt).id != "" ==>
    lookupPending(s, key, readAt).id in s.requests.issuedIds &&
    core__pairingAdmission_sameChannel(lookupPending(s, key, readAt).scope, requestChannel(key)) &&
    lookupPending(s, key, readAt).normalizedCode == key.codeQuery
{
  var scope := requestChannel(key);
  var livePredicate := (row: core__pairingAdmission_PendingRow) => core__pairingAdmission_sameChannel(row.scope, scope) && core__pairingAdmission_liveAt(readAt, s.requests.ttl, row);
  var codePredicate := (row: core__pairingAdmission_PendingRow) => row.normalizedCode == key.codeQuery;
  var live := core__pairingAdmission_liveInChannel(s.requests.rows, scope, readAt, s.requests.ttl);
  var eligible := ProofLib.Filter(codePredicate, live);
  var selected := lookupPending(s, key, readAt);
  reveal lookupPending(), core__pairingAdmission_liveInChannel(), core__pairingAdmission_oldestPending(), ProofLib.Filter();
  if selected.id != "" {
    PairingOldestMember(core__pairingAdmission_emptyRow, eligible);
    assert selected != core__pairingAdmission_emptyRow;
    ProofLib.FilterMember(codePredicate, live, selected);
    assert live == ProofLib.Filter(livePredicate, s.requests.rows);
    ProofLib.FilterMember(livePredicate, s.requests.rows, selected);
  }
}

lemma restoreRequest_ensures(s: ApprovalState, row: core__pairingAdmission_PendingRow)
  ensures (inv(s) ==> canRestoreRequest(s, row) ==> alwaysRequestOwnerIsStable(restoreRequest(s, row)))
  ensures (inv(s) ==> canRestoreRequest(s, row) ==> alwaysGrantMatchesRequest(restoreRequest(s, row)))
  ensures (inv(s) ==> canRestoreRequest(s, row) ==> alwaysConsumedExactRequest(restoreRequest(s, row)))
  ensures (inv(s) ==> canRestoreRequest(s, row) ==> alwaysStoredRequestHasIssuedId(restoreRequest(s, row)))
  ensures (inv(s) ==> canRestoreRequest(s, row) ==> stepExistingGrantIdentityIsStable(s, "restoreRequest", restoreRequest(s, row)))
{
  if inv(s) && canRestoreRequest(s, row) {
    var after := restoreRequest(s, row);
    reveal restoreRequest(), core__pairingAdmission_restorePending(), core__pairingAdmission_canRestorePending(), ProofLib.Filter();
    PairingAppendedRowIds(s.requests, after.requests, row);
  }
}

lemma writePending_ensures(s: ApprovalState, writeResult: core__pairingAdmission_WriteOutcome)
  ensures (inv(s) ==> canWritePending(s, writeResult) ==> alwaysRequestOwnerIsStable(writePending(s, writeResult)))
  ensures (inv(s) ==> canWritePending(s, writeResult) ==> alwaysGrantMatchesRequest(writePending(s, writeResult)))
  ensures (inv(s) ==> canWritePending(s, writeResult) ==> alwaysConsumedExactRequest(writePending(s, writeResult)))
  ensures (inv(s) ==> canWritePending(s, writeResult) ==> alwaysStoredRequestHasIssuedId(writePending(s, writeResult)))
  ensures (inv(s) ==> canWritePending(s, writeResult) ==> stepExistingGrantIdentityIsStable(s, "writePending", writePending(s, writeResult)))
{
  if inv(s) && canWritePending(s, writeResult) {
    var after := writePending(s, writeResult);
    reveal writePending(), core__pairingAdmission_writePending(), core__pairingAdmission_finishAdmission(), ProofLib.Filter();
    if writeResult.kind.FreshWrite? {
      PairingAppendedRowIds(s.requests, after.requests, core__pairingAdmission_newRow(s.requests.request, writeResult.generated));
    } else if writeResult.kind.RepeatedWrite? {
      var prior := core__pairingAdmission_refreshedRow(s.requests.prior, s.requests.request);
      forall row | row in after.requests.rows ensures row.id in after.requests.issuedIds {
        var i :| 0 <= i < |after.requests.rows| && after.requests.rows[i] == row;
        assert s.requests.rows[i] in s.requests.rows;
        assert row.id == s.requests.rows[i].id;
      }
    }
  }
}

lemma PairingAppendedRowIds(s: core__pairingAdmission_PairingAdmission, after: core__pairingAdmission_PairingAdmission, row: core__pairingAdmission_PendingRow)
  requires forall oldRow :: oldRow in s.rows ==> oldRow.id in s.issuedIds
  requires row.id !in s.issuedIds
  requires after.rows == s.rows + [row]
  requires after.issuedIds == s.issuedIds + ProofLib.Filter((id: string) => id !in s.issuedIds, [row.id])
  ensures forall owned :: owned in after.rows ==> owned.id in after.issuedIds
{
  ProofLib.FilterMember((id: string) => id !in s.issuedIds, [row.id], row.id);
  forall owned | owned in after.rows ensures owned.id in after.issuedIds {
    assert owned == row || owned in s.rows;
  }
}
