// Scheduler admission, asynchronous provider completion and task-row ownership.
// Two complete evidence pages and two task generations; one retry and one
// shutdown/reopen exercise the distinct lifecycle transitions.
module BackgroundMemoryDeferredPage {
  pure val Pages = Set(1, 2)
  pure val Keys = Set(1, 2, 3, 4)
  pure def key(revision: int, page: int): int = revision * 2 + page
  type Job = {
    task: str, revision: int, blocked: Set[int], status: int -> str,
    purchases: int -> int, terminalPurchases: int -> int,
    running: int, attemptRevision: int, retryUsed: bool,
    revised: bool, cancelled: bool, shutdown: bool, reopened: bool,
    staleWrites: int, backoff: bool
  }
  var s: Job

  action init = s' = {
    task: "live", revision: 0, blocked: Set(),
    status: Pages.mapBy(_ => "pending"), purchases: Keys.mapBy(_ => 0),
    terminalPurchases: Keys.mapBy(_ => 0), running: 0, attemptRevision: 0,
    retryUsed: false, revised: false, cancelled: false,
    shutdown: false, reopened: false, staleWrites: 0, backoff: false
  }
  pure def pick(state: Job): int =
    if (state.task != "live") 0
    else if (state.status.get(1) == "pending" and not(state.blocked.contains(1))) 1
    else if (state.status.get(2) == "pending" and not(state.blocked.contains(2))) 2
    else 0
  pure def owns(state: Job): bool =
    state.task == "live" and state.attemptRevision == state.revision

  action start = all {
    s.running == 0, not(s.shutdown), not(s.backoff), pick(s) != 0,
    {
      val p = pick(s)
      val k = key(s.revision, p)
      s' = { ...s, running: p, attemptRevision: s.revision,
        purchases: s.purchases.set(k, s.purchases.get(k) + 1) }
    }
  }
  action finish(failed: bool, wait: bool): bool = all {
    s.running != 0, not(s.shutdown),
    if (not(owns(s))) s' = { ...s, running: 0 }
    else {
      val p = s.running
      val k = key(s.revision, p)
      val other = Pages.exists(q => q != p and s.status.get(q) == "pending")
      s' = { ...s, running: 0,
        task: if (other) "live" else "done", backoff: wait and other,
        blocked: if (failed) s.blocked.union(Set(p)) else s.blocked,
        status: s.status.set(p, if (failed) "failed" else "done"),
        terminalPurchases: s.terminalPurchases.set(k, s.terminalPurchases.get(k) + 1) }
    }
  }
  action failPage = finish(true, false)
  action succeedPage = finish(false, false)
  // A second evaluator failed retryably in the same run. The selected page
  // still gains its non-retryable block before scheduler backoff.
  action mixedFailure = all { s.running == 1, finish(true, true) }
  action retryPage = all {
    s.running != 0, not(s.shutdown), not(s.retryUsed),
    s' = { ...s, running: 0, retryUsed: true, backoff: true }
  }
  action wakeBackoff = all { s.backoff, s' = { ...s, backoff: false } }
  // Reconciliation changes the admitted evidence identity and owns its own
  // metadata. An old call can return, but cannot write this generation's row.
  action reviseTask = all {
    s.task == "live", s.revision == 0, not(s.revised),
    s' = { ...s, revision: 1, revised: true, blocked: Set(),
      status: Pages.mapBy(_ => "pending") }
  }
  action cancelTask = all {
    s.task == "live", not(s.cancelled),
    s' = { ...s, task: "cancelled", cancelled: true }
  }
  // Recreating the same deterministic task id gets a fresh generation token.
  action replaceCancelled = all {
    s.task == "cancelled", s.revision == 0,
    s' = { ...s, task: "live", revision: 1, blocked: Set(), backoff: false,
      status: Pages.mapBy(_ => "pending") }
  }
  action closeAdmissions = all {
    not(s.shutdown), not(s.reopened), s' = { ...s, shutdown: true }
  }
  action reopen = all { s.shutdown, s' = { ...s, shutdown: false, reopened: true } }
  action abortClosed = all { s.shutdown, s.running != 0, s' = { ...s, running: 0 } }
  action settle = any { failPage, succeedPage, mixedFailure, retryPage, abortClosed }
  action stutter = s' = s
  action step = any { start, settle, reviseTask, cancelTask, replaceCancelled,
    closeAdmissions, reopen, wakeBackoff, stutter }

  val TypeOK = all {
    s.task.in(Set("live", "done", "cancelled")), s.revision.in(Set(0, 1)),
    s.attemptRevision.in(Set(0, 1)), s.running.in(Set(0, 1, 2)),
    s.blocked.subseteq(Pages), s.status.keys() == Pages,
    s.purchases.keys() == Keys, s.terminalPurchases.keys() == Keys,
    Pages.forall(p => s.status.get(p).in(Set("pending", "failed", "done")))
  }
  val AtMostOneTerminalPurchase = Keys.forall(k => s.terminalPurchases.get(k) <= 1)
  val PendingPageKeepsTask = s.task == "done" implies
    not(Pages.exists(p => s.status.get(p) == "pending"))
  val BlockedPageIsFailed = Pages.forall(p =>
    s.blocked.contains(p) implies s.status.get(p) == "failed")
  val NoBlockedReadmission = s.running != 0 and owns(s) implies
    not(s.blocked.contains(s.running))
  val NoStaleTaskWrites = s.staleWrites == 0
  temporal Fairness = start.weakFair(s) and settle.weakFair(s) and reopen.weakFair(s) and wakeBackoff.weakFair(s)
  temporal PagesSettle = Fairness.implies(Pages.forall(p =>
    (s.task == "live" and s.status.get(p) == "pending").leadsTo(
      s.task != "live" or s.status.get(p) != "pending")))
  temporal TaskFinishes = Fairness.implies(
    (s.task == "live").leadsTo(s.task.in(Set("done", "cancelled"))))
  temporal TaskFinishesWithoutFairness =
    (s.task == "live").leadsTo(s.task.in(Set("done", "cancelled")))

  action legacyDropDeferred = all { s.running == 1,
    s' = { ...s, task: "done", running: 0, status: s.status.set(1, "failed") } }
  action legacyWriteReplacement = all { s.running != 0, not(owns(s)),
    s' = { ...s, staleWrites: s.staleWrites + 1 } }

  run deferredPageSurvivesOutputLimitTest = init.then(start).then(failPage)
    .expect(s.task == "live" and s.blocked == Set(1))
    .then(start).then(failPage).expect(s.task == "done" and AtMostOneTerminalPurchase)
  run retryKeepsBlockedEvidenceTest = init.then(start).then(failPage)
    .then(start).then(retryPage).expect(s.blocked == Set(1) and s.task == "live")
    .then(wakeBackoff).then(start).then(succeedPage).expect(s.task == "done" and AtMostOneTerminalPurchase)
  run mixedFailureKeepsBlockedEvidenceTest = init.then(start).then(mixedFailure)
    .expect(s.blocked == Set(1) and s.backoff and s.task == "live")
    .then(wakeBackoff).then(start).then(succeedPage).expect(s.task == "done")
  run revisedTaskRejectsOldCompletionTest = init.then(start).then(reviseTask)
    .then(failPage).expect(s.task == "live" and s.blocked == Set() and NoStaleTaskWrites)
  run cancelledTaskIsNotRecreatedTest = init.then(start).then(cancelTask)
    .then(failPage).expect(s.task == "cancelled" and s.blocked == Set())
  run replacementRejectsOldCompletionTest = init.then(start).then(cancelTask)
    .then(replaceCancelled).then(failPage)
    .expect(s.task == "live" and s.revision == 1 and s.blocked == Set())
  run shutdownDoesNotConsumeEvidenceTest = init.then(start).then(closeAdmissions)
    .then(abortClosed).expect(s.task == "live" and s.status.get(1) == "pending")
    .then(reopen).then(start).then(failPage).expect(s.blocked == Set(1))
  run legacyDropLosesDeferredPageTest = init.then(start).then(legacyDropDeferred)
    .expect(not(PendingPageKeepsTask))
  run legacyReplacementWriteFailsTest = init.then(start).then(cancelTask)
    .then(replaceCancelled).then(legacyWriteReplacement).expect(not(NoStaleTaskWrites))
}
