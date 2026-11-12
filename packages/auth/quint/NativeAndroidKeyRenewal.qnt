// Android renewal custody: exclusive encrypted request -> successor secret/proof
// -> exact ACK -> durable confirmation -> retirement duty -> selected successor.
// Restart adopts the original durable generation; no claim is stolen on timeout.
module NativeAndroidKeyRenewal {
  pure val Old = 1
  pure val New = 2
  pure val Newer = 3
  pure val AckRounds = 6

  type State = {
    saved: int, intentCurrent: bool, attemptActive: bool, live: bool,
    supersededSaved: int, installed: bool, partialWrite: bool,
    // Journal: none, request, pending secret/proof, confirmed secret/proof, foreign.
    journal: str, claimOwner: int, worker: int, foreignJournal: bool,
    duty: bool, server: str, oldAccepted: bool, successorConfirmed: bool,
    phase: str, rounds: int, deadlinePassed: bool, requests: int,
    dispatched: bool, recorded: bool, restarts: int,
    ackWithoutCustody: bool, renewedTwice: bool, oldRevokeSent: bool,
    newRevokeSent: bool, announced: bool, keyRefused: bool,
    competitorBlocked: bool, outcome: str
  }
  var s: State

  pure val start: State = {
    saved: Old, intentCurrent: true, attemptActive: false, live: true,
    supersededSaved: -1, installed: false, partialWrite: false,
    journal: "none", claimOwner: 0, worker: 1, foreignJournal: false,
    duty: false, server: "none", oldAccepted: true, successorConfirmed: false,
    phase: "idle", rounds: 0, deadlinePassed: false, requests: 0,
    dispatched: false, recorded: false, restarts: 0,
    ackWithoutCustody: false, renewedTwice: false, oldRevokeSent: false,
    newRevokeSent: false, announced: false, keyRefused: false,
    competitorBlocked: false, outcome: "none"
  }
  action init = s' = start
  pure def owns(x: State): bool = x.live and x.intentCurrent and not(x.attemptActive)
  pure def secret(x: State): bool = x.journal.in(Set("pending", "confirmed"))
  pure def finish(x: State, outcome: str): State = { ...x, phase: "finished", outcome: outcome }

  // A restart recovers a full receipt before checking predecessor validity or
  // advisory preferences. A request-only claim cannot be taken over, even later.
  action check(due: bool, supported: bool): bool = all {
    s.phase.in(Set("idle", "finished")), s.live,
    s' = if (not(supported)) finish(s, "unavailable")
      else if (not(owns(s))) finish(s, "deferred")
      else if (s.journal == "confirmed") { ...s, phase: "duty" }
      else if (s.journal == "pending" and s.rounds < AckRounds) { ...s, phase: "ack" }
      else if (s.journal == "request") finish(s, "sign-in-required")
      else if (s.journal != "none") finish(s, "deferred")
      else if (s.saved != Old) finish(s, "current")
      else if (not(due)) finish(s, "current")
      else { ...s, phase: "claim", worker: 1, outcome: "none" }
  }

  // A second same-generation instance may have captured OLD before any of the
  // first instance's work. CAS excludes it while any request/secret record exists.
  // It can claim a now-empty slot after publication, so dispatch must recheck OLD.
  action competingClaim = all {
    s.live, s.intentCurrent,
    s' = if (s.journal != "none") { ...s, competitorBlocked: true }
      else if (s.phase.in(Set("idle", "finished")))
        { ...s, journal: "request", claimOwner: 2, worker: 2, phase: "claimed", dispatched: false }
      else s
  }
  action claim(stored: bool): bool = all {
    s.phase == "claim",
    s' = if (stored and owns(s) and s.journal == "none")
      { ...s, journal: "request", claimOwner: s.worker, phase: "claimed", dispatched: false }
      else finish(s, "deferred")
  }
  // Preference commit failure sends nothing; only its undispatched exact owner
  // can clear a request. A changed selected credential also sends nothing.
  action dispatch(recordStored: bool): bool = all {
    s.phase == "claimed",
    val exact = s.journal == "request" and s.claimOwner == s.worker
    s' = if (not(owns(s)) or not(exact)) finish(s, "deferred")
      else if (not(recordStored) or s.saved != Old or s.recorded)
        finish({ ...s, journal: "none", claimOwner: 0 }, "deferred")
      else { ...s, phase: "asked", dispatched: true, recorded: true, requests: s.requests + 1,
        renewedTwice: s.renewedTwice or s.successorConfirmed }
  }
  // A dispatched request remains claimed on every refusal/transport uncertainty.
  action renewReply(kind: str): bool = all {
    s.phase == "asked",
    s' = if (kind == "key-refused")
        finish({ ...s, keyRefused: true, oldAccepted: false }, "sign-in-required")
      else if (kind == "code") { ...s, phase: "token" }
      else finish(s, if (kind == "refused") "sign-in-required" else "deferred")
  }
  action tokenReply(minted: bool): bool = all {
    s.phase == "token",
    s' = if (minted) { ...s, server: "minted", phase: "stage" } else finish(s, "deferred")
  }
  // Exact request -> full encrypted successor receipt plus authoritative readback.
  // Failure leaves the request; losing the claim never sends an ACK.
  action stage(stored: bool): bool = all {
    s.phase == "stage",
    s' = if (stored and owns(s) and s.journal == "request" and s.claimOwner == s.worker and s.saved == Old)
      { ...s, journal: "pending", phase: "ack" }
      else finish(s, "deferred")
  }
  action replaceRequest = all {
    s.journal == "request", s.server != "active",
    s' = { ...s, journal: "foreign", foreignJournal: true, claimOwner: 0 }
  }

  // Only exact ACK200+credential id permits publication. A token-exchange
  // authorization_complete is not that receipt. Refusal retains custody: an
  // earlier exact ACK can still be in flight. "lost" commits remotely only.
  action ackReply(kind: str): bool = all {
    s.phase == "ack", s.rounds < AckRounds,
    s' = if (not(owns(s)) or s.journal != "pending") finish(s, "deferred")
      else {
        val sent = { ...s, rounds: s.rounds + 1, ackWithoutCustody: s.ackWithoutCustody or not(secret(s)) }
        if (kind == "acknowledged")
          { ...sent, server: "active", successorConfirmed: true, phase: "confirm" }
        else if (kind == "lost")
          finish({ ...sent, server: "active", successorConfirmed: true }, "deferred")
        else if (kind == "refused-after-commit")
          finish({ ...sent, server: "active", successorConfirmed: true }, "sign-in-required")
        else finish(sent, if (kind == "refused") "sign-in-required" else "deferred")
      }
  }
  action confirm(stored: bool): bool = all {
    s.phase == "confirm",
    s' = if (stored and owns(s) and s.journal == "pending") { ...s, journal: "confirmed", phase: "duty" }
      else finish(s, "deferred")
  }
  action retirementDuty(stored: bool): bool = all {
    s.phase == "duty",
    s' = if (stored and owns(s) and s.journal == "confirmed") { ...s, duty: true, phase: "publish" }
      else finish(s, "deferred")
  }
  // A partial host publication can leave selected-null. The confirmed receipt
  // and retirement duty remain sufficient to repair it under the old generation.
  action publish(kind: str): bool = all {
    s.phase == "publish",
    s' = if (not(owns(s)) or s.journal != "confirmed" or not(s.duty)) finish(s, "deferred")
      else if (kind == "stored") { ...s, saved: New, installed: true, partialWrite: false, phase: "cleanup" }
      else if (kind == "partial") finish({ ...s, saved: 0, partialWrite: true }, "deferred")
      else finish(s, "deferred")
  }
  action cleanup(stored: bool): bool = all {
    s.phase == "cleanup",
    s' = if (owns(s) and s.saved == New and s.journal == "confirmed")
        { ...s, journal: if (stored) "none" else s.journal, phase: "revoke-old" }
      else finish(s, "deferred")
  }
  // The optional host notification is best effort, not a runtime-ready receipt.
  // Named retirement affects OLD only and requires durable selected successor.
  action revokeOld = all {
    s.phase == "revoke-old",
    s' = if (owns(s) and s.saved == New and s.duty)
        finish({ ...s, oldRevokeSent: true, oldAccepted: false, announced: true }, "renewed")
      else finish(s, "deferred")
  }

  action signInStarts = all { not(s.attemptActive), s' = { ...s, attemptActive: true } }
  action credentialAction(replacement: int): bool = all {
    s.intentCurrent,
    s' = { ...s, intentCurrent: false, attemptActive: false, saved: replacement,
      supersededSaved: replacement, journal: "foreign", foreignJournal: true, claimOwner: 0 }
  }
  action deadline = all { not(s.deadlinePassed), s' = { ...s, deadlinePassed: true } }
  action destroy = all { s.live, s' = { ...s, live: false } }
  action restart = all { not(s.live), s.restarts < 2,
    s' = { ...s, live: true, phase: "idle", worker: 3, restarts: s.restarts + 1 } }
  // Dropping the plain record cannot free an encrypted request/receipt.
  action losePreferences = all { s.recorded, s' = { ...s, recorded: false } }
  action idle = s' = s
  action step = any {
    nondet due = Set(true, false).oneOf()
    nondet supported = Set(true, false).oneOf()
    check(due, supported),
    nondet stored = Set(true, false).oneOf()
    any { claim(stored), dispatch(stored), stage(stored), confirm(stored), retirementDuty(stored), cleanup(stored) },
    nondet renewal = Set("code", "refused", "key-refused", "retry").oneOf()
    renewReply(renewal),
    nondet minted = Set(true, false).oneOf()
    tokenReply(minted),
    nondet answer = Set("acknowledged", "exchange-complete", "retry", "lost", "refused", "refused-after-commit").oneOf()
    ackReply(answer),
    nondet publication = Set("stored", "failed", "partial").oneOf()
    publish(publication),
    competingClaim, replaceRequest, revokeOld, signInStarts,
    nondet replacement = Set(0, Newer).oneOf()
    credentialAction(replacement),
    deadline, destroy, restart, losePreferences, idle
  }

  val AckRequiresDurableCustody = not(s.ackWithoutCustody)
  val ActiveSuccessorRecoverable = (s.successorConfirmed and s.intentCurrent).implies(secret(s) or s.saved == New)
  val PublicationRequiresConfirmedReceipt = s.installed.implies(s.server == "active" and s.duty)
  val PartialPublicationRecoverable = (s.partialWrite and s.intentCurrent).implies(s.journal == "confirmed" and s.duty)
  val OldKeyRevokedOnlyAfterInstall = s.oldRevokeSent.implies(s.installed)
  val WorkingKeyKept = (not(s.installed) and s.supersededSaved == -1 and not(s.partialWrite)).implies(s.saved == Old)
  val NewerActionWins = (s.supersededSaved != -1).implies(s.saved == s.supersededSaved)
  val NewerJournalPreserved = s.foreignJournal.implies(s.journal == "foreign")
  val NoBareSuccessorRevocation = not(s.newRevokeSent)
  val SavedKeyAcceptedOrReportedRefused =
    (s.saved == Old and s.supersededSaved == -1 and not(s.keyRefused)).implies(s.oldAccepted)
  val NeverRenewsAfterConfirmedSuccessor = not(s.renewedTwice)
  val OnePredecessorDispatch = s.requests.in(0.to(1))
  val AnnouncedOnlyWhenRenewed = s.announced.implies(s.installed)
  val RetryBudget = s.rounds.in(0.to(AckRounds)) and s.restarts.in(0.to(2))

  run renewsWhenDueTest = init.then(check(true, true)).then(claim(true)).then(dispatch(true))
    .then(renewReply("code")).then(tokenReply(true)).then(stage(true)).then(ackReply("acknowledged"))
    .then(confirm(true)).then(retirementDuty(true)).then(publish("stored")).then(cleanup(true)).then(revokeOld)
    .expect(s.saved == New and s.oldRevokeSent and s.outcome == "renewed")
  run unsupportedSendsNothingTest = init.then(check(true, false)).expect(s.outcome == "unavailable" and s.requests == 0)
  run failedClaimSendsNothingTest = init.then(check(true, true)).then(claim(false)).expect(s.requests == 0 and s.rounds == 0)
  run failedDailyCommitSendsNothingTest = init.then(check(true, true)).then(claim(true)).then(dispatch(false))
    .expect(s.requests == 0 and s.journal == "none")
  run failedStageSendsNoAckTest = init.then(check(true, true)).then(claim(true)).then(dispatch(true))
    .then(renewReply("code")).then(tokenReply(true)).then(stage(false)).expect(s.rounds == 0 and s.journal == "request")
  run requestCrashCannotBeStolenTest = init.then(check(true, true)).then(claim(true)).then(destroy).then(restart)
    .then(check(true, true)).then(competingClaim).expect(s.requests == 0 and s.journal == "request" and s.competitorBlocked)
  run overlappingInstanceCannotDispatchTest = init.then(check(true, true)).then(claim(true)).then(competingClaim)
    .then(dispatch(true)).expect(s.requests == 1 and s.competitorBlocked)
  run lostClaimSendsNoAckTest = init.then(check(true, true)).then(claim(true)).then(dispatch(true))
    .then(renewReply("code")).then(tokenReply(true)).then(replaceRequest).then(stage(true))
    .expect(s.rounds == 0 and s.journal == "foreign")
  run lostAckRecoversAfterRestartAndDeadlineTest = init.then(check(true, true)).then(claim(true)).then(dispatch(true))
    .then(renewReply("code")).then(tokenReply(true)).then(stage(true)).then(ackReply("lost"))
    .then(losePreferences).then(destroy).then(restart).then(deadline).then(check(true, true))
    .then(ackReply("acknowledged")).then(confirm(true)).then(retirementDuty(true)).then(publish("stored"))
    .expect(s.saved == New and s.requests == 1 and s.rounds == 2)
  run terminalRefusalRetainsPossibleCommitTest = init.then(check(true, true)).then(claim(true)).then(dispatch(true))
    .then(renewReply("code")).then(tokenReply(true)).then(stage(true)).then(ackReply("refused-after-commit"))
    .then(losePreferences).then(check(true, true)).expect(s.journal == "pending" and s.phase == "ack" and s.requests == 1)
  run exchangeCompleteDoesNotPublishTest = init.then(check(true, true)).then(claim(true)).then(dispatch(true))
    .then(renewReply("code")).then(tokenReply(true)).then(stage(true)).then(ackReply("exchange-complete"))
    .expect(s.saved == Old and s.journal == "pending" and not(s.installed))
  run partialPublicationRecoversTest = init.then(check(true, true)).then(claim(true)).then(dispatch(true))
    .then(renewReply("code")).then(tokenReply(true)).then(stage(true)).then(ackReply("acknowledged"))
    .then(confirm(true)).then(retirementDuty(true)).then(publish("partial")).then(destroy).then(restart)
    .then(check(true, true)).then(retirementDuty(true)).then(publish("stored"))
    .expect(s.saved == New and s.rounds == 1)
  run newerIntentFencesRecoveryTest = init.then(check(true, true)).then(claim(true)).then(dispatch(true))
    .then(renewReply("code")).then(tokenReply(true)).then(stage(true)).then(ackReply("lost"))
    .then(credentialAction(Newer)).then(destroy).then(restart).then(check(true, true))
    .expect(s.saved == Newer and s.journal == "foreign" and s.rounds == 1)
  run staleReaderAfterPublicationSendsNothingTest = init.then(check(true, true)).then(claim(true)).then(dispatch(true))
    .then(renewReply("code")).then(tokenReply(true)).then(stage(true)).then(ackReply("acknowledged"))
    .then(confirm(true)).then(retirementDuty(true)).then(publish("stored")).then(cleanup(true)).then(revokeOld)
    .then(losePreferences).then(competingClaim).then(dispatch(true))
    .expect(s.saved == New and s.requests == 1 and s.journal == "none")
}
