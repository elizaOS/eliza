// One standard organization inference lease and its exact direct-debit recovery.
// The local caller cannot use a durable dispatch until it receives its acknowledgement.
module StandardInferenceAdmission {
  type State = {
    mode: str, phase: str, client: str, now: int, dueAt: int,
    generation: int, carried: int, refills: int, fenceUntil: int, credentialActive: bool,
    attempts: int, reply: bool, dispatches: int, invoked: bool,
    recoveryOwner: int, publishedBy: int, sqlDebit: int, gateDebit: int
  }

  pure val Active = Set("leased", "dispatched", "recovering")
  pure val Owners = Set(1, 2)
  pure val Horizon = 4
  pure val LeaseAge = 2

  var s: State
  action initialize(mode: str): bool = s' = {
    mode: mode, phase: "none", client: "ready", now: 0, dueAt: 0,
    generation: 1, carried: 1, refills: 0, fenceUntil: 0, credentialActive: true,
    attempts: 0, reply: false, dispatches: 0, invoked: false,
    recoveryOwner: 0, publishedBy: 0, sqlDebit: 0, gateDebit: 0
  }
  action init = any { initialize("ordinary"), initialize("combined") }

  // The request carries the generation of its admission snapshot.
  val currentPolicy = s.carried == s.generation and s.fenceUntil <= s.now
  val hold = if (Active.contains(s.phase)) 1 else 0
  val available = 2 - hold - s.gateDebit

  action reserve = all {
    s.mode == "ordinary" and s.phase == "none" and s.client == "ready",
    currentPolicy,
    s' = s.with("phase", "leased").with("dueAt", s.now + LeaseAge)
  }

  action startMark = all {
    s.attempts < 3 and Set("ready", "ambiguous").contains(s.client),
    s.mode == "combined" or s.phase != "none",
    s' = s.with("client", "waiting").with("attempts", s.attempts + 1)
      .with("reply", false)
  }

  def canMark(exact: bool): bool = exact and
    (s.mode != "combined" or s.credentialActive) and
    (s.phase == "dispatched" or (currentPolicy and
      ((s.mode == "combined" and s.phase == "none") or
        (s.mode == "ordinary" and s.phase == "leased"))))

  action persistMark(exact: bool): bool = all {
    s.client == "waiting" and not(s.reply),
    canMark(exact),
    s' = s.with("phase", "dispatched").with("reply", true)
      .with("dueAt", s.now + LeaseAge)
      .with("dispatches", if (s.phase == "dispatched") s.dispatches else s.dispatches + 1)
  }

  action acceptAck = all {
    s.client == "waiting" and s.reply,
    s' = s.with("client", "authorized").with("reply", false)
  }

  // An interrupted request can have stopped before or after durable mutation.
  action loseAck = all {
    s.client == "waiting",
    s' = s.with("client", "ambiguous").with("reply", false)
  }

  // The gate answers a first deferred commit under a superseded generation or
  // an open fence with an explicit refusal and records nothing.
  action refuseStaleMark = all {
    s.client == "waiting" and not(s.reply),
    s.mode == "combined" and s.phase == "none" and not(currentPolicy),
    s' = s.with("client", "refused")
  }

  // The refused caller reads the primary once, after any open policy mutation
  // commits, and prepares the same request under the generation it read.
  action refillStalePolicy = all {
    s.client == "refused" and s.refills == 0 and s.fenceUntil <= s.now,
    s' = s.with("carried", s.generation).with("refills", 1)
      .with("client", "ready").with("attempts", 0)
  }

  // A refusal that stands (the refill found a hold, the refill failed, or the
  // one retry was refused again) ends the request with nothing reserved.
  action settleRefusedAtZero = all {
    s.client == "refused",
    s' = s.with("client", "cancelled")
  }

  action finishMark = any { persistMark(true), acceptAck, loseAck, refuseStaleMark }

  action invokeProvider = all {
    s.client == "authorized" and not(s.invoked),
    s' = s.with("invoked", true)
  }

  def canRelease(exact: bool): bool =
    Set("ready", "ambiguous").contains(s.client) and
    (s.phase == "leased" or (s.phase == "dispatched" and exact))

  action cancelBeforeProvider(exact: bool): bool = all {
    canRelease(exact),
    s' = s.with("phase", "released").with("client", "cancelled")
  }

  // The caller holds the acknowledgement and declines to invoke the provider:
  // the rate verdict joined at the boundary denied it, or the client left.
  // The live zero settlement returns the hold; no debit exists to collect.
  action abandonAuthorized = all {
    s.phase == "dispatched" and s.client == "authorized" and not(s.invoked),
    s' = s.with("phase", "released").with("client", "cancelled")
  }

  action expireUndispatched = all {
    s.phase == "leased" and s.dueAt <= s.now,
    s' = s.with("phase", "released")
  }

  action beginFence = all {
    s.fenceUntil == 0,
    s' = s.with("fenceUntil", s.now + 1)
  }

  action abortFence = all { s.fenceUntil > 0, s' = s.with("fenceUntil", 0) }
  action advancePolicy = all {
    s.generation == 1,
    s' = s.with("generation", 2).with("fenceUntil", 0)
  }

  action revokeCredential = all {
    s.credentialActive,
    s' = s.with("credentialActive", false)
  }

  action claimRecovery = all {
    Set("dispatched", "recovering").contains(s.phase) and s.dueAt <= s.now,
    s.recoveryOwner < 2,
    s' = s.with("phase", "recovering").with("recoveryOwner", s.recoveryOwner + 1)
      .with("dueAt", s.now + LeaseAge)
  }

  // SQL has the original request's idempotent debit. A lost callback leaves
  // the hold in the gate, even if this debit already committed.
  action debitRecovery = all {
    s.phase == "recovering",
    s' = s.with("sqlDebit", 1)
  }

  action publishRecoveryBalance(owner: int): bool = all {
    s.phase == "recovering" and s.recoveryOwner == owner and s.sqlDebit == 1,
    s' = s.with("gateDebit", 1).with("publishedBy", owner)
  }

  action finishRecovery(owner: int): bool = all {
    s.phase == "recovering" and s.recoveryOwner == owner and s.publishedBy == owner,
    s' = s.with("phase", "settled")
  }

  action settleKnown = all {
    s.phase == "dispatched" and s.invoked,
    s' = s.with("phase", "settled").with("sqlDebit", 1).with("gateDebit", 1)
  }

  action tick = all { s.now < Horizon, s' = s.with("now", s.now + 1) }
  action wait = s' = s

  action step = any {
    reserve, startMark, finishMark, refillStalePolicy, settleRefusedAtZero,
    invokeProvider, cancelBeforeProvider(true),
    abandonAuthorized, expireUndispatched, beginFence, abortFence, advancePolicy, revokeCredential,
    claimRecovery, debitRecovery, settleKnown, tick, wait,
    {
      nondet owner = Owners.oneOf()
      any { publishRecoveryBalance(owner), finishRecovery(owner) }
    }
  }

  val Safety = and {
    s.dispatches <= 1,
    s.invoked implies (s.client == "authorized" and s.dispatches == 1),
    s.phase == "released" implies (not(s.invoked) and s.sqlDebit == 0),
    s.phase == "recovering" implies (hold == 1 and s.dispatches == 1),
    s.phase == "settled" implies (hold == 0 and s.sqlDebit == 1 and s.gateDebit == 1),
    s.gateDebit <= s.sqlDebit,
    available >= 0,
    s.refills <= 1 and s.carried <= s.generation,
    s.client == "refused" implies (s.phase == "none" and s.dispatches == 0 and not(s.invoked))
  }

  temporal DurableAuthority = always((all {
    (s.dispatches == 0 and next(s.dispatches) == 1) implies
      (currentPolicy and (s.mode != "combined" or s.credentialActive)),
    (s.client != "authorized" and next(s.client) == "authorized") implies
      (s.client == "waiting" and s.reply),
    (s.phase == "recovering" and next(s.phase) == "settled") implies
      (s.publishedBy == s.recoveryOwner and s.gateDebit == 1),
    s.sqlDebit == 1 implies next(s.sqlDebit) == 1,
    Set("released", "settled").contains(s.phase) implies next(s.phase) == s.phase
  }).orKeep(s))

  temporal MarkReturns = (s.client == "waiting").leadsTo(s.client != "waiting")
  temporal FairMarkReply = finishMark.weakFair(s) implies MarkReturns

  run stalePolicyFencesOrdinaryDispatchTest = initialize("ordinary").then(reserve)
    .then(advancePolicy).then(startMark).expect(not(canMark(true)))
    .then(loseAck).then(cancelBeforeProvider(false)).expect(s.dispatches == 0 and available == 2)

  run staleDeferredCommitRefillsOnceAndDispatchesTest = initialize("combined")
    .then(advancePolicy).then(startMark).expect(not(canMark(true)))
    .then(refuseStaleMark).expect(hold == 0 and s.dispatches == 0)
    .then(refillStalePolicy).then(startMark).then(persistMark(true)).then(acceptAck)
    .then(invokeProvider).expect(s.dispatches == 1 and s.invoked and s.refills == 1)

  run staleDeferredCommitRefusedAfterRefillSettlesAtZeroTest = initialize("combined")
    .then(advancePolicy).then(startMark).then(refuseStaleMark).then(refillStalePolicy)
    .then(beginFence).then(startMark).then(refuseStaleMark)
    .expect(s.refills == 1 and s.fenceUntil > s.now)
    .then(settleRefusedAtZero)
    .expect(s.client == "cancelled" and s.dispatches == 0 and available == 2 and not(s.invoked))

  run lostMarkAckReplaysOneHoldTest = initialize("combined")
    .then(startMark).then(persistMark(true)).then(loseAck)
    .expect(hold == 1 and not(s.invoked) and not(canMark(false)))
    .then(advancePolicy).then(startMark).then(persistMark(true)).then(acceptAck).then(invokeProvider)
    .expect(hold == 1 and s.dispatches == 1 and s.invoked)

  run revokeBlocksCombinedReplayWithoutErasingHoldTest = initialize("combined")
    .then(startMark).then(persistMark(true)).then(loseAck).then(revokeCredential)
    .then(startMark).expect(not(canMark(true))).then(loseAck)
    .expect(not(canRelease(false)) and hold == 1)
    .then(cancelBeforeProvider(true)).expect(s.phase == "released" and available == 2)

  run recoveryPublicationFailureRetainsDebtAndHoldTest = initialize("combined")
    .then(startMark).then(persistMark(true)).then(loseAck)
    .then(tick).then(tick).then(claimRecovery).then(debitRecovery)
    .expect(s.sqlDebit == 1 and s.gateDebit == 0 and hold == 1)
    .then(tick).then(tick).then(claimRecovery).then(debitRecovery)
    .then(publishRecoveryBalance(2)).then(finishRecovery(2))
    .expect(s.sqlDebit == 1 and s.gateDebit == 1 and available == 1)

  run staleRecoveryCannotRetireSuccessorTest = initialize("ordinary").then(reserve)
    .then(startMark).then(persistMark(true)).then(acceptAck).then(invokeProvider)
    .then(tick).then(tick).then(claimRecovery).then(debitRecovery)
    .then(publishRecoveryBalance(1)).then(tick).then(tick).then(claimRecovery)
    .expect(s.publishedBy != s.recoveryOwner and hold == 1)
    .then(publishRecoveryBalance(2)).then(finishRecovery(2)).expect(s.phase == "settled")

  run authorizedCallerAbandonsWithoutProviderTest = initialize("combined")
    .then(startMark).then(persistMark(true)).then(acceptAck)
    .expect(hold == 1 and s.client == "authorized" and not(s.invoked))
    .then(abandonAuthorized)
    .expect(s.phase == "released" and available == 2 and s.sqlDebit == 0 and not(s.invoked))

  run leaseExpiryBeforeDispatchReturnsCapacityTest = initialize("ordinary").then(reserve)
    .then(tick).then(tick).then(expireUndispatched)
    .expect(s.phase == "released" and available == 2 and s.sqlDebit == 0)
}
