// Silent renewal of a saved Android Cloud key (CloudSignInPlugin.renewNow,
// renewalAcknowledgement, renewalSettled; policy in CloudKeyRenewal).
// The saved key asks Cloud for a new one. The new key is confirmed before it is
// saved, and the old key is revoked only after that save. A sign-in attempt or
// a newer credential action ends the renewal without touching the saved key.
//
// Both keys belong to one sign-in, and Cloud ends a whole sign-in when a key
// revokes itself without naming its confirmed successor, or asks for renewal
// after its successor was confirmed. So the old key's revocation names the new
// one, a new key that was not saved is revoked only once the saved key is no
// longer the one the renewal presented, and a saved key that may have a
// confirmed successor is never presented for renewal again.
module NativeAndroidKeyRenewal {
  pure val Old = 1
  pure val New = 2
  pure val Newer = 3
  pure val AckRounds = 3

  type State = {
    // Local store and the host's credential intent.
    saved: int, intentCurrent: bool, attemptActive: bool, live: bool,
    supersededSaved: int, installed: bool,
    // Cloud's view of the new key: none, minted (unconfirmed) or active.
    server: str,
    // Cloud's view of the sign-in: it still accepts the old key; it confirmed a
    // successor of the old key at some point; the old key asked for renewal
    // after that.
    oldAccepted: bool, successorConfirmed: bool, renewedTwice: bool,
    // The renewal itself.
    phase: str, rounds: int, deadlinePassed: bool, requests: int, askedToday: bool,
    oldRevokeSent: bool, newRevokeSent: bool, announced: bool, outcome: str,
    // The plain renewal record of the saved key: none, retry, refused,
    // rejected (Cloud answered 401) or confirming (a confirmation request may
    // have reached Cloud and Cloud has not refused it).
    record: str, keyRefused: bool
  }
  var s: State

  pure val start: State = {
    saved: Old, intentCurrent: true, attemptActive: false, live: true,
    supersededSaved: -1, installed: false, server: "none",
    oldAccepted: true, successorConfirmed: false, renewedTwice: false,
    phase: "idle", rounds: 0, deadlinePassed: false, requests: 0, askedToday: false,
    oldRevokeSent: false, newRevokeSent: false, announced: false, outcome: "none",
    record: "none", keyRefused: false
  }
  action init = s' = start

  pure def owns(x: State): bool = x.live and x.intentCurrent and not(x.attemptActive)
  pure def finish(x: State, outcome: str): State = { ...x, phase: "finished", outcome: outcome }

  // The check on load, resume or an explicit call. The daily request is recorded
  // before it is sent. A key recorded as confirming is never asked for again.
  action check(due: bool, supported: bool): bool = all {
    s.phase.in(Set("idle", "finished")), s.live,
    s' = if (s.saved != Old) finish(s, "signed-out")
      else if (not(due)) finish(s, "current")
      else if (not(supported)) finish(s, "unavailable")
      else if (s.attemptActive) finish(s, "deferred")
      else if (s.record == "confirming") finish(s, "sign-in-required")
      else if (s.askedToday)
        finish(s, if (s.record.in(Set("refused", "rejected"))) "sign-in-required" else "deferred")
      else { ...s, phase: "asked", askedToday: true, requests: s.requests + 1, record: "retry",
        server: "none", rounds: 0, newRevokeSent: false, outcome: "none" }
  }

  // 200 with a code, a refusal of the renewal (403, 409), a refusal of the key
  // itself (401) or no usable answer. Cloud answers 401 whatever else it would
  // have said once it no longer accepts the old key, and it ends the sign-in
  // when the old key asks after its successor was confirmed.
  action renewReply(kind: str): bool = all {
    s.phase == "asked",
    val twice = s.oldAccepted and s.successorConfirmed
    val rejected = kind == "key-refused" or not(s.oldAccepted) or twice
    s' = if (rejected)
        finish({ ...s, record: "rejected", keyRefused: true, renewedTwice: s.renewedTwice or twice,
          oldAccepted: s.oldAccepted and not(twice) }, "sign-in-required")
      else if (kind == "code") { ...s, phase: "token" }
      else if (kind == "refused") finish({ ...s, record: "refused" }, "sign-in-required")
      else finish(s, "deferred")
  }

  // The token route mints an unconfirmed key. One that would not outlive the
  // saved key is left to lapse.
  action tokenReply(minted: bool, outlives: bool): bool = all {
    s.phase == "token",
    s' = if (not(minted)) finish(s, "deferred")
      else if (not(outlives) or not(owns(s))) finish({ ...s, server: "minted" }, "deferred")
      // Recorded before the first acknowledgement request.
      else { ...s, server: "minted", phase: "ack", rounds: 0, record: "confirming" }
  }

  // One acknowledgement request. "lost" reaches Cloud but its answer does not
  // reach the phone. A round that no longer owns the renewal sends nothing.
  // Cloud refuses only a key it has not confirmed: after a lost confirmation it
  // answers "already complete". Only a refusal clears the confirming record.
  action ackReply(asked: str): bool = all {
    s.phase == "ack",
    val kind = if (asked == "refused" and s.server == "active") "already-complete" else asked
    s' = if (not(owns(s))) { ...s, phase: "drop" }
      else if (kind.in(Set("acknowledged", "already-complete")))
        { ...s, server: "active", successorConfirmed: true, rounds: s.rounds + 1, phase: "save" }
      else if (kind == "refused") { ...s, rounds: s.rounds + 1, phase: "drop", record: "retry" }
      else {
        val reached = if (kind == "lost") "active" else s.server
        val confirmed = s.successorConfirmed or kind == "lost"
        if (s.deadlinePassed or s.rounds + 1 >= AckRounds)
          { ...s, server: reached, successorConfirmed: confirmed, rounds: s.rounds + 1, phase: "drop" }
        else { ...s, server: reached, successorConfirmed: confirmed, rounds: s.rounds + 1 }
      }
  }

  // The guarded save: this renewal still owns the slot and the saved key is the
  // one it presented.
  action save(stored: bool): bool = all {
    s.phase == "save",
    s' = if (stored and owns(s) and s.saved == Old)
        { ...s, saved: New, installed: true, phase: "revoke-old" }
      else { ...s, phase: "drop" }
  }

  // An unsaved new key. While the key the renewal presented is still the saved
  // one, nothing is sent: the new key revoking itself would be a sign-out that
  // ends the saved key. Once the saved key was removed or replaced, the new key
  // is revoked, which ends the sign-in the owner already left.
  action drop = all {
    s.phase == "drop",
    val sent = s.live and s.saved != Old
    s' = finish({ ...s, newRevokeSent: sent, oldAccepted: s.oldAccepted and not(sent) }, "deferred")
  }

  // The old key revokes itself and names the new one: Cloud ends the old key alone.
  action revokeOld = all {
    s.phase == "revoke-old",
    s' = finish({ ...s, oldRevokeSent: true, oldAccepted: false, announced: true, record: "none" }, "renewed")
  }

  // The environment: a sign-in attempt starts, a newer credential action
  // (sign-out or a completed sign-in) replaces the slot, Cloud's deadline
  // passes, the plugin closes, a day passes.
  action signInStarts = all { not(s.attemptActive), s' = { ...s, attemptActive: true } }
  action credentialAction(replacement: int): bool = all {
    s.intentCurrent, s.phase != "idle",
    s' = { ...s, intentCurrent: false, attemptActive: false, saved: replacement, supersededSaved: replacement }
  }
  action deadline = all { not(s.deadlinePassed), s.phase == "ack", s' = { ...s, deadlinePassed: true } }
  action destroy = all { s.live, s' = { ...s, live: false } }
  action nextDay = all { s.phase == "finished", s.askedToday, s.requests < 2,
    s' = { ...s, askedToday: false, deadlinePassed: false } }

  action idle = s' = s
  action step = any {
    nondet due = Set(true, false).oneOf()
    nondet supported = Set(true, false).oneOf()
    check(due, supported),
    nondet renewal = Set("code", "refused", "key-refused", "retry").oneOf()
    renewReply(renewal),
    nondet minted = Set(true, false).oneOf()
    nondet outlives = Set(true, false).oneOf()
    tokenReply(minted, outlives),
    nondet answer = Set("acknowledged", "already-complete", "retry", "lost", "refused").oneOf()
    ackReply(answer),
    nondet stored = Set(true, false).oneOf()
    save(stored),
    drop, revokeOld, signInStarts,
    nondet replacement = Set(0, Newer).oneOf()
    credentialAction(replacement),
    deadline, destroy, nextDay, idle
  }

  // The old key is revoked only after the confirmed new key is the saved one.
  val OldKeyRevokedOnlyAfterInstall = s.oldRevokeSent.implies(s.installed)
  // Only a key Cloud confirmed is ever saved by a renewal.
  val InstalledKeyIsConfirmed = s.installed.implies(s.server == "active")
  // A refusal or a failure leaves the working key saved, unless the owner's own newer action changed it.
  val WorkingKeyKept = (not(s.installed) and s.supersededSaved == -1).implies(s.saved == Old)
  // A newer credential action is never overwritten.
  val NewerActionWins = (s.supersededSaved != -1).implies(s.saved == s.supersededSaved)
  // The saved new key is never the one a renewal revokes.
  val SavedKeyNotRevoked = (s.installed and s.supersededSaved == -1).implies(not(s.newRevokeSent))
  // An unsaved new key is revoked only once the saved key is no longer the one the renewal presented.
  val UnsavedKeyRevokedOnlyAfterSavedKeyLeft = s.newRevokeSent.implies(s.saved != Old)
  // While the old key is the saved one, Cloud still accepts it, or the renewal said that Cloud refused it.
  val SavedKeyAcceptedOrReportedRefused =
    (s.saved == Old and s.supersededSaved == -1 and not(s.keyRefused)).implies(s.oldAccepted)
  // The old key never asks for renewal after Cloud confirmed its successor.
  val NeverRenewsAfterConfirmedSuccessor = not(s.renewedTwice)
  // A saved key that may have a confirmed successor is recorded as such until a renewal is saved.
  val ConfirmedSuccessorIsRecorded =
    (s.successorConfirmed and s.saved == Old and s.supersededSaved == -1).implies(s.record == "confirming")
  val AnnouncedOnlyWhenRenewed = s.announced.implies(s.installed)
  val RequestBudget = s.requests.in(0.to(2)) and s.rounds.in(0.to(AckRounds))

  run renewsWhenDueTest = init.then(check(true, true)).then(renewReply("code"))
    .then(tokenReply(true, true)).then(ackReply("acknowledged")).then(save(true)).then(revokeOld)
    .expect(s.saved == New and s.oldRevokeSent and not(s.newRevokeSent) and s.outcome == "renewed")

  run skipsWhenNotDueTest = init.then(check(false, true))
    .expect(s.outcome == "current" and s.requests == 0 and s.saved == Old)

  run refusalKeepsWorkingKeyTest = init.then(check(true, true)).then(renewReply("refused"))
    .expect(s.outcome == "sign-in-required" and s.saved == Old and not(s.oldRevokeSent) and not(s.keyRefused))
    .then(check(true, true)).expect(s.outcome == "sign-in-required" and s.requests == 1 and s.oldAccepted)

  run refusedKeyIsReportedTest = init.then(check(true, true)).then(renewReply("key-refused"))
    .expect(s.outcome == "sign-in-required" and s.keyRefused and s.saved == Old and s.record == "rejected")

  run lostAckIsRecoveredTest = init.then(check(true, true)).then(renewReply("code"))
    .then(tokenReply(true, true)).then(ackReply("lost")).expect(s.saved == Old and s.phase == "ack")
    .then(ackReply("already-complete")).then(save(true)).then(revokeOld)
    .expect(s.saved == New and s.oldRevokeSent and s.rounds == 2)

  run unconfirmedKeyIsNeverSavedTest = init.then(check(true, true)).then(renewReply("code"))
    .then(tokenReply(true, true)).then(ackReply("refused")).then(drop)
    .expect(s.saved == Old and not(s.oldRevokeSent) and not(s.newRevokeSent) and s.oldAccepted
      and s.record == "retry" and s.outcome == "deferred")
    .then(nextDay).then(check(true, true)).expect(s.phase == "asked" and s.requests == 2)

  run confirmedButUnsavedKeyIsNeverRenewedAgainTest = init.then(check(true, true)).then(renewReply("code"))
    .then(tokenReply(true, true)).then(ackReply("acknowledged")).then(save(false)).then(drop)
    .expect(s.saved == Old and not(s.newRevokeSent) and s.oldAccepted and s.record == "confirming")
    .then(nextDay).then(check(true, true))
    .expect(s.outcome == "sign-in-required" and s.requests == 1 and s.oldAccepted and not(s.renewedTwice))

  run lostConfirmationIsNeverRenewedAgainTest = init.then(check(true, true)).then(renewReply("code"))
    .then(tokenReply(true, true)).then(ackReply("lost")).then(deadline).then(ackReply("retry")).then(drop)
    .expect(s.saved == Old and s.successorConfirmed and s.oldAccepted and s.record == "confirming")
    .then(nextDay).then(check(true, true)).expect(s.outcome == "sign-in-required" and s.requests == 1)

  run signInEndsRenewalTest = init.then(check(true, true)).then(renewReply("code"))
    .then(tokenReply(true, true)).then(ackReply("retry")).then(signInStarts).then(ackReply("acknowledged"))
    .then(drop).expect(s.saved == Old and s.rounds == 1 and not(s.installed))

  run newerActionWinsTest = init.then(check(true, true)).then(renewReply("code"))
    .then(tokenReply(true, true)).then(ackReply("acknowledged")).then(credentialAction(0)).then(save(true))
    .then(drop).expect(s.saved == 0 and s.newRevokeSent and not(s.oldRevokeSent) and not(s.oldAccepted))
}
