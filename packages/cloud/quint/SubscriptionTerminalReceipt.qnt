// One platform Stripe terminal event. A retained receipt is independent from
// its subscription projection and any still-uncommitted finalization writes.
module SubscriptionTerminalReceipt {
  type State = {
    receipt: str, receiptRevision: int, now: int,
    lease: int, leaseUntil: int, lastLease: int,
    observed: bool, capturedSource: int, capturedProjection: int, draft: bool,
    accountActive: bool, currentAuthority: bool,
    sourceRevision: int, projectionRevision: int,
    terminalSource: bool, freeProjection: bool, audited: bool,
    noticeQueued: bool, generationBumped: bool
  }

  pure val Tokens = Set(1, 2, 3)
  pure val Horizon = 5

  var s: State
  action init = s' = {
    receipt: "absent", receiptRevision: 0, now: 0, lease: 0, leaseUntil: 0, lastLease: 0,
    observed: false, capturedSource: 0, capturedProjection: 0, draft: false,
    accountActive: true, currentAuthority: true, sourceRevision: 1, projectionRevision: 1,
    terminalSource: false, freeProjection: false, audited: false,
    noticeQueued: false, generationBumped: false
  }

  pure def clearLease(state: State): State = state
    .with("lease", 0).with("leaseUntil", 0).with("observed", false)
    .with("capturedSource", 0).with("capturedProjection", 0).with("draft", false)

  pure def publishTerminal(state: State): State = state
    .with("sourceRevision", state.sourceRevision + 1)
    .with("projectionRevision", state.projectionRevision + 1)
    .with("terminalSource", true).with("freeProjection", true)
    .with("audited", true).with("noticeQueued", true).with("generationBumped", true)

  action record(exact: bool): bool =
    s' = if (exact and s.receipt == "absent") s.with("receipt", "received") else s

  def owns(token: int): bool = s.receipt == "processing" and token > 0 and
    s.lease == token and s.leaseUntil > s.now

  action claim = all {
    not(s.draft) and s.lastLease < 3,
    s.receipt == "received" or (s.receipt == "processing" and s.leaseUntil <= s.now),
    s' = s.with("receipt", "processing").with("lease", s.lastLease + 1)
      .with("lastLease", s.lastLease + 1).with("leaseUntil", s.now + 2)
      .with("capturedSource", s.sourceRevision).with("capturedProjection", s.projectionRevision)
      .with("observed", false)
  }

  action observe(token: int): bool = all {
    not(s.draft) and s.receipt == "processing" and s.lease == token and not(s.observed),
    s' = s.with("observed", true)
  }

  action releaseForRetry(token: int): bool = all {
    not(s.draft) and owns(token),
    s' = clearLease(s).with("receipt", "received")
  }

  def canStage(token: int, exact: bool): bool =
    exact and owns(token) and s.observed and not(s.draft) and
      s.accountActive and s.currentAuthority and
      s.capturedSource == s.sourceRevision and s.capturedProjection == s.projectionRevision

  action stage(token: int, exact: bool): bool = all {
    canStage(token, exact),
    s' = s.with("draft", true)
  }

  // The final receipt CAS samples database time again. Draft writes are private
  // until the whole transaction commits. Expiry or a write failure rolls back.
  action commit = all {
    s.draft and owns(s.lease),
    {
      val publication = if (s.terminalSource) s else publishTerminal(s)
      s' = clearLease(publication).with("receipt", "applied")
        .with("receiptRevision", publication.sourceRevision)
    }
  }

  action rollback = all { s.draft, s' = s.with("draft", false).with("observed", false) }
  action finish = any { commit, rollback }

  action advanceSource = all {
    not(s.draft) and s.currentAuthority and not(s.terminalSource) and s.sourceRevision == 1,
    s' = s.with("sourceRevision", 2)
  }

  action advanceProjection = all {
    not(s.draft) and s.currentAuthority and not(s.terminalSource) and s.projectionRevision == 1,
    s' = s.with("projectionRevision", 2)
  }

  action publishViaRecovery = all {
    not(s.draft) and s.accountActive and s.currentAuthority and not(s.terminalSource),
    s' = publishTerminal(s)
  }

  action replaceAuthority = all {
    not(s.draft) and s.currentAuthority,
    s' = s.with("currentAuthority", false).with("freeProjection", false)
      .with("projectionRevision", s.projectionRevision + 1)
  }

  action fenceAccount = all {
    not(s.draft) and s.accountActive,
    s' = s.with("accountActive", false)
  }

  action tick = all { s.now < Horizon, s' = s.with("now", s.now + 1) }
  action wait = s' = s

  action step = any {
    record(true), claim, finish, advanceSource, advanceProjection, publishViaRecovery,
    replaceAuthority, fenceAccount, tick, wait,
    {
      nondet token = Tokens.oneOf()
      any { observe(token), stage(token, true), releaseForRetry(token) }
    }
  }

  val Safety = and {
    s.terminalSource == s.audited and s.terminalSource == s.noticeQueued and
      s.terminalSource == s.generationBumped,
    s.freeProjection == (s.terminalSource and s.currentAuthority),
    (s.receipt == "processing") == (s.lease > 0),
    s.draft implies s.receipt == "processing",
    (s.receipt == "applied") == (s.receiptRevision > 0),
    s.receipt == "applied" implies (s.terminalSource and s.receiptRevision == s.sourceRevision)
  }

  temporal ReceiptAuthority = always((all {
    (s.receipt == "processing" and next(s.receipt) == "received") implies
      (not(s.draft) and owns(s.lease)),
    (s.receipt != "applied" and next(s.receipt) == "applied") implies all {
      s.draft and owns(s.lease) and s.accountActive and s.currentAuthority,
      next(s.receiptRevision) == next(s.sourceRevision),
      next(s.sourceRevision) == (if (s.terminalSource) s.sourceRevision else s.sourceRevision + 1),
      next(s.projectionRevision) == (if (s.terminalSource) s.projectionRevision else s.projectionRevision + 1),
      next(s.freeProjection) and next(s.audited) and next(s.noticeQueued) and next(s.generationBumped)
    },
    (s.draft and next(s.receipt) != "applied") implies all {
      next(s.sourceRevision) == s.sourceRevision, next(s.projectionRevision) == s.projectionRevision,
      next(s.freeProjection) == s.freeProjection,
      next(s.audited) == s.audited, next(s.noticeQueued) == s.noticeQueued,
      next(s.generationBumped) == s.generationBumped
    },
    s.receipt == "applied" implies
      (next(s.receipt) == s.receipt and next(s.receiptRevision) == s.receiptRevision)
  }).orKeep(s))

  temporal EveryDraftFinishes = s.draft.leadsTo(not(s.draft))
  temporal FairFinalization = finish.weakFair(s) implies EveryDraftFinishes

  run mismatchedReplayLeavesReceiptUntouchedTest = init.then(record(true)).then(record(false))
    .expect(s.receipt == "received" and s.lease == 0)
    .then(claim).then(observe(1)).expect(not(canStage(1, false)))

  run lateExpiryRollsBackAndFencesRetryTest = init.then(record(true)).then(claim)
    .then(observe(1)).then(stage(1, true)).then(tick).then(tick)
    .expect(not(owns(1))).then(rollback)
    .expect(s.sourceRevision == 1 and s.projectionRevision == 1 and not(s.noticeQueued))
    .then(claim).expect(not(owns(1)) and owns(2))
    .then(observe(2)).then(stage(2, true)).then(commit)
    .expect(s.receipt == "applied" and s.freeProjection and s.noticeQueued)

  run oldProjectionAndSourceNeedReobservationTest = init.then(record(true)).then(claim)
    .then(observe(1)).then(advanceSource).then(advanceProjection)
    .expect(not(canStage(1, true)))
    .then(releaseForRetry(1)).then(claim).then(observe(2)).then(stage(2, true)).then(commit)
    .expect(s.receiptRevision == 3 and s.projectionRevision == 3)

  run acknowledgedRecoveryDoesNotRepublishTest = init.then(publishViaRecovery)
    .then(record(true)).then(claim).then(observe(1)).then(stage(1, true)).then(commit)
    .expect(s.receiptRevision == 2 and s.projectionRevision == 2 and s.noticeQueued)

  run historicalReplayPreservesReplacementTest = init.then(record(true)).then(claim)
    .then(observe(1)).then(stage(1, true)).then(commit).then(replaceAuthority).then(record(true))
    .expect(s.receiptRevision == 2 and s.projectionRevision == 3 and not(s.freeProjection))

  run fencedAccountCannotBeginFinalizationTest = init.then(record(true)).then(claim)
    .then(observe(1)).then(fenceAccount).expect(not(canStage(1, true)))
}
