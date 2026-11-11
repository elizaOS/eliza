// One attempted operation, its owner-authorized local discard and one exact
// receipt read. A prepared reply may be stale: local discard never cancels mail.
module InboxAttemptDiscard {
  var s: { phase: str, owner: bool, row: bool, preparedRead: bool,
    clearAdmitted: bool, acknowledged: bool, providerStarted: bool, dispatches: int }
  action init = {
    nondet started = Bool.oneOf()
    s' = { phase: "ready", owner: true, row: true, preparedRead: false,
      clearAdmitted: false, acknowledged: false, providerStarted: started, dispatches: 1 }
  }
  action request = all { s.phase == "ready", s.owner, s' = { ...s, phase: "reading" } }
  action prepared = all { s.phase == "reading",
    s' = if (s.owner) { ...s, phase: "clearing", preparedRead: true, clearAdmitted: true }
      else { ...s, phase: "retired" } }
  action startedOrFailedRead = all { s.phase == "reading",
    s' = { ...s, phase: if (s.owner) "retained" else "retired" } }
  action clearDone = all { s.phase == "clearing", s.clearAdmitted,
    s' = { ...s, row: false, acknowledged: s.owner,
      phase: if (s.owner) "discarded" else "retired" } }
  action clearFailed = all { s.phase == "clearing",
    s' = { ...s, phase: if (s.owner) "retained" else "retired" } }
  action retire = all { s.owner, s' = { ...s, owner: false } }
  action lateProviderStart = s' = { ...s, providerStarted: true }
  action settleRead = any { prepared, startedOrFailedRead }
  action settleClear = any { clearDone, clearFailed }
  action step = any { request, settleRead, settleClear, retire, lateProviderStart, s' = s }
  val pending = s.phase.in(Set("reading", "clearing"))
  val TypeOK = s.phase.in(Set("ready", "reading", "clearing", "retained", "retired", "discarded"))
  val OriginalRequestNeverReplayed = s.dispatches == 1
  val LocalRemovalNeedsPreparedRead = not(s.row) implies s.preparedRead and s.clearAdmitted
  val ConfirmationRequiresRemoval = s.acknowledged implies not(s.row)
  val RetainedOutcomeKeepsRow = s.phase == "retained" implies s.row
  temporal RemovalStaysLocal = always((not(s.row) implies not(next(s.row))).orKeep(s))
  temporal FairDiscardSettles = (settleRead.weakFair(s) and settleClear.weakFair(s)) implies pending.leadsTo(not(pending))
  temporal UnfairDiscardSettles = pending.leadsTo(not(pending))
  run retiredReadCannotAdmitClearTest = init.then(request).then(retire).then(prepared)
    .expect(s.row and not(s.clearAdmitted) and not(s.acknowledged))
  run discardedRequestCanStillReachProviderTest = init.then(request).then(prepared).then(clearDone)
    .then(lateProviderStart).expect(not(s.row) and s.providerStarted and s.dispatches == 1)
}
