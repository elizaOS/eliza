// acceptance_gate._signal_posix_process_group classifies one already-owned group.
// Group discovery, PID reuse, process reaping, and signal scheduling are outside
// this bounded projection. Selection is assumed to supply an owned group.
module AcceptanceGroupSignal {
  var s: { phase: str, inspection: str, outcome: str }
  action init = s' = {
    phase: "signal", inspection: "none", outcome: "pending"
  }
  action signalSettles(result: str): bool = all {
    s.phase == "signal", result.in(Set("sent", "missing", "denied")),
    s' = { ...s, phase: if (result == "denied") "inspect" else "done",
      outcome: if (result == "denied") "pending" else result }
  }
  // A fresh snapshot follows EPERM. It may observe a group that changed state
  // after the signal. Inspection failure or malformed/empty output cannot clear it.
  action inspect(result: str): bool = all {
    s.phase == "inspect", result.in(Set("live", "zombie", "absent", "error", "malformed", "empty")),
    s' = { ...s, phase: "done", inspection: result,
      outcome: if (result.in(Set("zombie", "absent"))) "ignored" else "error" }
  }
  action settle = any {
    signalSettles("sent"), signalSettles("missing"), signalSettles("denied"),
    inspect("live"), inspect("zombie"), inspect("absent"),
    inspect("error"), inspect("malformed"), inspect("empty")
  }
  action idle = s' = s
  action step = any { settle, idle }
  val safety = all {
    s.outcome == "ignored" implies s.inspection.in(Set("zombie", "absent")),
    s.inspection.in(Set("live", "error", "malformed", "empty")) implies s.outcome == "error",
    s.phase == "done" implies s.outcome != "pending"
  }
  temporal SettlesWithFairness = settle.weakFair(s).implies((s.phase != "done").leadsTo(s.phase == "done"))
  run zombieTest = init.then(signalSettles("denied")).then(inspect("zombie"))
    .expect(safety and s.outcome == "ignored")
  run absentTest = init.then(signalSettles("denied")).then(inspect("absent"))
    .expect(safety and s.outcome == "ignored")
  run liveTest = init.then(signalSettles("denied")).then(inspect("live"))
    .expect(safety and s.outcome == "error")
  run failedInspectionTest = init.then(signalSettles("denied")).then(inspect("error"))
    .expect(safety and s.outcome == "error")
  run malformedInspectionTest = init.then(signalSettles("denied")).then(inspect("malformed"))
    .expect(safety and s.outcome == "error")
  run emptyInspectionTest = init.then(signalSettles("denied")).then(inspect("empty"))
    .expect(safety and s.outcome == "error")
}
