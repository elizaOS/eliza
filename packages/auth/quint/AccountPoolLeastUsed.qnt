// AccountPool.select waits on expiry work before ranking. Concurrent calls
// rank against the live process stamps after that wait, while persisted usage
// and recency come from the account snapshot. This case keeps snapshots fixed
// while calls are pending and isolates the least-used stamp protocol.
module AccountPoolLeastUsed {
  val accounts = Set(1, 2, 3, 4)
  val providers = Set(1, 2)
  val slots = Set(1, 2)
  type Call = { phase: str, provider: int, session: bool, result: int }
  type Pin = { account: int, attempts: int }
  type State = {
    calls: int -> Call, stamps: int -> int, usedAt: int -> int, pin: Pin,
    clock: int, now: int, started: int, preview: int,
    unequalUsage: bool, recorded: bool, restarted: bool, violations: Set[str],
  }
  val emptyCall = { phase: "idle", provider: 1, session: false, result: 0 }
  val emptyPin = { account: 0, attempts: 0 }
  val zeroes = accounts.mapBy(_ => 0)
  var s: State

  action start(unequalUsage: bool): bool = s' = {
    calls: slots.mapBy(_ => emptyCall), stamps: zeroes, usedAt: zeroes,
    pin: emptyPin, clock: 0, now: 1, started: 0, preview: 0,
    unequalUsage: unequalUsage, recorded: false, restarted: false, violations: Set(),
  }
  action init = any { start(false), start(true) }

  pure def members(provider: int): Set[int] = if (provider == 1) Set(1, 2) else Set(3, 4)
  pure def usage(t: State, id: int): int = if (t.unequalUsage and id == 2) 1 else 0
  pure def later(left: int, right: int): int = if (left >= right) left else right
  pure def age(t: State, id: int): int = later(t.stamps.get(id), t.usedAt.get(id))
  pure def winner(t: State, provider: int): int = {
    val first = if (provider == 1) 1 else 3
    val second = first + 1
    val firstUsage = usage(t, first)
    val secondUsage = usage(t, second)
    if (firstUsage != secondUsage) {
      if (firstUsage < secondUsage) first else second
    } else if (age(t, first) <= age(t, second)) first else second
  }
  pure def rankIsCorrect(t: State, picked: int, provider: int): bool = members(provider).forall(other =>
    usage(t, picked) <= usage(t, other) and
      (usage(t, picked) == usage(t, other)).implies(age(t, picked) <= age(t, other)) and
      (usage(t, picked) == usage(t, other) and age(t, picked) == age(t, other)).implies(picked <= other))
  pure def withWitness(proposed: State, name: str, holds: bool): State =
    if (holds) proposed else { ...proposed, violations: proposed.violations.union(Set(name)) }
  pure def checkStamp(before: State, proposed: State, picked: int): State = {
    val authorizedClock = if (picked == 0) before.clock else later(before.now, before.clock + 1)
    val expected = if (picked == 0) before.stamps else before.stamps.set(picked, authorizedClock)
    withWitness(proposed, "stamp", proposed.stamps == expected and proposed.clock == authorizedClock)
  }

  action begin(slot: int, provider: int, session: bool): bool = all {
    s.started < 4, s.calls.get(slot).phase != "waiting",
    not(session) or provider == 1,
    s' = {
      ...s, started: s.started + 1,
      calls: s.calls.set(slot, { phase: "waiting", provider: provider, session: session, result: 0 }),
    },
  }
  action finish(slot: int): bool = {
    val call = s.calls.get(slot)
    val reused = call.session and s.pin.attempts > 0 and s.pin.attempts < 3
    val picked = if (reused) s.pin.account else winner(s, call.provider)
    val stamp = later(s.now, s.clock + 1)
    val result = {
      ...s,
      calls: s.calls.set(slot, { ...call, phase: "done", result: picked }),
      clock: if (reused) s.clock else stamp,
      stamps: if (reused) s.stamps else s.stamps.set(picked, stamp),
      pin: if (call.session) {
        account: picked, attempts: if (reused) s.pin.attempts + 1 else 1,
      } else s.pin,
    }
    all {
      call.phase == "waiting",
      s' = checkStamp(s, result, if (reused) 0 else picked)
        .withWitness("ranking", reused or rankIsCorrect(s, picked, call.provider)),
    }
  }

  action preview = all {
    s.preview == 0,
    s' = checkStamp(s, { ...s, preview: winner(s, 1) }, 0),
  }
  val idle = slots.forall(slot => s.calls.get(slot).phase != "waiting")
  action recordUse = all {
    idle, not(s.recorded),
    s' = { ...s, now: s.clock + 1, recorded: true, usedAt: s.usedAt.set(1, s.clock + 1) },
  }
  action restart = all {
    idle, not(s.restarted),
    s' = { ...s, restarted: true, stamps: zeroes, clock: 0, pin: emptyPin },
  }

  action step = any {
    {
      nondet slot = slots.oneOf()
      nondet provider = providers.oneOf()
      nondet session = Set(false, true).oneOf()
      begin(slot, provider, session)
    },
    { nondet slot = slots.oneOf() finish(slot) },
    preview, recordUse, restart,
    s' = s,
  }

  val TypeOK = and {
    s.started.in(0.to(4)), s.stamps.keys() == accounts, s.usedAt.keys() == accounts,
    s.calls.keys() == slots, s.pin.attempts.in(0.to(3)),
    slots.forall(slot => s.calls.get(slot).phase.in(Set("idle", "waiting", "done"))),
  }
  val SelectedWithinProvider = slots.forall(slot => {
    val call = s.calls.get(slot)
    (call.phase == "done").implies(members(call.provider).contains(call.result))
  })
  val UsageAndEffectiveAgeOrderPicks = not(s.violations.contains("ranking"))
  val StampsChangeOnlyForFreshPicks = not(s.violations.contains("stamp"))
  val PersistedRecencySurvivesRestart = and {
    s.usedAt.get(1) == (if (s.recorded) s.now else 0),
    Set(2, 3, 4).forall(id => s.usedAt.get(id) == 0),
  }
  temporal PendingPicksSettle = slots.forall(slot => finish(slot).weakFair(s)) implies
    slots.forall(slot => always((s.calls.get(slot).phase == "waiting").implies(
      eventually(s.calls.get(slot).phase == "done"))))

  run overlappingBurstPicksSeeLiveStampsTest = start(false)
    .then(begin(1, 1, false)).then(begin(2, 1, false)).then(finish(1)).then(finish(2))
    .expect(s.calls.get(1).result == 1 and s.calls.get(2).result == 2)
  run previewDoesNotConsumeFirstPickTest = start(false)
    .then(preview).then(begin(1, 1, false)).then(finish(1))
    .expect(s.preview == 1 and s.calls.get(1).result == 1 and s.clock == 1)
  run otherProviderOwnsItsOwnStampTest = start(false)
    .then(begin(1, 1, false)).then(finish(1)).then(begin(2, 2, false)).then(finish(2))
    .expect(s.calls.get(2).result == 3)
  run reusingAffinityDoesNotRestampTest = start(false)
    .then(begin(1, 1, true)).then(finish(1)).then(begin(2, 1, false)).then(finish(2))
    .then(begin(1, 1, true)).then(finish(1)).then(begin(2, 1, false)).then(finish(2))
    .expect(s.calls.get(2).result == 1 and s.clock == 3)
  run restartClearsOnlyVolatileOrderingTest = start(false)
    .then(begin(1, 1, false)).then(finish(1)).then(recordUse).then(restart)
    .then(begin(1, 1, false)).then(finish(1))
    .expect(s.calls.get(1).result == 2 and s.usedAt.get(1) == 2)
  run unequalUsagePrecedesRecencyTest = start(true)
    .then(begin(1, 1, false)).then(finish(1)).then(begin(2, 1, false)).then(finish(2))
    .expect(s.calls.get(1).result == 1 and s.calls.get(2).result == 1)
}
