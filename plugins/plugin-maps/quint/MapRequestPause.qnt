module MapRequestPause {
  type State = { now: int, until: int, generation: int, pending: int, calls: int, invalidStart: bool }
  var s: State
  action init = s' = { now: 0, until: 0, generation: 0, pending: -1, calls: 0, invalidStart: false }
  action request = all {
    s.now >= s.until, s.calls < 3,
    s' = s.with("pending", s.generation).with("calls", s.calls + 1).with("invalidStart", s.now < s.until),
  }
  action refusal(token: int): bool = s' = if (token == s.generation and s.pending == token) {
    s.with("until", 3).with("pending", -1)
  } else s
  action tick = all { s.now < 3, s' = s.with("now", s.now + 1) }
  action reopen = s' = s.with("pending", -1)
  action retire = all { s.generation < 2, s' = s.with("generation", s.generation + 1).with("until", 0).with("pending", -1) }
  action step = { nondet token = 0.to(2).oneOf(); any { request, refusal(token), tick, reopen, retire } }
  val safety = not(s.invalidStart)
  run pausedRequestTest = init.then(request).then(refusal(0)).expect(s.calls == 1 and s.until > s.now)
  run reopenKeepsPauseTest = init.then(request).then(refusal(0)).then(reopen).expect(s.until == 3)
  run expiryResumesTest = init.then(request).then(refusal(0)).then(tick).then(tick).then(tick).then(request).expect(s.calls == 2)
  run retiredReplyTest = init.then(request).then(retire).then(refusal(0)).expect(s.until == 0)
}
