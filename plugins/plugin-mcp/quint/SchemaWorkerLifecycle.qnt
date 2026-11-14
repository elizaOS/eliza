// One request's isolated worker. Trusted fixed-dialect initialization precedes
// READY; untrusted schema parsing, compilation and evaluation occur afterward.
module SchemaWorkerLifecycle {
  var s: { phase: str, warmed: bool, inputDelivered: bool, result: str }
  action init = s' = { phase: "startup", warmed: false, inputDelivered: false, result: "pending" }
  action ready = all {
    s.phase == "startup",
    s' = { ...s, phase: "ready", warmed: true }
  }
  action submit = all {
    s.phase == "ready", s.warmed,
    s' = { ...s, phase: "evaluation", inputDelivered: true }
  }
  action deadline = all {
    s.phase.in(Set("startup", "evaluation")),
    s' = { ...s, phase: "terminating", result: "timeout" }
  }
  action evaluated(valid: bool): bool = all {
    s.phase == "evaluation", s.inputDelivered,
    s' = { ...s, phase: "terminating", result: if (valid) "valid" else "invalid" }
  }
  action workerError = all {
    s.phase.in(Set("startup", "ready", "evaluation")),
    s' = { ...s, phase: "terminating", result: "error" }
  }
  // The implementation waits for its termination promise to settle before
  // returning, even if that promise rejects; this does not prove OS reaping.
  action terminationSettled = all {
    s.phase == "terminating",
    s' = s.with("phase", "returned")
  }
  action advance = any { ready, submit, deadline, evaluated(true), evaluated(false), workerError, terminationSettled }
  action idle = s' = s
  action step = any { advance, idle }
  val safety = all {
    s.inputDelivered implies s.warmed,
    s.phase == "evaluation" implies s.inputDelivered,
    s.result == "valid" implies s.inputDelivered,
    s.phase == "returned" implies s.result != "pending",
    s.phase == "startup" implies not(s.inputDelivered)
  }
  temporal Settles = advance.weakFair(s).implies((s.phase != "returned").leadsTo(s.phase == "returned"))
  run validTest = init.then(ready).then(submit).then(evaluated(true)).then(terminationSettled).expect(safety and s.result == "valid")
  run invalidTest = init.then(ready).then(submit).then(evaluated(false)).then(terminationSettled).expect(safety and s.result == "invalid")
  run startupDeadlineTest = init.then(deadline).then(terminationSettled).expect(safety and s.result == "timeout" and not(s.inputDelivered))
  run evaluationDeadlineTest = init.then(ready).then(submit).then(deadline).then(terminationSettled).expect(safety and s.result == "timeout")
  run workerErrorTest = init.then(ready).then(workerError).then(terminationSettled).expect(safety and s.result == "error")
}
