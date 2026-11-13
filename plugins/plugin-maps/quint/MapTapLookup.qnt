module MapTapLookup {
  type State = { next: int, selected: int, pending: int, applied: int, alive: bool }
  var s: State
  action init = s' = { next: 0, selected: -1, pending: -1, applied: -1, alive: true }
  action tap = all {
    s.alive, s.next < 3,
    s' = s.with("selected", s.next).with("pending", s.next).with("next", s.next + 1).with("applied", -1),
  }
  action reply(token: int): bool = all {
    token >= 0, token < s.next,
    s' = if (s.alive and token == s.pending and token == s.selected) {
      s.with("pending", -1).with("applied", token)
    } else s,
  }
  action close = s' = s.with("selected", -1).with("pending", -1).with("applied", -1)
  action dispose = s' = s.with("alive", false).with("selected", -1).with("pending", -1).with("applied", -1)
  action step = { nondet token = 0.to(2).oneOf(); any { tap, reply(token), close, dispose } }
  val safety = s.applied >= 0 implies (s.alive and s.applied == s.selected and s.pending == -1)
  run currentTapTest = init.then(tap).then(reply(0)).expect(safety and s.applied == 0)
  run newerTapTest = init.then(tap).then(tap).then(reply(0)).expect(safety and s.applied == -1)
  run closedTapTest = init.then(tap).then(close).then(reply(0)).expect(safety and s.applied == -1)
  run disposedTapTest = init.then(tap).then(dispose).then(reply(0)).expect(safety and s.applied == -1)
}
