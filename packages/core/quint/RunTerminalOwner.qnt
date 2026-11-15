// One run, one delivery-dependent task and two terminal event subscribers.
module RunTerminalOwner {
  // Inner emitEvent outcome. The task tracker reports rejection and resolves its request.
  type State = {
    delivery: str, work: str, outcome: str, knownReceipt: bool,
    capturedReceipt: bool, lateRefused: bool, handlers: int -> str,
    firstFailure: int, emitResult: str
  }
  pure val ids = Set(1, 2)
  var s: State
  action init = s' = {
    delivery: "held", work: "new", outcome: "none", knownReceipt: false,
    capturedReceipt: false, lateRefused: false, handlers: ids.mapBy(_ => "new"),
    firstFailure: 0, emitResult: "none"
  }

  action observeReceipt = all { not(s.knownReceipt), s' = { ...s, knownReceipt: true } }
  action admitWork = all {
    s.outcome == "none", s.work == "new", s' = { ...s, work: "waiting" }
  }
  action finishDelivery(saved: bool): bool = all {
    s.delivery == "held", s' = { ...s, delivery: if (saved) "saved" else "failed" }
  }
  action finishWork = all {
    s.work == "waiting", s.delivery != "held",
    s' = { ...s, work: if (s.delivery == "saved") "ran" else "skipped" }
  }
  action request(status: str): bool = all {
    s.outcome == "none", s' = { ...s, outcome: status, capturedReceipt: s.knownReceipt }
  }
  action refuseLate = all {
    s.outcome != "none", not(s.lateRefused), s' = { ...s, lateRefused: true }
  }
  action emit = all {
    s.outcome != "none", s.work != "waiting", s.handlers.get(1) == "new",
    s' = { ...s, handlers: ids.mapBy(_ => "waiting") }
  }
  action settle(id: int, ok: bool): bool = all {
    s.handlers.get(id) == "waiting",
    s' = {
      ...s,
      handlers: s.handlers.set(id, if (ok) "fulfilled" else "rejected"),
      firstFailure: if (not(ok) and s.firstFailure == 0) id else s.firstFailure
    }
  }
  action returnTerminal = all {
    s.emitResult == "none", ids.forall(id => Set("fulfilled", "rejected").contains(s.handlers.get(id))),
    s' = { ...s, emitResult: if (s.firstFailure == 0) "completed" else "failed" }
  }
  action settleDelivery = any { finishDelivery(true), finishDelivery(false) }
  action settleHandler(id: int): bool = any { settle(id, true), settle(id, false) }
  action step = any {
    observeReceipt, admitWork, settleDelivery, finishWork,
    request("completed"), request("failed"), refuseLate, emit,
    settleHandler(1), settleHandler(2), returnTerminal, s' = s
  }

  val WaitsForOwnedWork = s.handlers.get(1) != "new" implies s.work != "waiting"
  val FailedDeliveryDoesNotRun = s.delivery == "failed" implies s.work != "ran"
  val JoinsEverySubscriber = s.emitResult != "none" implies
    ids.forall(id => Set("fulfilled", "rejected").contains(s.handlers.get(id)))
  val ReportsFirstFailure = and {
    s.firstFailure != 0 implies s.handlers.get(s.firstFailure) == "rejected",
    (s.emitResult == "failed") == (s.emitResult != "none" and s.firstFailure != 0)
  }
  temporal FirstRequestAndFailureStay = always(and {
    s.outcome != "none" implies and {
      next(s.outcome) == s.outcome, next(s.capturedReceipt) == s.capturedReceipt,
      s.work == "new" implies next(s.work) == "new"
    },
    s.firstFailure != 0 implies next(s.firstFailure) == s.firstFailure
  }.orKeep(s))
  temporal TerminalReturns = (s.outcome != "none").leadsTo(s.emitResult != "none")
  temporal Fairness = and {
    settleDelivery.weakFair(s), finishWork.weakFair(s), emit.weakFair(s),
    settleHandler(1).weakFair(s), settleHandler(2).weakFair(s), returnTerminal.weakFair(s)
  }
  temporal FairTerminalReturns = Fairness implies TerminalReturns

  run rejectingSiblingWaitsTest = init.then(request("completed")).then(emit)
    .then(settle(1, false)).expect(s.emitResult == "none")
    .then(settle(2, true)).then(returnTerminal)
    .expect(s.firstFailure == 1 and s.emitResult == "failed")
  run firstObservedFailureStaysTest = init.then(request("completed")).then(emit)
    .then(settle(2, false)).then(settle(1, false)).then(returnTerminal)
    .expect(s.firstFailure == 2 and s.emitResult == "failed")
  run failedDeliveryRetainsReceiptTest = init.then(observeReceipt).then(admitWork)
    .then(request("failed")).then(refuseLate).then(finishDelivery(false)).then(finishWork)
    .then(emit).then(settle(1, true)).then(settle(2, true)).then(returnTerminal)
    .expect(s.capturedReceipt and s.lateRefused and s.work == "skipped")
}
