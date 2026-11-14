lemma AllowanceIdentityFilter(s: ModelLeases)
  ensures alwaysAllowanceIdsUnique(s) == (forall a :: a in s.allowances ==> a.id > 0 && |ProofLib.Filter((other: Allowance) => (other.id == a.id), s.allowances)| == 1)
{}

lemma AttemptLeaseIdentityFilter(s: ModelLeases)
  ensures alwaysLeasesUnique(s) == (forall l :: l in s.leases ==> |ProofLib.Filter((other: AttemptLease) => (other.id == l.id), s.leases)| == 1)
{}

lemma AllowanceSelection(s: ModelLeases, accountId: int)
  ensures allowance(s, accountId) == (var matches := ProofLib.Filter((a: Allowance) => (a.id == accountId), s.allowances); if |matches| > 0 then matches[0] else noAllowance)
{}

lemma FindAllowance(s: ModelLeases, accountId: int)
  requires alwaysAllowanceIdsUnique(s)
  ensures allowance(s, accountId).id != 0 <==> (exists a :: a in s.allowances && a.id == accountId)
  ensures forall a :: a in s.allowances && a.id == accountId ==> allowance(s, accountId) == a
{
  AllowanceIdentityFilter(s); AllowanceSelection(s, accountId);
  var matches := ProofLib.Filter((a: Allowance) => (a.id == accountId), s.allowances);
  if |matches| > 0 {
    var existing := matches[0];
    ProofLib.FilterMember((a: Allowance) => (a.id == accountId), s.allowances, existing);
    ProofLib.FilterSamePredicate((a: Allowance) => (a.id == accountId), (other: Allowance) => (other.id == existing.id), s.allowances);
    assert |matches| == 1;
    forall a | a in s.allowances && a.id == accountId ensures a == existing
    { ProofLib.FilterMember((a: Allowance) => (a.id == accountId), s.allowances, a); }
  } else {
    forall a | a in s.allowances ensures a.id != accountId
    { ProofLib.FilterMember((a: Allowance) => (a.id == accountId), s.allowances, a); }
  }
}

lemma MapAllowances(s: ModelLeases, after: ModelLeases)
  requires alwaysAllowanceIdsUnique(s)
  requires |after.allowances| == |s.allowances|
  requires forall i :: 0 <= i < |s.allowances| ==> after.allowances[i].id == s.allowances[i].id
  ensures alwaysAllowanceIdsUnique(after)
  ensures forall a :: a in s.allowances ==> (exists b :: b in after.allowances && b.id == a.id)
{
  AllowanceIdentityFilter(s); AllowanceIdentityFilter(after);
  forall a | a in after.allowances ensures a.id > 0 && |ProofLib.Filter((other: Allowance) => (other.id == a.id), after.allowances)| == 1
  {
    var i :| 0 <= i < |after.allowances| && after.allowances[i] == a;
    assert s.allowances[i] in s.allowances;
    ProofLib.FilterLengthPointwise((other: Allowance) => (other.id == a.id), (other: Allowance) => (other.id == a.id), s.allowances, after.allowances);
  }
  forall a | a in s.allowances ensures exists b :: b in after.allowances && b.id == a.id
  {
    var i :| 0 <= i < |s.allowances| && s.allowances[i] == a;
    assert after.allowances[i] in after.allowances;
  }
}

lemma RetainLeaseAccounts(s: ModelLeases, after: ModelLeases)
  requires alwaysLeaseHasAllowance(s) && alwaysAllowanceIdsUnique(s) && alwaysAllowanceIdsUnique(after)
  requires after.leases == s.leases
  requires forall a :: a in s.allowances ==> (exists b :: b in after.allowances && b.id == a.id)
  ensures alwaysLeaseHasAllowance(after)
{
  forall l | l in after.leases ensures l.id > 0 && allowance(after, l.allowance).id != 0 && l.messageId != ""
  {
    FindAllowance(s, l.allowance);
    FindAllowance(after, l.allowance);
  }
}

lemma ProductChargeNonnegative(a: int, b: int, limit: int)
  ensures productCharge(a, b, limit).within ==> productCharge(a, b, limit).whole >= 0 && productCharge(a, b, limit).remainder >= 0
{
  if productCharge(a, b, limit).within {
    assert a >= 0 && b > 0;
    assert 0 <= a / 1000 && 0 <= b / 1000;
    assert quotient_core__modelAttemptLeases(a, 1000) == a / 1000;
    assert quotient_core__modelAttemptLeases(b, 1000) == b / 1000;
    assert remainder_core__modelAttemptLeases(a, 1000) == a % 1000;
    assert remainder_core__modelAttemptLeases(b, 1000) == b % 1000;
    var ar := a % 1000;
    var br := b % 1000;
    assert 0 <= ar * br;
    assert quotient_core__modelAttemptLeases(ar * br, 1000) == (ar * br) / 1000;
    assert remainder_core__modelAttemptLeases(ar * br, 1000) == (ar * br) % 1000;
  }
}

lemma createAllowance_ensures(s: ModelLeases, allowanceId: int, allowanceInput: AllowanceInput)
  ensures (inv(s) ==> canCreateAllowance(s, allowanceId, allowanceInput) ==> alwaysAllowanceIdsUnique(createAllowance(s, allowanceId, allowanceInput)))
  ensures (inv(s) ==> canCreateAllowance(s, allowanceId, allowanceInput) ==> alwaysLeasesUnique(createAllowance(s, allowanceId, allowanceInput)))
  ensures (inv(s) ==> canCreateAllowance(s, allowanceId, allowanceInput) ==> alwaysLeaseHasAllowance(createAllowance(s, allowanceId, allowanceInput)))
  ensures (inv(s) ==> canCreateAllowance(s, allowanceId, allowanceInput) ==> alwaysAllowancesNonnegative(createAllowance(s, allowanceId, allowanceInput)))
  ensures (inv(s) ==> canCreateAllowance(s, allowanceId, allowanceInput) ==> stepAllowanceNeverRefunded(s, createAllowance(s, allowanceId, allowanceInput)))
  ensures (inv(s) ==> canCreateAllowance(s, allowanceId, allowanceInput) ==> stepClosedLeaseStaysClosed(s, createAllowance(s, allowanceId, allowanceInput)))
{
  if inv(s) && canCreateAllowance(s, allowanceId, allowanceInput) {
    var after := createAllowance(s, allowanceId, allowanceInput);
    AllowanceIdentityFilter(s); AllowanceIdentityFilter(after);
    var added := after.allowances[|s.allowances|];
    forall a | a in after.allowances ensures a.id > 0 && |ProofLib.Filter((other: Allowance) => (other.id == a.id), after.allowances)| == 1
    {
      ProofLib.FilterAppend((other: Allowance) => (other.id == a.id), s.allowances, added);
      if a == added { ProofLib.FilterNone((other: Allowance) => (other.id == a.id), s.allowances); }
      else { assert a in s.allowances; }
    }
    RetainLeaseAccounts(s, after);
  }
}

lemma openTurnLease_ensures(s: ModelLeases, allowanceId: int, leaseId: int, messageId: string)
  ensures (inv(s) ==> canOpenTurnLease(s, allowanceId, leaseId, messageId) ==> alwaysAllowanceIdsUnique(openTurnLease(s, allowanceId, leaseId, messageId)))
  ensures (inv(s) ==> canOpenTurnLease(s, allowanceId, leaseId, messageId) ==> alwaysLeasesUnique(openTurnLease(s, allowanceId, leaseId, messageId)))
  ensures (inv(s) ==> canOpenTurnLease(s, allowanceId, leaseId, messageId) ==> alwaysLeaseHasAllowance(openTurnLease(s, allowanceId, leaseId, messageId)))
  ensures (inv(s) ==> canOpenTurnLease(s, allowanceId, leaseId, messageId) ==> alwaysAllowancesNonnegative(openTurnLease(s, allowanceId, leaseId, messageId)))
  ensures (inv(s) ==> canOpenTurnLease(s, allowanceId, leaseId, messageId) ==> stepAllowanceNeverRefunded(s, openTurnLease(s, allowanceId, leaseId, messageId)))
  ensures (inv(s) ==> canOpenTurnLease(s, allowanceId, leaseId, messageId) ==> stepClosedLeaseStaysClosed(s, openTurnLease(s, allowanceId, leaseId, messageId)))
{
  if inv(s) && canOpenTurnLease(s, allowanceId, leaseId, messageId) {
    var after := openTurnLease(s, allowanceId, leaseId, messageId);
    AttemptLeaseIdentityFilter(s); AttemptLeaseIdentityFilter(after);
    var added := after.leases[|s.leases|];
    forall l | l in after.leases ensures |ProofLib.Filter((other: AttemptLease) => (other.id == l.id), after.leases)| == 1
    {
      ProofLib.FilterAppend((other: AttemptLease) => (other.id == l.id), s.leases, added);
      if l == added { ProofLib.FilterNone((other: AttemptLease) => (other.id == l.id), s.leases); }
      else { assert l in s.leases; }
    }
  }
}

lemma closeTurnLease_ensures(s: ModelLeases, leaseId: int)
  ensures (inv(s) ==> canCloseTurnLease(s, leaseId) ==> alwaysAllowanceIdsUnique(closeTurnLease(s, leaseId)))
  ensures (inv(s) ==> canCloseTurnLease(s, leaseId) ==> alwaysLeasesUnique(closeTurnLease(s, leaseId)))
  ensures (inv(s) ==> canCloseTurnLease(s, leaseId) ==> alwaysLeaseHasAllowance(closeTurnLease(s, leaseId)))
  ensures (inv(s) ==> canCloseTurnLease(s, leaseId) ==> alwaysAllowancesNonnegative(closeTurnLease(s, leaseId)))
  ensures (inv(s) ==> canCloseTurnLease(s, leaseId) ==> stepAllowanceNeverRefunded(s, closeTurnLease(s, leaseId)))
  ensures (inv(s) ==> canCloseTurnLease(s, leaseId) ==> stepClosedLeaseStaysClosed(s, closeTurnLease(s, leaseId)))
{
  if inv(s) && canCloseTurnLease(s, leaseId) {
    var after := closeTurnLease(s, leaseId);
    AttemptLeaseIdentityFilter(s); AttemptLeaseIdentityFilter(after);
    forall l | l in after.leases ensures |ProofLib.Filter((other: AttemptLease) => (other.id == l.id), after.leases)| == 1
    {
      var i :| 0 <= i < |after.leases| && after.leases[i] == l;
      assert s.leases[i] in s.leases;
      ProofLib.FilterLengthPointwise((other: AttemptLease) => (other.id == l.id), (other: AttemptLease) => (other.id == l.id), s.leases, after.leases);
    }
    forall l | l in s.leases ensures exists a :: a in after.leases && a.id == l.id && (!l.ended || a.ended)
    {
      var i :| 0 <= i < |s.leases| && s.leases[i] == l;
      assert after.leases[i] in after.leases;
    }
  }
}

lemma closeAllowance_ensures(s: ModelLeases, allowanceId: int)
  ensures (inv(s) ==> canCloseAllowance(s, allowanceId) ==> alwaysAllowanceIdsUnique(closeAllowance(s, allowanceId)))
  ensures (inv(s) ==> canCloseAllowance(s, allowanceId) ==> alwaysLeasesUnique(closeAllowance(s, allowanceId)))
  ensures (inv(s) ==> canCloseAllowance(s, allowanceId) ==> alwaysLeaseHasAllowance(closeAllowance(s, allowanceId)))
  ensures (inv(s) ==> canCloseAllowance(s, allowanceId) ==> alwaysAllowancesNonnegative(closeAllowance(s, allowanceId)))
  ensures (inv(s) ==> canCloseAllowance(s, allowanceId) ==> stepAllowanceNeverRefunded(s, closeAllowance(s, allowanceId)))
  ensures (inv(s) ==> canCloseAllowance(s, allowanceId) ==> stepClosedLeaseStaysClosed(s, closeAllowance(s, allowanceId)))
{
  if inv(s) && canCloseAllowance(s, allowanceId) {
    var after := closeAllowance(s, allowanceId);
    MapAllowances(s, after); RetainLeaseAccounts(s, after);
    forall a | a in s.allowances ensures exists b :: b in after.allowances && b.id == a.id && b.remaining <= a.remaining && b.attemptsRemaining <= a.attemptsRemaining && (!a.closed || b.closed)
    {
      var i :| 0 <= i < |s.allowances| && s.allowances[i] == a;
      assert after.allowances[i] in after.allowances;
    }
  }
}

lemma setAllowanceClock_ensures(s: ModelLeases, now: int)
  ensures (inv(s) ==> alwaysAllowanceIdsUnique(setAllowanceClock(s, now)))
  ensures (inv(s) ==> alwaysLeasesUnique(setAllowanceClock(s, now)))
  ensures (inv(s) ==> alwaysLeaseHasAllowance(setAllowanceClock(s, now)))
  ensures (inv(s) ==> alwaysAllowancesNonnegative(setAllowanceClock(s, now)))
  ensures (inv(s) ==> stepAllowanceNeverRefunded(s, setAllowanceClock(s, now)))
  ensures (inv(s) ==> stepClosedLeaseStaysClosed(s, setAllowanceClock(s, now)))
{
  if inv(s) {
    var after := setAllowanceClock(s, now);
    MapAllowances(s, after); RetainLeaseAccounts(s, after);
    forall a | a in s.allowances ensures exists b :: b in after.allowances && b.id == a.id && b.remaining <= a.remaining && b.attemptsRemaining <= a.attemptsRemaining && (!a.closed || b.closed)
    {
      var i :| 0 <= i < |s.allowances| && s.allowances[i] == a;
      assert after.allowances[i] in after.allowances;
    }
  }
}

lemma reserveAttempt_ensures(s: ModelLeases, leaseId: int, reservationInput: AttemptReservationInput)
  ensures (inv(s) ==> canReserveAttempt(s, leaseId, reservationInput) ==> alwaysAllowanceIdsUnique(reserveAttempt(s, leaseId, reservationInput)))
  ensures (inv(s) ==> canReserveAttempt(s, leaseId, reservationInput) ==> alwaysLeasesUnique(reserveAttempt(s, leaseId, reservationInput)))
  ensures (inv(s) ==> canReserveAttempt(s, leaseId, reservationInput) ==> alwaysLeaseHasAllowance(reserveAttempt(s, leaseId, reservationInput)))
  ensures (inv(s) ==> canReserveAttempt(s, leaseId, reservationInput) ==> alwaysAllowancesNonnegative(reserveAttempt(s, leaseId, reservationInput)))
  ensures (inv(s) ==> canReserveAttempt(s, leaseId, reservationInput) ==> stepAllowanceNeverRefunded(s, reserveAttempt(s, leaseId, reservationInput)))
  ensures (inv(s) ==> canReserveAttempt(s, leaseId, reservationInput) ==> stepClosedLeaseStaysClosed(s, reserveAttempt(s, leaseId, reservationInput)))
{
  if inv(s) && canReserveAttempt(s, leaseId, reservationInput) {
    var accountId := issuedLease(s, leaseId).allowance;
    var account := allowance(s, accountId);
    var t := selectedTariff(s, leaseId, reservationInput.provider, reservationInput.model, reservationInput.route);
    var charge := reservationCharge(t, reservationInput.outputTokens, account.remaining);
    lawAffordableChargeBound_ensures(t, reservationInput.outputTokens, account.remaining);
    FindAllowance(s, accountId);
    var after := reserveAttempt(s, leaseId, reservationInput);
    MapAllowances(s, after); RetainLeaseAccounts(s, after);
    forall a | a in s.allowances ensures exists b :: b in after.allowances && b.id == a.id && b.remaining <= a.remaining && b.attemptsRemaining <= a.attemptsRemaining && (!a.closed || b.closed)
    {
      var i :| 0 <= i < |s.allowances| && s.allowances[i] == a;
      assert after.allowances[i] in after.allowances;
    }
    forall a | a in after.allowances ensures a.remaining >= 0 && a.attemptsRemaining >= 0
    {
      var i :| 0 <= i < |after.allowances| && after.allowances[i] == a;
      var prior := s.allowances[i];
      assert prior in s.allowances;
      if a.id == accountId { assert prior == account; }
    }
  }
}


lemma lawAffordableChargeBound_ensures(t: Tariff, outputTokens: int, remaining: int)
  ensures (lawAffordableChargeBound(t, outputTokens, remaining) == true)
{
  var input := productCharge(t.inputBound, t.inputRate, remaining);
  var output := productCharge(outputTokens, t.outputRate, remaining - input.whole);
  var sum := input.remainder + output.remainder + 999;
  var total := reservationCharge(t, outputTokens, remaining);
  if total.within {
    assert input.within && output.within;
    ProductChargeNonnegative(t.inputBound, t.inputRate, remaining);
    ProductChargeNonnegative(outputTokens, t.outputRate, remaining - input.whole);
    assert sum >= 0 && quotient_core__modelAttemptLeases(sum, 1000) == sum / 1000;
    assert sum / 1000 >= 0;
  }
}
