// Durable organization-credit Checkout; source obligations accompany this file.
// One immutable USD quote grants two abstract money units, one provider Session,
// one PaymentIntent, one organization. A step represents a complete DB transaction
// or one external effect. Provider response loss is independent of acceptance.
// Stable provider idempotency is assumed only inside its original retention window;
// checkout_retry_clock.qnt separately models the immutable dispatch-time gate.
// No fairness, SDK refinement, cryptography, arbitrary decimal, SQL lock or payout proof.
module checkout_credit_settlement {
  type State = {
    order: str, customerPinned: bool, pendingCreate: bool,
    provider: str, createCalls: int, providerEffects: int, bound: bool,
    browserCanceled: bool, paymentIntentAcked: bool,
    grantCount: int, balance: int, spent: int, clawed: int, shortfall: int,
    cacheDirty: bool, checkoutAcked: bool,
    providerRefund: int, refundDue: Set[int], refundAcked: Set[int], refundTarget: int
  }
  var s: State
  pure val quote = 2

  action init = s' = {
    order: "quoted", customerPinned: false, pendingCreate: false,
    provider: "absent", createCalls: 0, providerEffects: 0, bound: false,
    browserCanceled: false, paymentIntentAcked: false,
    grantCount: 0, balance: 0, spent: 0, clawed: 0, shortfall: 0,
    cacheDirty: false, checkoutAcked: false,
    providerRefund: 0, refundDue: Set(), refundAcked: Set(), refundTarget: 0
  }

  // Customer authority has completed before the quote is allowed to create.
  action pinCustomer = all {
    s.order == "quoted",
    s' = s.with("customerPinned", true)
  }
  action startCreate = all {
    s.customerPinned, s.createCalls < 2,
    Set("quoted", "provider_started", "provider_ambiguous").contains(s.order),
    s' = s.with("order", "provider_started").with("pendingCreate", true)
      .with("createCalls", s.createCalls + 1)
  }
  // A network failure does not tell us whether Stripe accepted the request.
  action loseResponse = all {
    s.order == "provider_started",
    s' = s.with("order", "provider_ambiguous")
  }
  action acceptCreate = all {
    s.pendingCreate,
    s' = s.with("pendingCreate", false)
      .with("provider", if (s.provider == "absent") "open" else s.provider)
      .with("providerEffects", if (s.provider == "absent") 1 else s.providerEffects)
  }
  action rejectBeforeProviderEffect = all {
    s.pendingCreate, s.provider == "absent",
    s' = s.with("pendingCreate", false).with("order", "provider_ambiguous")
  }
  // This includes authenticated list recovery and the original create response.
  // A late bind after webhook settlement is rejected without changing the ledger.
  action bindSession = all {
    s.provider != "absent",
    Set("provider_started", "provider_ambiguous").contains(s.order),
    s' = s.with("bound", true).with("order", "delivered")
  }
  action pay = all {
    s.provider == "open",
    s' = s.with("provider", "paid")
  }
  action expire = all {
    s.provider == "open",
    s' = s.with("provider", "expired")
  }
  // Following cancel_url is navigation, not a provider expiration or DB failure.
  action browserCancel = s' = s.with("browserCanceled", true)
  // Checkout-owned payment_intent.succeeded is acknowledged but cannot grant.
  action paymentIntentEvent = all {
    s.provider == "paid",
    s' = s.with("paymentIntentAcked", true)
  }

  // Both signed Checkout event and authenticated landing verification converge
  // on the same locked order, exact immutable receipt comparison and grant key.
  action settle = all {
    s.provider == "paid",
    Set("provider_started", "provider_ambiguous", "delivered", "settled").contains(s.order),
    s' = s.with("order", "settled").with("bound", true).with("grantCount", if (s.order == "settled") s.grantCount else s.grantCount + 1)
      .with("balance", if (s.order != "settled") s.balance + quote else s.balance)
      .with("cacheDirty", true)
  }
  action invalidateCache = all {
    s.grantCount == 1,
    s' = s.with("cacheDirty", false)
  }
  action acknowledgeCheckout = all {
    s.grantCount == 1, not(s.cacheDirty),
    s' = s.with("checkoutAcked", true)
  }
  // DB errors before COMMIT leave neither half of the grant/order pair visible.
  action rollbackSettlement = all { s.provider == "paid", s' = s }
  // Wrong owner, quote, customer, amount, Session or PI fails receipt validation.
  action rejectMismatchedReceipt = s' = s

  action spend = all {
    s.balance > 0,
    s' = s.with("balance", s.balance - 1).with("spent", s.spent + 1)
  }
  action providerRefund(target: int): bool = all {
    s.provider == "paid", target > s.providerRefund, target <= quote,
    s' = s.with("providerRefund", target).with("refundDue", s.refundDue.union(Set(target)))
  }
  // Delivery order may be arbitrary and a distinct delivery may repeat an
  // already applied target. Before grant, handler retains retryable work.
  action retryRefundBeforeGrant(target: int): bool = all {
    s.refundDue.contains(target), s.grantCount == 0, s' = s
  }
  action applyRefund(target: int): bool = all {
    s.refundDue.contains(target), s.grantCount == 1,
    val delta = if (target > s.refundTarget) target - s.refundTarget else 0
    val applied = if (delta < s.balance) delta else s.balance
    s' = s.with("balance", s.balance - applied).with("clawed", s.clawed + applied)
      .with("shortfall", s.shortfall + delta - applied)
      .with("refundTarget", if (target > s.refundTarget) target else s.refundTarget)
      .with("refundAcked", s.refundAcked.union(Set(target)))
  }
  action idle = s' = s
  action step = {
    nondet target = Set(1, 2).oneOf()
    any {
      pinCustomer, startCreate, loseResponse, acceptCreate, rejectBeforeProviderEffect,
      bindSession, pay, expire, browserCancel, paymentIntentEvent, settle,
      invalidateCache, acknowledgeCheckout, rollbackSettlement, rejectMismatchedReceipt,
      spend, providerRefund(target), retryRefundBeforeGrant(target), applyRefund(target), idle
    }
  }

  val uniqueGrant = s.grantCount >= 0 and s.grantCount <= 1
  val paymentBacked = s.grantCount == 0 or (s.provider == "paid" and s.bound and s.order == "settled")
  val conserved = s.balance + s.spent + s.clawed == quote * s.grantCount
  val nonnegative = s.balance >= 0 and s.spent >= 0 and s.clawed >= 0 and s.shortfall >= 0
  val reversalBound = s.clawed + s.shortfall == s.refundTarget and s.refundTarget <= quote
  val reversalAckBacked = s.refundAcked.forall(target => s.grantCount == 1 and target <= s.refundTarget)
  val safety = uniqueGrant and paymentBacked and conserved and nonnegative and reversalBound and reversalAckBacked

  run lostCreateResponseRecoveredByWebhookTest = init.then(pinCustomer).then(startCreate)
    .then(acceptCreate).then(loseResponse).then(pay).then(settle).then(invalidateCache)
    .then(acknowledgeCheckout).expect(safety and s.checkoutAcked and s.providerEffects == 1)
  run idempotentProviderRetryTest = init.then(pinCustomer).then(startCreate).then(acceptCreate)
    .then(loseResponse).then(startCreate).then(acceptCreate).then(bindSession)
    .expect(safety and s.createCalls == 2 and s.providerEffects == 1)
  run webhookAndVerificationConvergeTest = init.then(pinCustomer).then(startCreate)
    .then(acceptCreate).then(bindSession).then(pay).then(settle).then(settle)
    .expect(safety and s.grantCount == 1 and s.balance == quote)
  run paymentIntentBeforeCheckoutTest = init.then(pinCustomer).then(startCreate)
    .then(acceptCreate).then(pay).then(paymentIntentEvent)
    .expect(safety and s.grantCount == 0 and s.paymentIntentAcked)
  run cancelNavigationDoesNotCancelPaymentTest = init.then(pinCustomer).then(startCreate)
    .then(acceptCreate).then(bindSession).then(browserCancel).then(pay).then(settle)
    .expect(safety and s.browserCanceled and s.grantCount == 1)
  run expiredSessionNeverGrantsTest = init.then(pinCustomer).then(startCreate)
    .then(acceptCreate).then(bindSession).then(expire).then(rejectMismatchedReceipt)
    .expect(safety and s.grantCount == 0 and s.order == "delivered")
  run crashBeforeCommitRollsBackBothTest = init.then(pinCustomer).then(startCreate)
    .then(acceptCreate).then(pay).then(rollbackSettlement)
    .expect(safety and s.grantCount == 0 and s.order != "settled")
  run postCommitFailureCanRetryWithoutAnotherGrantTest = init.then(pinCustomer).then(startCreate)
    .then(acceptCreate).then(pay).then(settle).then(idle).then(settle)
    .then(invalidateCache).then(acknowledgeCheckout)
    .expect(safety and s.grantCount == 1 and s.checkoutAcked)
  run reversalBeforeGrantRemainsDueTest = init.then(pinCustomer).then(startCreate)
    .then(acceptCreate).then(pay).then(providerRefund(2)).then(retryRefundBeforeGrant(2))
    .then(settle).then(applyRefund(2)).expect(safety and s.balance == 0 and s.clawed == 2)
  run duplicateAndOutOfOrderRefundsTest = init.then(pinCustomer).then(startCreate)
    .then(acceptCreate).then(pay).then(settle).then(providerRefund(1)).then(providerRefund(2))
    .then(applyRefund(2)).then(applyRefund(1)).then(applyRefund(2))
    .expect(safety and s.clawed == 2 and s.shortfall == 0)
  run spentCreditsBecomeReversalShortfallTest = init.then(pinCustomer).then(startCreate)
    .then(acceptCreate).then(pay).then(settle).then(spend).then(providerRefund(2))
    .then(applyRefund(2)).expect(safety and s.clawed == 1 and s.shortfall == 1)

  // Negative mutations excluded from step: these assert that the specification
  // detects omission of the precise receipt, transaction or retry obligations.
  action unsafeDuplicateGrant = s' = s.with("grantCount", s.grantCount + 1).with("balance", s.balance + quote)
  action unsafeAcknowledgeRefund(target: int): bool = s' = s.with("refundAcked", Set(target))
  action unsafeUnpaidGrant = s' = s.with("grantCount", 1).with("balance", quote)
  run duplicateGrantNegativeWitnessTest = init.then(pinCustomer).then(startCreate)
    .then(acceptCreate).then(pay).then(settle).then(unsafeDuplicateGrant).expect(not(safety))
  run droppedEarlyRefundNegativeWitnessTest = init.then(pinCustomer).then(startCreate)
    .then(acceptCreate).then(pay).then(providerRefund(2)).then(unsafeAcknowledgeRefund(2))
    .expect(not(safety))
  run untrustedUnpaidReceiptNegativeWitnessTest = init.then(unsafeUnpaidGrant).expect(not(safety))
}
