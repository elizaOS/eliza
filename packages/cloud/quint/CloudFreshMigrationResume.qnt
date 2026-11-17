// One locked, source-validated cloud migration ledger across process retries.
module CloudFreshMigrationResume {
  type State = {
    origin: str,
    phase: int,
    owner: int,
    receipt: bool,
    exact: bool,
    quotaRows: bool,
    stable: bool,
  }
  var s: State

  // Phases: empty ledger, first row, safe prefix, committed pair, registry.
  pure def initial(origin: str): State = {
    origin: origin,
    phase: if (origin == "established") 1 else 0,
    owner: 0,
    receipt: false,
    exact: true,
    quotaRows: false,
    stable: false,
  }
  action init = {
    nondet origin = Set("fresh", "established", "wiped").oneOf()
    s' = initial(origin)
  }
  action acquire(owner: int): bool = all {
    s.owner == 0,
    s' = { ...s, owner: owner },
  }
  action first = all {
    s.owner != 0 and s.origin == "fresh" and s.phase == 0,
    s' = { ...s, phase: 1, receipt: true },
  }
  action prefix = all {
    s.owner != 0 and s.phase == 1 and (not(s.receipt) or s.exact),
    s' = { ...s, phase: 2 },
  }
  action pair = all {
    s.owner != 0 and s.phase == 2 and s.receipt and s.exact and not(s.quotaRows),
    s' = { ...s, phase: 3, receipt: false },
  }
  action registry = all {
    s.owner != 0 and s.phase == 3,
    s' = { ...s, phase: 4, owner: 0 },
  }
  // Rollback, process loss, and rejected attempts release the owner. They
  // preserve all durable rows and the provenance established by the first commit.
  action stop = all {
    s.owner != 0 and not(s.stable),
    s' = { ...s, owner: 0 },
  }
  action changeHistory = all {
    s.receipt and not(s.stable),
    s' = { ...s, exact: false },
  }
  action receiveQuota = all {
    s.phase.in(1.to(2)) and not(s.stable),
    s' = { ...s, quotaRows: true },
  }
  action stabilize = all {
    not(s.stable),
    s' = { ...s, stable: true },
  }
  action step = any {
    acquire(1), acquire(2), first, prefix, pair, registry, stop,
    changeHistory, receiveQuota, stabilize, s' = s,
  }

  val TypeOK = s.phase.in(0.to(4)) and s.owner.in(0.to(2))
  val ExactReceiptLifecycle = s.receipt == (s.origin == "fresh" and s.phase.in(1.to(2)))
  val NoLiveDrop = (s.phase >= 3).implies(s.origin == "fresh" and s.exact and not(s.quotaRows))
  val WipedLedgerNeverReplays = (s.origin == "wiped").implies(s.phase == 0)

  val stableRetry = s.stable and s.receipt and s.exact and not(s.quotaRows)
  temporal StableRetrySettles = stableRetry.leadsTo(s.phase == 4)
  temporal FairStableRetrySettles = all {
    acquire(1).weakFair(s), prefix.weakFair(s), pair.weakFair(s), registry.weakFair(s),
  }.implies(StableRetrySettles)

  run restartResumesExactPairTest = {
    s' = initial("fresh")
  }.then(acquire(1)).then(first).then(prefix).then(stop).then(acquire(2)).then(pair)
    .expect(s.phase == 3 and not(s.receipt)).then(registry).expect(s.phase == 4)

  run firstRollbackHasNoReceiptTest = {
    s' = initial("fresh")
  }.then(acquire(1)).then(stop).expect(s.phase == 0 and not(s.receipt))

  run incomingQuotaRetainsReceiptTest = {
    s' = initial("fresh")
  }.then(acquire(1)).then(first).then(prefix).then(receiveQuota)
    .then(stop).expect(s.phase == 2 and s.receipt and s.quotaRows)

  run existingDeploymentStopsBeforePairTest = {
    s' = initial("established")
  }.then(acquire(1)).then(prefix).then(stop).expect(s.phase == 2 and not(s.receipt))

  run changedPrefixKeepsReceiptAndLedgerTest = {
    s' = initial("fresh")
  }.then(acquire(1)).then(first).then(changeHistory).then(stop)
    .expect(s.phase == 1 and s.receipt and not(s.exact))
}
