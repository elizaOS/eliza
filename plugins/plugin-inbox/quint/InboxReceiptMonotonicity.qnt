// One InboxOperation record for a verified owner and grant. The durable phase
// survives restart. Only the process that reserved dispatch owns the send lease.
module InboxReceiptMonotonicity {
  type Journal = {
    current: bool, phase: str, receipt: str, reserved: bool, sendLease: bool,
    dispatches: int, reviewedContent: int, composerContent: int,
    renderedBound: bool, approvedContent: int, dispatchedContent: int,
  }
  var s: Journal

  val attempted = Set("dispatching", "observed")
  val terminal = Set("succeeded", "rejected")
  val pending = s.current and s.phase.in(attempted) and s.dispatches > 0 and not(s.receipt.in(terminal))

  action init = s' = {
    current: true, phase: "empty", receipt: "none", reserved: false,
    sendLease: false, dispatches: 0, reviewedContent: 0, composerContent: 0,
    renderedBound: false, approvedContent: -1, dispatchedContent: -1,
  }
  action prepare = all {
    s.current, s.phase == "empty",
    s' = s.with("phase", "review").with("receipt", "prepared")
      .with("reviewedContent", s.composerContent),
  }
  val fullBinding = s.composerContent == s.reviewedContent
  // A rendered button is a hint. Confirmation must read the live complete
  // proposal again, including attachment bytes, before taking the send lease.
  action render = s' = s.with("renderedBound", s.current and s.phase == "review" and fullBinding)
  action editInPlace = s' = s.with("composerContent", 1 - s.composerContent)
  action reserve = all {
    s.current, s.phase == "review", fullBinding,
    s' = s.with("phase", "dispatching").with("reserved", true)
      .with("sendLease", true).with("approvedContent", s.composerContent),
  }
  action confirm = if (s.current and s.phase == "review" and fullBinding)
    reserve else s' = s
  action dispatch = all {
    s.current, s.sendLease,
    s' = s.with("sendLease", false).with("dispatches", s.dispatches + 1)
      .with("dispatchedContent", s.reviewedContent),
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
    s' = s, prepare, render, editInPlace, confirm, dispatch, restart, retire, preparedRead, settle,
    observe("dispatched"), observe("outcome-unknown"),
  }

  val AtMostOneDispatch = s.dispatches <= 1
  val OnlyExactLiveContentCanReserve = s.reserved implies s.approvedContent == s.reviewedContent
  val ReviewedBytesStayAuthoritative = s.dispatches > 0 implies
    s.dispatchedContent == s.reviewedContent and s.dispatchedContent == s.approvedContent
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

// The complete proposal is projected to two byte/header identities, not object
// identities or string lengths. JavaScript serialization/shape eligibility is
// checked by the real controller suite; this state projection does not prove it.
module InboxReceiptMonotonicity_render_binding {
  import InboxReceiptMonotonicity.*
  run staleRenderedButtonCannotApproveChangedBytesTest = init.then(prepare).then(render)
    .expect(s.renderedBound).then(editInPlace).then(confirm)
    .expect(s.renderedBound and s.phase == "review" and not(s.sendLease) and s.dispatches == 0)
  run restoredExactBytesCanReserveTest = init.then(prepare).then(render)
    .then(editInPlace).then(editInPlace).then(confirm).then(dispatch)
    .expect(s.dispatches == 1 and ReviewedBytesStayAuthoritative)
  run editAfterApprovalCannotChangeDispatchedBytesTest = init.then(prepare).then(render)
    .then(confirm).then(editInPlace).then(dispatch)
    .expect(s.dispatches == 1 and s.composerContent != s.dispatchedContent and ReviewedBytesStayAuthoritative)
  run staleButtonCannotOutliveOwnerTest = init.then(prepare).then(render).then(retire).then(confirm)
    .expect(s.renderedBound and s.dispatches == 0 and not(s.sendLease))
}
