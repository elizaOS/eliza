// Durable greeting ownership in OnboardingSessionCoordinator. One session key
// projects the queue. Distinct pollers present either the old or new receipt.
module OnboardingGreetingLease {
  type Event = { kind: str, receipt: int }
  type State = {
    now: int,
    generation: int,
    present: bool,
    createdAt: int,
    issued: int,
    lease: int,
    leaseUntil: int,
    event: Event
  }
  var s: State

  pure def event(kind: str, receipt: int): Event = { kind: kind, receipt: receipt }
  pure def fresh(x: State): bool = x.now - x.createdAt <= 3
  pure def live(x: State): bool = x.lease != 0 and x.now < x.leaseUntil

  action init = s' = {
    now: 0, generation: 0, present: false, createdAt: 0, issued: 0,
    lease: 0, leaseUntil: 0, event: event("idle", 0)
  }

  action enqueue = all {
    not(s.present),
    s.generation < 2,
    s' = { ...s, generation: s.generation + 1, present: true,
      createdAt: s.now, lease: 0, leaseUntil: 0, event: event("enqueue", 0) }
  }
  action duplicate = all {
    s.present,
    s' = { ...s, event: event("duplicate", 0) }
  }

  action claim = all {
    s.present,
    fresh(s),
    not(live(s)),
    s.issued < 4,
    s' = { ...s, issued: s.issued + 1, lease: s.issued + 1,
      leaseUntil: s.now + 1, event: event("claim", s.issued + 1) }
  }
  action dropStale = all {
    s.present,
    not(fresh(s)),
    s' = { ...s, present: false, lease: 0, leaseUntil: 0, event: event("drop", 0) }
  }

  // An expired lease still acknowledges its own entry until a poller has
  // replaced it. Lease expiry is a reclaim permission, not an automatic erase.
  action acknowledge(receipt: int): bool = {
    val ownsEntry = s.present and s.lease != 0 and s.lease == receipt
    s' = { ...s, present: s.present and not(ownsEntry),
      lease: if (ownsEntry) 0 else s.lease,
      leaseUntil: if (ownsEntry) 0 else s.leaseUntil,
      event: event("ack", receipt) }
  }

  action loseReply = all {
    s.event.kind == "claim",
    s' = { ...s, event: event("unknown", s.lease) }
  }
  action restart = s' = { ...s, event: event("restart", 0) }
  action tick = all {
    s.now < 6,
    s' = { ...s, now: s.now + 1, event: event("tick", 0) }
  }
  action idle = s' = s

  action step = any {
    enqueue, duplicate, claim, dropStale, loseReply, restart, tick, idle,
    nondet receipt = Set(1, 2, 3, 4, 5).oneOf()
    acknowledge(receipt)
  }

  val TypeOK = all {
    s.now >= 0 and s.now <= 6,
    s.generation >= 0 and s.generation <= 2,
    s.issued >= 0 and s.issued <= 4,
    s.lease >= 0 and s.lease <= s.issued,
    s.present.implies(s.generation > 0),
    (not(s.present) or s.lease == 0).implies(s.lease == 0 and s.leaseUntil == 0)
  }

  pure def stored(x: State): (int, bool, int, int, int, int) =
    (x.generation, x.present, x.createdAt, x.issued, x.lease, x.leaseUntil)

  temporal ExactAcknowledgement = always((
    (next(s.event.kind) == "ack").implies(
      if (s.present and s.lease != 0 and s.lease == next(s.event.receipt))
        not(next(s.present)) and next(s.generation) == s.generation
      else next(stored(s)) == stored(s))).orKeep(s))
  temporal ClaimsOnlyFreshEntries = always((
    (next(s.event.kind) == "claim").implies(
      s.present and fresh(s) and not(live(s)) and next(s.lease) > s.issued and
      next(s.generation) == s.generation and next(s.createdAt) == s.createdAt)).orKeep(s))
  temporal RetainsDurableOwnership = always((
    Set("duplicate", "unknown", "restart").contains(next(s.event.kind))
      .implies(next(stored(s)) == stored(s))).orKeep(s))

  temporal StaleEntriesRetire = Set(1, 2).forall(generation => always(
    (s.present and s.generation == generation and not(fresh(s)))
      .implies(eventually(not(s.present) or s.generation != generation))))
  temporal FairCleanup = dropStale.weakFair(s).implies(StaleEntriesRetire)

  run recoveredLeaseRejectsOldAcknowledgementTest = init.then(enqueue).then(claim)
    .then(loseReply).then(restart).then(tick).then(claim).then(acknowledge(1))
    .expect(s.present and s.lease == 2).then(acknowledge(2)).expect(not(s.present))
  run duplicateRetainsLeaseTest = init.then(enqueue).then(claim).then(duplicate)
    .expect(s.generation == 1 and s.lease == 1 and s.createdAt == 0)
  run lateAcknowledgementBeforeReclaimTest = init.then(enqueue).then(claim)
    .then(tick).then(acknowledge(1)).expect(not(s.present))
  run cleanupDropsStaleEntryTest = init.then(enqueue).then(tick).then(tick)
    .then(tick).then(tick).then(dropStale).expect(not(s.present))
}
