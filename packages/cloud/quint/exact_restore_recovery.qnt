// Terminal exact-restore cleanup, including an ambiguous Docker create.
// Source: shared/src/db/repositories/agent-backup-restore-serving.ts (selector,
// begin/finish), agent-sandbox-replacement-attempts.ts (callback fences), and
// lib/services/agent-backup-restore-coordinator.ts + docker-sandbox-provider.ts.
// One fixed tenant/operation/attempt and two concurrent trusted coordinator turns.
// Entry state is an expired restore lease, failed_terminal operation, durable S0
// locator/counted slot, and a submitted Docker create whose result is unknown.
module exact_restore_recovery {
  pure val workers = Set(1, 2)
  type State = {
    phase: str,
    held: bool,
    releases: int,
    pendingDaemon: bool,
    created: bool,
    live: bool,
    observedId: bool,
    quiescent: bool,
    tombstone: bool,
    terminal: bool,
    currentNode: int,
    locators: Set[int],
    proofs: Set[int],
    receipt: bool,
    result: int -> str
  }
  var s: State
  action init = s' = {
    phase: "unresolved", held: true, releases: 0, pendingDaemon: true,
    created: false, live: false, observedId: false, quiescent: false,
    tombstone: false, terminal: true, currentNode: 1, locators: Set(), proofs: Set(),
    receipt: false, result: Map(1 -> "pending", 2 -> "pending")
  }
  // scope=1 represents the immutable original organization/agent/restore lease,
  // attempt and node locator. The trusted coordinator supplies no replacement
  // locator from user input. Scope=2 models a mismatch rejected under DB locks.
  action begin(w, scope) = all {
    scope == 1, Set("unresolved", "cleanup").contains(s.phase),
    s' = s.with("phase", "cleanup").with("locators", s.locators.union(Set(w)))
      .with("result", s.result.set(w, "fenced"))
  }
  action rejectScope(w, scope) = all { scope != 1, s' = s.with("result", s.result.set(w, "rejected")) }
  action nodeReincarnates = s' = s.with("currentNode", 2)
  action tombstone(w) = all {
    s.locators.contains(w), s.currentNode == 1,
    s' = s.with("tombstone", true)
  }
  // A submitted Docker daemon operation survives caller timeout/tombstone.
  // One durable provider-start marker permits at most one immutable candidate.
  action daemonCreates = all {
    s.pendingDaemon, not(s.created),
    s' = s.with("created", true).with("live", true)
  }
  action producerQuiescent = all {
    s.pendingDaemon, s' = s.with("pendingDaemon", false).with("quiescent", true)
  }
  action observeExactId(w) = all {
    s.locators.contains(w), s.currentNode == 1, s.live,
    s' = s.with("observedId", true)
  }
  action deleteExactId(w) = all {
    s.locators.contains(w), s.currentNode == 1, s.tombstone, s.observedId,
    s' = s.with("live", false)
  }
  action quarantine(w) = all {
    s.locators.contains(w),
    s.currentNode != 1 or not(s.tombstone) or s.live or (not(s.quiescent) and not(s.observedId)),
    s' = s.with("result", s.result.set(w,
      if (s.currentNode != 1) "node_authority_unavailable" else "daemon_outcome_unresolved"))
  }
  // A returned provider proof means exact removal/canonical absence, artifact
  // cleanup and no future unobserved candidate. Its digest binds the fixed S0
  // identity. Remote bytes, SSH verification and digest collision resistance are
  // assumptions; this finite model checks ordering, identity and atomic settlement.
  action receiveProof(w) = all {
    s.locators.contains(w), s.currentNode == 1, s.tombstone,
    not(s.live), s.quiescent or s.observedId,
    s' = s.with("proofs", s.proofs.union(Set(w))).with("result", s.result.set(w, "proof"))
  }
  action lostResponse(w) = all { s.locators.contains(w), s' = s.with("result", s.result.set(w, "cleanup_proof_unavailable")) }
  // Receipt retention and counted-slot release share one row-locked transaction.
  // The operation stays failed_terminal; a late turn replays the same receipt.
  action settle(w) = all {
    s.proofs.contains(w), s.phase == "cleanup", s.currentNode == 1,
    s' = s.with("phase", "proven").with("held", false).with("receipt", true)
      .with("releases", s.releases + 1).with("result", s.result.set(w, "cleaned"))
  }
  action replay(w) = all {
    s.phase == "proven", s.receipt, s' = s.with("result", s.result.set(w, "settled"))
  }
  action rejectLateCallback = all { s.phase != "unresolved", s' = s }
  action step = {
    nondet w = workers.oneOf()
    nondet scope = Set(1, 2).oneOf()
    any { begin(w, scope), rejectScope(w, scope), nodeReincarnates, tombstone(w),
      daemonCreates, producerQuiescent, observeExactId(w), deleteExactId(w), quarantine(w),
      receiveProof(w), lostResponse(w), settle(w), replay(w), rejectLateCallback }
  }
  val safety = all {
    s.terminal, s.releases <= 1, s.live implies s.held,
    not(s.held) implies s.phase == "proven" and s.receipt and s.tombstone
      and not(s.live) and (s.quiescent or s.observedId),
    s.receipt implies s.proofs.size() > 0,
    workers.forall(w => (Set("cleaned", "settled").contains(s.result.get(w))) implies s.receipt)
  }
  temporal StableAuthorityCleanupFinishes = (always(s.currentNode == 1)
    and producerQuiescent.weakFair(s)
    and workers.forall(w => begin(w, 1).weakFair(s) and tombstone(w).weakFair(s)
      and observeExactId(w).weakFair(s) and deleteExactId(w).weakFair(s)
      and receiveProof(w).weakFair(s) and settle(w).weakFair(s))).implies(eventually(s.receipt))
  run ambiguousAbsenceRetainsQuarantineTest = init.then(begin(1, 1)).then(tombstone(1))
    .then(quarantine(1)).expect(s.held and s.result.get(1) == "daemon_outcome_unresolved" and safety)
  run lateDaemonCreationRemovedBeforeProofTest = init.then(begin(1, 1)).then(tombstone(1))
    .then(quarantine(1)).then(daemonCreates).then(rejectLateCallback)
    .then(observeExactId(1)).then(deleteExactId(1)).then(receiveProof(1)).then(settle(1))
    .expect(not(s.held) and s.terminal and safety)
  run quiescentEmptyDaemonAllowsProofTest = init.then(begin(1, 1)).then(tombstone(1))
    .then(producerQuiescent).then(receiveProof(1)).then(settle(1)).expect(safety and s.receipt)
  run duplicateTurnsReleaseOnceTest = init.then(begin(1, 1)).then(begin(2, 1)).then(tombstone(1))
    .then(producerQuiescent).then(receiveProof(1)).then(receiveProof(2)).then(settle(1)).then(replay(2))
    .expect(s.releases == 1 and s.result.get(2) == "settled" and safety)
  run lostResponseReusesExactObservedIdTest = init.then(begin(1, 1)).then(tombstone(1))
    .then(daemonCreates).then(observeExactId(1)).then(deleteExactId(1)).then(lostResponse(1))
    .then(begin(2, 1)).then(receiveProof(2)).then(settle(2)).expect(s.releases == 1 and safety)
  run wrongScopeCannotAcquireLocatorTest = init.then(rejectScope(1, 2))
    .expect(s.locators.size() == 0 and s.held and safety)
  run changedNodePreservesQuarantineTest = init.then(begin(1, 1)).then(nodeReincarnates).then(quarantine(1))
    .expect(s.held and s.result.get(1) == "node_authority_unavailable" and safety)
  run nodeChangesAfterProofRetainsCapacityTest = init.then(begin(1, 1)).then(tombstone(1))
    .then(producerQuiescent).then(receiveProof(1)).then(nodeReincarnates).then(quarantine(1))
    .expect(s.held and not(s.receipt) and s.releases == 0 and safety)
  // Guard-removal mutation is outside step and demonstrates the essential proof.
  action unsafeEmptyInspectSettles = all {
    s.phase == "cleanup", s.tombstone, not(s.live),
    s' = s.with("held", false).with("phase", "proven").with("receipt", true)
  }
  run missingQuiescenceProofDetectedTest = init.then(begin(1, 1)).then(tombstone(1))
    .then(unsafeEmptyInspectSettles).then(daemonCreates).expect(not(safety))
}
