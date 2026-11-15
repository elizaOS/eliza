// Maps native device relay and generic device request lifecycle.
// An offer is bound to one authenticated device scope, active turn and conversation.
// At-most-one delivery means a lost transport response has unknown outcome, not replay.
module api_device_relay {
  var s: { offer: bool, enrolled: bool, turn: bool, pending: bool, delivered: bool, deliveries: int, expired: bool, done: bool }
  action init = s' = { offer: false, enrolled: true, turn: true, pending: false, delivered: false, deliveries: 0, expired: false, done: false }
  action open = all { s.enrolled, not(s.offer), not(s.done), s' = s.with("offer", true) }
  action dispatch = all { s.offer, s.enrolled, s.turn, not(s.pending), not(s.expired), not(s.done), s' = s.with("pending", true) }
  action poll = all { s.offer, s.enrolled, s.turn, s.pending, not(s.delivered), not(s.expired), s' = s.with("delivered", true).with("deliveries", s.deliveries + 1) }
  action revoke = s' = s.with("enrolled", false)
  action endTurn = s' = s.with("turn", false)
  action expire = s' = s.with("expired", true)
  action result = all { s.offer, s.enrolled, s.turn, s.pending, s.delivered, not(s.expired), s' = s.with("pending", false).with("done", true) }
  action retire = s' = s.with("offer", false).with("pending", false).with("done", true)
  action timeout = all { s.pending, s.expired, s' = s.with("pending", false).with("done", true) }
  action idle = s' = s
  action step = any { open, dispatch, poll, revoke, endTurn, expire, result, retire, timeout, idle }
  val safety = all { s.deliveries <= 1, s.deliveries >= 0, s.pending implies s.offer, s.done implies not(s.pending), s.delivered implies s.deliveries == 1 }
  run lostResponseCannotReplayTest = init.then(open).then(dispatch).then(poll).then(expire).then(timeout).expect(s.deliveries == 1 and s.done)
  run revokeBeforeDeliveryTest = init.then(open).then(dispatch).then(revoke).then(retire).expect(s.deliveries == 0)
  run acknowledgedDeviceEffectTest = init.then(open).then(dispatch).then(poll).then(result).expect(s.done and s.deliveries == 1)
}
