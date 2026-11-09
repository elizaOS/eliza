// Cold priority selection filters the captured provider inventory at the
// completion clock, then ranks by priority and persisted last-used time.
// Provider2 shares visible account id 1 with provider1.
module AccountPoolPriority {
  val accountKeys = Set(1, 2, 3)
  val ids = Set(0, 1, 2)
  val firstHealth = Set("ok", "cooling", "unknown-cooldown", "parked")
  type Account = { enabled: bool, health: str, until: int, ends: int, priority: int, lastUsed: int }
  type Query = { provider: int, allow: int, excluded: int }
  type State = {
    accounts: int -> Account, now: int, query: Query, phase: str, picked: int,
    calls: int, priorityWrites: Set[int], recorded: bool, violations: Set[str],
  }
  val defaults = { enabled: true, health: "ok", until: 0, ends: 3, priority: 0, lastUsed: 0 }
  val defaultQuery = { provider: 1, allow: 0, excluded: 0 }
  var s: State

  action start(health: str, expires: bool, peerEnabled: bool): bool = s' = {
    accounts: Map(
      1 -> { ...defaults, health: health, until: 1 },
      2 -> { ...defaults, enabled: peerEnabled, priority: 1, ends: if (expires) 1 else 3 },
      3 -> defaults),
    now: 0, query: defaultQuery, phase: "idle", picked: 0, calls: 0,
    priorityWrites: Set(), recorded: false, violations: Set(),
  }
  action init = {
    nondet health = firstHealth.oneOf()
    nondet expires = Set(true, false).oneOf()
    nondet peerEnabled = Set(true, false).oneOf()
    start(health, expires, peerEnabled)
  }

  pure def providerOf(key: int): int = if (key == 3) 2 else 1
  pure def visibleId(key: int): int = if (key == 3) 1 else key
  pure def inScope(key: int, query: Query): bool = and {
    providerOf(key) == query.provider,
    query.allow == 0 or query.allow == visibleId(key),
    query.excluded != visibleId(key),
  }
  pure def available(account: Account, now: int): bool =
    account.enabled and account.ends > now and
      (account.health == "ok" or (account.health == "cooling" and account.until < now))
  pure def candidates(t: State, query: Query): Set[int] =
    accountKeys.filter(key => inScope(key, query) and available(t.accounts.get(key), t.now))

  pure def before(left: Account, right: Account): bool =
    left.priority < right.priority or
      (left.priority == right.priority and left.lastUsed <= right.lastUsed)
  pure def best(t: State, eligible: Set[int]): int =
    if (eligible.contains(1) and eligible.contains(2)) {
      if (before(t.accounts.get(1), t.accounts.get(2))) 1 else 2
    } else if (eligible.contains(1)) 1
    else if (eligible.contains(2)) 2
    else if (eligible.contains(3)) 3 else 0

  pure def choose(t: State, query: Query): State = {
    val eligible = candidates(t, query)
    val picked = best(t, eligible)
    val chosen = t.accounts.get(if (picked == 0) 1 else picked)
    val checks = Map(
      "scope" -> (picked == 0 or (providerOf(picked) == query.provider and
        visibleId(picked) != query.excluded and
        (query.allow == 0 or visibleId(picked) == query.allow))),
      "eligibility" -> (picked == 0 or (chosen.enabled and chosen.ends > t.now and
        (chosen.health == "ok" or (chosen.health == "cooling" and t.now > chosen.until)))),
      "ranking" -> (picked == 0 or eligible.forall(key => {
        val other = t.accounts.get(key)
        chosen.priority <= other.priority and
          (chosen.priority == other.priority).implies(chosen.lastUsed <= other.lastUsed)
      })),
      "empty" -> ((picked == 0) == (eligible.size() == 0)),
    )
    {
      ...t, query: query, picked: picked, phase: "done",
      violations: t.violations.union(checks.keys().filter(key => not(checks.get(key)))),
    }
  }
  action begin(provider: int, allow: int, excluded: int): bool = all {
    s.phase != "waiting", s.calls < 3,
    s' = {
      ...s, query: { provider: provider, allow: allow, excluded: excluded },
      phase: "waiting", calls: s.calls + 1, picked: 0,
    },
  }
  action finish = all { s.phase == "waiting", s' = choose(s, s.query) }
  action preview(provider: int, allow: int): bool = all {
    s.phase != "waiting", s.calls < 3,
    s' = choose({ ...s, calls: s.calls + 1 }, { provider: provider, allow: allow, excluded: 0 }),
  }
  action tick = all { s.now < 2, s' = { ...s, now: s.now + 1 } }

  // A selection retains its captured inventory. These bounded metadata
  // updates occur before the next read. Time can advance during the wait.
  action reprioritize(key: int, priority: int): bool = all {
    s.phase != "waiting", not(s.priorityWrites.contains(key)),
    s' = {
      ...s, priorityWrites: s.priorityWrites.union(Set(key)),
      accounts: s.accounts.set(key, { ...s.accounts.get(key), priority: priority }),
    },
  }
  action recordUse = all {
    s.phase != "waiting", not(s.recorded),
    s' = { ...s, recorded: true, accounts: s.accounts.set(1, { ...s.accounts.get(1), lastUsed: 1 }) },
  }
  action step = any {
    {
      nondet provider = Set(1, 2).oneOf()
      nondet allow = ids.oneOf()
      nondet excluded = ids.oneOf()
      begin(provider, allow, excluded)
    },
    { nondet provider = Set(1, 2).oneOf() nondet allow = ids.oneOf() preview(provider, allow) },
    { nondet key = Set(1, 2).oneOf() nondet priority = Set(0, 1).oneOf() reprioritize(key, priority) },
    recordUse, tick, finish, s' = s,
  }

  val TypeOK = and {
    s.now.in(0.to(2)), s.calls.in(0.to(3)), s.picked.in(0.to(3)),
    s.accounts.keys() == accountKeys, s.phase.in(Set("idle", "waiting", "done")),
    s.priorityWrites.subseteq(Set(1, 2)),
  }
  val PickStaysInRequestedProviderAndIds = not(s.violations.contains("scope"))
  val PickRespectsCompletionClock = not(s.violations.contains("eligibility"))
  val PriorityThenPersistedAgeOrdersPicks = not(s.violations.contains("ranking"))
  val NoPickExactlyWhenNoEligibleAccount = not(s.violations.contains("empty"))

  temporal PriorityCallsSettle = finish.weakFair(s) implies
    always((s.phase == "waiting").implies(eventually(s.phase == "done")))

  run cooldownAndExpiryHaveDifferentEqualityRulesTest = start("cooling", true, true)
    .then(begin(1, 0, 0)).then(finish).expect(s.picked == 2)
    .then(tick).then(preview(1, 0)).expect(s.picked == 0)
    .then(begin(1, 0, 0)).then(tick).then(finish).expect(s.picked == 1)
  run providerScopeAndExclusionsPrecedeRankingTest = start("ok", false, true)
    .then(begin(2, 1, 0)).then(finish).expect(s.picked == 3)
    .then(begin(1, 1, 1)).then(finish).expect(s.picked == 0)
    .then(begin(1, 1, 0)).then(finish).expect(s.picked == 1)
  run persistedAgeBreaksOnlyPriorityTieTest = start("ok", false, true)
    .then(recordUse).then(begin(1, 0, 0)).then(finish).expect(s.picked == 1)
    .then(reprioritize(2, 0)).then(begin(1, 0, 0)).then(finish).expect(s.picked == 2)
  run unknownCooldownDoesNotReadmitTest = start("unknown-cooldown", false, false)
    .then(tick).then(tick).then(begin(1, 0, 0)).then(finish).expect(s.picked == 0)
}
