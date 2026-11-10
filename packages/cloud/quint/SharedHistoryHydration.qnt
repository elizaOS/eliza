// One serialized Shared room admits a reader while its background history
// lookup may outlive the caller's warming deadline.
module SharedHistoryHydration {
  pure val CompleteHistory = List("earlier question", "earlier answer")
  var s: {
    load: str, requests: int, replies: int, served: int,
    attempts: int, history: List[str]
  }

  action init = s' = {
    load: "empty", requests: 0, replies: 0, served: 0,
    attempts: 0, history: List()
  }
  val waiting = s.requests != s.replies
  action admit = all {
    not(waiting), s.requests < 3,
    s.load != "empty" or s.attempts < 2,
    s' = if (s.load == "ready")
      { ...s, requests: s.requests + 1, replies: s.replies + 1, served: s.served + 1 }
    else if (s.load == "reading") s.with("requests", s.requests + 1)
    else { ...s, load: "reading", requests: s.requests + 1, attempts: s.attempts + 1 }
  }
  action loadReply(success: bool): bool = all {
    s.load == "reading",
    s' = if (success) s.with("load", "ready").with("history", CompleteHistory)
      else s.with("load", "empty")
  }
  action reply = all {
    waiting, s.load != "reading",
    s' = { ...s, replies: s.replies + 1,
      served: s.served + (if (s.load == "ready") 1 else 0) }
  }
  action warmingDeadline = all {
    waiting, s.load == "reading",
    s' = s.with("replies", s.replies + 1)
  }
  action settleLoad = any { loadReply(true), loadReply(false) }
  action settleRequest = any { reply, warmingDeadline }
  action step = any { admit, settleLoad, settleRequest, s' = s }

  val OneWaitingRequest = and {
    s.replies <= s.requests, s.requests <= s.replies + 1,
    s.served <= s.replies, s.attempts <= 2, s.requests <= 3
  }
  val ReadyRetainsHistory = and {
    (s.load == "ready") == (s.history == CompleteHistory),
    s.served > 0 implies s.history == CompleteHistory
  }
  temporal DeadlineKeepsLookup = always((
    (s.load == "reading" and next(s.replies) > s.replies)
      implies (next(s.load) == "reading" and next(s.attempts) == s.attempts)
  ).orKeep(s))
  temporal RequestReturns = waiting.leadsTo(not(waiting))
  temporal FairRequestReturns = settleRequest.weakFair(s) implies RequestReturns
  temporal FairLookupReturns = settleLoad.weakFair(s) implies
    (s.load == "reading").leadsTo(s.load != "reading")

  run ColdReaderJoinsLookupTest = init.then(admit).then(loadReply(true)).then(reply)
    .expect(s.served == 1 and s.attempts == 1 and ReadyRetainsHistory)
  run DeadlineDoesNotCancelLookupTest = init.then(admit).then(warmingDeadline)
    .then(admit).then(loadReply(true)).then(reply)
    .expect(s.served == 1 and s.replies == 2 and s.attempts == 1)
  run FailedLookupCanRetryTest = init.then(admit).then(loadReply(false)).then(reply)
    .then(admit).then(loadReply(true)).then(reply).then(admit)
    .expect(s.served == 2 and s.attempts == 2 and ReadyRetainsHistory)
}
