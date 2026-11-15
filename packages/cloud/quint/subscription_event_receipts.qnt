// Platform provider-event receipt ownership and terminal lifecycle publication.
// Actual sources: subscription-billing-operations.ts (record/claim/release/
// applyEventInTransaction/finalizeLifecycleEvent), subscription-renewal-finalization.ts,
// stripe-terminal-lifecycle.ts, stripe-paid-renewal.ts, subscription-invoice-event-recovery.ts.
// One immutable receipt, two invocation tokens, two claims, clock 0..5,
// source/projection revisions 1..3. Provider validation is abstracted by a
// matching-observation bit, NOT a proof of Stripe authenticity or financial terms.
// Transaction writes remain tentative until the final live-lease CAS; receipt
// row locking excludes takeover while that transaction holds the row.
// appliedAt is the final SQL guard decision, not COMMIT/HTTP acknowledgement time.
// Terminal reconciliation acknowledgement is modeled; renewal funding and
// historical paid-invoice replay need their own remaining financial model.
// Generic applyEvent/reconcileEvent have only test callers and are NOT covered
// by the atomic-publication guarantee. App-scoped receipts, invoice grant
// arithmetic, two different event IDs for one invoice, fairness, retention,
// account-deletion owners and unbounded provider histories remain separate.
module subscription_event_receipts {
  type Worker = { generation: int, source: int, projection: int, observed: bool }
  type State = { phase: str, digest: int, acceptedDigest: int, owner: int, generation: int, until: int,
    time: int, source: int, projection: int, active: bool, current: bool,
    workers: int -> Worker, txOwner: int, staged: bool, stagedHistorical: bool,
    matchingRecovery: bool, recoveryRevision: int, applications: int,
    appliedRevision: int, appliedAt: int, appliedLeaseUntil: int, historicalAck: bool }
  var s: State
  pure val actors = Set(0, 1)
  pure val emptyWorker = { generation: 0, source: 0, projection: 0, observed: false }
  action init = s' = { phase: "absent", digest: 0, acceptedDigest: 0, owner: -1, generation: 0,
    until: 0, time: 0, source: 1, projection: 1, active: true, current: true,
    workers: actors.mapBy(_ => emptyWorker), txOwner: -1, staged: false,
    stagedHistorical: false, matchingRecovery: false, recoveryRevision: 0,
    applications: 0, appliedRevision: 0, appliedAt: -1, appliedLeaseUntil: 0,
    historicalAck: false }
  action recordEvent = all { s.phase == "absent", s' = s.with("phase", "received").with("digest", 1).with("acceptedDigest", 1) }
  action acceptDeliveryReplay(inputDigest: int, enforceIdentity: bool): bool = all {
    s.phase != "absent", not(enforceIdentity) or inputDigest == s.digest,
    s' = s.with("acceptedDigest", inputDigest) }
  action exactDeliveryReplay = acceptDeliveryReplay(1, true)
  action rejectChangedIdentity = all { s.phase != "absent", s' = s }
  def live(actor: int): bool = s.phase == "processing" and s.owner == actor and
    s.workers.get(actor).generation == s.generation and s.time < s.until
  def claimable: bool = s.txOwner == -1 and s.generation < 2 and
    (s.phase == "received" or (s.phase == "processing" and s.time >= s.until))
  action claim(actor: int, scope: int): bool = all { scope == 1, claimable,
    s' = s.with("phase", "processing").with("owner", actor)
      .with("generation", s.generation + 1).with("until", s.time + 2)
      .with("workers", s.workers.set(actor, emptyWorker.with("generation", s.generation + 1))) }
  action tick = all { s.time < 5, s' = s.with("time", s.time + 1) }
  action observeProvider(actor: int): bool = all { live(actor), s.txOwner == -1,
    s' = s.with("workers", s.workers.set(actor, s.workers.get(actor)
      .with("source", s.source).with("projection", s.projection).with("observed", true))) }
  def canBegin(actor: int, scope: int): bool = all { scope == 1, live(actor),
    s.txOwner == -1, s.active, s.current, s.workers.get(actor).observed,
    s.workers.get(actor).source == s.source, s.workers.get(actor).projection == s.projection,
    s.matchingRecovery or (s.source < 3 and s.projection < 3) }
  action beginTransaction(actor: int, scope: int): bool = all { canBegin(actor, scope),
    s' = s.with("txOwner", actor) }
  action stagePublication = all { s.txOwner != -1, not(s.staged),
    s' = s.with("staged", true).with("stagedHistorical", s.matchingRecovery) }
  def canCommit: bool = s.txOwner != -1 and s.staged and live(s.txOwner)
  action finishCommit(enforceLease: bool): bool = all {
    s.txOwner != -1, s.staged, not(enforceLease) or canCommit,
    s' = s.with("phase", "applied").with("owner", -1).with("until", 0)
      .with("source", if (s.stagedHistorical) s.source else s.source + 1)
      .with("projection", if (s.stagedHistorical) s.projection else s.projection + 1)
      .with("applications", if (s.stagedHistorical) s.applications else s.applications + 1)
      .with("appliedRevision", if (s.stagedHistorical) s.recoveryRevision else s.source + 1)
      .with("appliedAt", s.time).with("appliedLeaseUntil", s.until)
      .with("historicalAck", s.stagedHistorical).with("txOwner", -1).with("staged", false)
      .with("stagedHistorical", false) }
  action commit = finishCommit(true)
  action rollback = all { s.txOwner != -1,
    s' = s.with("txOwner", -1).with("staged", false).with("stagedHistorical", false) }
  action releaseForRetry(actor: int, scope: int): bool = all {
    scope == 1, live(actor), s.txOwner == -1,
    s' = s.with("phase", "received").with("owner", -1).with("until", 0) }
  action ignoreUnownedSchedule(actor: int): bool = all { live(actor), s.txOwner == -1,
    s' = s.with("phase", "ignored").with("owner", -1).with("until", 0) }
  action otherPublication = all { s.txOwner == -1, s.source < 3, s.projection < 3,
    s' = s.with("source", s.source + 1).with("projection", s.projection + 1)
      .with("matchingRecovery", false).with("recoveryRevision", 0) }
  action matchingRecoveryPublication = all { s.txOwner == -1, s.phase != "applied",
    not(s.matchingRecovery), s.source < 3, s.projection < 3,
    s' = s.with("source", s.source + 1).with("projection", s.projection + 1)
      .with("matchingRecovery", true).with("recoveryRevision", s.source + 1) }
  action fenceAccount = all { s.txOwner == -1, s' = s.with("active", false).with("current", false) }
  action historicalReceiptReplay = all { s.phase == "applied", s' = s }
  action rejectStaleWork(actor: int, scope: int): bool = all {
    not(canBegin(actor, scope)), s' = s }
  action idle = s' = s
  action step = {
    nondet actor = actors.oneOf()
    any { recordEvent, exactDeliveryReplay, claim(actor, 1), tick, observeProvider(actor),
      beginTransaction(actor, 1), stagePublication, commit, rollback,
      releaseForRetry(actor, 1), ignoreUnownedSchedule(actor), otherPublication,
      matchingRecoveryPublication, fenceAccount, historicalReceiptReplay, idle }
  }
  val safety = all {
    s.phase == "absent" or (s.digest == 1 and s.acceptedDigest == s.digest),
    s.applications <= 1,
    s.applications == 0 or s.phase == "applied",
    s.phase != "applied" or (s.appliedRevision > 0 and
      s.appliedAt < s.appliedLeaseUntil and (s.applications == 1 or s.historicalAck)),
    s.txOwner != -1 or not(s.staged),
    s.phase != "applied" or (s.owner == -1 and s.until == 0)
  }
  // Excluded negative witnesses: omit the final lease CAS, or publish a
  // tentative projection outside the transaction. These are not safe steps.
  action unsafeChangedDeliveryReplay = acceptDeliveryReplay(2, false)
  action unsafeExpiredCommit = finishCommit(false)
  action unsafeProjectionLeak = all { s.staged, not(s.stagedHistorical),
    s' = s.with("source", s.source + 1).with("projection", s.projection + 1)
      .with("applications", s.applications + 1) }

  run atomicPublicationTest = init.then(recordEvent).then(claim(0, 1)).then(observeProvider(0))
    .then(beginTransaction(0, 1)).then(stagePublication).then(commit)
    .expect(safety and s.applications == 1 and s.appliedRevision == 2)
  run expiryAfterTentativeWriteRollsBackTest = init.then(recordEvent).then(claim(0, 1))
    .then(observeProvider(0)).then(beginTransaction(0, 1)).then(stagePublication)
    .then(tick).then(tick).expect(not(canCommit)).then(rollback)
    .expect(safety and s.source == 1 and s.projection == 1 and s.applications == 0)
    .then(claim(1, 1)).then(observeProvider(1)).then(beginTransaction(1, 1))
    .then(stagePublication).then(commit).expect(safety and s.applications == 1)
  run staleInvocationCannotPublishTest = init.then(recordEvent).then(claim(0, 1))
    .then(observeProvider(0)).then(tick).then(tick).then(claim(1, 1))
    .then(rejectStaleWork(0, 1)).expect(safety and not(canBegin(0, 1)))
  run revisionChangeNeedsNewObservationTest = init.then(recordEvent).then(claim(0, 1))
    .then(observeProvider(0)).then(otherPublication).then(rejectStaleWork(0, 1))
    .expect(not(canBegin(0, 1))).then(observeProvider(0)).then(beginTransaction(0, 1))
    .then(stagePublication).then(commit).expect(safety and s.appliedRevision == 3)
  run receiptReplayPreservesReplacementTest = init.then(recordEvent).then(claim(0, 1))
    .then(observeProvider(0)).then(beginTransaction(0, 1)).then(stagePublication).then(commit)
    .then(otherPublication).then(fenceAccount).then(historicalReceiptReplay)
    .expect(safety and s.source == 3 and s.appliedRevision == 2 and s.applications == 1)
  run recoveredPublicationIsAcknowledgedWithoutRepublishingTest = init.then(recordEvent)
    .then(matchingRecoveryPublication).then(claim(0, 1)).then(observeProvider(0))
    .then(beginTransaction(0, 1)).then(stagePublication).then(commit)
    .expect(safety and s.source == 2 and s.projection == 2 and s.applications == 0 and s.historicalAck)
  run wrongScopeAndChangedDigestCannotMutateTest = init.then(recordEvent).then(rejectChangedIdentity)
    .then(claim(0, 1)).then(observeProvider(0)).then(rejectStaleWork(0, 0))
    .expect(safety and canBegin(0, 1) and not(canBegin(0, 0)) and s.digest == 1)
  run accountFenceBlocksNewPublicationTest = init.then(recordEvent).then(claim(0, 1))
    .then(observeProvider(0)).then(fenceAccount).then(rejectStaleWork(0, 1))
    .expect(safety and not(canBegin(0, 1)))
  run changedDeliveryAcceptanceNegativeWitnessTest = init.then(recordEvent)
    .then(unsafeChangedDeliveryReplay).expect(not(safety))
  run expiredCommitNegativeWitnessTest = init.then(recordEvent).then(claim(0, 1))
    .then(observeProvider(0)).then(beginTransaction(0, 1)).then(stagePublication)
    .then(tick).then(tick).then(unsafeExpiredCommit).expect(not(safety))
  run partialProjectionNegativeWitnessTest = init.then(recordEvent).then(claim(0, 1))
    .then(observeProvider(0)).then(beginTransaction(0, 1)).then(stagePublication)
    .then(unsafeProjectionLeak).expect(not(safety))
}
