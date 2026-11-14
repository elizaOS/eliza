lemma PreparedLeaseOwner(s: PreparedRequests)
  requires inv(s)
  ensures core__modelAttemptLeases_inv(s.leases)
{}

lemma PreparedGuardRecordsPreserved(s: PreparedRequests, after: PreparedRequests)
  requires alwaysExactBudgetAdmission(s) && alwaysGuardIdsUnique(s)
  requires |after.guards| == |s.guards|
  requires forall i :: 0 <= i < |s.guards| ==> after.guards[i].id == s.guards[i].id && after.guards[i].bytes == s.guards[i].bytes && after.guards[i].inputCount == s.guards[i].inputCount && after.guards[i].countSource == s.guards[i].countSource && after.guards[i].threshold == s.guards[i].threshold && after.guards[i].phase == s.guards[i].phase && after.guards[i].exactAuthority == s.guards[i].exactAuthority
  ensures stepGuardBytesStayFixed(s, after)
  ensures alwaysExactBudgetAdmission(after) && alwaysGuardIdsUnique(after)
{
  PreparedGuardFilters(s); PreparedGuardFilters(after);
  forall g | g in after.guards ensures g.id > 0 && |ProofLib.Filter((other: PreparedGuard) => (other.id == g.id), after.guards)| == 1
  {
    var i :| 0 <= i < |after.guards| && after.guards[i] == g;
    assert s.guards[i] in s.guards;
    ProofLib.FilterLengthPointwise((other: PreparedGuard) => (other.id == g.id), (other: PreparedGuard) => (other.id == g.id), s.guards, after.guards);
  }
  forall g | g in s.guards ensures exists a :: a in after.guards && a.id == g.id && a.bytes == g.bytes && a.inputCount == g.inputCount && a.countSource == g.countSource
  {
    var i :| 0 <= i < |s.guards| && s.guards[i] == g;
    assert after.guards[i] in after.guards;
  }
  forall g | g in after.guards && g.phase.GuardReady? && g.exactAuthority ensures g.inputCount < g.threshold
  {
    var i :| 0 <= i < |after.guards| && after.guards[i] == g;
    assert s.guards[i] in s.guards;
  }
}

lemma dispatchPrepared_ensures(s: PreparedRequests, guardId: int, observed: RequestObservation, byteCount: int, currentTurn: bool)
  ensures (inv(s) ==> canDispatchPrepared(s, guardId, observed, byteCount, currentTurn) ==> alwaysGuardIdsUnique(dispatchPrepared(s, guardId, observed, byteCount, currentTurn)))
  ensures (inv(s) ==> canDispatchPrepared(s, guardId, observed, byteCount, currentTurn) ==> alwaysExactBudgetAdmission(dispatchPrepared(s, guardId, observed, byteCount, currentTurn)))
  ensures (inv(s) ==> canDispatchPrepared(s, guardId, observed, byteCount, currentTurn) ==> alwaysGuardAttemptsNonnegative(dispatchPrepared(s, guardId, observed, byteCount, currentTurn)))
  ensures (inv(s) ==> canDispatchPrepared(s, guardId, observed, byteCount, currentTurn) ==> alwaysPreparedLeasesStayNonnegative(dispatchPrepared(s, guardId, observed, byteCount, currentTurn)))
  ensures (inv(s) ==> canDispatchPrepared(s, guardId, observed, byteCount, currentTurn) ==> alwaysRecheckKeepsAdmittedGuard(dispatchPrepared(s, guardId, observed, byteCount, currentTurn)))
  ensures (inv(s) ==> canDispatchPrepared(s, guardId, observed, byteCount, currentTurn) ==> stepGuardBytesStayFixed(s, dispatchPrepared(s, guardId, observed, byteCount, currentTurn)))
  ensures (inv(s) ==> canDispatchPrepared(s, guardId, observed, byteCount, currentTurn) ==> stepUnchangedCheckDoesNotCount(s, "dispatchPrepared", dispatchPrepared(s, guardId, observed, byteCount, currentTurn)))
{
  if inv(s) && canDispatchPrepared(s, guardId, observed, byteCount, currentTurn) {
    var g := preparedGuard(s, guardId);
    var after := dispatchPrepared(s, guardId, observed, byteCount, currentTurn);
    PreparedLeaseOwner(s);
    if g.leaseId != 0 {
      core__modelAttemptLeases_reserveAttempt_ensures(s.leases, g.leaseId, preparedReservation(g, observed, byteCount, currentTurn));
    }
    PreparedGuardRecordsPreserved(s, after);
  }
}

lemma dispatchUnchanged_ensures(s: PreparedRequests, byteCount: int, currentTurn: bool)
  ensures (inv(s) ==> canDispatchUnchanged(s, byteCount, currentTurn) ==> alwaysGuardIdsUnique(dispatchUnchanged(s, byteCount, currentTurn)))
  ensures (inv(s) ==> canDispatchUnchanged(s, byteCount, currentTurn) ==> alwaysExactBudgetAdmission(dispatchUnchanged(s, byteCount, currentTurn)))
  ensures (inv(s) ==> canDispatchUnchanged(s, byteCount, currentTurn) ==> alwaysGuardAttemptsNonnegative(dispatchUnchanged(s, byteCount, currentTurn)))
  ensures (inv(s) ==> canDispatchUnchanged(s, byteCount, currentTurn) ==> alwaysPreparedLeasesStayNonnegative(dispatchUnchanged(s, byteCount, currentTurn)))
  ensures (inv(s) ==> canDispatchUnchanged(s, byteCount, currentTurn) ==> alwaysRecheckKeepsAdmittedGuard(dispatchUnchanged(s, byteCount, currentTurn)))
  ensures (inv(s) ==> canDispatchUnchanged(s, byteCount, currentTurn) ==> stepGuardBytesStayFixed(s, dispatchUnchanged(s, byteCount, currentTurn)))
  ensures (inv(s) ==> canDispatchUnchanged(s, byteCount, currentTurn) ==> stepUnchangedCheckDoesNotCount(s, "dispatchUnchanged", dispatchUnchanged(s, byteCount, currentTurn)))
{
  if inv(s) && canDispatchUnchanged(s, byteCount, currentTurn) {
    var g := currentDispatchCandidate(s, byteCount, currentTurn);
    dispatchPrepared_ensures(s, g.id, capturedObservation(g), byteCount, currentTurn);
  }
}

lemma createAllowance_ensures(s: PreparedRequests, allowanceId: int, allowanceInput: core__modelAttemptLeases_AllowanceInput)
  ensures (inv(s) ==> canCreateAllowance(s, allowanceId, allowanceInput) ==> alwaysGuardIdsUnique(createAllowance(s, allowanceId, allowanceInput)))
  ensures (inv(s) ==> canCreateAllowance(s, allowanceId, allowanceInput) ==> alwaysExactBudgetAdmission(createAllowance(s, allowanceId, allowanceInput)))
  ensures (inv(s) ==> canCreateAllowance(s, allowanceId, allowanceInput) ==> alwaysGuardAttemptsNonnegative(createAllowance(s, allowanceId, allowanceInput)))
  ensures (inv(s) ==> canCreateAllowance(s, allowanceId, allowanceInput) ==> alwaysPreparedLeasesStayNonnegative(createAllowance(s, allowanceId, allowanceInput)))
  ensures (inv(s) ==> canCreateAllowance(s, allowanceId, allowanceInput) ==> alwaysRecheckKeepsAdmittedGuard(createAllowance(s, allowanceId, allowanceInput)))
  ensures (inv(s) ==> canCreateAllowance(s, allowanceId, allowanceInput) ==> stepGuardBytesStayFixed(s, createAllowance(s, allowanceId, allowanceInput)))
  ensures (inv(s) ==> canCreateAllowance(s, allowanceId, allowanceInput) ==> stepUnchangedCheckDoesNotCount(s, "createAllowance", createAllowance(s, allowanceId, allowanceInput)))
{
  if inv(s) && canCreateAllowance(s, allowanceId, allowanceInput) {
    PreparedLeaseOwner(s);
    core__modelAttemptLeases_createAllowance_ensures(s.leases, allowanceId, allowanceInput);
  }
}

lemma openTurnLease_ensures(s: PreparedRequests, allowanceId: int, leaseId: int, messageId: string)
  ensures (inv(s) ==> canOpenTurnLease(s, allowanceId, leaseId, messageId) ==> alwaysGuardIdsUnique(openTurnLease(s, allowanceId, leaseId, messageId)))
  ensures (inv(s) ==> canOpenTurnLease(s, allowanceId, leaseId, messageId) ==> alwaysExactBudgetAdmission(openTurnLease(s, allowanceId, leaseId, messageId)))
  ensures (inv(s) ==> canOpenTurnLease(s, allowanceId, leaseId, messageId) ==> alwaysGuardAttemptsNonnegative(openTurnLease(s, allowanceId, leaseId, messageId)))
  ensures (inv(s) ==> canOpenTurnLease(s, allowanceId, leaseId, messageId) ==> alwaysPreparedLeasesStayNonnegative(openTurnLease(s, allowanceId, leaseId, messageId)))
  ensures (inv(s) ==> canOpenTurnLease(s, allowanceId, leaseId, messageId) ==> alwaysRecheckKeepsAdmittedGuard(openTurnLease(s, allowanceId, leaseId, messageId)))
  ensures (inv(s) ==> canOpenTurnLease(s, allowanceId, leaseId, messageId) ==> stepGuardBytesStayFixed(s, openTurnLease(s, allowanceId, leaseId, messageId)))
  ensures (inv(s) ==> canOpenTurnLease(s, allowanceId, leaseId, messageId) ==> stepUnchangedCheckDoesNotCount(s, "openTurnLease", openTurnLease(s, allowanceId, leaseId, messageId)))
{
  if inv(s) && canOpenTurnLease(s, allowanceId, leaseId, messageId) {
    PreparedLeaseOwner(s);
    core__modelAttemptLeases_openTurnLease_ensures(s.leases, allowanceId, leaseId, messageId);
    var after := openTurnLease(s, allowanceId, leaseId, messageId);
    assert after.guards == s.guards;
    assert alwaysPreparedLeasesStayNonnegative(after);
    assert stepGuardBytesStayFixed(s, after);
  }
}

lemma closeTurnLease_ensures(s: PreparedRequests, leaseId: int)
  ensures (inv(s) ==> canCloseTurnLease(s, leaseId) ==> alwaysGuardIdsUnique(closeTurnLease(s, leaseId)))
  ensures (inv(s) ==> canCloseTurnLease(s, leaseId) ==> alwaysExactBudgetAdmission(closeTurnLease(s, leaseId)))
  ensures (inv(s) ==> canCloseTurnLease(s, leaseId) ==> alwaysGuardAttemptsNonnegative(closeTurnLease(s, leaseId)))
  ensures (inv(s) ==> canCloseTurnLease(s, leaseId) ==> alwaysPreparedLeasesStayNonnegative(closeTurnLease(s, leaseId)))
  ensures (inv(s) ==> canCloseTurnLease(s, leaseId) ==> alwaysRecheckKeepsAdmittedGuard(closeTurnLease(s, leaseId)))
  ensures (inv(s) ==> canCloseTurnLease(s, leaseId) ==> stepGuardBytesStayFixed(s, closeTurnLease(s, leaseId)))
  ensures (inv(s) ==> canCloseTurnLease(s, leaseId) ==> stepUnchangedCheckDoesNotCount(s, "closeTurnLease", closeTurnLease(s, leaseId)))
{
  if inv(s) && canCloseTurnLease(s, leaseId) {
    PreparedLeaseOwner(s);
    core__modelAttemptLeases_closeTurnLease_ensures(s.leases, leaseId);
  }
}

lemma closeAllowance_ensures(s: PreparedRequests, allowanceId: int)
  ensures (inv(s) ==> canCloseAllowance(s, allowanceId) ==> alwaysGuardIdsUnique(closeAllowance(s, allowanceId)))
  ensures (inv(s) ==> canCloseAllowance(s, allowanceId) ==> alwaysExactBudgetAdmission(closeAllowance(s, allowanceId)))
  ensures (inv(s) ==> canCloseAllowance(s, allowanceId) ==> alwaysGuardAttemptsNonnegative(closeAllowance(s, allowanceId)))
  ensures (inv(s) ==> canCloseAllowance(s, allowanceId) ==> alwaysPreparedLeasesStayNonnegative(closeAllowance(s, allowanceId)))
  ensures (inv(s) ==> canCloseAllowance(s, allowanceId) ==> alwaysRecheckKeepsAdmittedGuard(closeAllowance(s, allowanceId)))
  ensures (inv(s) ==> canCloseAllowance(s, allowanceId) ==> stepGuardBytesStayFixed(s, closeAllowance(s, allowanceId)))
  ensures (inv(s) ==> canCloseAllowance(s, allowanceId) ==> stepUnchangedCheckDoesNotCount(s, "closeAllowance", closeAllowance(s, allowanceId)))
{
  if inv(s) && canCloseAllowance(s, allowanceId) {
    PreparedLeaseOwner(s);
    core__modelAttemptLeases_closeAllowance_ensures(s.leases, allowanceId);
  }
}

lemma setAllowanceClock_ensures(s: PreparedRequests, now: int)
  ensures (inv(s) ==> alwaysGuardIdsUnique(setAllowanceClock(s, now)))
  ensures (inv(s) ==> alwaysExactBudgetAdmission(setAllowanceClock(s, now)))
  ensures (inv(s) ==> alwaysGuardAttemptsNonnegative(setAllowanceClock(s, now)))
  ensures (inv(s) ==> alwaysPreparedLeasesStayNonnegative(setAllowanceClock(s, now)))
  ensures (inv(s) ==> alwaysRecheckKeepsAdmittedGuard(setAllowanceClock(s, now)))
  ensures (inv(s) ==> stepGuardBytesStayFixed(s, setAllowanceClock(s, now)))
  ensures (inv(s) ==> stepUnchangedCheckDoesNotCount(s, "setAllowanceClock", setAllowanceClock(s, now)))
{
  if inv(s) {
    PreparedLeaseOwner(s);
    core__modelAttemptLeases_setAllowanceClock_ensures(s.leases, now);
  }
}

lemma checkUnchanged_ensures(s: PreparedRequests, guardId: int, observed: RequestObservation)
  ensures (inv(s) ==> canCheckUnchanged(s, guardId, observed) ==> alwaysGuardIdsUnique(checkUnchanged(s, guardId, observed)))
  ensures (inv(s) ==> canCheckUnchanged(s, guardId, observed) ==> alwaysExactBudgetAdmission(checkUnchanged(s, guardId, observed)))
  ensures (inv(s) ==> canCheckUnchanged(s, guardId, observed) ==> alwaysGuardAttemptsNonnegative(checkUnchanged(s, guardId, observed)))
  ensures (inv(s) ==> canCheckUnchanged(s, guardId, observed) ==> alwaysPreparedLeasesStayNonnegative(checkUnchanged(s, guardId, observed)))
  ensures (inv(s) ==> canCheckUnchanged(s, guardId, observed) ==> alwaysRecheckKeepsAdmittedGuard(checkUnchanged(s, guardId, observed)))
  ensures (inv(s) ==> canCheckUnchanged(s, guardId, observed) ==> stepGuardBytesStayFixed(s, checkUnchanged(s, guardId, observed)))
  ensures (inv(s) ==> canCheckUnchanged(s, guardId, observed) ==> stepUnchangedCheckDoesNotCount(s, "checkUnchanged", checkUnchanged(s, guardId, observed)))
{
  if inv(s) && canCheckUnchanged(s, guardId, observed) {
    var after := checkUnchanged(s, guardId, observed);
    PreparedGuardRecordsPreserved(s, after);
    forall g | g in after.guards && (g.errorCode == "MODEL_PREPARED_REQUEST_MUTATED" || g.errorCode == "MODEL_PREPARED_REQUEST_TOKEN_COUNT_DRIFT")
      ensures g.phase.GuardReady?
    {
      var i :| 0 <= i < |after.guards| && after.guards[i] == g;
      var prior := s.guards[i];
      assert prior in s.guards;
      if prior.id == guardId {
        PreparedGuardByIdentity(s, prior);
        assert prior == preparedGuard(s, guardId);
      }
    }
    forall oldGuard | oldGuard in s.guards ensures exists other :: other in after.guards && other.id == oldGuard.id && other.attempts == oldGuard.attempts
    {
      var i :| 0 <= i < |s.guards| && s.guards[i] == oldGuard;
      assert after.guards[i] in after.guards;
    }
  }
}


lemma PreparedGuardFilters(s: PreparedRequests)
  ensures alwaysGuardIdsUnique(s) == (forall g :: g in s.guards ==> g.id > 0 && |ProofLib.Filter((other: PreparedGuard) => (other.id == g.id), s.guards)| == 1)
{}

lemma PreparedGuardProjection(s: PreparedRequests, guardId: int)
  ensures preparedGuard(s, guardId) == (var matching := ProofLib.Filter((g: PreparedGuard) => (g.id == guardId), s.guards); if |matching| > 0 then matching[0] else noGuard)
{}

lemma PreparedGuardByIdentity(s: PreparedRequests, g: PreparedGuard)
  requires alwaysGuardIdsUnique(s) && g in s.guards
  ensures preparedGuard(s, g.id) == g
{
  PreparedGuardFilters(s);
  PreparedGuardProjection(s, g.id);
  var matching := ProofLib.Filter((candidate: PreparedGuard) => (candidate.id == g.id), s.guards);
  ProofLib.FilterSamePredicate((candidate: PreparedGuard) => (candidate.id == g.id), (other: PreparedGuard) => (other.id == g.id), s.guards);
  ProofLib.FilterMember((candidate: PreparedGuard) => (candidate.id == g.id), s.guards, g);
  assert |matching| == 1 && matching[0] == g;
}

lemma createRequestGuard_ensures(s: PreparedRequests, guardId: int, requestInput: RequestGuardInput)
  ensures (inv(s) ==> canCreateRequestGuard(s, guardId, requestInput) ==> alwaysGuardIdsUnique(createRequestGuard(s, guardId, requestInput)))
  ensures (inv(s) ==> canCreateRequestGuard(s, guardId, requestInput) ==> alwaysExactBudgetAdmission(createRequestGuard(s, guardId, requestInput)))
  ensures (inv(s) ==> canCreateRequestGuard(s, guardId, requestInput) ==> alwaysGuardAttemptsNonnegative(createRequestGuard(s, guardId, requestInput)))
  ensures (inv(s) ==> canCreateRequestGuard(s, guardId, requestInput) ==> alwaysPreparedLeasesStayNonnegative(createRequestGuard(s, guardId, requestInput)))
  ensures (inv(s) ==> canCreateRequestGuard(s, guardId, requestInput) ==> alwaysRecheckKeepsAdmittedGuard(createRequestGuard(s, guardId, requestInput)))
  ensures (inv(s) ==> canCreateRequestGuard(s, guardId, requestInput) ==> stepGuardBytesStayFixed(s, createRequestGuard(s, guardId, requestInput)))
  ensures (inv(s) ==> canCreateRequestGuard(s, guardId, requestInput) ==> stepUnchangedCheckDoesNotCount(s, "createRequestGuard", createRequestGuard(s, guardId, requestInput)))
{
  if inv(s) && canCreateRequestGuard(s, guardId, requestInput) {
    var after := createRequestGuard(s, guardId, requestInput);
    var created := buildRequestGuard(guardId, requestInput);
    assert after.guards == s.guards + [created];
    PreparedGuardFilters(s); PreparedGuardFilters(after);
    forall g | g in after.guards ensures g.id > 0 && |ProofLib.Filter((other: PreparedGuard) => (other.id == g.id), after.guards)| == 1
    {
      ProofLib.FilterAppend((other: PreparedGuard) => (other.id == g.id), s.guards, created);
      if g == created { ProofLib.FilterNone((other: PreparedGuard) => (other.id == g.id), s.guards); }
      else { assert g in s.guards; }
    }
  }
}
