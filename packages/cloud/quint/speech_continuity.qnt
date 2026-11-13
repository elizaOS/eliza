// One active speech transport and three billing windows. Runtime window counts
// may be larger. Reservations are recorded before asynchronous admission.
// A teardown request is not provider closure or a wall-clock progress claim.
module speech_continuity {
  var open: bool
  var providerStopRequested: bool
  var pending: int
  var granted: Set[int]
  var recorded: Set[int]
  var funded: Set[int]
  var settled: Set[int]
  var confirmed: bool
  var quotaRelease: str
  action init = all { open' = true, pending' = -1, granted' = Set(0),
    recorded' = Set(0), funded' = Set(0), settled' = Set(), confirmed' = false,
    providerStopRequested' = false, quotaRelease' = "not_required" }
  action reserve = all { open, pending == -1, recorded.size() < 3,
    quotaRelease != "pending", quotaRelease != "unknown",
    pending' = recorded.size(), recorded' = recorded.union(Set(recorded.size())),
    open' = open, granted' = granted, funded' = funded, settled' = settled,
    confirmed' = confirmed, providerStopRequested' = providerStopRequested,
    quotaRelease' = "pending" }
  action admission = all { pending >= 0,
    funded' = funded.union(Set(pending)), pending' = pending,
    recorded' = recorded, granted' = granted, open' = open,
    settled' = settled, confirmed' = confirmed,
    providerStopRequested' = providerStopRequested, quotaRelease' = quotaRelease }
  action extend = all { open, pending >= 0, funded.contains(pending),
    granted' = granted.union(Set(pending)), pending' = -1,
    open' = open, recorded' = recorded, funded' = funded,
    settled' = settled, confirmed' = confirmed,
    providerStopRequested' = providerStopRequested, quotaRelease' = "not_required" }
  action stop = all { open, open' = false, pending' = pending,
    granted' = granted, recorded' = recorded, funded' = funded,
    settled' = settled, confirmed' = confirmed,
    providerStopRequested' = true, quotaRelease' = quotaRelease }
  // Returning after Stop retains funded, ungranted ownership for zero settlement.
  action stoppedRenewalReturns = all { not(open), pending >= 0, funded.contains(pending),
    pending' = -1, open' = open, granted' = granted, recorded' = recorded,
    funded' = funded, settled' = settled, confirmed' = confirmed,
    providerStopRequested' = providerStopRequested, quotaRelease' = quotaRelease }
  action settleWindow(window: int): bool = all {
    not(open), pending == -1, funded.contains(window), not(settled.contains(window)),
    settled' = settled.union(Set(window)), open' = open, pending' = pending,
    granted' = granted, recorded' = recorded, funded' = funded,
    confirmed' = confirmed, providerStopRequested' = providerStopRequested,
    quotaRelease' = quotaRelease }
  action settle = { nondet window = recorded.oneOf(); settleWindow(window) }
  action refuse = all { pending >= 0, not(funded.contains(pending)),
    settled' = settled.union(Set(pending)), pending' = -1,
    open' = open, granted' = granted, recorded' = recorded, funded' = funded,
    confirmed' = confirmed, providerStopRequested' = providerStopRequested,
    quotaRelease' = quotaRelease }
  action quotaRefund(acknowledged: bool): bool = all { pending == -1, quotaRelease == "pending",
    quotaRelease' = if (acknowledged) "released" else "unknown",
    open' = open, pending' = pending, granted' = granted, recorded' = recorded,
    funded' = funded, settled' = settled, confirmed' = confirmed,
    providerStopRequested' = providerStopRequested }
  action confirm = all { not(open), pending == -1, recorded.subseteq(settled),
    quotaRelease != "pending",
    confirmed' = true, open' = open, pending' = pending, granted' = granted,
    recorded' = recorded, funded' = funded, settled' = settled,
    providerStopRequested' = providerStopRequested, quotaRelease' = quotaRelease }
  action idle = all { open' = open, pending' = pending, granted' = granted,
    recorded' = recorded, funded' = funded, settled' = settled, confirmed' = confirmed,
    providerStopRequested' = providerStopRequested, quotaRelease' = quotaRelease }
  action settlementFails = all { not(open), pending == -1,
    not(funded.subseteq(settled)), idle }
  action step = any { reserve, admission, extend, stop, stoppedRenewalReturns,
    settle, settlementFails, refuse, quotaRefund(true), quotaRefund(false), confirm, idle }
  val PaidBeforeExtension = granted.subseteq(funded)
  val ReceiptBeforeConfirmation = confirmed implies
    (not(open) and pending == -1 and recorded.subseteq(settled))
  val StopRequestsProviderTeardown = not(open) implies providerStopRequested
  val safety = PaidBeforeExtension and ReceiptBeforeConfirmation and StopRequestsProviderTeardown
  run continuousRenewal = init.then(reserve).then(admission).then(extend)
    .then(reserve).then(admission).then(extend).expect(open and granted.size() == 3 and safety)
  run stopDuringAdmission = init.then(reserve).then(stop)
    .expect(providerStopRequested and pending >= 0 and not(confirmed))
    .then(admission).then(stoppedRenewalReturns)
    .expect(not(open) and granted == Set(0) and not(confirmed) and safety)
  run failedZeroSettlementRetries = init.then(reserve).then(admission).then(stop)
    .then(stoppedRenewalReturns).then(settlementFails)
    .expect(recorded.contains(1) and funded.contains(1) and not(settled.contains(1)))
    .then(settleWindow(1)).then(settleWindow(0)).then(quotaRefund(true)).then(confirm)
    .expect(confirmed and granted == Set(0) and safety)
  // A lost additive refund acknowledgement is retained, never reissued. Its
  // uncertainty cannot replace money proof, but terminal money remains independent.
  run unknownQuotaKeepsIndependentMoney = init.then(reserve).then(admission).then(stop)
    .then(stoppedRenewalReturns).then(quotaRefund(false))
    .then(settleWindow(1)).then(settleWindow(0)).then(confirm)
    .expect(confirmed and quotaRelease == "unknown" and safety)
}
