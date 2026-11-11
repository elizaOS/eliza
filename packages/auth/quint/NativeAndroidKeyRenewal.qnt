// Silent renewal of a saved Android Cloud key (CloudSignInPlugin.renewNow,
// renewalAcknowledgement, renewalSettled; policy in CloudKeyRenewal).
// The saved key asks Cloud for a new one. The new key is confirmed before it is
// saved, and the old key is revoked only after that save. A sign-in attempt or
// a newer credential action ends the renewal without touching the saved key.
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
    // The renewal itself.
    phase: str, rounds: int, deadlinePassed: bool, requests: int, askedToday: bool,
    oldRevokeSent: bool, newRevokeSent: bool, announced: bool, outcome: str
  }
  var s: State

  pure val start: State = {
    saved: Old, intentCurrent: true, attemptActive: false, live: true,
    supersededSaved: -1, installed: false, server: "none",
    phase: "idle", rounds: 0, deadlinePassed: false, requests: 0, askedToday: false,
    oldRevokeSent: false, newRevokeSent: false, announced: false, outcome: "none"
  }
  action init = s' = start

  pure def owns(x: State): bool = x.live and x.intentCurrent and not(x.attemptActive)
  pure def finish(x: State, outcome: str): State = { ...x, phase: "finished", outcome: outcome }

  // The check on load, resume or an explicit call. The daily request is recorded
  // before it is sent.
  action check(due: bool, supported: bool): bool = all {
    s.phase.in(Set("idle", "finished")), s.live,
    s' = if (s.saved != Old) finish(s, "signed-out")
      else if (not(due)) finish(s, "current")
      else if (not(supported)) finish(s, "unavailable")
      else if (s.attemptActive or s.askedToday) finish(s, "deferred")
      else { ...s, phase: "asked", askedToday: true, requests: s.requests + 1,
        server: "none", rounds: 0, newRevokeSent: false, outcome: "none" }
  }

  // 200 with a code, a refusal (401, 403, 409) or no usable answer.
  action renewReply(kind: str): bool = all {
    s.phase == "asked",
    s' = if (kind == "code") { ...s, phase: "token" }
      else if (kind == "refused") finish(s, "sign-in-required")
      else finish(s, "deferred")
  }

  // The token route mints an unconfirmed key. One that would not outlive the
  // saved key is left to lapse.
  action tokenReply(minted: bool, outlives: bool): bool = all {
    s.phase == "token",
    s' = if (not(minted)) finish(s, "deferred")
      else if (not(outlives) or not(owns(s))) finish({ ...s, server: "minted" }, "deferred")
      else { ...s, server: "minted", phase: "ack", rounds: 0 }
  }

  // One acknowledgement request. "lost" reaches Cloud but its answer does not
  // reach the phone. A round that no longer owns the renewal sends nothing.
  action ackReply(kind: str): bool = all {
    s.phase == "ack",
    s' = if (not(owns(s))) { ...s, phase: "drop" }
      else if (kind.in(Set("acknowledged", "already-complete")))
        { ...s, server: "active", rounds: s.rounds + 1, phase: "save" }
      else if (kind == "refused") { ...s, rounds: s.rounds + 1, phase: "drop" }
      else {
        val reached = if (kind == "lost") "active" else s.server
        if (s.deadlinePassed or s.rounds + 1 >= AckRounds)
          { ...s, server: reached, rounds: s.rounds + 1, phase: "drop" }
        else { ...s, server: reached, rounds: s.rounds + 1 }
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

  // An unsaved new key is revoked best effort and the saved key stays.
  action drop = all {
    s.phase == "drop",
    s' = finish({ ...s, newRevokeSent: s.live }, "deferred")
  }

  action revokeOld = all {
    s.phase == "revoke-old",
    s' = finish({ ...s, oldRevokeSent: true, announced: true }, "renewed")
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
    nondet renewal = Set("code", "refused", "retry").oneOf()
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
  // A confirmed key that was not saved is sent a revocation while the plugin is open.
  val UnsavedConfirmedKeyRevoked =
    (s.phase == "finished" and s.server == "active" and not(s.installed) and s.live).implies(s.newRevokeSent)
  val AnnouncedOnlyWhenRenewed = s.announced.implies(s.installed)
  val RequestBudget = s.requests.in(0.to(2)) and s.rounds.in(0.to(AckRounds))

  run renewsWhenDueTest = init.then(check(true, true)).then(renewReply("code"))
    .then(tokenReply(true, true)).then(ackReply("acknowledged")).then(save(true)).then(revokeOld)
    .expect(s.saved == New and s.oldRevokeSent and not(s.newRevokeSent) and s.outcome == "renewed")

  run skipsWhenNotDueTest = init.then(check(false, true))
    .expect(s.outcome == "current" and s.requests == 0 and s.saved == Old)

  run refusalKeepsWorkingKeyTest = init.then(check(true, true)).then(renewReply("refused"))
    .expect(s.outcome == "sign-in-required" and s.saved == Old and not(s.oldRevokeSent))
    .then(check(true, true)).expect(s.outcome == "deferred" and s.requests == 1)

  run lostAckIsRecoveredTest = init.then(check(true, true)).then(renewReply("code"))
    .then(tokenReply(true, true)).then(ackReply("lost")).expect(s.saved == Old and s.phase == "ack")
    .then(ackReply("already-complete")).then(save(true)).then(revokeOld)
    .expect(s.saved == New and s.oldRevokeSent and s.rounds == 2)

  run unconfirmedKeyIsNeverSavedTest = init.then(check(true, true)).then(renewReply("code"))
    .then(tokenReply(true, true)).then(ackReply("refused")).then(drop)
    .expect(s.saved == Old and not(s.oldRevokeSent) and s.newRevokeSent and s.outcome == "deferred")

  run signInEndsRenewalTest = init.then(check(true, true)).then(renewReply("code"))
    .then(tokenReply(true, true)).then(ackReply("retry")).then(signInStarts).then(ackReply("acknowledged"))
    .then(drop).expect(s.saved == Old and s.rounds == 1 and not(s.installed))

  run newerActionWinsTest = init.then(check(true, true)).then(renewReply("code"))
    .then(tokenReply(true, true)).then(ackReply("acknowledged")).then(credentialAction(0)).then(save(true))
    .then(drop).expect(s.saved == 0 and s.newRevokeSent and not(s.oldRevokeSent))
}
