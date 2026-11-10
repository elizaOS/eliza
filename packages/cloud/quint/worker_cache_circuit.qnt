// CacheClient -> private InferenceAdmissionGate clock identity. Relative timer
// completion, durable publication and response delivery are separate events.
module worker_cache_circuit {
  type Reply = { generation: int, owner: int, ready: bool }
  type State = {
    generation: int, open: bool, readyGeneration: int, readyOwner: int,
    record: Reply, liveOwner: int, allocated: int,
    timerGeneration: int -> int, pending: Set[int], elapsed: Set[int],
    responses: int -> Reply, wall: int, safeReopen: bool, routeReply: int,
  }
  var s: State
  pure val owners = Set(1, 2)
  pure val slots = Set(0, 1)
  pure val empty = { generation: 0, owner: 0, ready: false }
  action init = s' = {
    generation: 1, open: true, readyGeneration: 0, readyOwner: 0,
    record: empty, liveOwner: 0, allocated: 0,
    timerGeneration: owners.mapBy(_ => 0), pending: Set(), elapsed: Set(),
    responses: slots.mapBy(_ => empty), wall: 1, safeReopen: true, routeReply: 0,
  }
  action wallJump(value: int): bool = s' = s.with("wall", value)
  action laterFailure = all {
    s.generation == 1,
    s' = s.with("generation", 2).with("open", true),
  }
  action restart = s' = s.with("liveOwner", 0)
  // Duplicate live/completed generations retain the original owner. An unknown
  // callback after restart is rearmed with a new owner and a full relative wait.
  action arm = all {
    s.open, s.allocated < 2,
    not(s.record.generation == s.generation and
      (s.record.ready or s.record.owner == s.liveOwner)),
    val owner = s.allocated + 1
    s' = s.with("allocated", owner).with("liveOwner", owner)
      .with("record", { generation: s.generation, owner: owner, ready: false })
      .with("timerGeneration", s.timerGeneration.set(owner, s.generation))
      .with("pending", s.pending.union(Set(owner))),
  }
  action expire(owner: int): bool = all {
    s.pending.contains(owner), not(s.elapsed.contains(owner)),
    s' = s.with("elapsed", s.elapsed.union(Set(owner))),
  }
  action publish(owner: int): bool = all {
    s.pending.contains(owner), s.elapsed.contains(owner),
    val same = s.record.owner == owner and s.record.generation == s.timerGeneration.get(owner)
    s' = s.with("pending", s.pending.exclude(Set(owner)))
      .with("record", if (same) s.record.with("ready", true) else s.record)
      .with("liveOwner", if (s.liveOwner == owner) 0 else s.liveOwner),
  }
  action request(slot: int): bool = all {
    s.record.generation == s.generation, s.responses.get(slot).generation == 0,
    s' = s.with("responses", s.responses.set(slot, s.record)),
  }
  action lose(slot: int): bool = all {
    s.responses.get(slot).generation > 0,
    s' = s.with("responses", s.responses.set(slot, empty)),
  }
  action deliver(slot: int): bool = all {
    s.responses.get(slot).generation > 0,
    val response = s.responses.get(slot)
    val current = response.ready and response.generation == s.generation and s.open
    s' = s.with("responses", s.responses.set(slot, empty))
      .with("readyGeneration", if (current) response.generation else s.readyGeneration)
      .with("readyOwner", if (current) response.owner else s.readyOwner),
  }
  // A successful observation can be scheduled by synchronous isAvailable; it
  // requires no cache command. Fairness states when an acknowledgement arrives.
  action observe = all {
    s.open, s.record.ready, s.record.generation == s.generation,
    s' = s.with("readyGeneration", s.generation).with("readyOwner", s.record.owner),
  }
  action probe = all {
    s.open, s.readyGeneration == s.generation,
    s' = s.with("open", false).with("safeReopen",
      s.elapsed.contains(s.readyOwner) and s.timerGeneration.get(s.readyOwner) == s.generation),
  }
  action route(clockIdentity: bool, clockPath: bool, post: bool): bool =
    s' = s.with("routeReply", if (clockIdentity and clockPath and post) 200 else 404)

  action expireAny = { nondet owner = owners.oneOf(); expire(owner) }
  action publishAny = { nondet owner = owners.oneOf(); publish(owner) }
  action stableStep = any { arm, expireAny, publishAny, observe, probe,
    { nondet wall = 0.to(2).oneOf(); wallJump(wall) } }
  action step = any { stableStep, laterFailure, restart,
    { nondet slot = slots.oneOf(); any { request(slot), lose(slot), deliver(slot) } },
    { nondet identity = Set(false, true).oneOf()
      nondet path = Set(false, true).oneOf()
      nondet post = Set(false, true).oneOf(); route(identity, path, post) } }

  val durableReadyHasElapsedOwner = s.record.ready implies
    (s.elapsed.contains(s.record.owner) and
      s.timerGeneration.get(s.record.owner) == s.record.generation)
  val clientReadyHasOriginalElapsedOwner = s.readyGeneration > 0 implies
    (s.elapsed.contains(s.readyOwner) and
      s.timerGeneration.get(s.readyOwner) == s.readyGeneration)
  val noReopenFromOldGeneration = s.safeReopen
  val boundedOwners = s.allocated >= 0 and s.allocated <= 2
  val safety = durableReadyHasElapsedOwner and clientReadyHasOriginalElapsedOwner
    and noReopenFromOldGeneration and boundedOwners

  temporal StableSynchronousRecovery =
    (arm.weakFair(s) and expireAny.weakFair(s) and publishAny.weakFair(s)
      and observe.weakFair(s) and probe.weakFair(s)) implies eventually(not(s.open))

  run wallJumpsCannotExpireTimerTest = init.then(arm).then(wallJump(2)).then(wallJump(0))
    .expect(not(s.record.ready) and s.open and safety)
  run duplicateUnknownAcknowledgementRetainsOwnerTest = init.then(arm).then(request(0)).then(lose(0))
    .then(request(0)).then(deliver(0)).expect(s.allocated == 1 and s.record.owner == 1 and safety)
  run restartRequiresNewElapsedOwnerTest = init.then(arm).then(restart).then(arm)
    .then(expire(1)).then(publish(1)).expect(not(s.record.ready) and s.record.owner == 2)
    .then(expire(2)).then(publish(2)).then(observe).then(probe).expect(not(s.open) and safety)
  run delayedOldReadyCannotAuthorizeNewGenerationTest = init.then(arm).then(expire(1)).then(publish(1))
    .then(request(0)).then(laterFailure).then(arm).then(deliver(0))
    .expect(s.open and s.readyGeneration == 0 and not(s.record.ready) and safety)
    .then(expire(2)).then(publish(2)).then(observe).then(probe).expect(not(s.open) and safety)
  run oldCallbackCannotPublishOrClearSuccessorTest = init.then(arm).then(laterFailure).then(arm)
    .then(expire(1)).then(publish(1))
    .expect(s.liveOwner == 2 and not(s.record.ready) and safety)
  run completedReceiptSurvivesRestartTest = init.then(arm).then(expire(1)).then(publish(1))
    .then(restart).then(observe).then(probe).expect(not(s.open) and s.allocated == 1 and safety)
  run clockAndTenantRoutesAreDisjointTest = init.then(route(false, true, true))
    .expect(s.routeReply == 404 and s.record == empty)
    .then(route(true, false, true)).expect(s.routeReply == 404 and s.record == empty)
    .then(route(true, true, false)).expect(s.routeReply == 404 and s.record == empty)
}
