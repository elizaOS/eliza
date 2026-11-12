// In-process acknowledgement of a key that a sign-in stored before Cloud
// confirmed it (CloudSignInPlugin.complete, retryAcknowledgement, activated,
// expireActivation). The sign-in step ends as activation-pending; Cloud is
// asked again until its deadline, with one request just after it. A confirmed
// key is announced once. A refused or unconfirmed key is removed and reported,
// only while this sign-in still owns the slot.
module NativeAndroidActivation {
  pure val Mine = 1
  pure val Newer = 2
  pure val MaxRounds = 4

  type State = {
    saved: int, receipt: int, intentCurrent: bool, live: bool, supersededSaved: int,
    // Cloud's view of this sign-in's key: pending or active.
    server: str,
    phase: str, rounds: int, deadlinePassed: bool, roundsAfterDeadline: int,
    announced: str, revokeSent: bool, pendingReported: bool
  }
  var s: State

  // The sign-in step stored the receipt and the key, got no confirmation and
  // answered activation-pending.
  action init = s' = {
    saved: Mine, receipt: Mine, intentCurrent: true, live: true, supersededSaved: -1,
    server: "pending", phase: "retrying", rounds: 0, deadlinePassed: false,
    roundsAfterDeadline: 0, announced: "none", revokeSent: false, pendingReported: true
  }

  pure def owns(x: State): bool = x.live and x.intentCurrent

  // Cloud confirmed: the receipt goes, and the sign-in is announced while the
  // same key is still the saved one.
  pure def activated(x: State): State = {
    ...x, phase: "finished", server: "active",
    receipt: if (x.receipt == Mine) 0 else x.receipt,
    announced: if (x.saved == Mine) "completed" else x.announced
  }
  // Refused, or the deadline passed: this sign-in's key and receipt are removed,
  // the key is revoked in case a confirmation was lost, and the owner is told.
  pure def expired(x: State): State = {
    ...x, phase: "finished",
    saved: if (x.saved == Mine) 0 else x.saved,
    receipt: if (x.receipt == Mine) 0 else x.receipt,
    revokeSent: true, announced: "expired"
  }

  // One background round. A superseded or closed sign-in sends nothing and
  // leaves the slot and the receipt for their owner or the next start.
  action round(kind: str): bool = all {
    s.phase == "retrying", s.rounds < MaxRounds or s.deadlinePassed,
    s' = if (not(owns(s))) { ...s, phase: "finished" }
      else {
        val sent = { ...s, rounds: s.rounds + 1,
          roundsAfterDeadline: s.roundsAfterDeadline + (if (s.deadlinePassed) 1 else 0) }
        if (kind.in(Set("acknowledged", "already-complete"))) activated(sent)
        else if (kind == "refused") expired(sent)
        else {
          val reached = { ...sent, server: if (kind == "lost") "active" else sent.server }
          if (s.deadlinePassed) expired(reached) else reached
        }
      }
  }

  action deadline = all { not(s.deadlinePassed), s' = { ...s, deadlinePassed: true } }
  // A newer credential action: a sign-out, or a sign-in that stores its own key and receipt.
  action credentialAction(replacement: int): bool = all {
    s.intentCurrent,
    s' = { ...s, intentCurrent: false, saved: replacement, supersededSaved: replacement,
      receipt: if (replacement == Newer) Newer else s.receipt }
  }
  action destroy = all { s.live, s' = { ...s, live: false } }

  action idle = s' = s
  action step = any {
    nondet answer = Set("acknowledged", "already-complete", "retry", "lost", "refused").oneOf()
    round(answer),
    deadline,
    nondet replacement = Set(0, Newer).oneOf()
    credentialAction(replacement),
    destroy, idle
  }

  // A sign-in is announced only for a key Cloud confirmed.
  val CompletedOnlyWhenConfirmed = (s.announced == "completed").implies(s.server == "active")
  // While Cloud has not decided and nothing superseded the sign-in, the key and its receipt stay.
  val UndecidedKeyStays =
    (s.phase == "retrying" and s.supersededSaved == -1).implies(s.saved == Mine and s.receipt == Mine)
  // A newer credential action's slot is never removed or announced as this sign-in's.
  val NewerActionWins = (s.supersededSaved != -1).implies(s.saved == s.supersededSaved)
  val NewerReceiptStays = (s.supersededSaved == Newer).implies(s.receipt == Newer)
  // A removed key is always sent a revocation, in case a confirmation was lost.
  val RemovedKeyRevoked = (s.announced == "expired").implies(s.revokeSent)
  // Exactly one request follows the deadline.
  val OneRequestAfterDeadline = s.roundsAfterDeadline.in(Set(0, 1))
  val RetryBudget = s.rounds.in(0.to(MaxRounds + 1))

  run lateConfirmationIsAnnouncedTest = init.then(round("retry")).then(round("retry"))
    .then(round("already-complete"))
    .expect(s.announced == "completed" and s.saved == Mine and s.receipt == 0 and s.rounds == 3)

  run refusalRemovesAndReportsTest = init.then(round("refused"))
    .expect(s.announced == "expired" and s.saved == 0 and s.receipt == 0 and s.revokeSent)

  run deadlineSendsOneLastRequestTest = init.then(round("retry")).then(deadline).then(round("retry"))
    .expect(s.announced == "expired" and s.saved == 0 and s.roundsAfterDeadline == 1)

  run lostConfirmationSeenAfterDeadlineTest = init.then(round("lost")).then(deadline)
    .then(round("already-complete"))
    .expect(s.announced == "completed" and s.saved == Mine and s.roundsAfterDeadline == 1)

  run newerSignInKeepsItsSlotTest = init.then(round("retry")).then(credentialAction(Newer))
    .then(deadline).then(round("refused"))
    .expect(s.saved == Newer and s.receipt == Newer and s.announced == "none" and s.rounds == 1)

  run closedPluginKeepsReceiptTest = init.then(destroy).then(round("acknowledged"))
    .expect(s.saved == Mine and s.receipt == Mine and s.rounds == 0 and s.announced == "none")
}
