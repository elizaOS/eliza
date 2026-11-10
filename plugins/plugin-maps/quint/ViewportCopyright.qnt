// Up to two moves outside attributed bounds and three metadata requests, including late replies and disposal.
module ViewportCopyright {
  type State = { view: int, next: int, pending: int, requestedView: int, shown: int, visible: bool, failed: bool, alive: bool }
  var s: State
  action init = s' = { view: 0, next: 0, pending: -1, requestedView: -1, shown: -1, visible: false, failed: false, alive: true }
  action move = all {
    s.alive, s.view < 2,
    s' = s.with("view", s.view + 1).with("pending", -1).with("visible", false).with("shown", -1),
  }
  action request = all {
    s.alive, s.next < 3,
    s' = s.with("pending", s.next).with("next", s.next + 1).with("requestedView", s.view).with("visible", false).with("shown", -1),
  }
  action reply(token: int, success: bool): bool = all {
    token >= 0, token < s.next,
    s' = if (s.alive and token == s.pending) {
      s.with("pending", -1).with("shown", if (success) s.requestedView else -1).with("visible", success).with("failed", not(success))
    } else s,
  }
  action dispose = s' = s.with("alive", false).with("pending", -1).with("visible", false).with("shown", -1)
  action insideAttributedArea = s' = s
  action step = {
    nondet token = 0.to(2).oneOf()
    nondet success = Bool.oneOf()
    any { move, insideAttributedArea, request, reply(token, success), dispose }
  }
  val safety = s.visible implies (s.alive and not(s.failed) and s.pending == -1 and s.shown == s.view)
  run recoveryTest = init.then(request).then(reply(0, false)).then(request).then(reply(1, true)).expect(safety and s.visible)
  run lateReplyTest = init.then(request).then(move).then(request).then(reply(0, true)).expect(safety and not(s.visible))
  run disposedReplyTest = init.then(request).then(dispose).then(reply(0, true)).expect(safety and not(s.visible))
}
