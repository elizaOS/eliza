// One scenario process owns its environment and mock redirect until cleanup.
module ScenarioRuntimeOwnership {
  const Live: bool
  const ConfiguredMock: bool
  var s: { phase: str, active: bool, envMock: bool, runtimeMock: bool,
    fetchOwned: bool, deniedSecond: bool, rejected: bool }
  action init = s' = { phase: "idle", active: false, envMock: false,
    runtimeMock: false, fetchOwned: false, deniedSecond: false, rejected: false }
  action acquire = all { s.phase == "idle", s' = {...s, phase: "prepare", active: true} }
  action prepare = all { s.phase == "prepare", s' = {...s,
    phase: "configure", envMock: true, fetchOwned: true} }
  action configure = all { s.phase == "configure", s' = {...s,
    phase: if (Live and ConfiguredMock) "closing" else "ready",
    rejected: Live and ConfiguredMock,
    envMock: if (Live and ConfiguredMock) s.envMock else not(Live),
    runtimeMock: not(Live)} }
  action secondAcquire = all { s.active, s' = {...s, deniedSecond: true} }
  action close = all { Set("prepare", "configure", "ready").contains(s.phase),
    s' = {...s, phase: "closing"} }
  action cleanup(success: bool): bool = all { s.phase == "closing", s' = {...s,
    phase: if (success) "closed" else "failed", active: not(success),
    envMock: false, fetchOwned: false} }
  action step = any { acquire, prepare, configure, secondAcquire, close,
    cleanup(true), cleanup(false), s' = s }
  val TypeOK = Set("idle", "prepare", "configure", "ready", "closing", "closed", "failed").contains(s.phase)
  val LiveHasNoMockEndpoint = Live and s.phase == "ready" implies not(s.envMock or s.runtimeMock)
  val BadLiveSelectionCannotStart = Live and ConfiguredMock implies s.phase != "ready"
  val ClosedRestoresProcess = Set("closed", "failed").contains(s.phase) implies not(s.envMock or s.fetchOwned)
  val FailedCleanupQuarantinesOwner = s.phase == "failed" implies s.active
  val ActiveUntilCleanup = Set("prepare", "configure", "ready", "closing").contains(s.phase) implies s.active
  temporal CleanupSettles = any {cleanup(true), cleanup(false)}.weakFair(s)
    implies (s.phase == "closing").leadsTo(Set("closed", "failed").contains(s.phase))
  run selectionMatchesLane = init.then(acquire).then(prepare).then(configure)
    .expect(LiveHasNoMockEndpoint and BadLiveSelectionCannotStart)
  run failedCleanupKeepsOwnership = init.then(acquire).then(close).then(cleanup(false))
    .then(secondAcquire).expect(FailedCleanupQuarantinesOwner and s.deniedSecond)
}
module ScenarioRuntimeLive { import ScenarioRuntimeOwnership(Live = true, ConfiguredMock = false).* }
module ScenarioRuntimeBadLive { import ScenarioRuntimeOwnership(Live = true, ConfiguredMock = true).* }
module ScenarioRuntimeDeterministic { import ScenarioRuntimeOwnership(Live = false, ConfiguredMock = true).* }
