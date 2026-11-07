// Sliding-window and token-bucket admission, CAS retry.
// Integer time abstracts real milliseconds; each budget bound is reduced to two.
// Tokens are per-principal; denied calls consume no operation or duplicate write.
module api_budgets {
  var s: { tokens: int, accepted: int, attempts: int, committed: bool, conflict: bool }
  action init = s' = { tokens: 2, accepted: 0, attempts: 0, committed: false, conflict: false }
  action admit = all { s.tokens > 0, s.accepted < 2, s' = s.with("tokens", s.tokens - 1).with("accepted", s.accepted + 1) }
  action deny = all { s.tokens == 0, s' = s }
  action tick = s' = s.with("tokens", 2).with("accepted", 0)
  action conflict = all { not(s.committed), s.attempts < 3, s' = s.with("attempts", s.attempts + 1).with("conflict", true) }
  action commit = all { not(s.committed), s.attempts < 3, s' = s.with("attempts", s.attempts + 1).with("committed", true).with("conflict", false) }
  action idle = s' = s
  action step = any { admit, deny, tick, conflict, commit, idle }
  val safety = all { s.tokens >= 0, s.tokens <= 2, s.accepted + s.tokens == 2, s.attempts >= 0, s.attempts <= 3, s.committed implies not(s.conflict) }
  run retryFreshThenCommitTest = init.then(conflict).then(conflict).then(commit).expect(s.committed and s.attempts == 3)
  run deniedCallDoesNotSpendTest = init.then(admit).then(admit).then(deny).expect(s.accepted == 2)
}
