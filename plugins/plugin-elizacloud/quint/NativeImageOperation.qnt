/// One image description, one optional native payer, at most four transport attempts.
module NativeImageOperation {
  var s: { phase: str, native: bool, operation: int, sentOperation: int,
    attempts: int, fundingFailure: bool, fallback: bool }
  action init = s' = { phase: "idle", native: false, operation: 0,
    sentOperation: 0, attempts: 0, fundingFailure: false, fallback: false }
  action begin(native: bool): bool = all { s.phase == "idle",
    s' = { ...s, phase: "prepared", native: native, operation: if(native) 1 else 0 } }
  action send = all { s.phase == "prepared", s.attempts < 4,
    s' = { ...s, phase: "active", attempts: s.attempts + 1, sentOperation: s.operation } }
  action retry = all { s.phase == "active", s.attempts < 4,
    s' = { ...s, phase: "prepared" } }
  action complete = all { s.phase == "active", s' = { ...s, phase: "complete" } }
  action rejectRequest = all { s.phase == "active",
    s' = { ...s, phase: "failed", fundingFailure: s.native } }
  action fallback = all { s.phase == "failed", not(s.fundingFailure),
    s' = { ...s, fallback: true } }
  action cancel = all { Set("prepared", "active").contains(s.phase),
    s' = { ...s, phase: "cancelled" } }
  action settle = any { complete, rejectRequest, cancel }
  action step = any { begin(true), begin(false), send, retry, settle, fallback, s'=s }
  val terminal = Set("complete", "failed", "cancelled").contains(s.phase)
  val safety = s.attempts <= 4 and
    (s.attempts > 0 implies s.sentOperation == s.operation) and
    (s.native and s.attempts > 0 implies s.operation == 1) and
    (not(s.native) implies s.operation == 0) and
    (s.fundingFailure implies s.native and not(s.fallback))
  temporal Settles = settle.weakFair(s) implies
    always(Set("prepared", "active").contains(s.phase) implies eventually(terminal))
  run nativeRetryTest = init.then(begin(true)).then(send).then(retry).then(send)
    .then(complete).expect(s.operation == 1 and s.attempts == 2 and safety)
  run nativeFailureTest = init.then(begin(true)).then(send).then(rejectRequest)
    .expect(s.fundingFailure and not(s.fallback) and safety)
  run prepaidTest = init.then(begin(false)).then(send).then(rejectRequest).then(fallback)
    .expect(s.fallback and s.operation == 0 and safety)
  run cancelledTest = init.then(begin(true)).then(send).then(retry).then(cancel)
    .expect(s.phase == "cancelled" and safety)
}
