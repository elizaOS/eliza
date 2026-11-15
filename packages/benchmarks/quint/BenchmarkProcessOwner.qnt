// The deadline monitor owns one direct Popen child from spawn through reaping.
// Observation and receipt failures retain the error while attempting cleanup.
module BenchmarkProcessOwner {
  pure val StopReasons = Set("cancel", "wall", "silent")
  var s: {
    phase: str, child: str, reason: str, event: str, outcome: str,
    errorRetained: bool, cleanupFailed: bool, observations: int, receipts: int
  }
  action init = s' = {
    phase: "spawn", child: "absent", reason: "none", event: "none", outcome: "pending",
    errorRetained: false, cleanupFailed: false, observations: 0, receipts: 0
  }
  action spawn(ok: bool): bool = all {
    s.phase == "spawn",
    s' = if (ok) { ...s, phase: "initial", child: "alive" }
      else { ...s, phase: "returned", outcome: "error", errorRetained: true }
  }
  action initialObservation = all {
    s.phase == "initial",
    s' = { ...s, phase: "receipt", event: "started" }
  }
  action outputObserved = all {
    s.phase == "monitor", s.observations < 2,
    s' = { ...s, phase: "receipt", event: "output", observations: s.observations + 1 }
  }
  action childExits = all {
    s.phase.in(Set("initial", "monitor", "receipt")), s.child == "alive",
    s' = s.with("child", "exited")
  }
  action pollExit = all {
    s.phase == "monitor", s.child == "exited",
    s' = { ...s, child: "reaped", phase: "receipt", event: "exited", reason: "exit" }
  }
  action requestStop(reason: str): bool = all {
    s.phase == "monitor", s.child == "alive", StopReasons.contains(reason),
    s' = { ...s, phase: "cleanup", reason: reason }
  }
  // A failure after the child exited polls/reaps it before raising. A live
  // child transfers to cleanup. No successful benchmark result is fabricated.
  action monitorFails = all {
    s.phase.in(Set("initial", "monitor", "receipt")),
    s' = { ...s, reason: "error", errorRetained: true, event: "none",
      child: if (s.child == "exited") "reaped" else s.child,
      phase: if (s.child == "alive") "cleanup" else "returned",
      outcome: if (s.child == "alive") "pending" else "error" }
  }
  action receiptWritten = all {
    s.phase == "receipt",
    {
      val terminal = s.event.in(Set("exited", "cancel", "wall", "silent"))
      s' = { ...s, receipts: s.receipts + 1, event: "none",
        phase: if (terminal) "returned" else "monitor",
        outcome: if (terminal) s.reason else "pending" }
    }
  }
  // The existing TERM/grace/KILL/wait helper is an external operation here.
  // A successful settlement confirms direct-child reaping. A failure may
  // retain the child and must retain an explicit error outcome.
  action cleanupSettles(ok: bool): bool = all {
    s.phase == "cleanup",
    s' = if (ok)
      { ...s, child: "reaped",
        phase: if (s.errorRetained) "returned" else "receipt",
        event: if (s.errorRetained) "none" else s.reason,
        outcome: if (s.errorRetained) "error" else "pending" }
    else if (s.errorRetained)
      { ...s, phase: "returned", outcome: "error", cleanupFailed: true }
    else
      { ...s, reason: "error", errorRetained: true }
  }
  action advance = any { receiptWritten, cleanupSettles(true), cleanupSettles(false) }
  action idle = s' = s
  action step = any {
    spawn(true), spawn(false), initialObservation, outputObserved, childExits,
    pollExit, requestStop("cancel"), requestStop("wall"), requestStop("silent"), monitorFails, advance, idle
  }

  val returned = s.phase == "returned"
  val closing = s.phase == "cleanup" or (s.phase == "receipt" and s.reason != "none")
  val safety = all {
    s.phase.in(Set("spawn", "initial", "monitor", "receipt", "cleanup", "returned")),
    s.child.in(Set("absent", "alive", "exited", "reaped")),
    s.observations >= 0, s.observations <= 2, s.receipts >= 0, s.receipts <= 4,
    returned and not(s.cleanupFailed) implies s.child.in(Set("absent", "reaped")),
    returned implies s.outcome != "pending",
    s.errorRetained and returned implies s.outcome == "error",
    s.cleanupFailed implies (returned and s.errorRetained and s.outcome == "error"),
    s.outcome.in(Set("exit", "cancel", "wall", "silent")) implies s.child == "reaped"
  }
  temporal CloseWithoutFairness = closing.leadsTo(returned)
  temporal CloseSettles = advance.weakFair(s).implies(CloseWithoutFairness)

  action begin = spawn(true).then(initialObservation).then(receiptWritten)
  run normalExitTest = init.then(begin).then(childExits).then(pollExit).then(receiptWritten)
    .expect(safety and s.child == "reaped" and s.outcome == "exit")
  run initialObservationFailureTest = init.then(spawn(true)).then(monitorFails)
    .then(cleanupSettles(true)).expect(safety and s.errorRetained and returned)
  run pollObservationFailureTest = init.then(begin).then(monitorFails).then(cleanupSettles(true))
    .expect(safety and returned and s.child == "reaped")
  run cancelledTest = init.then(begin).then(requestStop("cancel")).then(cleanupSettles(true))
    .then(receiptWritten).expect(safety and s.outcome == "cancel")
  run receiptFailureTest = init.then(begin).then(requestStop("wall")).then(cleanupSettles(true))
    .then(monitorFails).expect(safety and s.outcome == "error" and s.child == "reaped")
  run refusedCleanupTest = init.then(begin).then(monitorFails).then(cleanupSettles(false))
    .expect(safety and s.cleanupFailed and s.child == "alive")
  // The old monitor raised immediately and abandoned the launched child.
  action legacyFailureReturn = all {
    s.phase.in(Set("initial", "monitor")), s.child == "alive",
    s' = { ...s, phase: "returned", outcome: "error", errorRetained: true }
  }
  run legacyLiveChildWitnessTest = init.then(begin).then(legacyFailureReturn)
    .expect(not(safety) and s.child == "alive")
}
