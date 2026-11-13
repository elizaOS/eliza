// Background memory admits one shared evidence page per run. A page that
// stops at the output limit is not bought again. A different deferred page
// still runs. The job ends when no pending page remains.
module BackgroundMemoryDeferredPage {
  pure val Pages = Set(1, 2)

  var s: {
    task: str,
    blocked: Set[int],
    calls: int -> int,
    status: int -> str
  }

  action init = s' = {
    task: "live",
    blocked: Set(),
    calls: Pages.mapBy(_ => 0),
    status: Pages.mapBy(_ => "pending")
  }

  pure def pick(state: {
    task: str,
    blocked: Set[int],
    calls: int -> int,
    status: int -> str
  }): int =
    if (state.task != "live") 0
    else if (state.status.get(1) == "pending" and not(state.blocked.contains(1))) 1
    else if (state.status.get(2) == "pending" and not(state.blocked.contains(2))) 2
    else 0

  action failPage(p: int): bool = all {
    pick(s) == p,
    s.calls.get(p) == 0,
    {
      val other = Pages.exists(q => q != p and s.status.get(q) == "pending")
      s' = {
        ...s,
        task: if (other) "live" else "done",
        blocked: s.blocked.union(Set(p)),
        calls: s.calls.set(p, 1),
        status: s.status.set(p, "failed")
      }
    }
  }

  action succeedPage(p: int): bool = all {
    pick(s) == p,
    s.calls.get(p) == 0,
    {
      val other = Pages.exists(q => q != p and s.status.get(q) == "pending")
      s' = {
        ...s,
        task: if (other) "live" else "done",
        calls: s.calls.set(p, 1),
        status: s.status.set(p, "done")
      }
    }
  }

  // The rejected repair kept the job but selected the same failed page again.
  action repurchaseFailedPage: bool = all {
    s.blocked.contains(1),
    s' = { ...s, calls: s.calls.set(1, s.calls.get(1) + 1) }
  }

  // The previous worker deleted the job while another page was still pending.
  action legacyDropDeferred: bool = all {
    pick(s) == 1,
    s.status.get(2) == "pending",
    s' = {
      ...s,
      task: "done",
      calls: s.calls.set(1, 1),
      status: s.status.set(1, "failed")
    }
  }

  action stutter = s' = s

  action step = any {
    failPage(1), failPage(2), succeedPage(1), succeedPage(2), stutter
  }

  val TypeOK = all {
    s.task.in(Set("live", "done")),
    s.blocked.subseteq(Pages),
    s.calls.keys() == Pages,
    s.status.keys() == Pages,
    Pages.forall(p =>
      s.calls.get(p).in(Set(0, 1)) and
      s.status.get(p).in(Set("pending", "failed", "done")))
  }
  val AtMostOnePurchase = Pages.forall(p => s.calls.get(p) <= 1)
  val PendingPageKeepsTask =
    Pages.exists(p => s.status.get(p) == "pending") implies s.task == "live"
  val BlockedPageIsFailed =
    Pages.forall(p =>
      s.blocked.contains(p) implies
      s.status.get(p) == "failed" and s.calls.get(p) == 1)

  temporal Fairness =
    failPage(1).weakFair(s) and failPage(2).weakFair(s) and
    succeedPage(1).weakFair(s) and succeedPage(2).weakFair(s)
  temporal PagesSettle = Fairness.implies(
    Pages.forall(p =>
      (s.status.get(p) == "pending").leadsTo(s.status.get(p) != "pending")))
  temporal TaskFinishes =
    Fairness.implies((s.task == "live").leadsTo(s.task == "done"))
  temporal TaskFinishesWithoutFairness =
    (s.task == "live").leadsTo(s.task == "done")

  run deferredPageSurvivesOutputLimitTest =
    init.then(failPage(1))
      .expect(s.task == "live" and s.blocked == Set(1) and s.status.get(2) == "pending")
      .then(failPage(2))
      .expect(s.task == "done" and s.calls.get(1) == 1 and s.calls.get(2) == 1
        and AtMostOnePurchase and PendingPageKeepsTask)
  run successThenDeferredPageTest =
    init.then(succeedPage(1))
      .expect(s.task == "live" and s.status.get(1) == "done" and s.status.get(2) == "pending")
      .then(failPage(2))
      .expect(s.task == "done" and PendingPageKeepsTask and BlockedPageIsFailed)
  run legacyDropLosesDeferredPageTest =
    init.then(legacyDropDeferred).expect(not(PendingPageKeepsTask))
  run repurchaseExceedsOneCallTest =
    init.then(failPage(1)).then(repurchaseFailedPage).expect(not(AtMostOnePurchase))
}
