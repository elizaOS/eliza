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

// A SharedRuntimeConversation releases its request queue when it returns a
// prewarm response. The body keeps the specific warmup's outcome, independently
// of the queue and of the other response bodies.
module SharedDeferredPrewarm {
  pure val BodyIds = Set(1, 2, 3, 4)
  pure val Generations = Set(1, 2)
  pure val OrderedHistory = List("earlier question", "earlier answer")
  type Body = { generation: int, phase: str }
  type State = {
    admitted: int, attempts: int, active: int, ready: bool,
    outcomes: int -> str, bodies: int -> Body, historyReply: List[str],
  }

  var s: State

  action init = s' = {
    admitted: 0, attempts: 0, active: 0, ready: false,
    outcomes: Generations.union(Set(0)).mapBy(_ => "unused"),
    bodies: BodyIds.mapBy(_ => { generation: 0, phase: "new" }),
    historyReply: List(),
  }

  // Headers with an incomplete body release the queue immediately. A second
  // caller joins the first attempt while its module load is held. A third
  // caller can reuse readiness or start the bounded fresh retry.
  action openBody(id: int): bool = {
    val starts = s.active == 0 and not(s.ready)
    val generation = if (starts) s.attempts + 1 else s.attempts
    all {
      id == s.admitted + 1,
      starts implies s.attempts < 2,
      if (id == 2) s.active == 1
      else if (id == 3) s.active == 0 and Set(1, 2).forall(i => s.bodies.get(i).phase != "pending")
      else if (id == 4) s.ready and s.attempts == 2 and s.bodies.get(3).phase == "success"
      else true,
      s' = {
        ...s, admitted: id, attempts: generation,
        active: if (starts) generation else s.active,
        outcomes: if (starts) s.outcomes.set(generation, "pending") else s.outcomes,
        bodies: s.bodies.set(id, { generation: generation, phase: "pending" }),
      },
    }
  }

  val initialBodiesPending = Set(1, 2).forall(id => s.bodies.get(id).phase == "pending")

  // The module gate is after hydration. A room request can read the real
  // history while both prewarm bodies are still waiting for module readiness.
  action readHistory = all {
    s.active == 1 and initialBodiesPending and s.historyReply == List(),
    s' = { ...s, historyReply: OrderedHistory },
  }

  action cancelFirstBody = all {
    s.active == 1 and initialBodiesPending,
    s' = { ...s, bodies: s.bodies.set(1, { generation: 1, phase: "canceled" }) },
  }

  // The settled promise clears the active slot. Each body still observes the
  // generation it captured, including a failure before the room was ready.
  action finishWarmup(success: bool): bool = all {
    s.active != 0,
    s.active == 2 implies success,
    s' = {
      ...s, active: 0, ready: success,
      outcomes: s.outcomes.set(s.active, if (success) "success" else "failed"),
    },
  }

  action publishBody(id: int): bool = {
    val body = s.bodies.get(id)
    val outcome = s.outcomes.get(body.generation)
    all {
      body.phase == "pending",
      Set("success", "failed").contains(outcome),
      s' = { ...s, bodies: s.bodies.set(id, { ...body, phase: outcome }) },
    }
  }

  action settleWarmup = any { finishWarmup(true), finishWarmup(false) }

  action step = any {
    { nondet id = BodyIds.oneOf() openBody(id) },
    { nondet id = BodyIds.oneOf() publishBody(id) },
    readHistory, cancelFirstBody, settleWarmup, s' = s,
  }

  val OneWarmupOwner = Generations.forall(generation =>
    (s.outcomes.get(generation) == "pending") == (s.active == generation)
  )

  val SharedGenerationAndFreshRetry = and {
    s.admitted >= 2 implies s.bodies.get(2).generation == s.bodies.get(1).generation,
    s.attempts == 2 implies s.outcomes.get(1) == "failed" and s.bodies.get(3).generation == 2,
    s.admitted == 4 implies s.ready and s.bodies.get(4).generation == 2,
  }

  val BodyCompletionUsesItsWarmup = BodyIds.forall(id => {
    val body = s.bodies.get(id)
    Set("success", "failed").contains(body.phase) implies
      s.outcomes.get(body.generation) == body.phase
  })

  temporal CancelDoesNotSettleWarmup = always((
    s.bodies.get(1).phase != "canceled" and next(s.bodies.get(1).phase) == "canceled"
      implies next(s.active) == s.active and next(s.outcomes) == s.outcomes
        and next(s.bodies.get(2)) == s.bodies.get(2)
  ).orKeep(s))

  temporal HistoryReadDoesNotConsumeBodies = always((
    next(s.historyReply) != s.historyReply implies initialBodiesPending
      and next(s.historyReply) == OrderedHistory and next(s.bodies) == s.bodies
      and next(s.active) == s.active
  ).orKeep(s))

  temporal EveryPrewarmBodySettles = BodyIds.forall(id =>
    (s.bodies.get(id).phase == "pending").leadsTo(s.bodies.get(id).phase != "pending")
  )

  temporal FairWarmupAndBodiesSettle = (
    settleWarmup.weakFair(s) and BodyIds.forall(id => publishBody(id).weakFair(s))
  ) implies EveryPrewarmBodySettles

  run CanceledBodyLeavesPeerAndRoomLiveTest = init
    .then(openBody(1)).then(openBody(2)).then(readHistory)
    .expect(initialBodiesPending and s.historyReply == OrderedHistory and s.attempts == 1)
    .then(cancelFirstBody).expect(s.active == 1 and s.bodies.get(2).phase == "pending")
    .then(finishWarmup(true)).then(publishBody(2))
    .expect(s.bodies.get(1).phase == "canceled" and s.bodies.get(2).phase == "success")

  run FailedBodiesRetryAndReuseReadinessTest = init
    .then(openBody(1)).then(openBody(2)).then(finishWarmup(false))
    .then(publishBody(1)).then(publishBody(2))
    .expect(s.bodies.get(1).phase == "failed" and s.bodies.get(2).phase == "failed")
    .then(openBody(3)).expect(s.active == 2 and SharedGenerationAndFreshRetry)
    .then(finishWarmup(true)).then(publishBody(3)).then(openBody(4)).then(publishBody(4))
    .expect(s.attempts == 2 and s.bodies.get(4).phase == "success" and BodyCompletionUsesItsWarmup)
}
