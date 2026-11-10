// One grant, cumulative refund receipts and one dispute. The organization
// transaction publishes reinstatement, refund repair and hold settlement together.
module credit_reversal_reinstatement {
  type ReversalSource = Dispute | Refund | Reapplication
  type Reinstatement = NoEvent | WaitingForWithdrawal | Settled
  type Obligation = {
    source: ReversalSource, target: int, applied: int, shortfall: int, outstanding: int
  }
  type State = {
    funded: bool, balance: int, spent: int, toppedUp: bool,
    rows: List[Obligation], providerRefund: int, acknowledgedRefund: int,
    reinstatement: Reinstatement, preparedRefund: int,
    failureBudget: int, acknowledgedReinstatement: bool,
  }
  var s: State
  pure val grant = 2
  pure def min(a: int, b: int): int = if (a < b) a else b
  pure def max(a: int, b: int): int = if (a > b) a else b
  pure def total(row: Obligation): int = row.applied + row.shortfall
  pure def repaid(row: Obligation): int = row.shortfall - row.outstanding
  pure def hasDispute(x: State): bool = x.rows.select(row => row.source == Dispute).length() > 0
  pure def disputeRepayment(x: State): int =
    x.rows.foldl(0, (sum, row) => sum + if (row.source == Dispute) repaid(row) else 0)
  pure def disputeApplied(x: State): int =
    x.rows.foldl(0, (sum, row) => sum + if (row.source == Dispute) row.applied else 0)
  pure def reinstatementReceipt(x: State): bool = x.reinstatement == Settled
  pure def onHold(x: State, row: Obligation): bool =
    row.outstanding > 0 and not(row.source == Dispute and reinstatementReceipt(x))
  pure def refundBooked(x: State): int =
    x.rows.foldl(0, (sum, row) => sum + if (row.source == Dispute) 0 else total(row))
  pure def knownRefund(x: State): int =
    x.rows.foldl(0, (target, row) => if (row.source == Dispute) target else max(target, row.target))
  pure def covered(x: State): int = x.rows.foldl(0, (sum, row) =>
    sum + if (row.source == Dispute and reinstatementReceipt(x)) 0 else total(row))
  pure def hasHold(x: State): bool = x.rows.select(row => onHold(x, row)).length() > 0
  pure def paidAdmission(x: State): bool = x.balance > 0 and not(hasHold(x))

  // Zero-delta cumulative receipts preserve the observed target. Their economic
  // obligation is zero, but a later preparation must still see that observation.
  pure def book(x: State, source: ReversalSource, target: int): State = {
    val series = if (source == Dispute) 0 else refundBooked(x)
    val delta = min(max(target - series, 0), grant - covered(x))
    if (target <= 0 or x.rows.select(row => row.source == source and row.target == target).length() > 0) x
    else {
      val applied = min(delta, x.balance)
      val shortfall = delta - applied
      { ...x, balance: x.balance - applied, rows: x.rows.append({
        source: source, target: target, applied: applied,
        shortfall: shortfall, outstanding: shortfall,
      }) }
    }
  }
  pure def repay(x: State): State = {
    val settled = x.rows.foldl({ balance: x.balance, rows: List() }, (acc, row) => {
      val payment = if (onHold(x, row)) min(row.outstanding, acc.balance) else 0
      { balance: acc.balance - payment,
        rows: acc.rows.append({ ...row, outstanding: row.outstanding - payment }) }
    })
    { ...x, balance: settled.balance, rows: settled.rows }
  }
  action init = s' = {
    funded: false, balance: 0, spent: 0, toppedUp: false, rows: List(),
    providerRefund: 0, acknowledgedRefund: 0, reinstatement: NoEvent,
    preparedRefund: -1, failureBudget: 1, acknowledgedReinstatement: false,
  }
  action grantCredits = all { not(s.funded), s' = { ...s, funded: true, balance: grant } }
  action spend = all { paidAdmission(s), s' = { ...s, balance: s.balance - 1, spent: s.spent + 1 } }
  action topUp = all { s.funded, not(s.toppedUp), s' = { ...s, balance: s.balance + 1, toppedUp: true } }
  action repayOutstanding = all { hasHold(s), s.balance > 0, s' = repay(s) }
  action observeRefund(target: int): bool = all {
    target > s.providerRefund, s' = { ...s, providerRefund: target },
  }
  action retryBeforeGrant = all { not(s.funded), s' = s }
  action deliverRefund(target: int): bool = all {
    s.funded, target <= s.providerRefund,
    val updated = book(s, Refund, target)
    s' = { ...updated, acknowledgedRefund: max(s.acknowledgedRefund, target) },
  }
  action withdrawDispute(target: int): bool = all {
    s.funded, s' = if (hasDispute(s)) s else book(s, Dispute, target),
  }
  action observeReinstatement = all {
    s.reinstatement == NoEvent, s' = { ...s, reinstatement: WaitingForWithdrawal },
  }
  action prepareObserved(observed: int): bool = all {
    s.reinstatement == WaitingForWithdrawal, hasDispute(s), s.preparedRefund == -1,
    observed >= 0, observed <= s.providerRefund,
    s' = { ...s, preparedRefund: max(observed, knownRefund(s)) },
  }
  action prepare = { nondet observed = 0.to(s.providerRefund).oneOf(); prepareObserved(observed) }
  action stalePreparation = all {
    s.reinstatement == WaitingForWithdrawal, s.preparedRefund >= 0,
    s.preparedRefund < knownRefund(s), s' = s.with("preparedRefund", -1),
  }
  action failedTransaction = all {
    s.reinstatement == WaitingForWithdrawal, s.preparedRefund >= knownRefund(s),
    s.failureBudget > 0,
    s' = s.with("preparedRefund", -1).with("failureBudget", 0),
  }
  action commitReinstatement = all {
    s.reinstatement == WaitingForWithdrawal, s.preparedRefund >= knownRefund(s),
    val returned = { ...s, reinstatement: Settled,
      balance: s.balance + disputeApplied(s) + disputeRepayment(s) }
    s' = repay(book(returned, Reapplication, s.preparedRefund)).with("preparedRefund", -1),
  }
  action acknowledgeReinstatement = all {
    s.reinstatement == Settled, not(s.acknowledgedReinstatement),
    s' = s.with("acknowledgedReinstatement", true),
  }
  // The transaction can commit before its cache/publication acknowledgement.
  action replayAfterLostAcknowledgement = all { s.reinstatement == Settled, s' = s }
  action continueReinstatement = any { prepare, stalePreparation, commitReinstatement }
  action deliverLatestRefund = all {
    s.providerRefund > s.acknowledgedRefund, deliverRefund(s.providerRefund),
  }
  action idle = s' = s
  action step = {
    nondet target = Set(1, 2).oneOf()
    any { grantCredits, spend, topUp, repayOutstanding, observeRefund(target),
      retryBeforeGrant, deliverRefund(target), deliverLatestRefund, withdrawDispute(target),
      observeReinstatement, continueReinstatement, failedTransaction,
      acknowledgeReinstatement, replayAfterLostAcknowledgement, idle }
  }
  pure def netDebits(x: State): int = x.rows.foldl(0, (sum, row) => {
    val released = row.source == Dispute and reinstatementReceipt(x)
    sum + if (released) 0 else row.applied + repaid(row)
  })
  val Conserved = s.balance >= 0 and s.balance + s.spent + netDebits(s) ==
    (if (s.funded) grant else 0) + (if (s.toppedUp) 1 else 0)
  val Capped = covered(s) <= grant and s.rows.select(row => total(row) < 0 or total(row) > row.target or row.target <= 0 or
    row.applied < 0 or row.outstanding < 0 or row.outstanding > row.shortfall).length() == 0
  val UniqueReceipts = s.rows.foldl(Set(), (identities, row) =>
    identities.union(Set((row.source, row.target)))).size() == s.rows.length()
  val AcknowledgedCovered = covered(s) >= s.acknowledgedRefund
  val KnownRefundRetained = knownRefund(s) >= s.acknowledgedRefund
  val PaidAdmissionCovered = paidAdmission(s) implies AcknowledgedCovered
  temporal ReinstatementSettles = always((s.reinstatement != NoEvent and hasDispute(s))
    implies eventually(s.reinstatement == Settled))
  temporal RefundSettles = always((s.funded and s.providerRefund > s.acknowledgedRefund)
    implies eventually(s.providerRefund == s.acknowledgedRefund))
  temporal RepaymentSettles = always((hasHold(s) and s.balance > 0)
    implies eventually(not(hasHold(s)) or s.balance == 0))
  temporal FairReversalDelivery =
    (continueReinstatement.weakFair(s) and deliverLatestRefund.weakFair(s) and
      repayOutstanding.weakFair(s) and acknowledgeReinstatement.weakFair(s)) implies
    (ReinstatementSettles and RefundSettles and RepaymentSettles and
      always(s.reinstatement == Settled implies eventually(s.acknowledgedReinstatement)))
  temporal HoldAuthority = always(and {
    (next(s.spent) > s.spent) implies paidAdmission(s),
    reinstatementReceipt(s) implies next(disputeRepayment(s)) == disputeRepayment(s),
  }.orKeep(s))

  run beforeGrantRetriesTest = init.then(observeRefund(2)).then(retryBeforeGrant)
    .expect(s.rows.length() == 0 and s.acknowledgedRefund == 0)
    .then(grantCredits).then(deliverRefund(2)).expect(s.balance == 0 and refundBooked(s) == 2)
  run cumulativeRefundReplayTest = init.then(grantCredits).then(spend)
    .then(observeRefund(1)).then(deliverRefund(1)).then(observeRefund(2)).then(deliverRefund(2))
    .then(deliverRefund(1)).then(deliverRefund(2))
    .expect(Conserved and UniqueReceipts and refundBooked(s) == 2 and hasHold(s))
  run zeroCreditReceiptAllowsLaterRefundTest = init.then(grantCredits).then(spend).then(spend)
    .then(observeReinstatement).then(withdrawDispute(2)).then(prepareObserved(0)).then(commitReinstatement)
    .then(observeRefund(2)).then(deliverRefund(2))
    .expect(reinstatementReceipt(s) and refundBooked(s) == 2 and hasHold(s) and Conserved)
  run atomicRepairNeverPublishesReturnedCreditTest = init.then(grantCredits)
    .then(withdrawDispute(1)).then(observeRefund(2)).then(deliverRefund(2))
    .then(observeReinstatement).then(prepareObserved(2)).then(commitReinstatement)
    .expect(s.balance == 0 and refundBooked(s) == 2 and AcknowledgedCovered and PaidAdmissionCovered)
  run failedRepairPublishesNoCreditTest = init.then(grantCredits).then(withdrawDispute(1))
    .then(observeRefund(2)).then(deliverRefund(2)).then(observeReinstatement)
    .then(prepareObserved(2)).then(failedTransaction)
    .expect(s.balance == 0 and not(paidAdmission(s)) and not(reinstatementReceipt(s)))
    .then(prepareObserved(2)).then(commitReinstatement).expect(Conserved and AcknowledgedCovered)
  run zeroRefundReceiptInvalidatesStalePreparationTest = init.then(grantCredits)
    .then(withdrawDispute(2)).then(observeReinstatement).then(prepareObserved(0))
    .then(observeRefund(2)).then(deliverRefund(2))
    .expect(knownRefund(s) == 2 and refundBooked(s) == 0 and s.preparedRefund == 0)
    .then(stalePreparation).then(prepareObserved(0)).then(commitReinstatement)
    .expect(s.balance == 0 and AcknowledgedCovered and Conserved)
  run returnedRepaymentUsesOriginalAmountTest = init.then(grantCredits).then(spend).then(spend)
    .then(withdrawDispute(2)).then(topUp).then(repayOutstanding).then(observeReinstatement)
    .then(prepareObserved(0)).then(commitReinstatement)
    .expect(s.balance == 1 and Conserved and not(hasHold(s)))
  run repaymentAndHoldRollbackTogetherTest = init.then(grantCredits).then(spend).then(spend)
    .then(withdrawDispute(2)).then(topUp).then(repayOutstanding).then(observeRefund(2))
    .then(deliverRefund(2)).then(observeReinstatement).then(prepareObserved(2)).then(failedTransaction)
    .expect(s.balance == 0 and hasHold(s) and disputeRepayment(s) == 1)
    .then(prepareObserved(2)).then(commitReinstatement)
    .expect(s.balance == 0 and hasHold(s) and AcknowledgedCovered and Conserved)
  run postCommitAcknowledgementLossDoesNotReplayCreditTest = init.then(grantCredits)
    .then(withdrawDispute(1)).then(observeRefund(2)).then(deliverRefund(2))
    .then(observeReinstatement).then(prepareObserved(2)).then(commitReinstatement)
    .then(replayAfterLostAcknowledgement).then(replayAfterLostAcknowledgement)
    .expect(s.balance == 0 and not(s.acknowledgedReinstatement) and Conserved)
    .then(acknowledgeReinstatement).expect(s.acknowledgedReinstatement and AcknowledgedCovered)
}
