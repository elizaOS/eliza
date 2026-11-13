// PendingRequestMap and PTY reconnect grace. Each request/timer has a generation.
// A stale timeout cannot remove its replacement; reconnect is rechecked on fire.
module api_transport {
  var s: { waiter: int, settled: Set[int], generation: int, live: bool, timer: int, stopped: bool, closed: bool }
  action init = s' = { waiter: 0, settled: Set(), generation: 0, live: true, timer: 0, stopped: false, closed: false }
  action wait(g: int): bool = all { not(s.closed), not(s.settled.contains(g)), s.waiter != g, s' = s.with("waiter", g).with("settled", if (s.waiter != 0) s.settled.union(Set(s.waiter)) else s.settled) }
  action settle(g: int): bool = all { s.waiter == g, s' = s.with("waiter", 0).with("settled", s.settled.union(Set(g))) }
  action timeout(g: int): bool = if (s.waiter == g) settle(g) else s' = s
  action disconnect = all { not(s.closed), not(s.stopped), s.generation < 2, s' = s.with("live", false).with("generation", s.generation + 1).with("timer", s.generation + 1) }
  action reconnect = all { not(s.closed), not(s.stopped), s' = s.with("live", true).with("timer", 0) }
  action fire(g: int): bool = if (s.timer == g and not(s.live)) s' = s.with("timer", 0).with("stopped", true) else s' = s
  action close = s' = s.with("closed", true).with("live", false).with("timer", 0).with("settled", if (s.waiter != 0) s.settled.union(Set(s.waiter)) else s.settled).with("waiter", 0)
  action idle = s' = s
  action step = any { wait(1), wait(2), settle(1), settle(2), timeout(1), timeout(2), disconnect, reconnect, fire(1), fire(2), close, idle }
  val safety = all { s.waiter != 0 implies not(s.settled.contains(s.waiter)), s.live implies not(s.stopped), s.closed implies s.waiter == 0, s.timer <= s.generation }
  run staleTimerKeepsNewWaiterTest = init.then(wait(1)).then(wait(2)).then(timeout(1)).expect(s.waiter == 2).then(settle(2)).expect(safety)
  run reconnectPreservesPtyTest = init.then(disconnect).then(reconnect).then(fire(1)).expect(not(s.stopped))
}
