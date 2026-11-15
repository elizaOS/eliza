// One absolute monotonic deadline across drain, routing cleanup and transport quit.
// Each operation can acknowledge, fail or stall. A successful model terminal
// state means clean teardown; process termination does not prove runtime cleanup.
module shutdown_sequence {
  pure val phases = Set("drain", "cleanup", "quit")
  pure val deadline = 2
  var phase: str
  var waiting: bool
  var clock: int
  var startedAt: str -> int
  var failed: bool
  var quitCompleted: bool
  var disconnected: bool

  action init = all {
    phase' = "drain", waiting' = false, clock' = 0,
    startedAt' = phases.mapBy(_ => -1), failed' = false,
    quitCompleted' = false, disconnected' = false,
  }

  pure def nextPhase(current) = if (current == "drain") "cleanup"
    else if (current == "cleanup") "quit" else "done"

  action begin = all {
    phases.contains(phase), not(waiting), clock < deadline,
    phase' = phase, waiting' = true, clock' = clock,
    startedAt' = startedAt.set(phase, clock), failed' = failed,
    quitCompleted' = quitCompleted, disconnected' = disconnected,
  }

  action acknowledge = all {
    waiting, clock < deadline,
    phase' = nextPhase(phase), waiting' = false, clock' = clock,
    startedAt' = startedAt, failed' = failed,
    quitCompleted' = (quitCompleted or phase == "quit"),
    disconnected' = disconnected,
  }

  action reject = all {
    waiting, clock < deadline,
    phase' = nextPhase(phase), waiting' = false, clock' = clock,
    startedAt' = startedAt, failed' = true,
    quitCompleted' = quitCompleted,
    disconnected' = (disconnected or phase == "quit"),
  }

  action tick = all {
    phase != "done", clock < deadline,
    phase' = phase, waiting' = waiting, clock' = clock + 1,
    startedAt' = startedAt, failed' = failed,
    quitCompleted' = quitCompleted, disconnected' = disconnected,
  }

  action timeout = all {
    phase != "done", clock >= deadline,
    phase' = "done", waiting' = false, clock' = clock,
    startedAt' = startedAt, failed' = true,
    quitCompleted' = quitCompleted, disconnected' = true,
  }

  action idle = all {
    phase' = phase, waiting' = waiting, clock' = clock,
    startedAt' = startedAt, failed' = failed,
    quitCompleted' = quitCompleted, disconnected' = disconnected,
  }

  action step = any { begin, acknowledge, reject, tick, timeout, idle }

  val safety = all {
    phases.forall(p => startedAt.get(p) < deadline),
    phase == "done" implies quitCompleted or disconnected,
    disconnected implies failed,
    phase == "done" and not(failed) implies quitCompleted,
    clock >= deadline and phase == "done" implies failed,
  }

  run cleanShutdownTest = init.then(begin).then(acknowledge).then(begin)
    .then(acknowledge).then(begin).then(acknowledge)
    .expect(safety and phase == "done" and not(failed) and not(disconnected))
  run stalledDrainUsesSharedDeadlineTest = init.then(begin).then(tick).then(tick)
    .then(timeout).expect(safety and failed and disconnected and startedAt.get("cleanup") == -1)
  run failedDrainStillClosesTransportTest = init.then(begin).then(reject).then(begin)
    .then(acknowledge).then(begin).then(acknowledge)
    .expect(safety and failed and quitCompleted)
  run cleanupDoesNotResetBudgetTest = init.then(begin).then(tick).then(acknowledge)
    .then(begin).then(tick).then(timeout)
    .expect(safety and disconnected and startedAt.get("quit") == -1)
  run rejectedQuitDisconnectsTest = init.then(begin).then(acknowledge).then(begin)
    .then(acknowledge).then(begin).then(reject)
    .expect(safety and failed and disconnected)
}
