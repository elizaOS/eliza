// acquire/renew/releaseAgentBackupRestoreLease. Each action represents the
// transaction under the backup/catalogue locks and its post-lock database clock.
// Identity equality abstracts the full organization/agent/backup/source/digest/
// copy-role tuple. Owner and fencing-token checks remain separate below.
module RestoreLease {
  pure val attempts = Set("a", "b")
  pure val owners = Set("alice", "bob")
  type State = {
    exists: Set[str], released: Set[str], expiry: str -> int,
    epoch: str -> int, owner: str -> str,
    now: int, catalogEpoch: int, restorable: bool, binding: bool,
    last: str, lastAttempt: str, previousExpiry: int,
    renewedWhileLive: bool, admittedScope: bool,
  }
  var s: State

  action init = s' = {
    exists: Set(), released: Set(), expiry: attempts.mapBy(_ => 0),
    epoch: attempts.mapBy(_ => 0), owner: attempts.mapBy(_ => "none"),
    now: 0, catalogEpoch: 0, restorable: true, binding: true,
    last: "init", lastAttempt: "a", previousExpiry: 0,
    renewedWhileLive: true, admittedScope: true,
  }
  def live(a: str): bool = s.exists.contains(a) and
    not(s.released.contains(a)) and s.expiry.get(a) > s.now and
    s.epoch.get(a) == s.catalogEpoch

  // A live existing attempt replays without extending its expiry. Expired or
  // released attempts cannot be reopened, even when another attempt is absent.
  action acquire(a: str, owner: str, scopeMatches: bool, tokenMatches: bool): bool = all {
    s.restorable, s.binding, scopeMatches,
    if (s.exists.contains(a)) all {
      live(a), s.owner.get(a) == owner, tokenMatches,
      s' = { ...s, last: "replay", lastAttempt: a,
        previousExpiry: s.expiry.get(a), admittedScope: scopeMatches },
    } else all {
      not(s.exists.exists(other => live(other))),
      s' = {
        ...s,
        exists: s.exists.union(Set(a)),
        released: s.released.union(s.exists),
        expiry: s.expiry.set(a, s.now + 2),
        epoch: s.epoch.set(a, s.catalogEpoch),
        owner: s.owner.set(a, owner),
        last: "acquire", lastAttempt: a, admittedScope: scopeMatches,
      },
    },
  }
  action renew(a: str, owner: str, scopeMatches: bool, tokenMatches: bool, duration: int): bool = all {
    s.restorable, s.binding, scopeMatches, tokenMatches,
    live(a), s.owner.get(a) == owner,
    s.now + duration > s.expiry.get(a),
    s' = {
      ...s, expiry: s.expiry.set(a, s.now + duration),
      last: "renew", lastAttempt: a, previousExpiry: s.expiry.get(a),
      renewedWhileLive: live(a), admittedScope: scopeMatches,
    },
  }
  // Release remains idempotent after expiry/catalogue changes. It checks the
  // retained identity and token, without requiring current restore admission.
  action release(a: str, owner: str, scopeMatches: bool, tokenMatches: bool): bool = all {
    s.exists.contains(a), scopeMatches, tokenMatches,
    s.owner.get(a) == owner,
    s' = {
      ...s, released: s.released.union(Set(a)),
      last: "release", lastAttempt: a, admittedScope: scopeMatches,
    },
  }
  action tick = all {
    s.now < 5,
    s' = { ...s, now: s.now + 1, last: "tick" },
  }
  action advanceCatalog = all {
    s.catalogEpoch == 0,
    s' = { ...s, catalogEpoch: 1, last: "catalog" },
  }
  action changeAdmission(restorable: bool, binding: bool): bool =
    s' = { ...s, restorable: restorable, binding: binding, last: "admission" }
  action step = {
    nondet a = attempts.oneOf()
    nondet owner = owners.oneOf()
    nondet scopeMatches = Set(true, false).oneOf()
    nondet tokenMatches = Set(true, false).oneOf()
    nondet duration = Set(1, 2).oneOf()
    nondet restorable = Set(true, false).oneOf()
    nondet binding = Set(true, false).oneOf()
    any {
      acquire(a, owner, scopeMatches, tokenMatches),
      renew(a, owner, scopeMatches, tokenMatches, duration),
      release(a, owner, scopeMatches, tokenMatches),
      tick, advanceCatalog, changeAdmission(restorable, binding), s' = s,
    }
  }
  val OneUnreleasedLease = s.exists.exclude(s.released).size() <= 1
  val ReleasedLeasesExist = s.released.subseteq(s.exists)
  val ReplayPreservesExpiry = s.last != "replay" or
    s.expiry.get(s.lastAttempt) == s.previousExpiry
  val RenewalExtendsLiveLease = s.last != "renew" or
    (s.renewedWhileLive and s.expiry.get(s.lastAttempt) > s.previousExpiry)
  val ExactScope = s.admittedScope
  temporal NoReopen = always((s.released.subseteq(next(s.released))).orKeep(s))

  run expiredAttemptStaysTerminalTest = init
    .then(acquire("a", "alice", true, true))
    .then(tick).then(tick)
    .expect(not(live("a")))
  run staleLeaseCanBeReleasedTest = init
    .then(acquire("a", "alice", true, true))
    .then(advanceCatalog)
    .then(release("a", "alice", true, true))
    .expect(s.released.contains("a"))
  run replayDoesNotExtendTest = init
    .then(acquire("a", "alice", true, true))
    .then(tick)
    .then(acquire("a", "alice", true, true))
    .expect(s.expiry.get("a") == 2)
}
