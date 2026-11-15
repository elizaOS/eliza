// Native-host surface-channel/client: single session epoch and single delivery.
// A delivered effect retired before reply is uncertain; automatic replay is prohibited.
module api_native_surface {
  var s: { epoch: int, connected: bool, owner: int, capturedOwner: int, pending: bool, delivered: bool, effect: bool, outcome: str, closed: bool }
  action init = s' = { epoch: 0, connected: false, owner: 1, capturedOwner: 0, pending: false, delivered: false, effect: false, outcome: "none", closed: false }
  action connect = all { not(s.closed), s.epoch < 2, not(s.pending), s' = s.with("epoch", s.epoch + 1).with("connected", true) }
  action request(effectful: bool): bool = all { s.connected, not(s.pending), s.outcome == "none", s' = s.with("pending", true).with("effect", effectful).with("capturedOwner", s.owner) }
  action pull = all { s.pending, not(s.delivered), s.connected, s.owner == s.capturedOwner, s' = s.with("delivered", true) }
  action reply = all { s.pending, s.delivered, s.connected, s.owner == s.capturedOwner, s' = s.with("pending", false).with("outcome", "complete") }
  action retire = s' = s.with("connected", false).with("pending", false).with("outcome", if (s.pending) (if (s.delivered and s.effect) "uncertain" else "stale") else s.outcome)
  action rotate = all { s.owner == 1, s' = s.with("owner", 2) }
  action close = all { not(s.pending), s' = s.with("connected", false).with("closed", true) }
  action idle = s' = s
  action step = any { connect, request(true), request(false), pull, reply, retire, rotate, close, idle }
  val safety = all { s.outcome == "complete" implies s.delivered, s.outcome == "uncertain" implies (s.delivered and s.effect), s.closed implies not(s.connected), s.pending implies s.outcome == "none" }
  run deliveredEffectBecomesUnknownTest = init.then(connect).then(request(true)).then(pull).then(retire).expect(s.outcome == "uncertain")
  run undeliveredCancellationIsStaleTest = init.then(connect).then(request(true)).then(retire).expect(s.outcome == "stale")
  run newOwnerCannotAcceptOldReplyTest = init.then(connect).then(request(false)).then(pull).then(rotate).then(retire).expect(s.outcome == "stale")
}
