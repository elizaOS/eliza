// One InboxOperation record for a verified owner and grant. The durable phase
// survives restart. Only the process that reserved dispatch owns the send lease.
module InboxReceiptMonotonicity {
  type Journal = {
    current: bool, phase: str, receipt: str, reserved: bool, sendLease: bool,
    dispatches: int,
  }
  var s: Journal

  val attempted = Set("dispatching", "observed")
  val terminal = Set("succeeded", "rejected")
  val pending = s.current and s.phase.in(attempted) and s.dispatches > 0 and not(s.receipt.in(terminal))

  action init = s' = {
    current: true, phase: "empty", receipt: "none", reserved: false,
    sendLease: false, dispatches: 0,
  }
  action prepare = all {
    s.current, s.phase == "empty",
    s' = s.with("phase", "review").with("receipt", "prepared"),
  }
  action reserve = all {
    s.current, s.phase == "review",
    s' = s.with("phase", "dispatching").with("reserved", true).with("sendLease", true),
  }
  action dispatch = all {
    s.current, s.sendLease,
    s' = s.with("sendLease", false).with("dispatches", s.dispatches + 1),
  }
  action restart = s' = s.with("sendLease", false)
  action retire = s' = s.with("current", false).with("sendLease", false)
  action preparedRead = all {
    s.current, s.phase.in(attempted), s' = s,
  }
  action observe(receipt: str): bool = all {
    pending, s' = s.with("phase", "observed").with("receipt", receipt),
  }
  action settle = {
    nondet receipt = terminal.oneOf()
    observe(receipt)
  }
  action step = any {
    s' = s, prepare, reserve, dispatch, restart, retire, preparedRead, settle,
    observe("dispatched"), observe("outcome-unknown"),
  }

  val AtMostOneDispatch = s.dispatches <= 1
  val PersistBeforeDispatch = (s.sendLease or s.dispatches > 0) implies s.reserved
  val NoReviewAfterReservation = s.reserved implies s.phase.in(attempted)
  val ObservedReceiptCannotRearm = (s.phase == "observed") implies s.receipt != "prepared"
  temporal ReceiptSettlesOrRetires = settle.weakFair(s) implies pending.leadsTo(not(pending))

  run observedDispatchSurvivesOldReadTest = init.then(prepare).then(reserve).then(dispatch)
    .then(observe("dispatched")).then(restart).then(preparedRead)
    .expect(s.phase == "observed" and s.receipt == "dispatched" and s.dispatches == 1 and not(s.sendLease))
  run unknownSurvivesOldReadUntilCanonicalOutcomeTest = init.then(prepare).then(reserve).then(dispatch)
    .then(observe("outcome-unknown")).then(preparedRead)
    .expect(s.phase == "observed" and s.receipt == "outcome-unknown")
    .then(observe("succeeded")).then(preparedRead)
    .expect(s.receipt == "succeeded" and s.dispatches == 1)
  run restartAfterReserveDoesNotResendTest = init.then(prepare).then(reserve)
    .then(restart).then(preparedRead)
    .expect(s.phase == "dispatching" and s.dispatches == 0 and not(s.sendLease))
}
