// shell/media/audio-redaction/connector/action adapters: validation before
// dispatch; distinguish failed, cancelled and uncertain effects from success.
// Provider algorithms, bytes, transport and persistence are abstract predicates.
module services_effect_pipeline {
  var s: { phase: str, validated: bool, dispatched: bool, persisted: bool, success: bool, cancelled: bool }
  action init = s' = { phase: "new", validated: false, dispatched: false, persisted: false, success: false, cancelled: false }
  action validate = all { s.phase == "new", s' = s.with("phase", "validated").with("validated", true) }
  action invalid = all { s.phase == "new", s' = s.with("phase", "failed") }
  action dispatch = all { s.phase == "validated", not(s.cancelled), s' = s.with("phase", "running").with("dispatched", true) }
  action response = all { s.phase == "running", not(s.cancelled), s' = s.with("phase", "persisting") }
  action persist = all { s.phase == "persisting", not(s.cancelled), s' = s.with("phase", "complete").with("persisted", true).with("success", true) }
  action failure = all { s.phase.in(Set("validated","running","persisting")), s' = s.with("phase", if (s.dispatched) "uncertain" else "failed") }
  action cancel = all { s.phase.in(Set("new","validated","running","persisting")), s' = s.with("phase", if (s.dispatched) "uncertain" else "cancelled").with("cancelled", true) }
  action keep = s' = s
  action step = any { validate, invalid, dispatch, response, persist, failure, cancel, keep }
  val safety = all { s.dispatched implies s.validated, s.success implies s.persisted and s.dispatched and not(s.cancelled), s.phase == "complete" implies s.success, s.cancelled implies not(s.success) }
  run cancelledAfterDispatchIsUncertainTest = init.then(validate).then(dispatch).then(cancel).expect(s.phase == "uncertain" and not(s.success))
  run persistBeforeSuccessTest = init.then(validate).then(dispatch).then(response).expect(not(s.success)).then(persist).expect(s.success)
}
