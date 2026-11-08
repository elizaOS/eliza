// PR validation joins seven mandatory lanes before the required aggregate check.
// Each lane settles once. GitHub scheduling and job completion are external.
module CiAdmission {
  pure val Lanes = Set("secret-scan", "source-checks", "sdk-owning",
    "billing-payment-replay-e2e", "subscription-authority-postgres",
    "paradee-stream-contract", "quint")
  pure val Outcomes = Set("success", "failure", "cancelled", "skipped")
  var s: { results: str -> str, gate: str }
  action init = s' = { results: Lanes.mapBy(_ => "running"), gate: "waiting" }
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
  action idle = s' = s
  action step = any {
    {
      nondet lane = Lanes.oneOf()
      settleLane(lane)
    },
    evaluate, idle
  }
  val TypeOK = Lanes.forall(lane => Outcomes.union(Set("running")).contains(s.results.get(lane)))
    and Set("waiting", "success", "failure").contains(s.gate)
  val NoEarlyDecision = (s.gate != "waiting").implies(finished)
  val SuccessRequiresEveryLane = (s.gate == "success").implies(successful)
  val FailureHasFailedLane = (s.gate == "failure").implies(not(successful))
  val QuintIsRequired = (s.gate == "success").implies(s.results.get("quint") == "success")
  val safety = TypeOK and NoEarlyDecision and SuccessRequiresEveryLane
    and FailureHasFailedLane and QuintIsRequired
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
  run quintSkipBlocksSuccessTest = init.then(otherLanesPass)
    .then(settle("quint", "skipped")).then(evaluate)
    .expect(safety and s.gate == "failure")
  run allLanesPassTest = init.then(otherLanesPass)
    .then(settle("quint", "success")).then(evaluate)
    .expect(safety and s.gate == "success")
}
