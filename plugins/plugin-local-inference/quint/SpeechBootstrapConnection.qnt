// The transport keeps the existing consent -> session -> socket order.
module SpeechBootstrapConnection {
  var s: { phase: int, http1: bool, keepAlive: bool, connections: int, pending: bool, stopped: bool }
  action start(http1: bool, keepAlive: bool): bool = s' = {
    phase: 0, http1: http1, keepAlive: keepAlive, connections: 0, pending: false, stopped: false
  }
  action init = {
    nondet http1 = Set(true, false).oneOf()
    nondet keepAlive = Set(true, false).oneOf()
    start(http1, keepAlive)
  }
  action request = all {
    not(s.stopped), s.phase < 3, not(s.pending),
    s' = { ...s, pending: true, connections: s.connections +
      (if (s.phase == 0 or not(s.keepAlive) or (s.phase == 2 and not(s.http1))) 1 else 0) }
  }
  action complete = all {
    s.pending, not(s.stopped),
    s' = { ...s, phase: s.phase + 1, pending: false }
  }
  action stop = all {
    s.phase < 3, not(s.stopped), s' = { ...s, pending: false, stopped: true }
  }
  action progress = any { request, complete, stop }
  action step = any { progress, s' = s }
  val TypeOK = s.phase.in(0.to(3)) and s.connections.in(0.to(3))
  val ReuseWhenCompatible = (s.http1 and s.keepAlive) implies s.connections <= 1
  val WebSocketAfterBootstrap = s.phase == 3 implies s.connections >= 1 and not(s.pending)
  val StopSettles = s.stopped implies not(s.pending)
  temporal SettlesWithoutFairness = (s.phase < 3 and not(s.stopped)).leadsTo(s.phase == 3 or s.stopped)
  temporal Settles = progress.weakFair(s).implies(SettlesWithoutFairness)
  run http1ReusesTest = start(true, true).then(request).then(complete)
    .then(request).then(complete).then(request).then(complete).expect(s.connections == 1)
  run http2NeedsNewUpgradeTest = start(false, true).then(request).then(complete)
    .then(request).then(complete).then(request).then(complete).expect(s.connections == 2)
  run closedSocketReconnectsTest = start(true, false).then(request).then(complete)
    .then(request).then(complete).then(request).then(complete).expect(s.connections == 3)
  run stoppedRequestSettlesTest = start(true, true).then(request).then(stop).expect(StopSettles)
}
