// One active speech transport and three billing windows. Runtime window counts
// may be larger. Reservations are recorded before asynchronous admission.
module speech_continuity {
  var providerCloseRequested: bool
  var open: bool
  var pending: int
  var granted: Set[int]
  var recorded: Set[int]
  var funded: Set[int]
  var settled: Set[int]
  var confirmed: bool
  action init = all { providerCloseRequested' = false, open' = true, pending' = -1, granted' = Set(0),
    recorded' = Set(0), funded' = Set(0), settled' = Set(), confirmed' = false }
  action reserve = all { providerCloseRequested' = providerCloseRequested, open, pending == -1, recorded.size() < 3,
    pending' = recorded.size(), recorded' = recorded.union(Set(recorded.size())),
    open' = open, granted' = granted, funded' = funded, settled' = settled,
    confirmed' = confirmed }
  action admission = all { providerCloseRequested' = providerCloseRequested, pending >= 0,
    funded' = funded.union(Set(pending)), pending' = pending,
    recorded' = recorded, granted' = granted, open' = open,
    settled' = settled, confirmed' = confirmed }
  action extend = all { providerCloseRequested' = providerCloseRequested, open, pending >= 0, funded.contains(pending),
    granted' = granted.union(Set(pending)), pending' = -1,
    open' = open, recorded' = recorded, funded' = funded,
    settled' = settled, confirmed' = confirmed }
  action stop = all { open, providerCloseRequested' = true, open' = false, pending' = pending,
    granted' = granted, recorded' = recorded, funded' = funded,
    settled' = settled, confirmed' = confirmed }
  action settle = { nondet window = recorded.oneOf(); all { providerCloseRequested' = providerCloseRequested,
    not(open), funded.contains(window),
    settled' = settled.union(Set(window)), open' = open, pending' = pending,
    granted' = granted, recorded' = recorded, funded' = funded,
    confirmed' = confirmed } }
  action refuse = all { providerCloseRequested' = providerCloseRequested, pending >= 0, not(funded.contains(pending)),
    settled' = settled.union(Set(pending)), pending' = -1,
    open' = open, granted' = granted, recorded' = recorded, funded' = funded,
    confirmed' = confirmed }
  action confirm = all { providerCloseRequested' = providerCloseRequested, not(open), recorded.subseteq(settled),
    confirmed' = true, open' = open, pending' = pending, granted' = granted,
    recorded' = recorded, funded' = funded, settled' = settled }
  action idle = all { providerCloseRequested' = providerCloseRequested, open' = open, pending' = pending, granted' = granted,
    recorded' = recorded, funded' = funded, settled' = settled, confirmed' = confirmed }
  action step = any { reserve, admission, extend, stop, settle, refuse, confirm, idle }
  val PaidBeforeExtension = granted.subseteq(funded)
  val ReceiptBeforeConfirmation = confirmed implies (not(open) and recorded.subseteq(settled))
  val StopStartsProviderShutdown = not(open) implies providerCloseRequested
  val safety = PaidBeforeExtension and ReceiptBeforeConfirmation and StopStartsProviderShutdown
  run continuousRenewal = init.then(reserve).then(admission).then(extend)
    .then(reserve).then(admission).then(extend).expect(open and granted.size() == 3 and safety)
  run stopDuringAdmission = init.then(reserve).then(stop).then(admission)
    .expect(not(open) and providerCloseRequested and pending >= 0 and granted == Set(0) and not(confirmed) and safety)
}
