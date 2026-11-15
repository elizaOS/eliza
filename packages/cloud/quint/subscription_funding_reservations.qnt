// Per-operation projection of subscription-funding-reservations.ts.
// One durable (organization, logical-operation) key, two transaction callers,
// two scope/merchant pairs, integer amounts 0..2 and two opaque digest/key values.
// Caller-owned organization locking serializes transactions. A failure aborts
// the whole transaction; repository calls stage complete records before commit.
// Positive createPrerequisite reservations only; zero-funded observations and
// cross-operation balances/credit-reference uniqueness need separate models.
// requested also represents reserved_amount, which the writer and schema keep equal.
// Balances, allowance eligibility, actual expiry, digest cryptography, provider
// effects and SQL isolation are assumptions/evidence outside this projection.
// Owned reference IDs are alpha representatives per role. Reusing reserveRef
// in persistCurrent does not assert that actual reserve, settle and refund
// ledger rows share identity; their independent uniqueness is not modeled.
module subscription_funding_reservations {
  type Funding = {
    status: str, scope: int, merchant: int, digest: int, expiry: int, cash: bool,
    requested: int, allowance: int, purchased: int, period: int, reserveRef: int,
    usedA: int, usedP: int, releasedA: int, releasedP: int, expiredA: int,
    expired: bool, key: int, terminalDigest: int, settleRef: int, refundRef: int, overage: int
  }
  pure val empty: Funding = {
    status: "absent", scope: -1, merchant: -1, digest: -1, expiry: -1, cash: false,
    requested: 0, allowance: 0, purchased: 0, period: -1, reserveRef: -1,
    usedA: 0, usedP: 0, releasedA: 0, releasedP: 0, expiredA: 0,
    expired: false, key: -1, terminalDigest: -1, settleRef: -1, refundRef: -1, overage: 0
  }
  var s: { committed: Funding, staged: Funding, before: Funding, identity: Funding,
    sealed: Funding, tx: int, failed: bool, last: str }
  action init = s' = { committed: empty, staged: empty, before: empty, identity: empty,
    sealed: empty, tx: -1, failed: false, last: "init" }
  pure def ownedRef(amount: int, ref: int): bool =
    if (amount == 0) ref == -1 else Set(0, 1).contains(ref)
  pure def immutable(a: Funding, b: Funding): bool = all {
    a.scope == b.scope, a.merchant == b.merchant, a.digest == b.digest, a.expiry == b.expiry,
    a.cash == b.cash, a.requested == b.requested, a.allowance == b.allowance,
    a.purchased == b.purchased, a.period == b.period, a.reserveRef == b.reserveRef
  }
  pure def terminal(row: Funding): bool = Set("finalized", "canceled").contains(row.status)
  pure def conserved(row: Funding): bool = if (row.status == "absent") row == empty else all {
    row.requested > 0, row.allowance >= 0, row.purchased >= 0,
    row.allowance + row.purchased == row.requested,
    row.cash implies row.allowance == 0,
    (row.allowance == 0 and row.period == -1) or (row.allowance > 0 and row.period == 0),
    ownedRef(row.purchased, row.reserveRef),
    if (row.status == "reserved") all {
      row.usedA == 0, row.usedP == 0, row.releasedA == 0, row.releasedP == 0, row.expiredA == 0,
      row.key == -1, row.terminalDigest == -1, row.settleRef == -1, row.refundRef == -1,
      not(row.expired), row.overage == 0
    } else all {
      terminal(row), row.key >= 0, row.terminalDigest >= 0,
      row.usedA >= 0, row.usedP >= 0, row.releasedA >= 0, row.releasedP >= 0, row.expiredA >= 0,
      row.allowance == row.usedA + row.releasedA + row.expiredA,
      row.purchased == row.usedP + row.releasedP,
      if (row.expired) row.releasedA == 0 else row.expiredA == 0,
      ownedRef(row.usedP, row.settleRef), ownedRef(row.releasedP, row.refundRef), row.overage >= 0,
      row.status == "canceled" implies (row.usedA == 0 and row.usedP == 0 and row.overage == 0)
    }
  }
  action beginTx(caller: int): bool = all {
    s.tx == -1, s' = { ...s, tx: caller, staged: s.committed, before: s.committed,
      failed: false, last: "begin" }
  }
  action reserve(scope: int, merchant: int, digest: int, expiry: int, cash: bool,
      requested: int, allowance: int, purchased: int, period: int, reserveRef: int): bool = all {
    s.tx >= 0, not(s.failed),
    { val candidate = { ...empty, status: "reserved", scope: scope, merchant: merchant,
        digest: digest, expiry: expiry, cash: cash, requested: requested,
        allowance: allowance, purchased: purchased, period: period, reserveRef: reserveRef }
      val valid = requested > 0 and allowance >= 0 and purchased >= 0 and
        requested == allowance + purchased and (not(cash) or allowance == 0) and
        ((allowance == 0 and period == -1) or (allowance > 0 and period == 0)) and
        ownedRef(purchased, reserveRef)
      val fresh = s.staged.status == "absent"
      val replay = not(fresh) and immutable(s.staged, candidate)
      s' = { ...s, staged: if (valid and fresh) candidate else s.staged,
        failed: not(valid and (fresh or replay)),
        last: if (not(valid and (fresh or replay))) "rejected" else if (fresh) "reserved" else "replayed" }
    }
  }
  action reserveAgain(digest: int): bool = reserve(s.staged.scope, s.staged.merchant, digest,
    s.staged.expiry, s.staged.cash, s.staged.requested, s.staged.allowance,
    s.staged.purchased, s.staged.period, s.staged.reserveRef)
  action persist(org: int, scope: int, merchant: int, kind: str, key: int, digest: int,
      usedA: int, usedP: int, expired: bool, settleRef: int, refundRef: int, overage: int): bool = all {
    s.tx >= 0, not(s.failed),
    { val row = s.staged
      val scoped = org == 0 and row.status != "absent" and row.scope == scope and row.merchant == merchant
      val wanted = if (kind == "settlement") "finalized" else "canceled"
      val replay = terminal(row) and row.status == wanted and row.key == key and row.terminalDigest == digest
      val valid = usedA >= 0 and usedP >= 0 and usedA <= row.allowance and usedP <= row.purchased and
        overage >= 0 and (kind == "settlement" or (usedA == 0 and usedP == 0 and overage == 0)) and
        ownedRef(usedP, settleRef) and ownedRef(row.purchased - usedP, refundRef)
      val fresh = row.status == "reserved" and valid
      val accepted = scoped and (replay or fresh)
      val nextRow = { ...row, status: wanted, usedA: usedA, usedP: usedP,
        releasedA: if (expired) 0 else row.allowance - usedA,
        expiredA: if (expired) row.allowance - usedA else 0,
        releasedP: row.purchased - usedP, expired: expired, key: key, terminalDigest: digest,
        settleRef: settleRef, refundRef: refundRef, overage: overage }
      s' = { ...s, staged: if (scoped and fresh) nextRow else row,
        failed: not(accepted), last: if (not(accepted)) "rejected" else if (replay) "replayed" else "terminal" }
    }
  }
  action persistCurrent(kind: str, key: int, digest: int, usedA: int, usedP: int,
      expired: bool, overage: int): bool = persist(0, s.staged.scope, s.staged.merchant, kind, key,
    digest, usedA, usedP, expired, if (usedP > 0) s.staged.reserveRef else -1,
    if (s.staged.purchased > usedP) s.staged.reserveRef else -1, overage)
  action rejectAdmission = all { s.tx >= 0, s' = { ...s, failed: true, last: "callerRejected" } }
  action commitTx = all {
    s.tx >= 0, not(s.failed),
    s' = { ...s, committed: s.staged, tx: -1, last: "commit",
      identity: if (s.identity.status == "absent" and s.staged.status != "absent") s.staged else s.identity,
      sealed: if (s.sealed.status == "absent" and terminal(s.staged)) s.staged else s.sealed }
  }
  action rollbackTx = all {
    s.tx >= 0, s' = { ...s, staged: s.committed, tx: -1, failed: false, last: "rollback" }
  }
  // Guard-removal witnesses are excluded from normal execution.
  action legacyBrokenSplit = all {
    s.tx >= 0, s.staged.status == "absent",
    s' = { ...s, staged: { ...empty, status: "reserved", scope: 0, merchant: 0, digest: 0,
      expiry: 0, requested: 2, purchased: 1, reserveRef: 0 }, last: "reserved" }
  }
  action legacyPublishRollback = all {
    s.tx >= 0, s' = { ...s, committed: s.staged, tx: -1, last: "rollback", failed: false }
  }
  action legacyExpiredRelease = all {
    s.tx >= 0, s.staged.expired, s.staged.expiredA > 0,
    s' = { ...s, staged: { ...s.staged, releasedA: s.staged.expiredA, expiredA: 0 } }
  }
  action legacyRewriteTerminal = all {
    s.tx >= 0, terminal(s.staged),
    s' = { ...s, staged: { ...s.staged, key: 1 - s.staged.key } }
  }
  action step = if (s.tx == -1) {
    nondet caller = Set(0, 1).oneOf()
    beginTx(caller)
  } else if (s.failed) rollbackTx else any {
    commitTx, rollbackTx, rejectAdmission,
    // Enumerate distinct storage outcomes. All rejected argument combinations
    // abort unchanged; terminal replay arguments produce only replay/rejection.
    // The general actions above and negative scenarios retain their full guards.
    if (s.staged.status == "absent") any {
      { nondet scope = Set(0, 1).oneOf()
        nondet digest = Set(0, 1).oneOf()
        nondet expiry = Set(0, 1).oneOf()
        nondet requested = Set(1, 2).oneOf()
        nondet allowance = Set(0, 1, 2).filter(value => value <= requested).oneOf()
        nondet cash = (if (allowance == 0) Set(false, true) else Set(false)).oneOf()
        reserve(scope, scope, digest, expiry, cash, requested, allowance, requested - allowance,
          if (allowance > 0) 0 else -1, if (requested > allowance) 0 else -1)
      },
      reserve(0, 0, 0, 0, false, 2, 1, 0, 0, -1)
    } else any {
      reserveAgain(s.staged.digest), reserveAgain(1 - s.staged.digest),
      if (terminal(s.staged)) any {
        persistCurrent(if (s.staged.status == "finalized") "settlement" else "cancellation",
          s.staged.key, s.staged.terminalDigest, s.staged.usedA, s.staged.usedP,
          s.staged.expired, s.staged.overage),
        persistCurrent("settlement", 1 - s.staged.key, s.staged.terminalDigest, 0, 0, false, 0)
      } else {
        nondet kind = Set("settlement", "cancellation").oneOf()
        nondet key = Set(0, 1).oneOf()
        nondet digest = Set(0, 1).oneOf()
        nondet expired = Set(false, true).oneOf()
        nondet usedA = (if (kind == "cancellation") Set(0)
          else Set(0, 1, 2).filter(value => value <= s.staged.allowance)).oneOf()
        nondet usedP = (if (kind == "cancellation") Set(0)
          else Set(0, 1, 2).filter(value => value <= s.staged.purchased)).oneOf()
        nondet overage = (if (kind == "cancellation") Set(0) else Set(0, 1)).oneOf()
        persistCurrent(kind, key, digest, usedA, usedP, expired, overage)
      },
      persist(1, s.staged.scope, s.staged.merchant, "settlement", 0, 0, 0, 0, false, -1,
        if (s.staged.purchased > 0) s.staged.reserveRef else -1, 0),
      persist(0, 1 - s.staged.scope, s.staged.merchant, "settlement", 0, 0, 0, 0, false, -1,
        if (s.staged.purchased > 0) s.staged.reserveRef else -1, 0),
      persist(0, s.staged.scope, 1 - s.staged.merchant, "settlement", 0, 0, 0, 0, false, -1,
        if (s.staged.purchased > 0) s.staged.reserveRef else -1, 0)
    }
  }
  val safety = all {
    conserved(s.committed), conserved(s.staged),
    Set(-1, 0, 1).contains(s.tx),
    s.failed implies s.tx >= 0,
    s.tx == -1 implies s.staged == s.committed,
    s.tx >= 0 implies s.committed == s.before,
    s.last == "rollback" implies s.committed == s.before,
    s.committed.status != "absent" implies immutable(s.staged, s.committed),
    terminal(s.committed) implies s.staged == s.committed,
    s.identity.status != "absent" implies immutable(s.committed, s.identity),
    s.sealed.status != "absent" implies s.committed == s.sealed
  }
  action mixedReserve = reserve(0, 0, 0, 0, false, 2, 1, 1, 0, 0)
  run mixedSourcesConserveRequestTest = init.then(beginTx(0)).then(mixedReserve).then(commitTx)
    .expect(s.committed.allowance + s.committed.purchased == 2 and safety)
  run cashOnlyCannotUseAllowanceTest = init.then(beginTx(0))
    .then(reserve(0, 0, 0, 0, true, 2, 1, 1, 0, 0)).expect(s.failed and safety)
  run rejectedAdmissionRollsBackAllRecordsTest = init.then(beginTx(0)).then(mixedReserve)
    .then(rejectAdmission).then(rollbackTx).expect(s.committed == empty and safety)
  run exactReserveReplayKeepsOriginalTest = init.then(beginTx(0)).then(mixedReserve).then(commitTx)
    .then(beginTx(1)).then(reserveAgain(0)).expect(s.last == "replayed" and s.staged == s.committed and safety)
  run conflictingReserveDigestRejectedTest = init.then(beginTx(0)).then(mixedReserve).then(commitTx)
    .then(beginTx(1)).then(reserveAgain(1)).expect(s.failed and s.staged == s.committed and safety)
  run settlementConservesEachSourceTest = init.then(beginTx(0)).then(mixedReserve)
    .then(persistCurrent("settlement", 0, 0, 1, 0, false, 1)).then(commitTx)
    .expect(s.committed.usedA == 1 and s.committed.releasedP == 1 and safety)
  run expiredCancellationForfeitsOnlyAllowanceTest = init.then(beginTx(0)).then(mixedReserve)
    .then(persistCurrent("cancellation", 0, 0, 0, 0, true, 0)).then(commitTx)
    .expect(s.committed.expiredA == 1 and s.committed.releasedA == 0 and s.committed.releasedP == 1 and safety)
  run liveCancellationReleasesBothSourcesTest = init.then(beginTx(0)).then(mixedReserve)
    .then(persistCurrent("cancellation", 0, 0, 0, 0, false, 0)).then(commitTx)
    .expect(s.committed.releasedA == 1 and s.committed.releasedP == 1 and safety)
  run failedCompletionRollsBackTerminalAndRefundTest = init.then(beginTx(0)).then(mixedReserve).then(commitTx)
    .then(beginTx(1)).then(persistCurrent("settlement", 0, 0, 1, 0, false, 0))
    .then(rejectAdmission).then(rollbackTx).expect(s.committed.status == "reserved" and safety)
  run exactTerminalIdentityReplaysOriginalReceiptTest = init.then(beginTx(0)).then(mixedReserve)
    .then(persistCurrent("settlement", 0, 0, 1, 0, false, 0)).then(commitTx).then(beginTx(1))
    .then(persistCurrent("settlement", 0, 0, 1, 0, false, 0)).expect(s.last == "replayed" and s.staged == s.committed and safety)
  run conflictingTerminalKindRejectedTest = init.then(beginTx(0)).then(mixedReserve)
    .then(persistCurrent("settlement", 0, 0, 1, 0, false, 0)).then(commitTx).then(beginTx(1))
    .then(persistCurrent("cancellation", 0, 0, 0, 0, false, 0)).expect(s.failed and safety)
  run foreignTenantCannotFinalizeTest = init.then(beginTx(0)).then(mixedReserve)
    .then(persist(1, 0, 0, "settlement", 0, 0, 1, 0, false, -1, 0, 0)).expect(s.failed and s.staged.status == "reserved" and safety)
  run foreignScopeCannotFinalizeTest = init.then(beginTx(0)).then(mixedReserve)
    .then(persist(0, 1, 0, "settlement", 0, 0, 1, 0, false, -1, 0, 0)).expect(s.failed and safety)
  run foreignMerchantCannotFinalizeTest = init.then(beginTx(0)).then(mixedReserve)
    .then(persist(0, 0, 1, "settlement", 0, 0, 1, 0, false, -1, 0, 0)).expect(s.failed and safety)
  run foreignCreditReferenceRejectedTest = init.then(beginTx(0))
    .then(reserve(0, 0, 0, 0, false, 1, 0, 1, -1, 2)).expect(s.failed and safety)
  run changedOwnedReservationReferenceRejectedTest = init.then(beginTx(0)).then(mixedReserve)
    .then(commitTx).then(beginTx(1)).then(reserve(0, 0, 0, 0, false, 2, 1, 1, 0, 1))
    .expect(s.failed and s.staged == s.committed and safety)
  run terminalCannotExceedReservedSourceTest = init.then(beginTx(0)).then(mixedReserve)
    .then(persistCurrent("settlement", 0, 0, 2, 0, false, 0)).expect(s.failed and safety)
  run conflictingTerminalKeyRejectedTest = init.then(beginTx(0)).then(mixedReserve)
    .then(persistCurrent("settlement", 0, 0, 1, 0, false, 0)).then(commitTx).then(beginTx(1))
    .then(persistCurrent("settlement", 1, 0, 1, 0, false, 0)).expect(s.failed and safety)
  run brokenSplitIsDetectedTest = init.then(beginTx(0)).then(legacyBrokenSplit).expect(not(safety))
  run partialRollbackIsDetectedTest = init.then(beginTx(0)).then(mixedReserve)
    .then(legacyPublishRollback).expect(not(safety))
  run misclassifiedExpiredAllowanceIsDetectedTest = init.then(beginTx(0)).then(mixedReserve)
    .then(persistCurrent("cancellation", 0, 0, 0, 0, true, 0)).then(legacyExpiredRelease).expect(not(safety))
  run terminalRewriteIsDetectedTest = init.then(beginTx(0)).then(mixedReserve)
    .then(persistCurrent("settlement", 0, 0, 1, 0, false, 0)).then(commitTx).then(beginTx(1))
    .then(legacyRewriteTerminal).expect(not(safety))
}
