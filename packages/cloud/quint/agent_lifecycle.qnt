// AgentLifecycle / AgentManager: one agent, arbitrary asynchronous completion order.
// Source: packages/cloud/services/agent-server/src/agent-manager.ts
// Abstraction: runtime initialize/stop and Redis publication acknowledge independently;
// failures may repeat forever. Safety does not assume eventual network recovery.
// This is the per-agent projection; cross-agent capacity is outside its scope.
module agent_lifecycle {
  type State = {
    phase: str,
    runtimeLive: bool,
    pending: str,
    draining: bool,
    shutdownComplete: bool
  }

  var s: State

  action init = s' = {
    phase: "absent", runtimeLive: false, pending: "none",
    draining: false, shutdownComplete: false
  }

  action start = all {
    s.phase == "absent", not(s.draining),
    s' = s.with("phase", "starting")
  }

  action construct = all {
    s.phase == "starting",
    s' = s.with("phase", "initializing").with("runtimeLive", true)
  }

  action initialized = all {
    s.phase == "initializing",
    s' = s.with("phase", if (s.draining) "stopping" else "publishing")
  }

  action published = all {
    s.phase == "publishing",
    s' = s.with("phase", if (s.draining) "stopping" else "running")
  }

  action startupFailed = all {
    Set("initializing", "publishing").contains(s.phase),
    s' = s.with("phase", "stopping").with("pending", "delete")
  }

  // Latest develop rejects a mutation while initialization owns the reservation.
  // Mutations admitted once publication begins serialize with the start owner.
  action requestDelete = all {
    Set("publishing", "running", "stopping", "stopped").contains(s.phase),
    s' = s.with("pending", "delete")
  }

  action requestStop = all {
    Set("publishing", "running", "stopping", "stopped").contains(s.phase),
    s.pending != "delete",
    s' = s.with("pending", "stop")
  }

  action rejectInitializingMutation = all {
    Set("starting", "initializing").contains(s.phase), s' = s
  }

  action beginStop = all {
    s.phase == "running", s.pending != "none" or s.draining,
    s' = s.with("phase", "stopping")
  }

  action stopped = all {
    s.phase == "stopping",
    s' = s.with("phase", "stopped").with("runtimeLive", false)
  }

  // A failed stop retains its runtime and reservation so a later retry can
  // clean it up; no capacity is released on an unacknowledged side effect.
  action stopFailed = all { s.phase == "stopping", s' = s }

  action deleted = all {
    s.phase == "stopped", s.pending == "delete",
    s' = s.with("phase", "absent").with("pending", "none")
  }

  action drain = s' = s.with("draining", true)

  action finishShutdown = all {
    s.draining, not(s.runtimeLive), Set("absent", "stopped").contains(s.phase),
    s' = s.with("shutdownComplete", true)
  }

  action rejectStartAfterDrain = all { s.draining, s.phase == "absent", s' = s }
  action idle = s' = s

  action step = any {
    start, construct, initialized, published, startupFailed,
    requestDelete, requestStop, rejectInitializingMutation,
    beginStop, stopped, stopFailed, deleted,
    drain, finishShutdown, rejectStartAfterDrain, idle
  }

  val safety = all {
    Set("absent", "stopped").contains(s.phase).implies(not(s.runtimeLive)),
    Set("initializing", "publishing", "running", "stopping").contains(s.phase)
      .implies(s.runtimeLive),
    s.shutdownComplete.implies(s.draining and not(s.runtimeLive))
  }

  run deleteDuringStartupTest = init.then(start).then(rejectInitializingMutation)
    .then(construct).then(initialized).then(published).then(requestDelete).then(beginStop)
    .then(stopped).then(deleted).expect(s.phase == "absent" and safety)

  run drainDuringStartupTest = init.then(start).then(construct).then(drain)
    .then(initialized).then(stopped).then(finishShutdown)
    .expect(s.shutdownComplete and safety)

  run failedStartupCleanupRetainsRuntimeTest = init.then(start).then(construct)
    .then(startupFailed).then(stopFailed)
    .expect(s.phase == "stopping" and s.runtimeLive and safety)

  run failedPublicationStopsRuntimeTest = init.then(start).then(construct)
    .then(initialized).then(startupFailed).then(stopped).then(deleted)
    .expect(s.phase == "absent" and safety)

  run noAdmissionAfterShutdownTest = init.then(drain).then(finishShutdown)
    .then(rejectStartAfterDrain).expect(s.phase == "absent" and safety)

  // Historical regression witness: delete acknowledged a "stopped" startup
  // reservation while initialize was still live. Latest develop rejects this.
  // Kept outside step: only the corrected transitions are explored above.
  action legacyDeleteDuringStartup = all {
    s.phase == "initializing", s' = s.with("phase", "absent")
  }
  run legacyDeleteRaceDetectedTest = init.then(start).then(construct)
    .then(legacyDeleteDuringStartup).expect(not(safety))
}
