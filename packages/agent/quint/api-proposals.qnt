// Runtime-management proposal file protocol. Filesystem rename is atomic;
// the claim is revalidated after rename; malformed/expired/mismatched claims fail.
// Two competing consumers, one proposal lifecycle; UUID reuse is not modeled.
module api_proposals {
  var s: { file: str, expired: bool, matches: bool, claimedBy: int, granted: Set[int], checked: Set[int] }
  action init = s' = { file: "absent", expired: false, matches: true, claimedBy: 0, granted: Set(), checked: Set() }
  action create = all { s.file == "absent", s' = s.with("file", "live") }
  action expire = s' = s.with("expired", true)
  action mismatch = s' = s.with("matches", false)
  action check(consumer: int): bool = all { s.file == "live", not(s.expired), s.matches, s' = s.with("checked", s.checked.union(Set(consumer))) }
  action claim(consumer: int): bool = all { s.file == "live", s.checked.contains(consumer), s' = s.with("file", "claimed").with("claimedBy", consumer) }
  action validate = all { s.file == "claimed", s' = s.with("file", "consumed").with("granted", if (s.matches and not(s.expired)) s.granted.union(Set(s.claimedBy)) else s.granted) }
  action cleanup = all { s.file == "live", s.expired, s' = s.with("file", "consumed") }
  action idle = s' = s
  action step = any { create, expire, mismatch, check(1), check(2), claim(1), claim(2), validate, cleanup, idle }
  val safety = all { s.granted.size() <= 1, s.granted.forall(c => c.in(Set(1, 2))), s.granted.size() > 0 implies s.file == "consumed" }
  run concurrentConsumeTest = init.then(create).then(check(1)).then(check(2)).then(claim(2)).then(validate).expect(s.granted == Set(2))
  run expiryBetweenReadAndClaimTest = init.then(create).then(check(1)).then(expire).then(claim(1)).then(validate).expect(s.granted == Set())
}
