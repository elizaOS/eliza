// Device approval HTTP protocol (device-action-routes.ts, approval-routes.ts).
// State transitions are owned by plugin-assistant's approval/device services;
// this model states the contract consumed by the host, not a second authority.
// One operation, two bounded attempts; a provider receipt differs from consent.
module api_approvals {
  var s: { phase: str, approved: bool, attempt: int, dispatched: bool, receipt: bool, uncertain: bool }
  action init = s' = { phase: "pending", approved: false, attempt: 0, dispatched: false, receipt: false, uncertain: false }
  action approve = all { s.phase == "pending", s' = s.with("phase", "approved").with("approved", true) }
  action reject = all { s.phase == "pending", s' = s.with("phase", "rejected") }
  action expire = all { s.phase.in(Set("pending", "approved", "retryable")), s' = s.with("phase", "expired") }
  action claim = all { s.phase.in(Set("approved", "retryable")), s.approved, s.attempt < 2, s' = s.with("phase", "executing").with("attempt", s.attempt + 1).with("dispatched", false) }
  action dispatch = all { s.phase == "executing", s' = s.with("dispatched", true) }
  action retryable = all { s.phase == "executing", not(s.dispatched), s' = s.with("phase", "retryable") }
  action unknown = all { s.phase == "executing", s.dispatched, s' = s.with("phase", "reconciliation_required").with("uncertain", true) }
  action complete = all { s.phase == "executing", s.dispatched, s' = s.with("phase", "done").with("receipt", true) }
  action reconcileApplied = all { s.phase == "reconciliation_required", s' = s.with("phase", "done").with("receipt", true).with("uncertain", false) }
  action reconcileNotApplied = all { s.phase == "reconciliation_required", s' = s.with("phase", "retryable").with("dispatched", false).with("uncertain", false) }
  action idle = s' = s
  action step = any { approve, reject, expire, claim, dispatch, retryable, unknown, complete, reconcileApplied, reconcileNotApplied, idle }
  val safety = all { s.phase == "done" implies (s.approved and s.receipt), s.dispatched implies s.approved, s.uncertain implies s.phase == "reconciliation_required", s.attempt >= 0, s.attempt <= 2 }
  run consentIsNotReceiptTest = init.then(approve).expect(not(s.receipt) and s.phase != "done")
  run unknownEffectNeedsReconciliationTest = init.then(approve).then(claim).then(dispatch).then(unknown).then(reconcileApplied).expect(s.phase == "done" and s.receipt)
  run preDispatchFailureMayRetryTest = init.then(approve).then(claim).then(retryable).then(claim).then(dispatch).then(complete).expect(s.attempt == 2 and s.receipt)
}
