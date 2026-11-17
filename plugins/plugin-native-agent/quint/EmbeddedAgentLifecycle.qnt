// The cloud-only embedded agent under one supervisor: the agent alone, no gateway.
// The same lifecycle runs on the device (EmbeddedAgentService) and in development
// (embeddedAgentDevelopment). A start checks its data, payload and credential before
// any child exists; a child that exits before readiness fails the start with
// "agent", as does a spawn that fails; a running child that exits is restarted
// within the budget, then the lifecycle fails with "crashed"; a failure the
// supervisor cannot classify is "runtime".
module EmbeddedAgentLifecycle {
  pure val MAX_RESTARTS = 2
  pure val CHECKS = Set("config", "payload", "storage", "credential")
  var s: {
    state: str, failure: str, phase: str, attempt: int,
    childLive: bool, ready: bool
  }
  action begin(attempt: int): bool = s' = {
    state: "starting", failure: "none", phase: "check", attempt: attempt,
    childLive: false, ready: false
  }
  action init = s' = {
    state: "stopped", failure: "none", phase: "idle", attempt: 0,
    childLive: false, ready: false
  }
  action start = all { Set("stopped", "failed").contains(s.state), begin(0) }
  action restart = begin(0)
  action stop = s' = { ...s, state: "stopped", failure: "none", phase: "idle", childLive: false }
  action settle(cause: str): bool =
    s' = { ...s, state: "failed", failure: cause, phase: "idle", childLive: false }
  action refuse = all {
    s.state == "starting", s.phase == "check",
    nondet cause = CHECKS.oneOf()
    settle(cause)
  }
  action spawnAgent = all {
    s.state == "starting", s.phase == "check",
    s' = { ...s, phase: "spawned", childLive: true }
  }
  action spawnFails = all { s.state == "starting", s.phase == "check", settle("agent") }
  action observeReady = all {
    s.state == "starting", s.phase == "spawned", s.childLive,
    s' = { ...s, state: "running", phase: "running", ready: true }
  }
  action timeout = all { s.state == "starting", s.phase == "spawned", settle("agent") }
  action failUnclassified = all { s.state == "starting", settle("runtime") }
  action observeStartupExit = all {
    s.state == "starting", s.phase == "spawned", not(s.childLive), settle("agent")
  }
  action observeCrash = all {
    s.state == "running", not(s.childLive),
    if (s.attempt < MAX_RESTARTS) begin(s.attempt + 1) else settle("crashed")
  }
  action childExits = all { s.childLive, s' = { ...s, childLive: false } }
  action advance = any {
    refuse, spawnAgent, spawnFails, observeReady, timeout, observeStartupExit, observeCrash,
    failUnclassified
  }
  action step = any { advance, start, restart, stop, childExits, s' = s }

  val FailureNamesCause = (s.state == "failed") iff (s.failure != "none")
  val RunningWasReady = s.state == "running" implies s.ready
  val ChildOnlyWhileLaunched = Set("stopped", "failed").contains(s.state) implies not(s.childLive)
  val ChecksBeforeChild = s.childLive implies Set("spawned", "running").contains(s.phase)
  val CrashedOnlyAfterReadiness = s.failure == "crashed" implies s.ready and s.attempt == MAX_RESTARTS
  val StartupFailureIsNotACrash = s.failure == "agent" implies not(s.ready)
  val BoundedRestarts = s.attempt >= 0 and s.attempt <= MAX_RESTARTS
  val safety = FailureNamesCause and RunningWasReady and ChildOnlyWhileLaunched and ChecksBeforeChild and
    CrashedOnlyAfterReadiness and StartupFailureIsNotACrash and BoundedRestarts

  val Waiting = s.state == "starting" and s.phase == "spawned"
  temporal ReadinessWaitSettles = advance.weakFair(s).implies(Waiting.leadsTo(not(Waiting)))
  temporal ReadinessWaitSettlesWithoutFairness = Waiting.leadsTo(not(Waiting))

  run startsAgentAloneTest = init.then(start).then(spawnAgent).then(observeReady)
    .expect(s.state == "running" and s.childLive and safety)
  run refusedCheckSpawnsNothingTest = init.then(start).then(refuse)
    .expect(s.state == "failed" and CHECKS.contains(s.failure) and not(s.childLive) and safety)
  run missingExecutableFailsAgentTest = init.then(start).then(spawnFails)
    .expect(s.failure == "agent" and safety)
  run unclassifiedFailureIsRuntimeTest = init.then(start).then(spawnAgent).then(failUnclassified)
    .expect(s.failure == "runtime" and not(s.childLive) and safety)
  run exitBeforeReadinessIsNotRestartedTest = init.then(start).then(spawnAgent).then(childExits)
    .then(observeStartupExit).expect(s.failure == "agent" and s.attempt == 0 and safety)
  run crashRestartsWithinBudgetTest = init.then(start).then(spawnAgent).then(observeReady)
    .then(childExits).then(observeCrash)
    .expect(s.state == "starting" and s.attempt == 1 and safety)
  run exhaustedBudgetFailsCrashedTest = init.then(start).then(spawnAgent).then(observeReady)
    .then(childExits).then(observeCrash).then(spawnAgent).then(observeReady)
    .then(childExits).then(observeCrash).then(spawnAgent).then(observeReady)
    .then(childExits).then(observeCrash)
    .expect(s.failure == "crashed" and not(s.childLive) and safety)
  run restartResetsBudgetTest = init.then(start).then(spawnAgent).then(observeReady)
    .then(childExits).then(observeCrash).then(restart)
    .expect(s.state == "starting" and s.attempt == 0 and safety)
}
