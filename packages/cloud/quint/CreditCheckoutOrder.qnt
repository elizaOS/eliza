// StripeCheckoutOrdersService: one immutable quote and two settlement callers.
// A single primary transaction owns visible credit + order publication.
module CreditCheckoutOrder {
  var s: {
    phase: str, clock: int, customer: int, currentCustomer: int,
    firstStart: int, originalStart: int, lastDispatch: int,
    providerSession: int, boundSession: int, paid: bool,
    txOwner: int, txSession: int, grant: bool, balance: int,
    grantWasPaid: bool, grantWasMatching: bool,
    cache: str, callerOutcome: str, foreignIntent: bool,
    lookup: str, lookupPage: int, lookupSawMatch: bool,
    dispatchCount: int, lastWasRetry: bool, lastLookupComplete: bool,
    lastRequiredLookup: bool, pendingQuotedObservation: bool
  }

  pure val initial = {
    phase: "quoted", clock: 0, customer: 0, currentCustomer: 1,
    firstStart: -1, originalStart: -1, lastDispatch: -1,
    providerSession: 0, boundSession: 0, paid: false,
    txOwner: 0, txSession: 0, grant: false, balance: 0,
    grantWasPaid: false, grantWasMatching: false,
    cache: "none", callerOutcome: "none", foreignIntent: false,
    lookup: "idle", lookupPage: 0, lookupSawMatch: false,
    dispatchCount: 0, lastWasRetry: false, lastLookupComplete: false,
    lastRequiredLookup: false, pendingQuotedObservation: false
  }
  action init = s' = initial
  action initHistoricalUnknown = s' = initial.with("phase", "provider_ambiguous")
    .with("customer", 1).with("providerSession", 1)
  action initFailed = s' = initial.with("phase", "failed")

  // A replay with the same tenant/key/digest returns the existing quote. A
  // mismatched initiating user or digest rejects without changing that quote.
  action exactRequestReplay = s' = s.with("callerOutcome", "quote_replayed")
  action conflictingRequestReplay = s' = s.with("callerOutcome", "request_conflict")

  action bindCustomer = all {
    s.phase == "quoted", s.customer == 0,
    s' = s.with("customer", s.currentCustomer)
  }
  action rotateOrganizationCustomer = s' = s.with("currentCustomer", 2)
  val retryAuthorized = Set("provider_started", "provider_ambiguous").contains(s.phase) and
    s.firstStart >= 0 and s.clock < s.firstStart + 3 and s.lookup == "empty"
  action publishDispatch(requiredLookup, pendingObservation) = all {
    s' = s.with("phase", "provider_started")
      .with("firstStart", if (s.firstStart == -1) s.clock else s.firstStart)
      .with("originalStart", if (s.originalStart == -1) s.clock else s.originalStart)
      .with("lastDispatch", s.clock).with("dispatchCount", s.dispatchCount + 1)
      .with("lastWasRetry", s.firstStart >= 0).with("lastLookupComplete", s.lookup == "empty")
      .with("lastRequiredLookup", requiredLookup).with("pendingQuotedObservation", pendingObservation)
      .with("lookup", "idle")
  }
  action rememberQuotedObservation = all {
    s.phase == "quoted", s' = s.with("pendingQuotedObservation", true)
  }
  action dispatch = all {
    s.customer != 0, s.dispatchCount < 2,
    s.phase == "quoted" or retryAuthorized,
    // The first caller leaves any second caller's earlier quote observation.
    publishDispatch(s.phase != "quoted", s.pendingQuotedObservation)
  }
  action dispatchFromEarlierQuote = all {
    s.pendingQuotedObservation, s.customer != 0, s.dispatchCount < 2,
    Set("provider_started", "provider_ambiguous").contains(s.phase),
    s.firstStart >= 0, s.clock < s.firstStart + 3,
    publishDispatch(false, false)
  }
  action beginLookup = all {
    Set("provider_started", "provider_ambiguous").contains(s.phase),
    s.lookup != "scanning",
    s' = s.with("lookup", "scanning").with("lookupPage", 0).with("lookupSawMatch", false)
  }
  action lookupPage(matching, more) = all {
    s.lookup == "scanning", s.lookupPage < 2,
    not(more) or s.lookupPage == 0,
    not(matching) or s.providerSession != 0,
    s' = s.with("lookupPage", s.lookupPage + 1)
      .with("lookupSawMatch", s.lookupSawMatch or matching)
      .with("lookup", if (matching and s.lookupSawMatch) "conflict"
        else if (more) "scanning" else if (matching or s.lookupSawMatch) "found" else "empty")
  }
  action lookupFailure = all {
    s.lookup == "scanning", s' = s.with("lookup", "failed")
  }
  action tick = all { s.clock < 5, s' = s.with("clock", s.clock + 1) }

  // Provider creation and the local Session receipt are different events.
  // Repeating the same provider key inside its supported window returns the
  // original Session. Provider truth is a boundary assumption, not a theorem.
  action providerCreates = all {
    Set("provider_started", "provider_ambiguous").contains(s.phase),
    s.firstStart >= 0, s.providerSession == 0,
    s' = s.with("providerSession", 1)
  }
  action loseProviderResponse = all {
    s.phase == "provider_started",
    s' = s.with("phase", "provider_ambiguous").with("callerOutcome", "unknown")
  }
  action bindSession = all {
    Set("provider_started", "provider_ambiguous").contains(s.phase),
    s.providerSession != 0,
    s' = s.with("phase", "delivered").with("boundSession", s.providerSession)
  }
  action replayBoundSession = all {
    Set("delivered", "settled").contains(s.phase),
    s.boundSession == s.providerSession, s.boundSession != 0,
    s' = s.with("callerOutcome", "session_already_bound")
  }
  action paymentCompletes = all {
    s.providerSession != 0,
    s' = s.with("paid", true)
  }
  action unrelatedIntentAlreadyExists = all {
    not(s.grant), s.txOwner == 0,
    s' = s.with("foreignIntent", true)
  }

  // Matching abstracts ALL receipt comparisons: quote ID in both metadata
  // and client_reference_id, tenant/caller when supplied, amount, currency,
  // pinned customer, bound Session and bound PaymentIntent.
  action acquireSettlement(caller) = all {
    Set(1, 2).contains(caller), s.txOwner == 0,
    not(s.grant), s.paid, s.providerSession != 0,
    Set("provider_started", "provider_ambiguous", "delivered").contains(s.phase),
    s.boundSession == 0 or s.boundSession == s.providerSession,
    s' = s.with("txOwner", caller).with("txSession", s.providerSession)
  }
  action rejectMismatchedReceipt = s' = s.with("callerOutcome", "receipt_rejected")

  // A unique-intent collision rolls back both grant and quote publication.
  action commitSettlement(caller) = all {
    s.txOwner == caller,
    s' = if (s.foreignIntent)
      s.with("txOwner", 0).with("txSession", 0).with("callerOutcome", "intent_conflict")
    else s.with("txOwner", 0).with("boundSession", s.txSession).with("txSession", 0)
      .with("phase", "settled").with("grant", true).with("balance", s.balance + 2)
      .with("grantWasPaid", s.paid).with("grantWasMatching", true)
      .with("cache", "pending").with("callerOutcome", "waiting_cache")
  }
  action rollbackSettlement = all {
    s.txOwner != 0,
    s' = s.with("txOwner", 0).with("txSession", 0).with("callerOutcome", "transaction_failed")
  }
  action replaySettlement = all {
    s.grant,
    s' = s.with("cache", "pending").with("callerOutcome", "waiting_cache")
  }
  action cacheInvalidated = all {
    s.cache == "pending",
    s' = s.with("cache", "done").with("callerOutcome", "settled")
  }
  action cacheUnavailable = all {
    s.cache == "pending",
    s' = s.with("cache", "unknown").with("callerOutcome", "cache_failed")
  }

  action step = any {
    exactRequestReplay, conflictingRequestReplay, bindCustomer,
    rotateOrganizationCustomer, rememberQuotedObservation, dispatch, dispatchFromEarlierQuote, tick, providerCreates,
    beginLookup, lookupPage(false, true), lookupPage(true, true),
    lookupPage(false, false), lookupPage(true, false), lookupFailure,
    loseProviderResponse, bindSession, replayBoundSession, paymentCompletes,
    unrelatedIntentAlreadyExists, rejectMismatchedReceipt,
    acquireSettlement(1), acquireSettlement(2),
    commitSettlement(1), commitSettlement(2), rollbackSettlement,
    replaySettlement, cacheInvalidated, cacheUnavailable, s' = s
  }

  val CreditPublishedOnce = s.balance == (if (s.grant) 2 else 0)
  val SettledHasOriginalReceipt = s.phase == "settled" implies
    s.grant and s.boundSession == s.providerSession and s.boundSession != 0
  val PaidMatchingReceiptRequired = s.grant implies s.grantWasPaid and s.grantWasMatching
  val FirstDispatchNeverExtended = s.firstStart == s.originalStart
  val RetryInsideOriginalWindow = s.lastDispatch == -1 or
    (s.firstStart >= 0 and s.lastDispatch < s.firstStart + 3)
  val ForeignIntentNeverGranted = s.foreignIntent implies not(s.grant)
  val RetryRequiresCompletedLookup = s.lastRequiredLookup implies s.lastLookupComplete
  val UnknownCacheRetainsSettlement = s.cache == "unknown" implies s.grant and s.phase == "settled"
  val safety = CreditPublishedOnce and SettledHasOriginalReceipt and
    PaidMatchingReceiptRequired and FirstDispatchNeverExtended and
    RetryInsideOriginalWindow and ForeignIntentNeverGranted and UnknownCacheRetainsSettlement and
    RetryRequiresCompletedLookup

  run lostCreateResponseSettlesFromReceiptTest = init.then(bindCustomer).then(dispatch)
    .then(providerCreates).then(loseProviderResponse).then(paymentCompletes)
    .then(acquireSettlement(1)).then(commitSettlement(1))
    .expect(s.grant and s.phase == "settled" and safety)
  run concurrentSettlementCallerReplaysTest = init.then(bindCustomer).then(dispatch)
    .then(providerCreates).then(bindSession).then(paymentCompletes)
    .then(acquireSettlement(1)).then(commitSettlement(1)).then(replaySettlement)
    .expect(s.balance == 2 and safety)
  run cacheFailureDoesNotMintAgainTest = init.then(bindCustomer).then(dispatch)
    .then(providerCreates).then(paymentCompletes).then(acquireSettlement(2))
    .then(commitSettlement(2)).then(cacheUnavailable).then(replaySettlement)
    .then(cacheInvalidated).expect(s.balance == 2 and s.callerOutcome == "settled" and safety)
  run transactionCrashDoesNotPublishTest = init.then(bindCustomer).then(dispatch)
    .then(providerCreates).then(paymentCompletes).then(acquireSettlement(1))
    .then(rollbackSettlement).expect(not(s.grant) and s.balance == 0 and safety)
  run conflictingIntentRollsBackTest = init.then(bindCustomer).then(dispatch)
    .then(providerCreates).then(paymentCompletes).then(unrelatedIntentAlreadyExists)
    .then(acquireSettlement(1)).then(commitSettlement(1))
    .expect(not(s.grant) and s.callerOutcome == "intent_conflict" and safety)
  run unknownHistoricalDispatchRecoversReadOnlyTest = initHistoricalUnknown.then(paymentCompletes)
    .then(acquireSettlement(1)).then(commitSettlement(1))
    .expect(s.grant and s.firstStart == -1 and s.lastDispatch == -1 and safety)
  run originalCustomerSurvivesRotationTest = init.then(bindCustomer)
    .then(rotateOrganizationCustomer).expect(s.customer == 1 and s.currentCustomer == 2 and safety)
  run horizonRetainsAmbiguousEvidenceTest = init.then(bindCustomer).then(dispatch)
    .then(loseProviderResponse).then(tick).then(tick).then(tick)
    .expect(s.phase == "provider_ambiguous" and s.firstStart == 0 and s.clock == 3 and safety)
  run failedHistoricalOrderDoesNotGrantTest = initFailed.then(tick)
    .then(rejectMismatchedReceipt).expect(s.phase == "failed" and not(s.grant) and safety)
  run retriesRetainFirstDispatchTest = init.then(bindCustomer).then(dispatch)
    .then(loseProviderResponse).then(tick).then(beginLookup)
    .then(lookupPage(false, true)).then(lookupPage(false, false)).then(dispatch)
    .expect(s.firstStart == 0 and s.lastDispatch == 1 and safety)
  run partialLookupCannotAuthorizeRetryTest = init.then(bindCustomer).then(dispatch)
    .then(loseProviderResponse).then(beginLookup).then(lookupPage(false, true))
    .expect(not(retryAuthorized) and safety)
  run failedLookupCannotAuthorizeRetryTest = init.then(bindCustomer).then(dispatch)
    .then(loseProviderResponse).then(beginLookup).then(lookupFailure)
    .expect(not(retryAuthorized) and safety)
  run laterPageFindsOriginalSessionTest = init.then(bindCustomer).then(dispatch)
    .then(providerCreates).then(loseProviderResponse).then(beginLookup)
    .then(lookupPage(false, true)).then(lookupPage(true, false)).then(bindSession)
    .expect(s.boundSession == 1 and s.lookup == "found" and safety)
  run distinctMatchingPagesCannotAuthorizeRetryTest = init.then(bindCustomer).then(dispatch)
    .then(providerCreates).then(loseProviderResponse).then(beginLookup)
    .then(lookupPage(true, true)).then(lookupPage(true, false))
    .expect(s.lookup == "conflict" and not(retryAuthorized) and safety)
  run lateCreateAcknowledgementPreservesSettlementTest = init.then(bindCustomer).then(dispatch)
    .then(providerCreates).then(paymentCompletes).then(acquireSettlement(1)).then(commitSettlement(1))
    .then(replayBoundSession).expect(s.phase == "settled" and s.balance == 2 and safety)
  run earlierQuotedCallerReusesOriginalWindowTest = init.then(rememberQuotedObservation).then(bindCustomer)
    .then(dispatch).then(loseProviderResponse).then(dispatchFromEarlierQuote)
    .expect(s.dispatchCount == 2 and s.firstStart == 0 and not(s.lastRequiredLookup) and safety)
}
