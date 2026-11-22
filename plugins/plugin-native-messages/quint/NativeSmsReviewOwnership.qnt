// Native bridge review ownership across the journal worker and Android main queue.
// The radio and journal acknowledgement are abstract ports; no carrier result is inferred.
// SMS role eligibility is a separate uncached PackageManager boundary. Conformance checks typed
// MMS filters, enabled host components and package scope; the query grants no role or send authority.
module NativeSmsReviewOwnership {
  type State = { phase: str, owner: bool, retired: bool, cancelAck: bool,
    composer: bool, approved: bool, dialog: bool, dispatches: int, result: str }
  var s: State
  action start(composer: bool): bool = s' = { phase: "lookup", owner: true, retired: false,
    cancelAck: false, composer: composer, approved: false, dialog: false, dispatches: 0, result: "none" }
  action init = start(false)
  action initComposer = start(true)
  action initModel = any { init, initComposer }
  action lookupReturns = all { s.phase == "lookup", s' = s.with("phase", "posted") }
  action present = all { s.phase == "posted", not(s.retired), not(s.composer),
    s' = s.with("phase", "review").with("dialog", true) }
  action approve = all { s.phase == "review", s.dialog, not(s.retired),
    s' = s.with("phase", "queued").with("dialog", false).with("approved", true) }
  // Only a host-verified owner Send may reach the protected composer entry point.
  action acceptComposer = all { s.phase == "posted", s.composer, not(s.retired),
    s' = s.with("phase", "queued").with("approved", true) }
  // The exact operation's outstanding owner is retired before the cancel bridge call resolves.
  action cancel = all { not(s.cancelAck), s.owner,
    s' = s.with("retired", true).with("cancelAck", true).with("dialog", false) }
  action cancelOtherOperation = s' = s
  action background = all { not(s.retired), s.owner,
    s' = s.with("retired", true).with("dialog", false) }
  action settleCancelled = all { s.retired,
    Set("posted", "review", "queued").contains(s.phase),
    s' = s.with("phase", "done").with("owner", false).with("result", "cancelled") }
  // The default SMS app prepares its own provider rows before any platform send.
  action outboxRefused = all { s.phase == "queued", not(s.retired), s.owner,
    s' = s.with("phase", "done").with("owner", false).with("result", "denied") }
  action dispatch = all { s.phase == "queued", not(s.retired), s.owner, s.approved,
    s.dispatches == 0,
    s' = s.with("phase", "dispatched").with("dispatches", 1) }
  // A known outcome of an already admitted dispatch survives later retirement.
  action reply(result: str): bool = all { s.phase == "dispatched",
    Set("submitted", "failed", "unknown").contains(result),
    s' = s.with("phase", "done").with("owner", false).with("result", result) }
  action progress = any { lookupReturns, present, approve, acceptComposer, settleCancelled, outboxRefused,
    dispatch, reply("submitted"), reply("failed"), reply("unknown") }
  action step = any { progress, cancel, cancelOtherOperation, background, s' = s }
  val TypeOK = Set("lookup", "posted", "review", "queued", "dispatched", "done").contains(s.phase)
    and Set("none", "cancelled", "denied", "submitted", "failed", "unknown").contains(s.result)
  val AtMostOneInvocation = s.dispatches >= 0 and s.dispatches <= 1
  val InvocationNeedsOwnerApproval = s.dispatches > 0 implies s.approved
  val DialogNeedsLiveOwner = s.dialog implies (s.owner and not(s.retired) and s.phase == "review")
  val SettledOwnerReleased = (s.phase == "done") == not(s.owner)
  val CancelledMeansNoInvocation = s.result == "cancelled" implies s.dispatches == 0
  val ProviderRefusalMeansNoInvocation = s.result == "denied" implies s.dispatches == 0
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
  run outboxRefusalBeforeRadioTest = init.then(lookupReturns).then(present).then(approve)
    .then(outboxRefused).expect(s.result == "denied" and ProviderRefusalMeansNoInvocation and not(s.owner))
  run ownerComposerDispatchesWithoutDialogTest = initComposer.then(lookupReturns).then(acceptComposer)
    .then(dispatch).expect(not(s.dialog) and s.dispatches == 1 and InvocationNeedsOwnerApproval)
  run composerRetiredBeforeDispatchTest = initComposer.then(lookupReturns).then(acceptComposer)
    .then(background).then(settleCancelled).expect(not(s.dialog) and CancelledMeansNoInvocation)
  run composerGuardRefusalBeforeRadioTest = initComposer.then(lookupReturns).then(acceptComposer)
    .then(outboxRefused).expect(s.result == "denied" and ProviderRefusalMeansNoInvocation)
}
