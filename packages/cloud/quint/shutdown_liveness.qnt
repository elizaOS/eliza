// Temporal obligations over the unchanged public shutdown model.
// Source: services/agent-server/src/agent-shutdown.ts and agent-lifecycle.ts.
// `clock` is finite logical timer progress, not a proof about wall-clock time.
// No provider acknowledgement/success assumption is imposed. Progress assumes
// the process stays scheduled, timers can advance, and a continuously enabled
// timeout callback is eventually run. Synchronous callbacks must return.
// Fairness is conditional evidence; the runtime does not enforce the abstract
// scheduler/OS assumptions. Permanent event-loop blockage remains excluded.
module shutdown_liveness {
  import shutdown_sequence.* from "./shutdown_sequence"

  temporal termination = eventually(phase == "done")
  temporal clockProgress = tick.weakFair(clock)
  temporal timeoutDispatch = timeout.weakFair(phase)
  temporal fairTimers = clockProgress and timeoutDispatch

  // Both are expected to fail: an idle loop can suppress all progress, and
  // clock progress alone still lets an enabled timeout remain ignored forever.
  temporal terminationWithoutAssumptions = termination
  temporal terminationWithClockOnly = clockProgress implies termination
  temporal terminationWithTimeoutOnly = timeoutDispatch implies termination

  temporal terminationWithFairTimers = fairTimers implies termination
  temporal deadlineEventuallyDisconnects = fairTimers implies (
    (phase != "done" and clock >= deadline) leadsTo (phase == "done" and disconnected)
  )
  temporal terminalMeansClosedOrDisconnected = fairTimers implies eventually(
    phase == "done" and (quitCompleted or disconnected)
  )

  // Expected to fail. A counterexample witnesses an execution satisfying the
  // fairness antecedent, preventing an inconsistent-assumptions success claim.
  temporal noFairFailedExecutionExists = not(
    fairTimers and eventually(phase == "done" and failed and disconnected)
  )

  run stalledAtDeadlineWitnessTest = init.then(begin).then(tick).then(tick)
    .then(idle).expect(safety and waiting and phase == "drain" and clock == deadline)
  run timeoutWithoutProviderSuccessWitnessTest = init.then(begin).then(tick)
    .then(tick).then(timeout).expect(safety and phase == "done" and failed and disconnected)
}
