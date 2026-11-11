// Native bridge review ownership across the journal worker and Android main queue.
// The radio and journal acknowledgement are abstract ports; no carrier result is inferred.
module NativeSmsReviewOwnership {
  type State = { phase: str, owner: bool, retired: bool, cancelAck: bool,
    dialog: bool, dispatches: int, result: str }
  var s: State
  action init = s' = { phase: "lookup", owner: true, retired: false,
    cancelAck: false, dialog: false, dispatches: 0, result: "none" }
  action lookupReturns = all { s.phase == "lookup", s' = s.with("phase", "posted") }
  action present = all { s.phase == "posted", not(s.retired),
    s' = s.with("phase", "review").with("dialog", true) }
  action approve = all { s.phase == "review", s.dialog, not(s.retired),
    s' = s.with("phase", "queued").with("dialog", false) }
  // The exact operation's outstanding owner is retired before the cancel bridge call resolves.
  action cancel = all { not(s.cancelAck), s.owner,
    s' = s.with("retired", true).with("cancelAck", true).with("dialog", false) }
  action cancelOtherOperation = s' = s
  action background = all { not(s.retired), s.owner,
    s' = s.with("retired", true).with("dialog", false) }
  action settleCancelled = all { s.retired,
    Set("posted", "review", "queued").contains(s.phase),
    s' = s.with("phase", "done").with("owner", false).with("result", "cancelled") }
  action dispatch = all { s.phase == "queued", not(s.retired), s.owner,
    s.dispatches == 0,
    s' = s.with("phase", "dispatched").with("dispatches", 1) }
  // A known outcome of an already admitted dispatch survives later retirement.
  action reply(result: str): bool = all { s.phase == "dispatched",
    Set("submitted", "failed", "unknown").contains(result),
    s' = s.with("phase", "done").with("owner", false).with("result", result) }
  action progress = any { lookupReturns, present, approve, settleCancelled,
    dispatch, reply("submitted"), reply("failed"), reply("unknown") }
  action step = any { progress, cancel, cancelOtherOperation, background, s' = s }
  val TypeOK = Set("lookup", "posted", "review", "queued", "dispatched", "done").contains(s.phase)
    and Set("none", "cancelled", "submitted", "failed", "unknown").contains(s.result)
  val AtMostOneInvocation = s.dispatches >= 0 and s.dispatches <= 1
  val DialogNeedsLiveOwner = s.dialog implies (s.owner and not(s.retired) and s.phase == "review")
  val SettledOwnerReleased = (s.phase == "done") == not(s.owner)
  val CancelledMeansNoInvocation = s.result == "cancelled" implies s.dispatches == 0
  temporal CancelAckFencesInvocation = always((s.cancelAck implies
    next(s.dispatches) == s.dispatches).orKeep(s))
  temporal KnownResultStable = always((s.result != "none" implies
    next(s.result) == s.result).orKeep(s))
  temporal Settles = s.owner.leadsTo(not(s.owner))
  temporal FairRetirementSettles = (lookupReturns.weakFair(s)
    and settleCancelled.weakFair(s)) implies s.retired.leadsTo(not(s.owner) or s.phase == "dispatched")
  run cancelBeforeJournalReplyTest = init.then(cancel).then(lookupReturns)
    .then(settleCancelled).expect(s.result == "cancelled" and s.dispatches == 0)
  run cancelAfterSendTapTest = init.then(lookupReturns).then(present).then(approve)
    .then(cancel).then(settleCancelled).expect(CancelledMeansNoInvocation)
  run backgroundBeforeReviewTest = init.then(background).then(lookupReturns)
    .then(settleCancelled).expect(not(s.dialog) and not(s.owner))
  run cancellationRetainsAdmittedResultTest = init.then(lookupReturns).then(present)
    .then(approve).then(dispatch).then(cancel).then(reply("submitted"))
    .expect(s.result == "submitted" and s.dispatches == 1 and not(s.owner))
  run unrelatedCancellationCannotRetireTest = init.then(cancelOtherOperation)
    .then(lookupReturns).then(present).expect(s.dialog and not(s.retired))
}
