// owner-binding.ts: one connector's code; immutable owner captured at issue;
// consume before asynchronous identity write, expire/attempt limits fail closed.
module services_owner_pairing {
  var s: { phase: str, owner: int, attempts: int, expired: bool, writes: int, success: bool }
  action init = s' = { phase: "empty", owner: 0, attempts: 0, expired: false, writes: 0, success: false }
  action issue(owner: int): bool = all { owner.in(Set(1,2)), s.phase != "writing", s' = { phase: "pending", owner: owner, attempts: 2, expired: false, writes: 0, success: false } }
  action wrongCode = all { s.phase == "pending", not(s.expired), s.attempts > 0, s' = s.with("attempts", s.attempts - 1).with("phase", if (s.attempts == 1) "empty" else "pending") }
  action age = all { s.phase == "pending", s' = s.with("expired", true) }
  action expire = all { s.phase == "pending", s.expired, s' = s.with("phase", "empty").with("attempts", 0) }
  action consume = all { s.phase == "pending", not(s.expired), s.attempts > 0, s' = s.with("phase", "writing").with("attempts", 0) }
  action written = all { s.phase == "writing", s' = s.with("phase", "empty").with("writes", 1).with("success", true) }
  action writeFailed = all { s.phase == "writing", s' = s.with("phase", "empty") }
  action keep = s' = s
  action step = any { issue(1), issue(2), wrongCode, age, expire, consume, written, writeFailed, keep }
  val safety = all { s.attempts >= 0, s.attempts <= 2, s.writes.in(Set(0,1)), s.success implies s.writes == 1, s.phase == "writing" implies s.owner.in(Set(1,2)) }
  run exhaustedCodeTest = init.then(issue(1)).then(wrongCode).then(wrongCode).expect(s.phase == "empty" and not(s.success))
  run failedWriteConsumesCodeTest = init.then(issue(2)).then(consume).then(writeFailed).expect(s.phase == "empty" and s.owner == 2)
}
