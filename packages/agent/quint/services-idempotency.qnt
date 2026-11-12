// chat-idempotency-service.ts: one scoped key, two possible reservation owners.
// Values and time are abstracted to fingerprint equality and a retention-expired bit.
module services_idempotency {
  var s: { phase: str, owner: int, fingerprint: int, generation: int, receiptGeneration: int, waiters: int, receipt: bool, expired: bool }
  action init = s' = { phase: "vacant", owner: 0, fingerprint: 0, generation: 0, receiptGeneration: 0, waiters: 0, receipt: false, expired: false }
  action acquire(owner: int, fingerprint: int): bool = all {
    s.phase == "vacant", owner.in(Set(1, 2)), fingerprint.in(Set(1, 2)), s.generation < 2,
    s' = { phase: "active", owner: owner, fingerprint: fingerprint, generation: s.generation + 1, receiptGeneration: 0, waiters: 0, receipt: false, expired: false }
  }
  action duplicate(fingerprint: int): bool = all {
    s.phase == "active", s.fingerprint == fingerprint, s.waiters < 2,
    s' = s.with("waiters", s.waiters + 1)
  }
  action settle(owner: int, generation: int): bool = all {
    s.phase == "active", s.owner == owner, s.generation == generation,
    s' = s.with("phase", "settled").with("receipt", true).with("receiptGeneration", generation).with("waiters", 0)
  }
  action release(owner: int, generation: int): bool = all {
    s.phase == "active", s.owner == owner, s.generation == generation,
    s' = { phase: "vacant", owner: 0, fingerprint: 0, generation: s.generation, receiptGeneration: 0, waiters: 0, receipt: false, expired: false }
  }
  action age = all { s.phase == "settled", s' = s.with("expired", true) }
  action evict = all { s.phase == "settled", s.expired, s' = { phase: "vacant", owner: 0, fingerprint: 0, generation: s.generation, receiptGeneration: 0, waiters: 0, receipt: false, expired: false } }
  action cancelWaiter = all { s.waiters > 0, s' = s.with("waiters", s.waiters - 1) }
  action attemptSettle(owner: int, generation: int): bool = if (s.phase == "active" and s.owner == owner and s.generation == generation) settle(owner, generation) else keep
  action reset = s' = { phase: "vacant", owner: 0, fingerprint: 0, generation: s.generation, receiptGeneration: 0, waiters: 0, receipt: false, expired: false }
  action keep = s' = s
  action step = any { acquire(1,1), acquire(2,2), duplicate(1), duplicate(2), attemptSettle(1,1), attemptSettle(1,2), attemptSettle(2,1), attemptSettle(2,2), release(1,1), release(1,2), release(2,1), release(2,2), age, evict, cancelWaiter, reset, keep }
  val safety = all { s.phase.in(Set("vacant", "active", "settled")), s.generation >= 0, s.generation <= 2, s.receipt implies s.receiptGeneration == s.generation, s.waiters >= 0, s.waiters <= 2, s.receipt == (s.phase == "settled"), s.phase == "vacant" implies s.owner == 0, s.phase != "active" implies s.waiters == 0 }
  run settleNotifiesTest = init.then(acquire(1,1)).then(duplicate(1)).then(settle(1,1)).expect(s.receipt and s.waiters == 0)
  run expiresBeforeNewFingerprintTest = init.then(acquire(1,1)).then(settle(1,1)).then(age).then(evict).then(acquire(2,2)).expect(s.owner == 2 and not(s.receipt))
  run oldReservationCannotSettleNewIncarnationTest = init.then(acquire(1,1)).then(release(1,1)).then(acquire(1,1)).then(attemptSettle(1,1)).expect(not(s.receipt) and s.generation == 2)
  run cancellationReleasesWaiterTest = init.then(acquire(1,1)).then(duplicate(1)).then(cancelWaiter).expect(s.phase == "active" and s.waiters == 0)
}
