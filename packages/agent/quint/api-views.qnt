// View installations and renderer claims: two generations for one owner.
// Identity values abstract unforgeable in-process handles; strings alone never authorize.
// Replacing an installation revokes old entries and invalidates pending replies.
module api_views {
  var s: { closed: bool, pending: int, active: int, revoked: Set[int], waiter: int, claim: bool, done: bool, resultEntry: int }
  action init = s' = { closed: false, pending: 0, active: 0, revoked: Set(), waiter: 0, claim: false, done: false, resultEntry: 0 }
  action begin(g: int): bool = all {
    not(s.closed), g != s.active, not(s.revoked.contains(g)),
    s' = s.with("pending", g).with("revoked", if (s.pending != 0 and s.pending != g) s.revoked.union(Set(s.pending)) else s.revoked)
  }
  action commit = all {
    not(s.closed), s.pending != 0, not(s.revoked.contains(s.pending)),
    s' = s.with("active", s.pending).with("pending", 0).with("revoked", if (s.active != 0) s.revoked.union(Set(s.active)) else s.revoked)
  }
  action wait = all { not(s.closed), s.active != 0, s.waiter == 0, not(s.done), s' = s.with("waiter", s.active).with("claim", false) }
  action claim = all { not(s.closed), s.waiter == s.active, s.waiter != 0, not(s.claim), s' = s.with("claim", true) }
  action result = all { not(s.closed), s.waiter == s.active, s.waiter != 0, s.claim, s' = s.with("done", true).with("resultEntry", s.waiter).with("waiter", 0).with("claim", false) }
  action cancel = s' = s.with("waiter", 0).with("claim", false)
  action revoke = all { s.active != 0, s' = s.with("revoked", s.revoked.union(Set(s.active))).with("active", 0) }
  action close = s' = s.with("closed", true).with("revoked", s.revoked.union(Set(s.active, s.pending)).exclude(Set(0))).with("pending", 0).with("active", 0).with("waiter", 0).with("claim", false)
  action idle = s' = s
  action step = any { begin(1), begin(2), commit, wait, claim, result, cancel, revoke, close, idle }
  val safety = all {
    s.active != 0 implies not(s.revoked.contains(s.active)),
    s.pending != 0 implies not(s.revoked.contains(s.pending)),
    s.closed implies all { s.pending == 0, s.active == 0, s.waiter == 0, not(s.claim) },
    s.done implies s.resultEntry != 0
  }
  run replacementRejectsStaleClaimTest = init.then(begin(1)).then(commit).then(wait).then(claim).then(begin(2)).then(commit).expect(s.waiter != s.active).then(cancel).expect(safety)
  run duplicateRendererOnlyOneClaimTest = init.then(begin(1)).then(commit).then(wait).then(claim).then(result).expect(s.done and s.waiter == 0)
  run shutdownClearsPendingTest = init.then(begin(1)).then(commit).then(wait).then(close).expect(safety)
}
