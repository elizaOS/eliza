// Android startup acknowledgement recovery for a stored enrollment receipt.
// The saved native key remains under the credential store's ownership.
module NativeAndroidAckRecovery {
  pure val Production = 1
  pure val Staging = 2
  pure val ServerCredential = 11
  pure val ReplacementCredential = 12
  pure val NoReceipt = { present: false, parsed: false, environment: 0,
    credential: 0, expired: false }
  pure val NoPost = { environment: 0, credential: 0, saved: 0 }

  type Receipt = { present: bool, parsed: bool, environment: int,
    credential: int, expired: bool }
  type Post = { environment: int, credential: int, saved: int }
  type State = {
    environment: int, saved: int, initialSaved: int, receipt: Receipt,
    initialReceipt: Receipt, runReceipt: Receipt, live: bool, runs: int,
    phase: str, calls: int, post: Post, removal: str, outcome: str
  }
  var s: State

  pure val Matching = { present: true, parsed: true, environment: Production,
    credential: ServerCredential, expired: false }

  pure def initial(receipt: Receipt, saved: int): State = {
    environment: Production, saved: saved, initialSaved: saved,
    receipt: receipt, initialReceipt: receipt, runReceipt: NoReceipt, live: true,
    runs: 0, phase: "idle", calls: 0, post: NoPost, removal: "none", outcome: "none"
  }

  action init = any {
    s' = initial(NoReceipt, ServerCredential),
    s' = initial(Matching, ServerCredential),
    s' = initial(Matching, 0),
    s' = initial(Matching, ReplacementCredential),
    s' = initial({ ...Matching, environment: Staging }, ServerCredential),
    s' = initial({ ...Matching, expired: true }, ServerCredential),
    s' = initial({ ...Matching, parsed: false }, ServerCredential)
  }

  action begin = all {
    s.phase.in(Set("idle", "finished")), s.runs < 2,
    s' = { ...s, live: true, runs: s.runs + 1, runReceipt: s.receipt,
      phase: "reading", calls: 0, post: NoPost, outcome: "none" }
  }

  pure def matches(s: State): bool =
    s.receipt.present and s.receipt.parsed and
      s.receipt.credential == s.saved and s.receipt.environment == s.environment

  action readReply(readable: bool): bool = all {
    s.phase == "reading",
    s' = if (not(readable)) { ...s, phase: "finished", outcome: "kept" }
      else if (not(s.receipt.present)) { ...s, phase: "finished", outcome: "absent" }
      else if (not(s.receipt.parsed)) { ...s, phase: "finished", outcome: "kept" }
      else if (not(matches(s)) or s.receipt.expired) { ...s, phase: "remove-stale" }
      else { ...s, phase: "send" }
  }

  // Each reply that can retry consumes a round. The Java loop sleeps between
  // calls and checks destruction before sending again.
  action send = all {
    s.phase == "send", s.calls < 3,
    s' = if (s.live) { ...s, phase: "waiting", calls: s.calls + 1,
        post: { environment: s.environment, credential: s.receipt.credential, saved: s.saved } }
      else { ...s, phase: "finished", outcome: "kept" }
  }

  action reply(kind: str): bool = all {
    s.phase == "waiting",
    s' = if (kind.in(Set("acknowledged", "already-complete")))
      { ...s, phase: "remove-acknowledged" }
      else if (kind == "retryable" and s.calls < 3) { ...s, phase: "send" }
      else { ...s, phase: "finished", outcome: "kept" }
  }

  action removeReceipt(removed: bool): bool = all {
    s.phase.in(Set("remove-stale", "remove-acknowledged")),
    not(removed) or s.live,
    s' = if (removed) { ...s, receipt: NoReceipt, removal: s.phase,
        phase: "finished", outcome: "removed" }
      else { ...s, phase: "finished", outcome: "kept" }
  }

  action destroy = all {
    s.live,
    s' = { ...s, live: false }
  }

  action progress = any {
    readReply(true), readReply(false), send,
    nondet kind = Set("acknowledged", "already-complete", "retryable",
      "wrong-credential", "denied", "unexpected-error").oneOf()
    reply(kind),
    removeReceipt(true), removeReceipt(false)
  }

  action idle = s' = s
  action step = any { begin, progress, destroy, idle }

  val RetryBudget = all {
    s.calls.in(0.to(3)), s.runs.in(0.to(2)),
    (s.phase == "waiting").implies(s.calls > 0),
    (s.phase == "send").implies(s.calls < 3)
  }

  val AckUsesCurrentUnexpiredReceipt = (s.post != NoPost).implies(all {
    s.runReceipt.present, s.runReceipt.parsed, not(s.runReceipt.expired),
    s.post.environment == s.runReceipt.environment and s.post.environment == s.environment,
    s.post.credential == s.runReceipt.credential and s.post.credential == s.post.saved
  })

  val RecoveryNeverReplacesSavedKey = s.saved == s.initialSaved

  val RemoveOnlyStaleOrAcknowledged = all {
    (s.initialReceipt.present and not(s.receipt.present)).implies(
      s.removal.in(Set("remove-stale", "remove-acknowledged"))),
    (s.removal == "remove-stale").implies(
      s.initialReceipt.expired or s.initialReceipt.credential != s.saved or
        s.initialReceipt.environment != s.environment),
    (s.outcome == "kept").implies(s.receipt == s.runReceipt)
  }

  val Running = not(s.phase.in(Set("idle", "finished")))
  temporal EachRunSettles = always((Running).implies(eventually(not(Running))))
  temporal UnderFairReplies = (progress.weakFair(s)).implies(EachRunSettles)

  action initMatching = s' = initial(Matching, ServerCredential)
  action initForeign = s' = initial({ ...Matching, environment: Staging }, ServerCredential)

  run retryThenClearTest = initMatching.then(begin).then(readReply(true))
    .then(send).then(reply("retryable")).then(send).then(reply("retryable"))
    .then(send).then(reply("already-complete")).then(removeReceipt(true))
    .expect(s.calls == 3 and not(s.receipt.present) and RecoveryNeverReplacesSavedKey)

  run exhaustedBudgetKeepsReceiptForRestartTest = initMatching.then(begin).then(readReply(true))
    .then(send).then(reply("retryable")).then(send).then(reply("retryable"))
    .then(send).then(reply("retryable"))
    .expect(s.outcome == "kept" and s.calls == 3 and s.receipt == Matching)
    .then(begin).then(readReply(true)).then(send).then(reply("acknowledged"))
    .then(removeReceipt(true)).expect(s.runs == 2 and not(s.receipt.present))

  run foreignEnvironmentNeverPostsTest = initForeign.then(begin)
    .then(readReply(true)).then(removeReceipt(true))
    .expect(s.calls == 0 and s.removal == "remove-stale")

  run destructionStopsNextRetryTest = initMatching.then(begin).then(readReply(true))
    .then(send).then(reply("retryable")).then(destroy).then(send)
    .expect(s.calls == 1 and s.outcome == "kept" and s.receipt == Matching)
}
