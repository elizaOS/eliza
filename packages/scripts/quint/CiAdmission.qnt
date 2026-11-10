// PR validation joins seven mandatory lanes before the required aggregate check.
// Each lane settles once. Whole-workflow cancellation before aggregate dispatch
// cancels the gate; cancellation of a dependency still fails admission.
// GitHub scheduling and job completion are external.
module CiAdmission {
  pure val Lanes = Set("secret-scan", "source-checks", "sdk-owning",
    "billing-payment-replay-e2e", "subscription-authority-postgres",
    "paradee-stream-contract", "quint")
  pure val Outcomes = Set("success", "failure", "cancelled", "skipped")
  var s: { results: str -> str, gate: str, workflowCancelled: bool }
  action init = s' = { results: Lanes.mapBy(_ => "running"), gate: "waiting", workflowCancelled: false }
  action settle(lane: str, outcome: str): bool = all {
    s.results.get(lane) == "running",
    s' = { ...s, results: s.results.set(lane, outcome) }
  }
  action settleLane(lane: str): bool = {
    nondet outcome = Outcomes.oneOf()
    settle(lane, outcome)
  }
  val finished = Lanes.forall(lane => s.results.get(lane) != "running")
  val successful = Lanes.forall(lane => s.results.get(lane) == "success")
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
  val QuintIsRequired = (s.gate == "success").implies(s.results.get("quint") == "success")
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
  run omittedQuintAllowsPrematureSuccessTest = init.then(otherLanesPass)
    .then(legacyGate).expect(not(NoEarlyDecision) and not(QuintIsRequired))
  run quintFailureBlocksSuccessTest = init.then(otherLanesPass)
    .then(settle("quint", "failure")).then(evaluate)
    .expect(safety and s.gate == "failure")
  run quintCancellationBlocksSuccessTest = init.then(otherLanesPass)
    .then(settle("quint", "cancelled")).then(evaluate)
    .expect(safety and s.gate == "failure")
  run workflowCancellationCancelsGateTest = init.then(cancelWorkflow)
    .expect(safety and s.gate == "cancelled" and not(finished))
  run workflowCancellationAfterWorkersCancelsGateTest = init.then(otherLanesPass)
    .then(settle("quint", "success")).then(cancelWorkflow)
    .expect(safety and s.gate == "cancelled" and finished)
  run quintSkipBlocksSuccessTest = init.then(otherLanesPass)
    .then(settle("quint", "skipped")).then(evaluate)
    .expect(safety and s.gate == "failure")
  run allLanesPassTest = init.then(otherLanesPass)
    .then(settle("quint", "success")).then(evaluate)
    .expect(safety and s.gate == "success")
}

// The named Quint lane joins all workers and verifies the complete evidence
// partition before it can make the existing top-level lane successful.
module QuintShardAdmission {
  const ChecksRequired: bool
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
    s' = {...s, proof: if (not(ChecksRequired) or valid) "valid" else "invalid"}
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
  import QuintShardAdmission(ChecksRequired=true).*
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

module QuintShardAdmission_unchanged {
  import QuintShardAdmission(ChecksRequired=false).*
  run unchangedSourceDoesNotRequireFabricatedProofTest = init.then(workersSucceed).then(validate(false)).then(evaluate)
    .expect(safety and s.gate == "success")
  run unchangedWorkflowCancellationCancelsGateTest = init.then(workersSucceed).then(cancelWorkflow)
    .expect(safety and s.gate == "cancelled" and s.proof == "unchecked")
}
