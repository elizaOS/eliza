// One admitted chat SDK stream. The first terminal callback owns the cached
// settlement promise, including its failure result.
module ChatSdkStreamSettlement {
  type State = {
    webSearch: bool, delivered: bool, searchFailed: bool,
    phase: str, callback: str, caller: str, reportedUsage: str, unaccepted: bool,
    selected: str, accounting: str, factories: int
  }

  pure val Usage = Set("missing", "zero", "positive")
  pure val Callbacks = Set("finish", "abort", "provider_error")
  pure val Callers = Set("sdk", "stream_backstop")

  var s: State
  action initialize(webSearch: bool): bool = s' = {
    webSearch: webSearch, delivered: false, searchFailed: false,
    phase: "streaming", callback: "none", caller: "none", reportedUsage: "missing",
    unaccepted: false, selected: "none", accounting: "none", factories: 0
  }
  action init = any { initialize(true), initialize(false) }

  action deliverOutput = all {
    s.phase == "streaming" and not(s.delivered),
    s' = s.with("delivered", true)
  }

  action observeFailedSearch = all {
    s.phase == "streaming" and s.webSearch and not(s.searchFailed),
    s' = s.with("searchFailed", true).with("delivered", true)
  }

  action terminal(callback: str, caller: str, usage: str, unaccepted: bool): bool = {
    val choice = if (callback == "finish") (if (usage == "missing") "unknown" else "actual")
      else if (callback == "abort") (if (s.webSearch) "unknown" else "partial")
      else if (unaccepted and not(s.delivered)) "zero"
      else "unknown"
    s' = if (s.phase != "streaming") s else
      s.with("phase", "claimed").with("callback", callback).with("caller", caller)
        .with("reportedUsage", usage).with("unaccepted", unaccepted)
        .with("selected", choice).with("accounting", choice).with("factories", s.factories + 1)
  }

  // Pricing may fail before the winning callback reaches its accounting port.
  action pricingFailure = all {
    s.phase == "claimed" and Set("actual", "partial").contains(s.accounting),
    s' = s.with("accounting", "unknown")
  }

  action startAccounting = all {
    s.phase == "claimed",
    s' = s.with("phase", "settling")
  }

  action settleReply(success: bool): bool = all {
    s.phase == "settling",
    s' = s.with("phase", if (success) "fulfilled" else "rejected")
  }

  action accountingWork = any { pricingFailure, startAccounting, settleReply(true), settleReply(false) }
  action wait = s' = s

  action step = any {
    deliverOutput, observeFailedSearch, accountingWork, wait,
    {
      nondet callback = Callbacks.oneOf()
      nondet caller = Callers.oneOf()
      nondet usage = Usage.oneOf()
      nondet unaccepted = Set(true, false).oneOf()
      all {
        caller == "sdk" or callback != "finish",
        terminal(callback, caller, usage, unaccepted)
      }
    }
  }

  val Safety = and {
    (s.phase == "streaming") == (s.factories == 0),
    s.factories <= 1,
    s.accounting == "zero" implies (s.callback == "provider_error" and s.unaccepted and not(s.delivered)),
    (s.callback == "finish" and s.reportedUsage == "missing") implies s.selected == "unknown",
    (s.callback == "finish" and s.reportedUsage == "zero") implies s.selected == "actual",
    (s.callback == "abort" and s.webSearch) implies s.accounting == "unknown",
    s.searchFailed implies (s.webSearch and s.delivered)
  }

  temporal SettlementOwnership = always((all {
    (s.factories == 1) implies all {
      next(s.factories) == s.factories,
      next(s.callback) == s.callback,
      next(s.caller) == s.caller,
      next(s.selected) == s.selected
    },
    Set("fulfilled", "rejected").contains(s.phase) implies next(s.phase) == s.phase
  }).orKeep(s))

  temporal SettlementReturns = Set("claimed", "settling").contains(s.phase)
    .leadsTo(Set("fulfilled", "rejected").contains(s.phase))
  temporal FairSettlement = accountingWork.weakFair(s) implies SettlementReturns

  run failedSearchAbortKeepsUnknownTest = initialize(true).then(observeFailedSearch)
    .then(terminal("abort", "sdk", "missing", false))
    .then(terminal("provider_error", "stream_backstop", "missing", true))
    .then(startAccounting).then(settleReply(true))
    .expect(s.callback == "abort" and s.accounting == "unknown" and s.factories == 1)

  run verifiedRejectionBeforeOutputReleasesTest = initialize(false)
    .then(terminal("provider_error", "sdk", "missing", true))
    .expect(s.accounting == "zero")

  run rejectionAfterOutputKeepsUnknownTest = initialize(false).then(deliverOutput)
    .then(terminal("provider_error", "stream_backstop", "missing", true))
    .expect(s.accounting == "unknown")

  run explicitZeroUsageIsReportedTest = initialize(false)
    .then(terminal("finish", "sdk", "zero", false))
    .expect(s.selected == "actual")

  run missingUsageKeepsEstimateTest = initialize(false).then(deliverOutput)
    .then(terminal("finish", "sdk", "missing", false))
    .expect(s.accounting == "unknown")

  run ordinaryAbortAttemptsPartialPricingTest = initialize(false).then(deliverOutput)
    .then(terminal("abort", "sdk", "missing", false)).expect(s.accounting == "partial")
    .then(pricingFailure).expect(s.accounting == "unknown" and s.selected == "partial")

  run rejectedAccountingPromiseRetainsOriginalOwnerTest = initialize(false)
    .then(terminal("finish", "sdk", "positive", false)).then(startAccounting)
    .then(settleReply(false)).then(terminal("abort", "stream_backstop", "missing", false))
    .expect(s.phase == "rejected" and s.callback == "finish" and s.factories == 1)
}
