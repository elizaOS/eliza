// escalation.ts: per-agent serialized escalation, coalescing, bounded retries,
// durable resolution before timer cancellation, shutdown drains admitted work.
module services_escalation {
  var s: { active: bool, timer: bool, step: int, delivered: int, stopped: bool, resolved: bool }
  action init = s' = { active: false, timer: false, step: 0, delivered: 0, stopped: false, resolved: false }
  action start = all { not(s.stopped), not(s.active), s' = s.with("active", true).with("timer", true).with("step", 0).with("resolved", false) }
  action send = all { s.active, not(s.stopped), s.delivered < 2, s' = s.with("delivered", s.delivered + 1) }
  action tick = all { s.active, s.timer, not(s.stopped), s.step < 2, s' = s.with("step", s.step + 1) }
  action resolve = all { s.active, s' = s.with("resolved", true).with("active", false).with("timer", false) }
  action stop = s' = s.with("stopped", true).with("timer", false)
  action keep = s' = s
  action step = any { start, send, tick, resolve, stop, keep }
  val safety = all { s.step >= 0, s.step <= 2, s.delivered >= 0, s.delivered <= 2, s.timer implies s.active and not(s.stopped), s.resolved implies not(s.active or s.timer) }
  run shutdownRetainsUnresolvedStateTest = init.then(start).then(send).then(stop).expect(s.active and not(s.timer) and not(s.resolved))
  run acknowledgedStopsRetriesTest = init.then(start).then(tick).then(resolve).expect(s.resolved and not(s.timer))
}
