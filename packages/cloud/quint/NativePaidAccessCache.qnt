// cloud-services.mjs settled paid-access cache, shared checks and background
// revalidation. This is a local funding UI gate, never charge authority.
// Two reusable read slots are reused only after every reference retires.
module NativePaidAccessCache {
  pure val Slots = Set(0, 1)
  pure val Callers = Set(0, 1)
  pure val Keys = Set("a", "b")
  type Read = {phase: str, key: str, generation: int, revision: int, epoch: int, outcome: str}
  type Call = {phase: str, key: str, generation: int, read: int, admittedKey: str, admittedGeneration: int}
  type State = {
    key: str, generation: int, revision: int, epoch: int, externalChanged: bool,
    remote: str -> bool, remoteChanges: int, authorityChanges: int, reads: int -> Read, calls: int -> Call,
    cache: int, flight: int, background: str, backgroundRead: int,
    wrongOwnerMutation: bool, finalizerErasedSuccessor: bool
  }
  pure val EmptyRead = {phase: "unused", key: "none", generation: 0, revision: 0, epoch: 0, outcome: "none"}
  pure val EmptyCall = {phase: "idle", key: "none", generation: 0, read: -1, admittedKey: "none", admittedGeneration: -1}
  var s: State
  pure def sameTuple(a: Read, b: Read): bool = a.key == b.key and
    a.generation == b.generation and a.revision == b.revision and a.epoch == b.epoch
  pure def current(v: State, r: int): bool = r >= 0 and
    v.reads.get(r).key == v.key and v.reads.get(r).generation == v.generation and
    v.reads.get(r).revision == v.revision and v.reads.get(r).epoch == v.epoch
  pure def owner(v: State, r: int): bool = v.reads.get(r).key == v.key and
    v.reads.get(r).generation == v.generation
  pure def free(v: State, r: int): bool =
    v.reads.get(r).phase.in(Set("unused", "done")) and v.cache != r and
    v.flight != r and v.backgroundRead != r and Callers.forall(c => v.calls.get(c).read != r)
  pure def matchingFlight(v: State): bool = v.flight >= 0 and current(v, v.flight)
  pure def warm(v: State): bool = v.cache >= 0 and current(v, v.cache) and
    v.reads.get(v.cache).outcome == "active"
  pure def allocate(v: State, r: int): State = {
    ...v, flight: r, reads: v.reads.set(r, {
      phase: "pending", key: v.key, generation: v.generation,
      revision: v.revision, epoch: v.epoch, outcome: "none"
    })
  }
  // Record the owner actually cleared, rather than a synthetic witness flag.
  pure def clearCapturedOwner(v: State, r: int): State = {
    ...v, key: "none", wrongOwnerMutation: v.wrongOwnerMutation or
      v.key != v.reads.get(r).key or v.generation != v.reads.get(r).generation
  }
  pure def retireFlight(v: State, r: int, after: int): State = {
    ...v, flight: after, finalizerErasedSuccessor: v.finalizerErasedSuccessor or
      (v.flight != r and v.flight != after)
  }
  action init = s' = {
    key: "a", generation: 0, revision: 0, epoch: 0, externalChanged: false,
    remote: Keys.mapBy(_ => true), remoteChanges: 0, authorityChanges: 0,
    reads: Slots.mapBy(_ => EmptyRead), calls: Callers.mapBy(_ => EmptyCall),
    cache: -1, flight: -1, background: "none", backgroundRead: -1,
    wrongOwnerMutation: false, finalizerErasedSuccessor: false
  }
  action begin(c: int, slot: int): bool = all {
    s.calls.get(c).phase == "idle",
    not(Slots.exists(r => s.reads.get(r).phase == "revoking")),
    s.key == "none" or warm(s) or matchingFlight(s) or free(s, slot),
    {
      val r = if (matchingFlight(s)) s.flight else slot
      val base = if (s.key != "none" and not(warm(s)) and not(matchingFlight(s))) allocate(s, r) else s
      s' = { ...base, calls: s.calls.set(c, {
        phase: if (s.key == "none") "failed" else if (warm(s)) "admitted" else "waiting",
        key: s.key, generation: s.generation, read: if (s.key == "none" or warm(s)) -1 else r,
        admittedKey: if (warm(s)) s.key else "none", admittedGeneration: if (warm(s)) s.generation else -1
      }), background: if (warm(s) and s.background == "none") "scheduled" else s.background }
    }
  }
  // A warm answer returns before this timer. The refresh is separately owned.
  action fireBackground(slot: int): bool = all {
    s.background == "scheduled",
    not(Slots.exists(r => s.reads.get(r).phase == "revoking")),
    s.key == "none" or matchingFlight(s) or free(s, slot),
    {
      val r = if (matchingFlight(s)) s.flight else slot
      val base = if (s.key != "none" and not(matchingFlight(s))) allocate(s, r) else s
      s' = { ...base, background: if (s.key == "none") "none" else "waiting",
        backgroundRead: if (s.key == "none") -1 else r }
    }
  }
  action resolve(r: int, unavailable: bool): bool = all {
    s.reads.get(r).phase == "pending",
    {
      val result = if (not(owner(s, r))) "stale" else if (unavailable) "unavailable"
        else if (s.remote.get(s.reads.get(r).key)) "active" else "refuse"
      s' = { ...s, reads: s.reads.set(r, { ...s.reads.get(r), phase: "resolved", outcome: result }),
        cache: if (current(s, r) and result.in(Set("active", "refuse"))) r else s.cache }
    }
  }
  // An old identity refusal cannot clear a replacement key saved externally.
  action identityRefused(r: int): bool = all {
    s.reads.get(r).phase == "pending",
    s.reads.get(r).generation != s.generation or
      (s.revision < 1 and s.epoch < 2 and s.authorityChanges < 2),
    s' = if (s.reads.get(r).generation == s.generation) {
      val invalidated = { ...s, revision: s.revision + 1, epoch: s.epoch + 1,
        authorityChanges: s.authorityChanges + 1, cache: -1 }
      if (s.reads.get(r).key == s.key)
        { ...invalidated, reads: s.reads.set(r, { ...s.reads.get(r), phase: "revoking" }) }
      else { ...invalidated, reads: s.reads.set(r, { ...s.reads.get(r), phase: "resolved", outcome: "stale" }) }
    } else { ...s, reads: s.reads.set(r, { ...s.reads.get(r), phase: "resolved", outcome: "stale" }) }
  }
  // onRevoked may await host work. Conditional clear checks the same owner again.
  action finishRevocation(r: int): bool = all {
    s.reads.get(r).phase == "revoking",
    {
      val changed = if (owner(s, r)) clearCapturedOwner(s, r) else s
      s' = { ...changed, reads: s.reads.set(r, { ...s.reads.get(r), phase: "resolved",
        outcome: if (owner(s, r)) "revoked" else "stale" }) }
    }
  }
  action settle(r: int): bool = any { resolve(r, false), resolve(r, true), identityRefused(r) }
  action finish(r: int): bool = all {
    s.reads.get(r).phase == "resolved",
    {
      val retired = retireFlight(s, r, if (s.flight == r) -1 else s.flight)
      s' = { ...retired, reads: s.reads.set(r, { ...s.reads.get(r), phase: "done" }) }
    }
  }
  action observe(c: int): bool = all {
    s.calls.get(c).phase == "waiting", s.reads.get(s.calls.get(c).read).phase == "done",
    {
      val call = s.calls.get(c)
      val read = s.reads.get(call.read)
      val valid = read.key == call.key and call.key == s.key and read.generation == call.generation and call.generation == s.generation
      s' = { ...s, calls: s.calls.set(c, { ...call, read: -1,
        admittedKey: if (valid and read.outcome == "active") s.key else "none",
        admittedGeneration: if (valid and read.outcome == "active") s.generation else -1,
        phase: if (valid and read.outcome == "active") "admitted"
          else if (valid or read.outcome == "revoked") "failed" else "stale" }) }
    }
  }
  action observeBackground = all {
    s.background == "waiting", s.reads.get(s.backgroundRead).phase == "done",
    s' = { ...s, background: "none", backgroundRead: -1 }
  }
  action changeExternalKey = all {
    not(s.externalChanged), s.key == "a", s.authorityChanges < 2,
    s' = { ...s, key: "b", externalChanged: true, authorityChanges: s.authorityChanges + 1 }
  }
  action changeAccount = all {
    s.generation < 1, s.epoch < 2, s.authorityChanges < 2,
    s' = { ...s, key: "b", generation: s.generation + 1, epoch: s.epoch + 1, cache: -1, authorityChanges: s.authorityChanges + 1 }
  }
  action changeRevision = all { s.revision < 1, s.authorityChanges < 2,
    s' = { ...s, revision: s.revision + 1, authorityChanges: s.authorityChanges + 1 } }
  action paidRefused = all {
    s.epoch < 2, s.authorityChanges < 2,
    s' = { ...s, epoch: s.epoch + 1, cache: -1, authorityChanges: s.authorityChanges + 1,
      background: if (s.background == "none") "scheduled" else s.background }
  }
  action remoteChange(key: str): bool = all {
    s.remoteChanges < 2,
    s' = { ...s, remote: s.remote.set(key, not(s.remote.get(key))), remoteChanges: s.remoteChanges + 1 }
  }
  action anyBackground = { nondet r = Slots.oneOf(); fireBackground(r) }
  action step = any {
    { nondet c = Callers.oneOf(); nondet r = Slots.oneOf(); any { begin(c, r), observe(c) } },
    { nondet r = Slots.oneOf(); any { settle(r), finishRevocation(r), finish(r) } },
    { nondet key = Keys.oneOf(); remoteChange(key) },
    anyBackground, observeBackground, changeExternalKey, changeAccount, changeRevision, paidRefused, s' = s
  }
  val TypeOK = all {
    s.key.in(Keys.union(Set("none"))), s.generation.in(Set(0, 1)), s.revision.in(Set(0, 1)),
    s.epoch >= 0, s.epoch <= 2, s.remoteChanges >= 0, s.remoteChanges <= 2,
    s.authorityChanges >= 0, s.authorityChanges <= 2,
    s.cache.in(Set(-1, 0, 1)), s.flight.in(Set(-1, 0, 1)), s.backgroundRead.in(Set(-1, 0, 1)),
    s.background.in(Set("none", "scheduled", "waiting")),
    s.reads.keys() == Slots, s.calls.keys() == Callers, s.remote.keys() == Keys,
    Slots.forall(r => s.reads.get(r).phase.in(Set("unused", "pending", "revoking", "resolved", "done")) and
      s.reads.get(r).outcome.in(Set("none", "active", "refuse", "unavailable", "stale", "revoked"))),
    Callers.forall(c => s.calls.get(c).phase.in(Set("idle", "waiting", "admitted", "failed", "stale")))
  }
  val DefiniteCacheOnly = s.cache >= 0 implies s.reads.get(s.cache).outcome.in(Set("active", "refuse"))
  val SingleFlightPerTuple = Slots.forall(a => Slots.forall(b =>
    (a != b and s.reads.get(a).phase == "pending" and s.reads.get(b).phase == "pending") implies
      not(sameTuple(s.reads.get(a), s.reads.get(b)))))
  val NoStaleAdmission = Callers.forall(c => s.calls.get(c).phase == "admitted" implies
    s.calls.get(c).key == s.calls.get(c).admittedKey and
    s.calls.get(c).generation == s.calls.get(c).admittedGeneration)
  val NoWrongOwnerMutation = not(s.wrongOwnerMutation)
  val FinalizerKeepsSuccessor = not(s.finalizerErasedSuccessor)
  temporal Fairness = all {
    Slots.forall(r => settle(r).weakFair(s) and finishRevocation(r).weakFair(s) and finish(r).weakFair(s)),
    Callers.forall(c => observe(c).weakFair(s)), anyBackground.weakFair(s), observeBackground.weakFair(s)
  }
  temporal CallsWithoutFairness = Callers.forall(c =>
    (s.calls.get(c).phase == "waiting").leadsTo(s.calls.get(c).phase != "waiting"))
  temporal CallsSettle = Fairness.implies(CallsWithoutFairness)
  temporal BackgroundSettles = Fairness.implies((s.background != "none").leadsTo(s.background == "none"))

  action legacyIdentityClearsReplacement(r: int): bool = all {
    s.reads.get(r).phase == "pending", not(owner(s, r)),
    s' = clearCapturedOwner(s, r)
  }
  action legacyRevocationClearsReplacement(r: int): bool = all {
    s.reads.get(r).phase == "revoking", not(owner(s, r)),
    s' = clearCapturedOwner(s, r)
  }
  action legacyFinishClearsSuccessor(r: int): bool = all {
    s.reads.get(r).phase == "resolved", s.flight != r, s.flight >= 0,
    s' = retireFlight(s, r, -1)
  }
  action legacyWarmWrongKey = all {
    s.cache >= 0, s.reads.get(s.cache).outcome == "active", not(current(s, s.cache)),
    s.calls.get(1).phase == "idle",
    s' = { ...s, calls: s.calls.set(1, {phase: "admitted", key: s.reads.get(s.cache).key,
      generation: s.reads.get(s.cache).generation, read: -1, admittedKey: s.key, admittedGeneration: s.generation}) }
  }
  run coldChecksCoalesceTest = init.then(begin(0, 0)).then(begin(1, 1))
    .expect(s.flight == 0 and s.calls.get(1).read == 0 and SingleFlightPerTuple)
  run warmIsLocalAndRefreshesTest = init.then(begin(0, 0)).then(resolve(0, false))
    .then(finish(0)).then(observe(0)).then(begin(1, 1))
    .expect(s.calls.get(1).phase == "admitted" and s.background == "scheduled" and s.flight == -1)
    .then(fireBackground(1)).then(resolve(1, false)).then(finish(1)).then(observeBackground)
    .expect(s.cache == 1 and s.background == "none")
  run refusalRechecksAndUpgradeCountsTest = init.then(remoteChange("a")).then(begin(0, 0))
    .then(resolve(0, false)).then(finish(0)).then(observe(0)).then(remoteChange("a"))
    .then(begin(1, 1)).expect(s.calls.get(1).phase == "waiting")
    .then(resolve(1, false)).then(finish(1)).then(observe(1)).expect(s.calls.get(1).phase == "admitted")
  run staleRemoteActiveIsOnlyLocalGateTest = init.then(begin(0, 0)).then(resolve(0, false))
    .then(finish(0)).then(observe(0)).then(remoteChange("a")).then(begin(1, 1))
    .expect(not(s.remote.get("a")) and s.calls.get(1).phase == "admitted" and s.background == "scheduled")
  run unavailableKeepsDefiniteAnswerTest = init.then(begin(0, 0)).then(resolve(0, false))
    .then(finish(0)).then(observe(0)).then(begin(1, 1)).then(fireBackground(1))
    .then(resolve(1, true)).then(finish(1)).then(observeBackground).expect(s.cache == 0 and DefiniteCacheOnly)
  run invalidationFencesFillAndOldFinallyTest = init.then(begin(0, 0)).then(paidRefused)
    .then(begin(1, 1)).then(resolve(0, false)).then(finish(0))
    .expect(s.cache == -1 and s.flight == 1).then(resolve(1, false)).expect(s.cache == 1)
  run revisionFencesCacheButNotOldCallerTest = init.then(begin(0, 0)).then(changeRevision)
    .then(resolve(0, false)).then(finish(0)).then(observe(0))
    .expect(s.cache == -1 and s.calls.get(0).phase == "admitted")
  run accountChangeRejectsOldReplyTest = init.then(begin(0, 0)).then(changeAccount)
    .then(resolve(0, false)).then(finish(0)).then(observe(0)).expect(s.calls.get(0).phase == "stale")
  run oldIdentityRefusalKeepsExternalReplacementTest = init.then(begin(0, 0)).then(changeExternalKey)
    .then(identityRefused(0)).expect(s.key == "b" and NoWrongOwnerMutation)
  run wrongKeyCacheWitnessTest = init.then(begin(0, 0)).then(resolve(0, false)).then(finish(0))
    .then(changeExternalKey).then(legacyWarmWrongKey).expect(not(NoStaleAdmission))
  run oldIdentityClearWitnessTest = init.then(begin(0, 0)).then(changeExternalKey)
    .then(legacyIdentityClearsReplacement(0)).expect(not(NoWrongOwnerMutation))
  run oldFinallyEraseWitnessTest = init.then(begin(0, 0)).then(paidRefused).then(begin(1, 1))
    .then(resolve(0, false)).then(legacyFinishClearsSuccessor(0)).expect(not(FinalizerKeepsSuccessor))
  run currentIdentityRevokesTest = init.then(begin(0, 0)).then(identityRefused(0))
    .then(finishRevocation(0)).then(finish(0)).then(observe(0))
    .expect(s.key == "none" and s.calls.get(0).phase == "failed" and NoWrongOwnerMutation)
  run lateRevocationCallbackKeepsReplacementTest = init.then(begin(0, 0)).then(identityRefused(0))
    .then(changeExternalKey).then(finishRevocation(0))
    .expect(s.key == "b" and NoWrongOwnerMutation and s.cache == -1)
  run oldLateRevocationClearWitnessTest = init.then(begin(0, 0)).then(identityRefused(0))
    .then(changeExternalKey).then(legacyRevocationClearsReplacement(0))
    .expect(not(NoWrongOwnerMutation))

}
