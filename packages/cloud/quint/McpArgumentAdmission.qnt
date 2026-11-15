// One already authorized invocation; the schema validator owns argument admission.
module McpArgumentAdmission {
  var s: { valid: bool, serverOk: bool, phase: str, calls: int, success: bool }
  action initialize(valid: bool, serverOk: bool): bool =
    s' = { valid: valid, serverOk: serverOk, phase: "validate", calls: 0, success: false }
  action init = {
    nondet valid = Set(false, true).oneOf()
    nondet serverOk = Set(false, true).oneOf()
    initialize(valid, serverOk)
  }
  action validate = all {
    s.phase == "validate",
    s' = s.with("phase", if (s.valid) "admitted" else "done")
  }
  action dispatch = all {
    s.phase == "admitted",
    s' = { ...s, phase: "waiting", calls: 1 }
  }
  action settle = all {
    s.phase == "waiting",
    s' = { ...s, phase: "done", success: s.serverOk }
  }
  action advance = any { validate, dispatch, settle }
  action step = any { advance, s' = s }
  val safe = all {
    s.calls.in(Set(0, 1)),
    not(s.valid) implies s.calls == 0,
    s.success implies (s.valid and s.serverOk and s.calls == 1)
  }
  temporal Settles = advance.weakFair(s) implies (s.phase == "validate").leadsTo(s.phase == "done")
  run admittedTest = initialize(true, true).then(validate).then(dispatch)
    .then(settle).expect(safe and s.success)
  action legacyWarnAndDispatch = all {
    s.phase == "validate", not(s.valid),
    s' = { ...s, phase: "waiting", calls: 1 }
  }
  run legacyInvalidDispatchTest = initialize(false, true)
    .then(legacyWarnAndDispatch).expect(not(safe))
}
