// PR validation joins seven lanes before the required aggregate check. Quint
// runs only for promotion to main: it must succeed there and be skipped elsewhere.
// Each lane settles once. Whole-workflow cancellation before aggregate dispatch
// cancels the gate; cancellation of a dependency still fails admission.
// GitHub scheduling and job completion are external.
module CiAdmission {
  pure val Lanes = Set("secret-scan", "source-checks", "sdk-owning",
    "billing-payment-replay-e2e", "subscription-authority-postgres",
    "paradee-stream-contract", "quint")
  pure val Outcomes = Set("success", "failure", "cancelled", "skipped")
  var s: { promotion: bool, results: str -> str, gate: str, workflowCancelled: bool }
  action start(promotion: bool): bool =
    s' = { promotion: promotion, results: Lanes.mapBy(_ => "running"), gate: "waiting", workflowCancelled: false }
  action init = {
    nondet promotion = Set(false, true).oneOf()
    start(promotion)
  }
  action settle(lane: str, outcome: str): bool = all {
    s.results.get(lane) == "running",
    s' = { ...s, results: s.results.set(lane, outcome) }
  }
  action settleLane(lane: str): bool = {
    nondet outcome = Outcomes.oneOf()
    settle(lane, outcome)
  }
  val finished = Lanes.forall(lane => s.results.get(lane) != "running")
  def expected(lane: str): str = if (lane == "quint" and not(s.promotion)) "skipped" else "success"
  val successful = Lanes.forall(lane => s.results.get(lane) == expected(lane))
  action evaluate = all {
    s.gate == "waiting", finished,
    s' = { ...s, gate: if (successful) "success" else "failure" }
  }
  action cancelWorkflow = all {
    s.gate == "waiting",
    s' = { ...s, gate: "cancelled", workflowCancelled: true }
  }
  action idle = s' = s
  action step = any {
    {
      nondet lane = Lanes.oneOf()
      settleLane(lane)
    },
    evaluate, cancelWorkflow, idle
  }
  val TypeOK = Lanes.forall(lane => Outcomes.union(Set("running")).contains(s.results.get(lane)))
    and Set("waiting", "success", "failure", "cancelled").contains(s.gate)
  val NoEarlyDecision = Set("success", "failure").contains(s.gate).implies(finished)
  val WorkflowCancellationMatchesGate = (s.gate == "cancelled") == s.workflowCancelled
  val SuccessRequiresEveryLane = (s.gate == "success").implies(successful)
  val FailureHasFailedLane = (s.gate == "failure").implies(not(successful))
  val QuintIsRequired = (s.gate == "success" and s.promotion).implies(s.results.get("quint") == "success")
  val safety = TypeOK and NoEarlyDecision and SuccessRequiresEveryLane
    and FailureHasFailedLane and QuintIsRequired and WorkflowCancellationMatchesGate
  temporal ConditionalCompletion = (Lanes.forall(lane => settleLane(lane).weakFair(s))
    and evaluate.weakFair(s)).implies(eventually(s.gate != "waiting"))
  temporal UnfairCompletion = eventually(s.gate != "waiting")

  // Test-only aggregate from the old workflow. Neither action is in step.
  action otherLanesPass = s' = { ...s, results: Lanes.mapBy(lane =>
    if (lane == "quint") s.results.get(lane) else "success") }
  action legacyGate = all {
    Lanes.exclude(Set("quint")).forall(lane => s.results.get(lane) == "success"),
    s' = { ...s, gate: "success" }
  }
  run omittedQuintAllowsPrematureSuccessTest = start(true).then(otherLanesPass)
    .then(legacyGate).expect(not(NoEarlyDecision) and not(QuintIsRequired))
  run quintFailureBlocksSuccessTest = start(true).then(otherLanesPass)
    .then(settle("quint", "failure")).then(evaluate)
    .expect(safety and s.gate == "failure")
  run quintCancellationBlocksSuccessTest = start(true).then(otherLanesPass)
    .then(settle("quint", "cancelled")).then(evaluate)
    .expect(safety and s.gate == "failure")
  run workflowCancellationCancelsGateTest = start(true).then(cancelWorkflow)
    .expect(safety and s.gate == "cancelled" and not(finished))
  run workflowCancellationAfterWorkersCancelsGateTest = start(true).then(otherLanesPass)
    .then(settle("quint", "success")).then(cancelWorkflow)
    .expect(safety and s.gate == "cancelled" and finished)
  run quintSkipBlocksSuccessTest = start(true).then(otherLanesPass)
    .then(settle("quint", "skipped")).then(evaluate)
    .expect(safety and s.gate == "failure")
  run allLanesPassTest = start(true).then(otherLanesPass)
    .then(settle("quint", "success")).then(evaluate)
    .expect(safety and s.gate == "success")
  run skippedQuintPassesOutsidePromotionTest = start(false).then(otherLanesPass)
    .then(settle("quint", "skipped")).then(evaluate)
    .expect(safety and s.gate == "success")
  run quintResultOutsidePromotionBlocksSuccessTest = start(false).then(otherLanesPass)
    .then(settle("quint", "success")).then(evaluate)
    .expect(safety and s.gate == "failure")
}

// The named Quint lane joins all workers and verifies the complete evidence
// partition before it can make the existing top-level lane successful.
module QuintShardAdmission {
  pure val Shards = Set(1, 2, 3, 4)
  pure val Outcomes = Set("success", "failure", "cancelled", "skipped")
  var s: { jobs: int -> str, proof: str, gate: str, workflowCancelled: bool }
  action init = s' = { jobs: Shards.mapBy(_ => "running"), proof: "unchecked", gate: "waiting", workflowCancelled: false }
  action settle(shard: int, outcome: str): bool = all {
    s.jobs.get(shard) == "running", s' = {...s, jobs: s.jobs.set(shard, outcome)}
  }
  action settleShard(shard: int): bool = {
    nondet outcome = Outcomes.oneOf()
    settle(shard, outcome)
  }
  val finished = Shards.forall(shard => s.jobs.get(shard) != "running")
  val workersPassed = Shards.forall(shard => s.jobs.get(shard) == "success")
  action validate(valid: bool): bool = all {
    not(s.workflowCancelled), finished, s.proof == "unchecked",
    s' = {...s, proof: if (valid) "valid" else "invalid"}
  }
  action checkEvidence = {
    nondet valid = Set(false, true).oneOf()
    validate(valid)
  }
  action evaluate = all {
    s.gate == "waiting", finished, s.proof != "unchecked",
    s' = {...s, gate: if (workersPassed and s.proof == "valid") "success" else "failure"}
  }
  action cancelWorkflow = all {
    s.gate == "waiting",
    s' = {...s, gate: "cancelled", workflowCancelled: true}
  }
  action step = any {
    {
      nondet shard = Shards.oneOf()
      settleShard(shard)
    },
    checkEvidence, evaluate, cancelWorkflow, s' = s
  }
  val safety = all {
    Shards.forall(shard => Outcomes.union(Set("running")).contains(s.jobs.get(shard))),
    Set("waiting", "success", "failure", "cancelled").contains(s.gate),
    (s.gate == "cancelled") == s.workflowCancelled,
    s.gate == "success" implies (finished and workersPassed and s.proof == "valid"),
    Set("success", "failure").contains(s.gate) implies finished,
    s.gate == "failure" implies (not(workersPassed) or s.proof == "invalid")
  }
  temporal ConditionalCompletion = (Shards.forall(shard => settleShard(shard).weakFair(s))
    and checkEvidence.weakFair(s) and evaluate.weakFair(s)) implies eventually(s.gate != "waiting")
  action workersSucceed = s' = {...s, jobs: Shards.mapBy(_ => "success")}
  action unsafeOmitWorker = s' = {...s, jobs: Shards.mapBy(shard => if (shard == 4) "running" else "success"), gate: "success"}
}

module QuintShardAdmission_required {
  import QuintShardAdmission.*
  run everyWorkerAndEvidenceRequiredTest = init.then(workersSucceed).then(validate(true)).then(evaluate)
    .expect(safety and s.gate == "success")
  run missingEvidenceCannotPassTest = init.then(workersSucceed).then(validate(false)).then(evaluate)
    .expect(safety and s.gate == "failure")
  run cancelledShardCannotPassTest = init.then(settle(1, "success"))
    .then(settle(2, "success")).then(settle(3, "success"))
    .then(settle(4, "cancelled")).then(validate(true)).then(evaluate)
    .expect(safety and s.gate == "failure")
  run workflowCancellationCancelsBeforeEvidenceTest = init.then(cancelWorkflow)
    .expect(safety and s.gate == "cancelled" and s.proof == "unchecked")
  run workflowCancellationAfterEvidenceCancelsGateTest = init.then(workersSucceed)
    .then(validate(true)).then(cancelWorkflow)
    .expect(safety and s.gate == "cancelled")
  run omittedWorkerNegativeWitnessTest = init.then(unsafeOmitWorker).expect(not(safety))
}


// Production consumes one exact-source successful main Full attempt. External
// run/artifact inputs may be missing or invalid; no success is assumed.
module MainProductionAdmission {
  var s: { attempt: int, readAttempt: int, identity: bool, rows: bool,
    staging: bool, phase: str }
  action start(identity: bool, rows: bool, staging: bool): bool =
    s' = { attempt: 1, readAttempt: 0, identity: identity, rows: rows, staging: staging, phase: "waiting" }
  action init = {
    nondet identity = Set(false, true).oneOf()
    nondet rows = Set(false, true).oneOf()
    nondet staging = Set(false, true).oneOf()
    start(identity, rows, staging)
  }
  action read = all { s.phase == "waiting", s' = { ...s, readAttempt: s.attempt, phase: "read" } }
  action rerun = all { s.phase == "read", s.attempt == 1, s' = { ...s, attempt: 2 } }
  val currentProof = s.identity and s.rows and s.staging and s.readAttempt == s.attempt
  action decide = all { s.phase == "read",
    s' = { ...s, phase: if (currentProof) "accepted" else "rejected" } }
  action step = any { read, rerun, decide, s' = s }
  val safety = Set("waiting", "read", "accepted", "rejected").contains(s.phase)
    and (s.phase == "accepted" implies currentProof)
    and (s.phase == "rejected" implies not(currentProof))
  temporal ConditionalCompletion = (read.weakFair(s) and decide.weakFair(s))
    implies eventually(Set("accepted", "rejected").contains(s.phase))
  run completeCurrentMainProofTest = start(true, true, true).then(read).then(decide)
    .expect(safety and s.phase == "accepted")
  run rerunCannotBorrowPriorAttemptTest = start(true, true, true).then(read).then(rerun).then(decide)
    .expect(safety and s.phase == "rejected")
  run wrongSourceOrRunCannotAdmitTest = start(false, true, true).then(read).then(decide)
    .expect(safety and s.phase == "rejected")
  run incompleteManifestCannotAdmitTest = start(true, false, true).then(read).then(decide)
    .expect(safety and s.phase == "rejected")
  run mainProofDoesNotReplaceStagingTest = start(true, true, false).then(read).then(decide)
    .expect(safety and s.phase == "rejected")
}
