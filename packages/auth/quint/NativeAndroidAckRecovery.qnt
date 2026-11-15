// Android startup acknowledgement recovery for a stored enrollment receipt
// (CloudSignInPlugin.resumeAcknowledgements).
// The sign-in worker reads the receipt. The requests run apart from that
// worker, so a newer sign-in can replace the receipt and key meanwhile.
// A receipt that names no saved key is stale and goes. A receipt for the saved
// key is settled with the outcomes of the in-process path: a confirmed key
// stays and is announced; a key Cloud refused, or did not confirm by its
// deadline, is removed with its receipt, revoked and reported. With no answer
// before the deadline the background rounds (NativeAndroidActivation) take over.
module NativeAndroidAckRecovery {
  pure val Production = 1
  pure val Staging = 2
  pure val ServerCredential = 11
  pure val ReplacementCredential = 12
  pure val NoReceipt = { present: false, parsed: false, environment: 0,
    credential: 0, expired: false }
  pure val NoPost = { environment: 0, credential: 0, saved: 0, late: false }
  pure val Newer = { present: true, parsed: true, environment: Production,
    credential: ReplacementCredential, expired: false }

  type Receipt = { present: bool, parsed: bool, environment: int,
    credential: int, expired: bool }
  type Post = { environment: int, credential: int, saved: int, late: bool }
  type State = {
    environment: int, saved: int, initialSaved: int, receipt: Receipt,
    initialReceipt: Receipt, runReceipt: Receipt, runSaved: int, replaced: bool,
    live: bool, runs: int, pending: bool,
    phase: str, calls: int, latePosts: int, post: Post, removal: str, outcome: str,
    // Why this recovery removed the saved key ("none" while it did not), and what it told the renderer.
    keyRemoval: str, removedKey: int, removedLate: bool, revoked: bool, completed: int, expiredReports: int
  }
  var s: State

  pure val Matching = { present: true, parsed: true, environment: Production,
    credential: ServerCredential, expired: false }

  pure def initial(receipt: Receipt, saved: int): State = {
    environment: Production, saved: saved, initialSaved: saved,
    receipt: receipt, initialReceipt: receipt, runReceipt: NoReceipt, runSaved: 0,
    replaced: false, live: true, pending: false,
    runs: 0, phase: "idle", calls: 0, latePosts: 0, post: NoPost, removal: "none", outcome: "none",
    keyRemoval: "none", removedKey: 0, removedLate: false, revoked: false, completed: 0, expiredReports: 0
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
    s' = { ...s, live: true, runs: s.runs + 1, runReceipt: s.receipt, runSaved: s.saved,
      phase: "reading", calls: 0, latePosts: 0, post: NoPost, outcome: "none", pending: false }
  }

  pure def matches(s: State): bool =
    s.receipt.present and s.receipt.parsed and
      s.receipt.credential == s.saved and s.receipt.environment == s.environment

  // A current receipt marks the deployment as awaiting activation (status().activationPending).
  action readReply(readable: bool): bool = all {
    s.phase == "reading",
    s' = if (not(readable)) { ...s, phase: "finished", outcome: "kept" }
      else if (not(s.receipt.present)) { ...s, phase: "finished", outcome: "absent" }
      else if (not(s.receipt.parsed)) { ...s, phase: "finished", outcome: "kept" }
      else if (not(matches(s))) { ...s, phase: "remove-stale" }
      else if (s.receipt.expired) { ...s, phase: "send-late", pending: true }
      else { ...s, phase: "send", pending: true }
  }

  // Before the deadline: up to three requests. The Java loop sleeps between
  // calls and checks destruction before sending again. Each request carries
  // the receipt and key that this run read.
  action send = all {
    s.phase == "send", s.calls < 3,
    s' = if (s.live) { ...s, phase: "waiting", calls: s.calls + 1,
        post: { environment: s.environment, credential: s.runReceipt.credential, saved: s.runSaved, late: false } }
      else { ...s, phase: "finished", outcome: "kept" }
  }

  // After the deadline: the one request that tells a lost confirmation from a dead key.
  action sendLate = all {
    s.phase == "send-late", s.latePosts < 1,
    s' = if (s.live) { ...s, phase: "waiting-late", latePosts: 1,
        post: { environment: s.environment, credential: s.runReceipt.credential, saved: s.runSaved, late: true } }
      else { ...s, phase: "finished", outcome: "kept" }
  }

  action reply(kind: str): bool = all {
    s.phase == "waiting",
    s' = if (not(s.live)) { ...s, phase: "finished", outcome: "kept" }
      else if (kind.in(Set("acknowledged", "already-complete"))) { ...s, phase: "confirm" }
      else if (kind == "denied") { ...s, phase: "expire-refused" }
      else if (kind == "retryable" and s.calls < 3) { ...s, phase: "send" }
      // No answer that settles the key: the background rounds continue from here.
      else { ...s, phase: "finished", outcome: "handed-over" }
  }

  action replyLate(kind: str): bool = all {
    s.phase == "waiting-late",
    s' = if (not(s.live)) { ...s, phase: "finished", outcome: "kept" }
      else if (kind.in(Set("acknowledged", "already-complete"))) { ...s, phase: "confirm" }
      else { ...s, phase: "expire-deadline" }
  }

  action removeStale(removed: bool): bool = all {
    s.phase == "remove-stale", not(removed) or s.live,
    s' = if (removed) { ...s, receipt: NoReceipt, removal: "remove-stale", phase: "finished", outcome: "removed" }
      else { ...s, phase: "finished", outcome: "kept" }
  }

  // Cloud confirmed the key. Its receipt goes when it is still this run's, and
  // the sign-in is announced while that key is still the saved one.
  action confirm(removed: bool): bool = all {
    s.phase == "confirm", not(removed) or s.live,
    val own = s.receipt == s.runReceipt
    s' = { ...s, phase: "finished", pending: false,
      receipt: if (own and removed) NoReceipt else s.receipt,
      removal: if (own and removed) "remove-acknowledged" else s.removal,
      completed: s.completed + (if (s.live and s.saved == s.runSaved) 1 else 0),
      outcome: if (not(own)) "superseded" else if (removed) "confirmed" else "kept" }
  }

  // Cloud refused the key, or the deadline passed without a confirmation: the
  // key can never work. It is removed only while it is still the exact saved
  // key, its receipt only while it is still this run's; then it is revoked and
  // the owner is told. A newer sign-in's key and receipt are left alone.
  action expire = all {
    s.phase.in(Set("expire-refused", "expire-deadline")),
    val reason = if (s.phase == "expire-refused") "refused" else "unconfirmed-after-deadline"
    s' = if (not(s.live)) { ...s, phase: "finished", outcome: "kept" }
      else if (s.saved != s.runSaved or s.receipt != s.runReceipt)
        { ...s, phase: "finished", pending: false, outcome: "superseded" }
      else { ...s, phase: "finished", pending: false, saved: 0, receipt: NoReceipt,
        keyRemoval: reason, removedKey: s.runSaved, removedLate: s.runReceipt.expired,
        removal: "remove-expired", revoked: true,
        expiredReports: s.expiredReports + 1, outcome: "expired" }
  }

  // A newer sign-in commits its receipt and key on the sign-in worker. The
  // worker is free while the requests run and while a settlement waits for it.
  action replace = all {
    s.phase.in(Set("send", "waiting", "send-late", "waiting-late", "confirm", "expire-refused", "expire-deadline")),
    not(s.replaced),
    s' = { ...s, replaced: true, receipt: Newer, saved: ReplacementCredential }
  }

  action destroy = all {
    s.live,
    s' = { ...s, live: false }
  }

  action progress = any {
    readReply(true), readReply(false), send, sendLate,
    nondet kind = Set("acknowledged", "already-complete", "retryable",
      "wrong-credential", "denied", "unexpected-error").oneOf()
    any { reply(kind), replyLate(kind) },
    removeStale(true), removeStale(false), confirm(true), confirm(false), expire
  }

  action idle = s' = s
  action step = any { begin, progress, replace, destroy, idle }

  val RetryBudget = all {
    s.calls.in(0.to(3)), s.latePosts.in(0.to(1)), s.runs.in(0.to(2)),
    (s.phase == "waiting").implies(s.calls > 0),
    (s.phase == "send").implies(s.calls < 3),
    // A run asks before the deadline or once after it, never both.
    not(s.calls > 0 and s.latePosts > 0)
  }

  // Every request carries the receipt and key this run read, for this deployment;
  // a request after the deadline is sent only for an expired receipt, and only once.
  val AckUsesRunReceipt = (s.post != NoPost).implies(all {
    s.runReceipt.present, s.runReceipt.parsed,
    s.post.late == s.runReceipt.expired,
    s.post.environment == s.runReceipt.environment and s.post.environment == s.environment,
    s.post.credential == s.runReceipt.credential and s.post.credential == s.post.saved
  })

  // The saved key changes only by a newer sign-in, or because this recovery
  // removed a key Cloud refused or never confirmed.
  val SavedKeyRemovedOnlyWhenDead = all {
    s.saved == (if (s.keyRemoval != "none") 0
      else if (s.replaced) ReplacementCredential else s.initialSaved),
    (s.keyRemoval != "none").implies(all {
      s.revoked, s.expiredReports > 0,
      s.removedKey == (if (s.replaced) ReplacementCredential else s.initialSaved),
      (s.keyRemoval == "unconfirmed-after-deadline") == s.removedLate
    })
  }

  // A key that can never work is not left saved as a sign-in: an expired
  // outcome leaves neither the key nor its receipt.
  val DeadKeyNotLeftSaved = (s.outcome == "expired").implies(
    s.saved == 0 and not(s.receipt.present) and s.revoked)

  // A run that read the older receipt never removes the receipt or the key of the newer sign-in.
  val NewerSignInSurvives =
    (s.replaced and s.runReceipt != Newer).implies(s.receipt == Newer and s.saved == ReplacementCredential)

  val RemoveOnlyStaleAcknowledgedOrDead = all {
    (s.initialReceipt.present and not(s.receipt.present)).implies(
      s.removal.in(Set("remove-stale", "remove-acknowledged", "remove-expired"))),
    (s.removal == "remove-stale").implies(
      s.initialReceipt.credential != s.initialSaved or
        s.initialReceipt.environment != s.environment),
    (s.outcome == "kept").implies(
      s.receipt == s.runReceipt or (s.replaced and s.receipt == Newer))
  }

  // The renderer hears about a recovery at most once per settlement, and a
  // settled run no longer reports the deployment as awaiting activation.
  val ReportedOnce = all {
    s.completed.in(0.to(2)), s.expiredReports.in(0.to(1)),
    s.outcome.in(Set("confirmed", "expired", "superseded")).implies(not(s.pending))
  }

  val Running = not(s.phase.in(Set("idle", "finished")))
  temporal EachRunSettles = always((Running).implies(eventually(not(Running))))
  temporal UnderFairReplies = (progress.weakFair(s)).implies(EachRunSettles)

  action initMatching = s' = initial(Matching, ServerCredential)
  action initForeign = s' = initial({ ...Matching, environment: Staging }, ServerCredential)
  action initExpired = s' = initial({ ...Matching, expired: true }, ServerCredential)

  run retryThenConfirmTest = initMatching.then(begin).then(readReply(true))
    .then(send).then(reply("retryable")).then(send).then(reply("retryable"))
    .then(send).then(reply("already-complete")).then(confirm(true))
    .expect(s.calls == 3 and not(s.receipt.present) and s.saved == ServerCredential and s.completed == 1)

  run exhaustedBudgetHandsOverAndRestartConfirmsTest = initMatching.then(begin).then(readReply(true))
    .then(send).then(reply("retryable")).then(send).then(reply("retryable"))
    .then(send).then(reply("retryable"))
    .expect(s.outcome == "handed-over" and s.calls == 3 and s.receipt == Matching and s.pending)
    .then(begin).then(readReply(true)).then(send).then(reply("acknowledged"))
    .then(confirm(true)).expect(s.runs == 2 and not(s.receipt.present) and s.completed == 1)

  run refusedAtStartupRemovesTheDeadKeyTest = initMatching.then(begin).then(readReply(true))
    .then(send).then(reply("denied")).then(expire)
    .expect(s.outcome == "expired" and s.saved == 0 and not(s.receipt.present)
      and s.revoked and s.expiredReports == 1 and s.keyRemoval == "refused")

  run restartAfterDeadlineRemovesTheUnconfirmedKeyTest = initExpired.then(begin).then(readReply(true))
    .expect(s.phase == "send-late" and s.pending)
    .then(sendLate).then(replyLate("retryable")).then(expire)
    .expect(s.latePosts == 1 and s.calls == 0 and s.saved == 0 and not(s.receipt.present)
      and s.keyRemoval == "unconfirmed-after-deadline" and s.expiredReports == 1)

  run lostConfirmationAfterDeadlineKeepsTheKeyTest = initExpired.then(begin).then(readReply(true))
    .then(sendLate).then(replyLate("already-complete")).then(confirm(true))
    .expect(s.saved == ServerCredential and not(s.receipt.present) and s.completed == 1 and s.expiredReports == 0)

  run newerSignInKeepsItsKeyAndReceiptTest = initMatching.then(begin).then(readReply(true))
    .then(send).then(replace).then(reply("denied")).then(expire)
    .expect(s.outcome == "superseded" and s.receipt == Newer and s.saved == ReplacementCredential
      and s.expiredReports == 0)
    .then(begin).then(readReply(true)).then(send).then(reply("acknowledged"))
    .then(confirm(true)).expect(s.post.credential == ReplacementCredential and not(s.receipt.present))

  run foreignEnvironmentNeverPostsTest = initForeign.then(begin)
    .then(readReply(true)).then(removeStale(true))
    .expect(s.calls == 0 and s.latePosts == 0 and s.removal == "remove-stale" and s.saved == ServerCredential)

  run destructionStopsNextRetryTest = initMatching.then(begin).then(readReply(true))
    .then(send).then(reply("retryable")).then(destroy).then(send)
    .expect(s.calls == 1 and s.outcome == "kept" and s.receipt == Matching and s.saved == ServerCredential)
}
