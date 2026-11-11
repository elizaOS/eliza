// Explicit owner discard of unconfirmed reminder journal entries. The host has
// already shown the warning: forgetting a request does not cancel its effect.
module ReminderCreationDiscard {
  var s: { row: str, phase: str, snapshot: str, confirmed: bool, result: str }
  action init = s' = { row: "pending", phase: "idle", snapshot: "none", confirmed: false, result: "none" }
  action begin = all { s.phase == "idle", s' = s.with("phase", "checking") }
  // Another readback can confirm the row while this discard reads an old list.
  action confirm = all { s.row == "pending", s' = s.with("row", "found").with("confirmed", true) }
  action absentRead = all { s.phase == "checking", s' = s.with("phase", "reread") }
  action foundRead = all { s.phase == "checking", s.row == "found",
    s' = s.with("phase", "done").with("result", "retained") }
  action reread = all { s.phase == "reread",
    s' = if (s.row == "pending") s.with("phase", "ready").with("snapshot", "pending")
      else s.with("phase", "done").with("result", "retained") }
  // The host store compares the original row atomically before removing it.
  action remove = all { s.phase == "ready", s.row == s.snapshot,
    s' = s.with("row", "absent").with("phase", "done").with("result", "forgotten") }
  action changed = all { s.phase == "ready", s.row != s.snapshot,
    s' = s.with("phase", "done").with("result", "changed") }
  action advance = any { absentRead, foundRead, reread, remove, changed }
  action step = any { begin, confirm, advance, s' = s }
  val ConfirmedCreationRetained = s.confirmed implies s.row == "found"
  val ForgotOnlyUnconfirmed = s.result == "forgotten" implies not(s.confirmed) and s.row == "absent"
  temporal AttemptSettles = (s.phase != "idle").leadsTo(s.phase == "done")
  temporal FairAttemptSettles = advance.weakFair(s) implies AttemptSettles
  action legacyReread = all { s.phase == "reread",
    s' = s.with("phase", "ready").with("snapshot", s.row) }
  run concurrentReadbackSurvivesTest = init.then(begin).then(confirm).then(absentRead).then(reread)
    .expect(ConfirmedCreationRetained and s.result == "retained")
  run changedStoreRefusesDeleteTest = init.then(begin).then(absentRead).then(reread).then(confirm).then(changed)
    .expect(ConfirmedCreationRetained and s.result == "changed")
  run ownerCanForgetUnknownTest = init.then(begin).then(absentRead).then(reread).then(remove)
    .expect(ForgotOnlyUnconfirmed and s.result == "forgotten")
  run legacyConfirmedRemovalWitnessTest = init.then(begin).then(confirm).then(absentRead)
    .then(legacyReread).then(remove).expect(not(ConfirmedCreationRetained))
}
module ReminderActionDiscard {
  var s: { pending: bool, forgotten: bool, externalApplied: bool, dispatches: int, receipt: str }
  action init = s' = { pending: true, forgotten: false, externalApplied: false, dispatches: 0, receipt: "none" }
  // No native call or receipt is invented by discarding the journal row.
  action discard = all { s.pending, s' = s.with("pending", false).with("forgotten", true) }
  // An already admitted effect can arrive before or after the owner forgets it.
  action lateEffect = all { not(s.externalApplied), s' = s.with("externalApplied", true) }
  action step = any { discard, lateEffect, s' = s }
  val DiscardNeverExecutesOrAcknowledges = s.dispatches == 0 and s.receipt == "none"
  val ForgottenRemainsForgotten = s.forgotten implies not(s.pending)
  temporal AttemptSettles = s.pending.leadsTo(not(s.pending))
  temporal FairAttemptSettles = discard.weakFair(s) implies AttemptSettles
  run lateEffectStillPossibleTest = init.then(discard).then(lateEffect)
    .expect(DiscardNeverExecutesOrAcknowledges and s.forgotten and s.externalApplied)
}
