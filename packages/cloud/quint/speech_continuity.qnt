// One active speech transport and three billing windows. Runtime window counts
// may be larger. Reservations are recorded before asynchronous admission.
// Once a window's end passes, the session freezes its metered share and
// settles it, so a renewal needs headroom for one more window, not for every
// window granted so far. Usage is abstract units with CAP per window.
// A teardown request is not provider closure or a wall-clock progress claim.
module speech_continuity {
  pure val CAP = 2
  var open: bool
  var providerCloseRequested: bool
  var pending: int
  var granted: Set[int]
  var recorded: Set[int]
  var funded: Set[int]
  var settled: Set[int]
  var confirmed: bool
  var quotaRelease: str
  // Metered usage, the windows frozen while open, and each window's charge.
  var usage: int
  var frozen: Set[int]
  var share: int -> int
  def total(windows: Set[int]): int =
    windows.fold(0, (sum, window) => sum + share.get(window))
  def frozenUsage: int = total(frozen)
  def held: Set[int] = granted.exclude(frozen)
  // A held window's share of the usage past the frozen windows, as
  // speechWindowShare splits it: the newest held window takes the remainder.
  def heldShare(window: int): int = {
    val rank = held.filter(other => other < window).size()
    val remainder = usage - frozenUsage - rank * CAP
    if (remainder <= 0) 0
    else if (rank == held.size() - 1 or remainder < CAP) remainder
    else CAP
  }
  action keepMoney = all { usage' = usage, frozen' = frozen, share' = share }
  action init = all { open' = true, pending' = -1, granted' = Set(0),
    recorded' = Set(0), funded' = Set(0), settled' = Set(), confirmed' = false,
    providerCloseRequested' = false, quotaRelease' = "not_required",
    usage' = 0, frozen' = Set(), share' = Map() }
  // Admission caps usage at the frozen shares plus every held window's budget.
  action use = all { open, usage + 1 <= frozenUsage + CAP * held.size(),
    usage' = usage + 1, frozen' = frozen, share' = share,
    open' = open, pending' = pending, granted' = granted, recorded' = recorded,
    funded' = funded, settled' = settled, confirmed' = confirmed,
    providerCloseRequested' = providerCloseRequested, quotaRelease' = quotaRelease }
  action reserve = all { open, pending == -1, recorded.size() < 3,
    quotaRelease != "pending", quotaRelease != "unknown",
    pending' = recorded.size(), recorded' = recorded.union(Set(recorded.size())),
    open' = open, granted' = granted, funded' = funded, settled' = settled,
    confirmed' = confirmed, providerCloseRequested' = providerCloseRequested,
    quotaRelease' = "pending", keepMoney }
  action admission = all { pending >= 0,
    funded' = funded.union(Set(pending)), pending' = pending,
    recorded' = recorded, granted' = granted, open' = open,
    settled' = settled, confirmed' = confirmed,
    providerCloseRequested' = providerCloseRequested, quotaRelease' = quotaRelease,
    keepMoney }
  action extend = all { open, pending >= 0, funded.contains(pending),
    granted' = granted.union(Set(pending)), pending' = -1,
    open' = open, recorded' = recorded, funded' = funded,
    settled' = settled, confirmed' = confirmed,
    providerCloseRequested' = providerCloseRequested, quotaRelease' = "not_required",
    keepMoney }
  action stop = all { open, open' = false, pending' = pending,
    granted' = granted, recorded' = recorded, funded' = funded,
    settled' = settled, confirmed' = confirmed,
    providerCloseRequested' = true, quotaRelease' = quotaRelease, keepMoney }
  // Returning after Stop retains funded, ungranted ownership for zero settlement.
  action stoppedRenewalReturns = all { not(open), pending >= 0, funded.contains(pending),
    pending' = -1, open' = open, granted' = granted, recorded' = recorded,
    funded' = funded, settled' = settled, confirmed' = confirmed,
    providerCloseRequested' = providerCloseRequested, quotaRelease' = quotaRelease,
    keepMoney }
  // Completion requires matching terminal receipts, including actual zero
  // receipts for an ungranted window. Invalid replies stay in settlementFails.
  action settleWindow(window: int): bool = all {
    not(open), pending == -1, funded.contains(window), not(settled.contains(window)),
    not(frozen.contains(window)),
    settled' = settled.union(Set(window)), open' = open, pending' = pending,
    granted' = granted, recorded' = recorded, funded' = funded,
    confirmed' = confirmed, providerCloseRequested' = providerCloseRequested,
    quotaRelease' = quotaRelease, usage' = usage, frozen' = frozen,
    share' = share.put(window, if (granted.contains(window)) heldShare(window) else 0) }
  action settle = { nondet window = recorded.oneOf(); settleWindow(window) }
  // While open, the oldest held window that a later granted window superseded
  // freezes at its metered share. Renewal can be in flight meanwhile.
  action freeze(window: int): bool = all {
    open, held.contains(window), held.exists(later => later > window),
    held.forall(other => other >= window),
    frozen' = frozen.union(Set(window)),
    share' = share.put(window, heldShare(window)), usage' = usage,
    settled' = settled, open' = open, pending' = pending,
    granted' = granted, recorded' = recorded, funded' = funded,
    confirmed' = confirmed, providerCloseRequested' = providerCloseRequested,
    quotaRelease' = quotaRelease }
  action supersede = { nondet window = granted.oneOf(); freeze(window) }
  // A frozen window settles at its frozen share, open or closed. A failed
  // attempt keeps it frozen for the next renewal or close to retry.
  action settleFrozen(window: int): bool = all {
    frozen.contains(window), not(settled.contains(window)),
    settled' = settled.union(Set(window)), open' = open, pending' = pending,
    granted' = granted, recorded' = recorded, funded' = funded,
    confirmed' = confirmed, providerCloseRequested' = providerCloseRequested,
    quotaRelease' = quotaRelease, keepMoney }
  action settleSuperseded = { nondet window = 0.to(2).oneOf(); settleFrozen(window) }
  action refuse = all { pending >= 0, not(funded.contains(pending)),
    settled' = settled.union(Set(pending)), pending' = -1,
    open' = open, granted' = granted, recorded' = recorded, funded' = funded,
    confirmed' = confirmed, providerCloseRequested' = providerCloseRequested,
    quotaRelease' = quotaRelease, usage' = usage, frozen' = frozen,
    share' = share.put(pending, 0) }
  action quotaRefund(acknowledged: bool): bool = all { pending == -1, quotaRelease == "pending",
    quotaRelease' = if (acknowledged) "released" else "unknown",
    open' = open, pending' = pending, granted' = granted, recorded' = recorded,
    funded' = funded, settled' = settled, confirmed' = confirmed,
    providerCloseRequested' = providerCloseRequested, keepMoney }
  action confirm = all { not(open), pending == -1, recorded.subseteq(settled),
    quotaRelease != "pending",
    confirmed' = true, open' = open, pending' = pending, granted' = granted,
    recorded' = recorded, funded' = funded, settled' = settled,
    providerCloseRequested' = providerCloseRequested, quotaRelease' = quotaRelease,
    keepMoney }
  action idle = all { open' = open, pending' = pending, granted' = granted,
    recorded' = recorded, funded' = funded, settled' = settled, confirmed' = confirmed,
    providerCloseRequested' = providerCloseRequested, quotaRelease' = quotaRelease,
    keepMoney }
  action settlementFails = all { not(open), pending == -1,
    not(funded.subseteq(settled)), idle }
  action step = any { use, reserve, admission, extend, stop, stoppedRenewalReturns,
    settle, supersede, settleSuperseded, settlementFails, refuse, quotaRefund(true),
    quotaRefund(false), confirm, idle }
  val PaidBeforeExtension = granted.subseteq(funded)
  // The live window's reservation is never frozen or settled while speech can
  // still run.
  val LiveWindowHeld = open implies
    granted.forall(window => settled.union(frozen).contains(window) implies
      granted.exists(later => later > window))
  val ReceiptBeforeConfirmation = confirmed implies
    (not(open) and pending == -1 and recorded.subseteq(settled))
  val StopStartsProviderShutdown = not(open) implies providerCloseRequested
  // Money attribution: each window is charged once, within its reservation; no
  // usage runs past the held reservations; confirmed charges equal usage.
  val ChargedOnce = share.keys() == settled.union(frozen)
  val ShareWithinReservation = share.keys().forall(window =>
    0 <= share.get(window) and share.get(window) <= CAP)
  val UsagePaid = usage <= frozenUsage + CAP * held.size()
  val ChargesEqualUsage = confirmed implies total(settled) == usage
  val safety = PaidBeforeExtension and ReceiptBeforeConfirmation and
    StopStartsProviderShutdown and LiveWindowHeld and ChargedOnce and
    ShareWithinReservation and UsagePaid and ChargesEqualUsage
  run continuousRenewal = init.then(reserve).then(admission).then(extend)
    .then(reserve).then(admission).then(extend).expect(open and granted.size() == 3 and safety)
  // Each renewal holds only the live window and the one it reserves.
  run supersededRenewal = init.then(use).then(reserve).then(admission).then(extend)
    .then(freeze(0)).then(settleFrozen(0))
    .expect(open and funded.exclude(settled) == Set(1) and share.get(0) == 1 and safety)
    .then(reserve).then(use).then(admission).then(extend).then(use).then(use)
    .expect(open and granted.size() == 3 and funded.exclude(settled) == Set(1, 2) and safety)
    .then(stop).then(settleWindow(1)).then(settleWindow(2)).then(confirm)
    .expect(confirmed and settled == Set(0, 1, 2) and share.get(1) == 2 and
      share.get(2) == 1 and safety)
  run liveWindowCannotFreeze = init.then(reserve).then(admission).then(extend)
    .then(freeze(1).fail())
  // A renewal may reserve while an older window's settlement is still
  // unacknowledged; close settles that window at its frozen share only.
  run frozenSettlementRetriedAtClose = init.then(use).then(reserve).then(admission).then(extend)
    .then(freeze(0)).then(reserve).then(admission).then(extend)
    .expect(open and settled == Set() and frozen == Set(0) and safety)
    .then(stop).then(settleFrozen(0)).then(settleWindow(1)).then(settleWindow(2)).then(confirm)
    .expect(confirmed and share.get(0) == 1 and total(settled) == 1 and safety)
  run frozenShareNeverResettles = init.then(use).then(reserve).then(admission).then(extend)
    .then(freeze(0)).then(stop).then(settleWindow(0).fail())
  run stopDuringAdmission = init.then(reserve).then(stop)
    .expect(providerCloseRequested and pending >= 0 and not(confirmed))
    .then(admission).then(stoppedRenewalReturns)
    .expect(not(open) and granted == Set(0) and not(confirmed) and safety)
  run ungrantedSettlementRetry = init.then(reserve).then(admission).then(stop)
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

  val variables = (open, providerCloseRequested, pending, granted, recorded,
    funded, settled, confirmed, quotaRelease, usage, frozen, share)
  temporal RetirementFairness = and {
    any { admission, refuse }.weakFair(variables),
    stoppedRenewalReturns.weakFair(variables),
    Set(0, 1, 2).forall(window => settleWindow(window).weakFair(variables)),
    Set(0, 1, 2).forall(window => settleFrozen(window).weakFair(variables)),
    any { quotaRefund(true), quotaRefund(false) }.weakFair(variables),
    confirm.weakFair(variables),
  }
  temporal FairStopConfirmsMoney = RetirementFairness implies
    (not(open)).leadsTo(confirmed)
  temporal UnfairStopConfirmsMoney = (not(open)).leadsTo(confirmed)
}
