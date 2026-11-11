// Android code and MFA verification from an issued code to the mobile grant boundary.
// The worker owns a retry reply after it has detached the bridge waiter.
// A retry reply follows a wrong code or a request that got no answer.
module NativeAndroidCodeVerification {
  pure val rpcIds = 1.to(12)
  pure val codeLanes = Set("email", "phone")
  pure val factorLanes = Set("totp", "sms", "passkey")
  type Work = { owner: int, rpc: int, stage: str }
  pure val noWork: Work = { owner: 0, rpc: 0, stage: "idle" }
  type State = {
    generation: int, channel: str, factor: str, sending: bool, expired: bool, failed: int,
    issued: int, waiter: int, work: Work, replies: int -> int,
  }
  var s: State

  action init = s' = {
    generation: 0, channel: "idle", factor: "none", sending: false, expired: false, failed: 0,
    issued: 0, waiter: 0, work: noWork, replies: rpcIds.mapBy(_ => 0),
  }
  pure def reply(x: State, rpc: int): State =
    { ...x, replies: x.replies.set(rpc, x.replies.get(rpc) + 1) }
  pure def retire(x: State): State =
    { ...x, channel: "idle", factor: "none", sending: false, expired: false, failed: 0, waiter: 0 }
  pure def ownsWork(x: State): bool =
    x.work.rpc != 0 and x.work.rpc == x.waiter and x.work.owner == x.generation

  // The bridge can admit the next send while canceled work drains. Its code
  // can only become ready after the single worker has finished prior work.
  action startCode(kind: str): bool = all {
    s.generation < 2, s.waiter == 0, not(s.sending), codeLanes.contains(kind),
    s' = { ...s, generation: s.generation + 1, channel: kind, factor: "none",
      sending: true, expired: false, failed: 0 },
  }
  action codeSent = all {
    s.sending, s.work == noWork,
    s' = { ...s, sending: false },
  }
  action expire = all {
    s.channel != "idle", not(s.sending), not(s.expired),
    s' = { ...s, expired: true },
  }
  action verify(attempt: int, kind: str): bool = {
    val ownsAttempt = s.channel != "idle" and attempt == s.generation and s.waiter == 0 and not(s.sending)
    val correctChannel = kind == "factor" or s.channel == kind
    val correctStep = if (kind == "factor") Set("totp", "sms").contains(s.factor) else s.factor == "none"
    s' = if (not(ownsAttempt and correctChannel)) s
      else if (s.expired) retire(s)
      else if (correctStep and s.issued < 12)
        { ...s, issued: s.issued + 1, waiter: s.issued + 1 }
      else s
  }
  action cancel(request: int): bool =
    s' = if (s.channel == "idle" or (request != 0 and request != s.generation)) s
      else if (s.waiter == 0) retire(s) else retire(reply(s, s.waiter))

  action startWork = all {
    s.work == noWork, s.waiter != 0,
    s' = { ...s, work: { owner: s.generation, rpc: s.waiter, stage: "checking" } },
  }
  action wrongCode = all {
    s.work.stage == "checking", ownsWork(s),
    if (s.failed == 4) s' = retire(reply({ ...s, work: noWork }, s.waiter))
    else s' = { ...s, failed: s.failed + 1, waiter: 0,
      work: { ...s.work, stage: "invalid-reply" } },
  }
  // The request got no answer, so the code can still be correct.
  // The step stays for a retry and the wrong-code budget does not change.
  action noAnswer = all {
    s.work.stage == "checking", ownsWork(s),
    s' = { ...s, waiter: 0, work: { ...s.work, stage: "invalid-reply" } },
  }
  action deliverWrongCode = all {
    s.work.stage == "invalid-reply",
    s' = reply({ ...s, work: noWork }, s.work.rpc),
  }
  action requireFactor(factor: str): bool = all {
    s.work.stage == "checking", ownsWork(s), s.factor == "none",
    factorLanes.contains(factor),
    s' = reply({ ...s, work: noWork, factor: factor, failed: 0, waiter: 0 }, s.waiter),
  }
  action handoffGrant = all {
    s.work.stage == "checking", ownsWork(s), not(s.expired),
    s' = { ...s, work: { ...s.work, stage: "grant" } },
  }
  // Answered failure, rejection, grant completion, or drainage after cancellation.
  action finishTerminal = all {
    Set("checking", "grant").contains(s.work.stage),
    s' = if (ownsWork(s)) retire(reply({ ...s, work: noWork }, s.waiter))
      else { ...s, work: noWork },
  }
  action finishWork = any {
    wrongCode, noAnswer, deliverWrongCode, handoffGrant, finishTerminal,
    { nondet factor = factorLanes.oneOf() requireFactor(factor) },
  }
  action step = any {
    codeSent, expire, startWork, finishWork, s' = s,
    { nondet kind = codeLanes.oneOf() startCode(kind) },
    { nondet id = 1.to(2).oneOf()
      nondet kind = Set("email", "phone", "factor").oneOf()
      verify(id, kind) },
    { nondet id = 0.to(2).oneOf() cancel(id) },
  }

  val AttemptBudget = s.failed.in(0.to(4))
  val WaiterHasReadyAttempt = (s.waiter != 0).implies(s.channel != "idle" and not(s.sending))
  val AtMostOneReply = rpcIds.forall(id => s.replies.get(id).in(0.to(1)))
  val PendingHasOneOwner = rpcIds.forall(id => {
    val activeWaiter = s.waiter == id
    val detachedReply = s.work.stage == "invalid-reply" and s.work.rpc == id
    and {
      (id <= s.issued and s.replies.get(id) == 0) == (activeWaiter != detachedReply),
      not(activeWaiter and detachedReply),
    }
  })
  temporal DetachedReplyPreservesNewWaiter = always((
    (s.work.stage == "invalid-reply" and next(s.work.stage) == "idle").implies(
      next(s.waiter) == s.waiter and next(s.generation) == s.generation)
  ).orKeep(s))
  temporal PendingVerificationSettles = and {
    always((s.waiter != 0).implies(eventually(s.waiter == 0))),
    always((s.work.stage == "invalid-reply").implies(eventually(s.work.stage != "invalid-reply"))),
  }
  temporal UnderFairWorker =
    (startWork.weakFair(s) and finishWork.weakFair(s)).implies(PendingVerificationSettles)

  run retryRetainsCancellationReplyTest = init.then(startCode("email")).then(codeSent)
    .then(verify(1, "email")).then(startWork).then(wrongCode)
    .then(verify(1, "email")).then(deliverWrongCode)
    .expect(s.waiter == 2 and PendingHasOneOwner)
    .then(cancel(1)).expect(s.replies.get(1) == 1 and s.replies.get(2) == 1)
  run lateReplyCannotRetireReplacementTest = init.then(startCode("phone")).then(codeSent)
    .then(verify(1, "phone")).then(startWork).then(cancel(1))
    .then(startCode("email")).then(verify(2, "email")).expect(s.waiter == 0)
    .then(finishTerminal).expect(s.sending and s.replies.get(1) == 1)
    .then(codeSent).then(verify(2, "email")).then(cancel(1)).expect(s.waiter == 2)
  action emailWrongRetry = verify(1, "email").then(startWork)
    .then(wrongCode).then(deliverWrongCode)
  run fiveWrongCodesRetireAttemptTest = init.then(startCode("email")).then(codeSent)
    .then(emailWrongRetry).then(emailWrongRetry).then(emailWrongRetry).then(emailWrongRetry)
    .then(verify(1, "email")).then(startWork).then(wrongCode)
    .expect(s.channel == "idle" and s.replies.get(5) == 1)
  run factorUsesFreshBudgetTest = init.then(startCode("email")).then(codeSent).then(emailWrongRetry)
    .then(verify(1, "email")).then(startWork).then(requireFactor("totp"))
    .expect(s.failed == 0 and s.waiter == 0)
    .then(verify(1, "email")).expect(s.waiter == 0)
    .then(verify(1, "factor")).then(startWork).then(handoffGrant)
    .expect(s.work.stage == "grant" and ownsWork(s))
  run unansweredVerifyKeepsStepTest = init.then(startCode("email")).then(codeSent)
    .then(verify(1, "email")).then(startWork).then(noAnswer).then(deliverWrongCode)
    .expect(s.channel == "email" and s.failed == 0 and s.replies.get(1) == 1)
    .then(verify(1, "email")).then(startWork).then(handoffGrant)
    .expect(s.work.stage == "grant" and ownsWork(s))
  run expiredCodeCannotClaimWorkerTest = init.then(startCode("phone")).then(codeSent).then(expire)
    .then(verify(1, "phone")).expect(s.issued == 0 and s.channel == "idle")
}
