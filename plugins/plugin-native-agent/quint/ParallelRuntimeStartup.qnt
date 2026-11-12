// One existing supervisor scope, two named children, three private publications.
// Readiness means the host has observed a successful authenticated probe.
module ParallelRuntimeStartup {
  var s: {
    publication: int, phase: str, retired: bool,
    agentStarted: bool, gatewayStarted: bool, brokerOpened: bool,
    agentLive: bool, gatewayLive: bool, brokerLive: bool,
    agentReady: bool, gatewayReady: bool, running: bool,
    disposed: bool, cleanupFailed: bool, killRequested: bool
  }
  action init = s' = {
    publication: 0, phase: "publish", retired: false,
    agentStarted: false, gatewayStarted: false, brokerOpened: false,
    agentLive: false, gatewayLive: false, brokerLive: false,
    agentReady: false, gatewayReady: false, running: false,
    disposed: false, cleanupFailed: false, killRequested: false
  }
  action publish = all {
    not(s.retired), s.phase == "publish", s.publication < 3,
    s' = { ...s, publication: s.publication + 1,
      phase: if (s.publication == 2) "agent" else "publish" }
  }
  action spawnAgent = all {
    not(s.retired), s.phase == "agent", s.publication == 3,
    s' = { ...s, agentStarted: true, agentLive: true, phase: "broker" }
  }
  action openBroker = all {
    not(s.retired), s.phase == "broker",
    s' = { ...s, brokerOpened: true, brokerLive: true, phase: "gateway" }
  }
  action spawnGateway = all {
    not(s.retired), s.phase == "gateway",
    s' = { ...s, gatewayStarted: true, gatewayLive: true, phase: "wait-agent" }
  }
  action observeAgentReady = all {
    not(s.retired), s.phase == "wait-agent", s.agentLive, s.gatewayLive,
    s' = { ...s, agentReady: true, phase: "wait-gateway" }
  }
  action observeGatewayReady = all {
    not(s.retired), s.phase == "wait-gateway", s.agentLive, s.gatewayLive,
    s' = { ...s, gatewayReady: true, phase: "admit" }
  }
  action admitRunning = all {
    not(s.retired), s.phase == "admit", s.agentLive, s.gatewayLive,
    s' = { ...s, running: true, phase: "running" }
  }
  action retire = all {
    not(s.retired),
    s' = { ...s, retired: true, running: false, phase: "cleanup" }
  }
  action timeout = all {
    Set("wait-agent", "wait-gateway").contains(s.phase), retire
  }
  action exitAgent = all {
    not(s.retired), s.agentLive, s' = { ...s, agentLive: false }
  }
  action exitGateway = all {
    not(s.retired), s.gatewayLive, s' = { ...s, gatewayLive: false }
  }
  action observeFailure = all {
    any {
      s.agentStarted and not(s.agentLive),
      s.gatewayStarted and not(s.gatewayLive)
    }, retire
  }
  // Scope.close requests destruction. Process.destroyForcibly does not
  // acknowledge physical exit; the existing JVM tests wait for it separately.
  action cleanupSuccess = all {
    s.retired, s.phase == "cleanup",
    s' = { ...s, brokerLive: false, killRequested: true,
      disposed: true, phase: "closed" }
  }
  // Failed cleanup may leave the broker and children live. No reclamation
  // receipt follows merely from attempted destruction or a thrown exception.
  action cleanupFailure = all {
    s.retired, s.phase == "cleanup", s.brokerOpened,
    s' = { ...s, killRequested: true,
      cleanupFailed: true, phase: "cleanup-failed" }
  }
  action cleanup = any { cleanupSuccess, cleanupFailure }
  action observeAgentTermination = all {
    s.retired, s.killRequested, s.agentLive,
    s' = { ...s, agentLive: false }
  }
  action observeGatewayTermination = all {
    s.retired, s.killRequested, s.gatewayLive,
    s' = { ...s, gatewayLive: false }
  }
  action advance = any {
    publish, spawnAgent, openBroker, spawnGateway,
    observeAgentReady, observeGatewayReady, admitRunning, timeout, observeFailure
  }
  action rejectForeignProbe = s' = s
  action step = any { advance, retire, cleanup, exitAgent, exitGateway,
    observeAgentTermination, observeGatewayTermination, s' = s }

  val PublicationsBeforeChildren =
    (s.agentStarted or s.gatewayStarted) implies s.publication == 3
  val OwnedGateway = s.gatewayStarted implies s.agentStarted and s.brokerOpened
  val ReadinessOrder = s.gatewayReady implies s.agentReady and s.gatewayStarted
  val RunningNeedsReadiness = s.running implies s.agentReady and s.gatewayReady and not(s.retired)
  val DisposedFencesScope = s.disposed implies
    s.retired and not(s.running) and not(s.brokerLive)
  val ChildrenStopped = not(s.agentLive) and not(s.gatewayLive)
  val safety = PublicationsBeforeChildren and OwnedGateway and ReadinessOrder and
    RunningNeedsReadiness and DisposedFencesScope

  temporal StartupSettlesWithoutFairness = true.leadsTo(s.running or s.retired)
  temporal StartupSettles = advance.weakFair(s).implies(StartupSettlesWithoutFairness)
  temporal RetirementSettlesWithoutFairness = s.retired.leadsTo(s.disposed or s.cleanupFailed)
  temporal RetirementSettles = cleanup.weakFair(s).implies(RetirementSettlesWithoutFairness)
  temporal ChildExitSettlesWithoutFairness =
    ((s.agentStarted and not(s.agentLive)) or (s.gatewayStarted and not(s.gatewayLive))).leadsTo(s.retired)
  temporal ChildExitSettles = advance.weakFair(s).implies(ChildExitSettlesWithoutFairness)
  // Physical exit requires independent observations after a kill request.
  // Fairness here is an environmental assumption, not a property of close().
  temporal ObservedTerminationProgress =
    (observeAgentTermination.weakFair(s) and observeGatewayTermination.weakFair(s)) implies
      always(s.disposed implies eventually(ChildrenStopped))
  temporal UnconditionalTerminationProgress = s.disposed.leadsTo(ChildrenStopped)
  temporal RetirementMonotone = always((s.retired implies next(s.retired)).orKeep(s))

  run startsBothBeforeReadinessTest = init.then(publish).then(publish).then(publish)
    .then(spawnAgent).then(openBroker).then(spawnGateway)
    .expect(s.agentLive and s.gatewayLive and not(s.agentReady) and not(s.running) and safety)
  run bothReadinessChecksPrecedeRunningTest = init.then(publish).then(publish).then(publish)
    .then(spawnAgent).then(openBroker).then(spawnGateway)
    .then(observeAgentReady).then(observeGatewayReady).then(admitRunning)
    .expect(s.running and safety)
  run publicationCancellationSpawnsNothingTest = init.then(publish).then(retire)
    .then(cleanupSuccess).expect(not(s.agentStarted) and not(s.brokerOpened) and s.disposed and safety)
  run gatewayExitRetiresBothChildrenTest = init.then(publish).then(publish).then(publish)
    .then(spawnAgent).then(openBroker).then(spawnGateway).then(exitGateway)
    .then(observeFailure).then(cleanupSuccess).then(observeAgentTermination)
    .expect(s.disposed and ChildrenStopped and not(s.brokerLive) and safety)
  run foreignProbeCannotAdmitReadinessTest = init.then(publish).then(publish).then(publish)
    .then(spawnAgent).then(openBroker).then(spawnGateway).then(rejectForeignProbe)
    .expect(not(s.agentReady) and not(s.gatewayReady) and not(s.running) and safety)
  run cancelledScopeIgnoresLateReadinessTest = init.then(publish).then(publish).then(publish)
    .then(spawnAgent).then(openBroker).then(spawnGateway).then(retire).then(rejectForeignProbe)
    .expect(not(s.running) and not(s.agentReady) and safety)
  run timeoutClosesPairTest = init.then(publish).then(publish).then(publish)
    .then(spawnAgent).then(openBroker).then(spawnGateway).then(timeout).then(cleanupSuccess)
    .expect(s.disposed and s.agentLive and s.gatewayLive and safety)
    .then(observeAgentTermination).then(observeGatewayTermination)
    .expect(ChildrenStopped and safety)
  run cleanupFailureRemainsVisibleTest = init.then(publish).then(publish).then(publish)
    .then(spawnAgent).then(openBroker).then(spawnGateway).then(retire).then(cleanupFailure)
    .expect(s.cleanupFailed and not(s.disposed) and not(s.running) and
      s.agentLive and s.gatewayLive and s.brokerLive and safety)
  run killRequestDoesNotObserveTerminationTest = init.then(publish).then(publish).then(publish)
    .then(spawnAgent).then(openBroker).then(spawnGateway).then(retire).then(cleanupSuccess)
    .expect(s.disposed and s.killRequested and s.agentLive and s.gatewayLive and safety)
    .then(observeAgentTermination).then(observeGatewayTermination)
    .expect(ChildrenStopped and safety)

}
