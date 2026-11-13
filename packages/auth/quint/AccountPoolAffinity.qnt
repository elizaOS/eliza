// AccountPool.select: await expiry metadata, filter the captured inventory,
// then consult live provider/session affinity and the round-robin cursor.
// Two concurrent calls retain their own inventory snapshots. Enabled flags
// stand for the eligibility predicate; health/time/usage rules are separate.
module AccountPoolAffinity {
  val providers = Set(1, 2)
  val sessions = Set(1, 2)
  val slots = Set(1, 2)
  val accounts = Set(1, 2, 3)
  val cacheKeys = Set(1, 2, 3, 4)
  type Entry = { account: int, attempts: int }
  type Call = { stage: str, provider: int, session: int, snapshot: Set[int], result: int }
  type State = {
    enabled: Set[int],
    calls: int -> Call,
    affinity: int -> Entry,
    cursor: int -> int,
    previousAffinity: int -> Entry,
    previousCursor: int -> int,
    started: int,
    changes: int,
    operation: str,
    slot: int,
    key: int,
    reused: bool,
  }
  var s: State
  def members(provider: int): Set[int] = if (provider == 1) Set(1, 2) else Set(3)
  def cacheKey(provider: int, session: int): int = (provider - 1) * 2 + session
  val emptyEntry = { account: 0, attempts: 0 }
  val idleCall = { stage: "idle", provider: 1, session: 1, snapshot: Set(), result: 0 }

  action init = {
    val affinity = cacheKeys.mapBy(_ => emptyEntry)
    val cursor = providers.mapBy(_ => -1)
    s' = {
      enabled: accounts, calls: slots.mapBy(_ => idleCall),
      affinity: affinity, cursor: cursor,
      previousAffinity: affinity, previousCursor: cursor,
      started: 0, changes: 0, operation: "init", slot: 1, key: 1, reused: false,
    }
  }

  action begin(slot: int, provider: int, session: int): bool = all {
    s.calls.get(slot).stage != "waiting",
    s.started < 4,
    s' = {
      ...s,
      calls: s.calls.set(slot, {
        stage: "waiting", provider: provider, session: session,
        snapshot: s.enabled.intersect(members(provider)), result: 0,
      }),
      started: s.started + 1,
      previousAffinity: s.affinity, previousCursor: s.cursor,
      operation: "begin", slot: slot,
      key: cacheKey(provider, session), reused: false,
    },
  }

  action finish(slot: int): bool = {
    val call = s.calls.get(slot)
    val key = cacheKey(call.provider, call.session)
    val cached = s.affinity.get(key)
    val eligible = [1, 2, 3].select(account => call.snapshot.contains(account))
    val nonempty = eligible.length() > 0
    val reused = cached.attempts < 3 and call.snapshot.contains(cached.account)
    val index = if (nonempty) (s.cursor.get(call.provider) + 1) % eligible.length() else 0
    val picked = if (reused) cached.account else if (nonempty) eligible.nth(index) else 0
    val entry = { account: picked, attempts: if (reused) cached.attempts + 1 else 1 }
    all {
      call.stage == "waiting",
      s' = {
        ...s,
        calls: s.calls.set(slot, { ...call, stage: "done", result: picked }),
        affinity: if (nonempty) s.affinity.set(key, entry) else s.affinity,
        cursor: if (nonempty and not(reused)) s.cursor.set(call.provider, index) else s.cursor,
        previousAffinity: s.affinity, previousCursor: s.cursor,
        operation: "finish", slot: slot, key: key, reused: reused,
      },
    }
  }

  // writeAccount rejection from expiry sweeping propagates to select's caller.
  action failSelection(slot: int): bool = all {
    s.calls.get(slot).stage == "waiting",
    s' = {
      ...s,
      calls: s.calls.set(slot, { ...s.calls.get(slot), stage: "done", result: -1 }),
      previousAffinity: s.affinity, previousCursor: s.cursor,
      operation: "fail", slot: slot, key: 1, reused: false,
    },
  }

  action enable(account: int, value: bool): bool = all {
    s.changes < 1,
    s' = {
      ...s,
      changes: s.changes + 1,
      enabled: if (value) s.enabled.union(Set(account)) else s.enabled.exclude(Set(account)),
      previousAffinity: s.affinity, previousCursor: s.cursor,
      operation: "enable", slot: 1, key: account, reused: false,
    },
  }

  action restart = all {
    slots.forall(slot => s.calls.get(slot).stage != "waiting"),
    s' = {
      ...s,
      affinity: cacheKeys.mapBy(_ => emptyEntry), cursor: providers.mapBy(_ => -1),
      calls: slots.mapBy(_ => idleCall),
      previousAffinity: s.affinity, previousCursor: s.cursor,
      operation: "restart", slot: 1, key: 1, reused: false,
    },
  }

  action step = any {
    {
      nondet slot = slots.oneOf()
      nondet provider = providers.oneOf()
      nondet session = sessions.oneOf()
      begin(slot, provider, session)
    },
    { nondet slot = slots.oneOf() finish(slot) },
    { nondet slot = slots.oneOf() failSelection(slot) },
    {
      nondet account = accounts.oneOf()
      nondet value = Set(false, true).oneOf()
      enable(account, value)
    },
    restart,
  }

  val TypeOK = and {
    s.enabled.subseteq(accounts),
    s.started.in(0.to(4)),
    s.changes.in(0.to(1)),
    s.calls.keys() == slots,
    s.affinity.keys() == cacheKeys,
    s.cursor.keys() == providers,
    cacheKeys.forall(key => s.affinity.get(key).attempts.in(0.to(3))),
    slots.forall(slot => s.calls.get(slot).stage.in(Set("idle", "waiting", "done"))),
  }
  val SelectedFromCapturedEligibility = slots.forall(slot => {
    val call = s.calls.get(slot)
    (call.result > 0).implies(call.snapshot.contains(call.result))
  })
  val ProviderMembership = slots.forall(slot => {
    val call = s.calls.get(slot)
    (call.result > 0).implies(members(call.provider).contains(call.result))
  })
  val IndependentAffinity = cacheKeys.forall(key =>
    (s.operation == "finish" and key != s.key).implies(
      s.affinity.get(key) == s.previousAffinity.get(key)))
  val AffinityReuseKeepsCursor =
    (s.operation == "finish" and s.reused).implies(s.cursor == s.previousCursor)
  val EmptySelectionKeepsState =
    (s.operation == "finish" and s.calls.get(s.slot).snapshot.size() == 0).implies(
      s.cursor == s.previousCursor and s.affinity == s.previousAffinity)
  val CacheEntriesStayInProvider = cacheKeys.forall(key => {
    val cachedId = s.affinity.get(key).account
    if (cachedId > 0) members(if (key <= 2) 1 else 2).contains(cachedId) else true
  })
  val FailedSelectionHasNoCacheEffects =
    (s.operation == "fail").implies(
      s.cursor == s.previousCursor and s.affinity == s.previousAffinity)
  val invariant = TypeOK and SelectedFromCapturedEligibility and ProviderMembership and
    IndependentAffinity and AffinityReuseKeepsCursor and EmptySelectionKeepsState and
    CacheEntriesStayInProvider and FailedSelectionHasNoCacheEffects
  temporal CallsFinish = slots.forall(slot =>
    finish(slot).weakFair(s).implies(always(
      (s.calls.get(slot).stage == "waiting").implies(eventually(
        s.calls.get(slot).stage != "waiting")))))

  run threeAffinityUsesThenRotateTest = init
    .then(begin(1, 1, 1)).then(finish(1))
    .then(begin(1, 1, 1)).then(finish(1))
    .then(begin(1, 1, 1)).then(finish(1))
    .then(begin(1, 1, 1)).then(finish(1))
    .expect(s.calls.get(1).result == 2)
  run inFlightSnapshotRemainsScopedTest = init
    .then(begin(1, 1, 1)).then(enable(1, false)).then(finish(1))
    .expect(s.calls.get(1).result == 1)
  run finishOrderOwnsRoundRobinTest = init
    .then(begin(1, 1, 1)).then(begin(2, 1, 2))
    .then(finish(2)).then(finish(1))
    .expect(s.calls.get(2).result == 1 and s.calls.get(1).result == 2)
  run providerAndSessionAreBothKeysTest = init
    .then(begin(1, 1, 1)).then(finish(1))
    .then(begin(1, 2, 1)).then(finish(1))
    .expect(s.calls.get(1).result == 3 and s.affinity.get(1).account == 1)
}
