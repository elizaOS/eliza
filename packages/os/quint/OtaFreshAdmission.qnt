// Authenticated OTA admission, floor ratchets, commit freshness and recovery.
// The descriptor/device/policy domains match fresh_admission_conformance_test.go.
// Signatures, host qualification and durable file replacement are separate guards.
module OtaFreshAdmission {
  pure def max(a: int, b: int): int = if (a > b) a else b
  type Descriptor = { lane: int, seq: int, rev: int, security: int,
    candidate: int, recovery: int, revoked: Set[int], expires: int,
    paused: bool, cohort: bool, core: int, rollout: int }
  val descriptors = List(
    { lane: 0, seq: 1, rev: 1, security: 1, candidate: 2, recovery: 3, revoked: Set(), expires: 9, paused: false, cohort: true, core: 1, rollout: 1 },
    { lane: 0, seq: 1, rev: 2, security: 1, candidate: 2, recovery: 3, revoked: Set(2), expires: 9, paused: false, cohort: true, core: 1, rollout: 2 },
    { lane: 0, seq: 1, rev: 2, security: 1, candidate: 2, recovery: 3, revoked: Set(3), expires: 9, paused: false, cohort: true, core: 1, rollout: 3 },
    { lane: 0, seq: 1, rev: 3, security: 1, candidate: 2, recovery: 3, revoked: Set(), expires: 9, paused: false, cohort: true, core: 1, rollout: 4 },
    { lane: 0, seq: 1, rev: 3, security: 1, candidate: 6, recovery: 7, revoked: Set(), expires: 9, paused: false, cohort: true, core: 2, rollout: 4 },
    { lane: 0, seq: 2, rev: 3, security: 2, candidate: 4, recovery: 5, revoked: Set(2), expires: 9, paused: false, cohort: true, core: 3, rollout: 5 },
    { lane: 0, seq: 2, rev: 3, security: 2, candidate: 4, recovery: 5, revoked: Set(), expires: 9, paused: false, cohort: true, core: 3, rollout: 4 },
    { lane: 0, seq: 3, rev: 4, security: 2, candidate: 4, recovery: 5, revoked: Set(), expires: 9, paused: true, cohort: true, core: 4, rollout: 6 },
    { lane: 0, seq: 2, rev: 3, security: 2, candidate: 4, recovery: 5, revoked: Set(3), expires: 9, paused: false, cohort: false, core: 3, rollout: 7 },
    { lane: 1, seq: 5, rev: 1, security: 1, candidate: 2, recovery: 3, revoked: Set(), expires: 9, paused: false, cohort: true, core: 5, rollout: 1 },
    { lane: 0, seq: 1, rev: 1, security: 1, candidate: 2, recovery: 3, revoked: Set(), expires: 2, paused: false, cohort: true, core: 1, rollout: 8 }
  )
  val devices = List(
    { lane: 0, installed: 1, quarantine: Set() },
    { lane: 0, installed: 2, quarantine: Set() },
    { lane: 0, installed: 1, quarantine: Set(2) },
    { lane: 1, installed: 1, quarantine: Set() }
  )
  val policies = List(
    { lower: 0, upper: 0, security: 1 },
    { lower: 0, upper: 0, security: 2 },
    { lower: 9, upper: 9, security: 1 },
    { lower: 1, upper: 2, security: 1 }
  )
  val empty: Descriptor = { lane: 0, seq: 0, rev: 0, security: 0,
    candidate: 0, recovery: 0, revoked: Set(), expires: 0,
    paused: false, cohort: false, core: 0, rollout: 0 }
  def descriptor(index: int): Descriptor = if (index < 0) empty else descriptors.nth(index)
  type State = { floors: int -> int, refreshed: int -> int,
    operation: str, release: int, device: int, policy: int,
    fetched: int, after: int, by: int, globalSecurity: int, outcome: str,
    changedLane: int, previous: int, previousRefresh: int, other: int, otherRefresh: int }
  var s: State
  val initial: State = { floors: Set(0, 1).mapBy(_ => -1), refreshed: Set(0, 1).mapBy(_ => -1),
    operation: "init", release: 0, device: 0, policy: 0, fetched: -1,
    after: -1, by: -1, globalSecurity: 1, outcome: "", changedLane: 0,
    previous: -1, previousRefresh: -1, other: -1, otherRefresh: -1 }
  action init = s' = initial

  def decide(d: Descriptor, device: int, policy: int, floor: Descriptor): str = {
    val dev = devices.nth(device)
    val p = policies.nth(policy)
    if (dev.lane != d.lane) "channel-mismatch"
    else if (d.seq < max(1, floor.seq) or d.rev < max(1, floor.rev)) "metadata-rollback"
    else if (d.paused) "rollout-paused"
    else if (p.lower < 0 or p.upper >= d.expires) "rollout-time"
    else if (d.revoked.contains(d.candidate) or d.revoked.contains(d.recovery)) "revoked-artifact"
    else if (d.security < max(p.security, floor.security)) "security-floor"
    else if (dev.quarantine.contains(d.candidate) or dev.quarantine.contains(d.recovery)) "quarantined"
    else if (d.candidate == dev.installed) "already-installed"
    else if (d.candidate <= dev.installed) "await-forward-version"
    else if (not(d.cohort)) "outside-cohort"
    else "eligible"
  }
  action remember(release: int, device: int, policy: int, fetched: int): bool = {
    val d = descriptors.nth(release)
    val lane = devices.nth(device).lane
    val floor = descriptor(s.floors.get(lane))
    val eligibleFloor = d.lane == lane and d.seq >= floor.seq and d.rev >= floor.rev and d.security >= floor.security
    val regression = not(floor.revoked.subseteq(d.revoked))
    val equivocation = (floor.seq == d.seq and floor.core != d.core) or
      (floor.seq == d.seq and floor.rev == d.rev and floor.rollout != d.rollout)
    val update = eligibleFloor and not(regression) and not(equivocation)
    val result = if (eligibleFloor and regression) "revocation regression"
      else if (eligibleFloor and floor.seq == d.seq and floor.core != d.core) "release sequence equivocation"
      else if (eligibleFloor and equivocation) "rollout revision equivocation"
      else decide(d, device, policy, floor)
    s' = { ...initial,
      floors: if (update) s.floors.set(lane, release) else s.floors,
      refreshed: if (update) s.refreshed.set(lane, max(s.refreshed.get(lane), fetched)) else s.refreshed,
      operation: "remember", release: release, device: device, policy: policy, fetched: fetched,
      outcome: result, changedLane: lane, previous: s.floors.get(lane),
      previousRefresh: s.refreshed.get(lane), other: s.floors.get(1 - lane),
      otherRefresh: s.refreshed.get(1 - lane) }
  }
  def commitResult(release: int, policy: int, after: int, by: int): str = {
    val d = descriptors.nth(release)
    val floor = descriptor(s.floors.get(d.lane))
    val p = policies.nth(policy)
    if (floor.seq < d.seq or floor.rev < d.rev) "error"
    else if (p.upper >= d.expires) "expired"
    else if (p.lower < 0) "rollout-time"
    else if (floor.revoked.contains(d.candidate) or floor.revoked.contains(d.recovery)) "revoked-artifact"
    else if (d.security < max(p.security, floor.security)) "below-security-floor"
    else if (floor.seq > d.seq) "superseded"
    else if (s.refreshed.get(d.lane) < after or (by >= 0 and p.upper > by)) "stale-metadata"
    else "eligible"
  }
  action commit(release: int, policy: int, after: int, by: int): bool =
    s' = { ...initial, floors: s.floors, refreshed: s.refreshed,
      operation: "commit", release: release, policy: policy, after: after, by: by,
      outcome: commitResult(release, policy, after, by) }
  def recoveryResult(release: int, globalSecurity: int): str = {
    val d = descriptors.nth(release)
    val floor = descriptor(s.floors.get(d.lane))
    if (floor.seq < d.seq or floor.rev < d.rev) "error"
    else if (floor.revoked.contains(d.recovery)) "revoked-artifact"
    else if (d.security < max(globalSecurity, floor.security)) "below-security-floor"
    else "loadable"
  }
  action recover(release: int, globalSecurity: int): bool =
    s' = { ...initial, floors: s.floors, refreshed: s.refreshed,
      operation: "recover", release: release, globalSecurity: globalSecurity,
      outcome: recoveryResult(release, globalSecurity) }

  action step = any {
    {
      nondet release = 0.to(10).oneOf()
      nondet device = 0.to(3).oneOf()
      nondet policy = 0.to(3).oneOf()
      nondet fetched = Set(-1, 0, 1).oneOf()
      remember(release, device, policy, fetched)
    },
    {
      nondet prepared = Set(0, 5, 8, 10).oneOf()
      nondet policy = 0.to(3).oneOf()
      nondet after = Set(-1, 0, 1).oneOf()
      nondet by = Set(-1, 1, 2).oneOf()
      commit(prepared, policy, after, by)
    },
    {
      nondet prepared = Set(0, 5, 8, 10).oneOf()
      nondet security = Set(1, 2).oneOf()
      recover(prepared, security)
    },
  }
  val FloorRatchets = s.operation != "remember" or {
    val before = descriptor(s.previous)
    val after = descriptor(s.floors.get(s.changedLane))
    after.seq >= before.seq and after.rev >= before.rev and after.security >= before.security and
      before.revoked.subseteq(after.revoked) and s.refreshed.get(s.changedLane) >= s.previousRefresh
  }
  val NoEquivocation = s.operation != "remember" or {
    val before = descriptor(s.previous)
    val after = descriptor(s.floors.get(s.changedLane))
    (before.seq == after.seq).implies(before.core == after.core) and
      (before.seq == after.seq and before.rev == after.rev).implies(before.rollout == after.rollout)
  }
  val LaneIsolation = s.operation != "remember" or
    (s.floors.get(1 - s.changedLane) == s.other and s.refreshed.get(1 - s.changedLane) == s.otherRefresh)
  val CommitUsesCurrentAuthority = s.operation != "commit" or s.outcome != "eligible" or {
    val d = descriptors.nth(s.release)
    val floor = descriptor(s.floors.get(d.lane))
    val p = policies.nth(s.policy)
    floor.seq == d.seq and floor.rev >= d.rev and d.security >= max(p.security, floor.security) and
      not(floor.revoked.contains(d.candidate)) and not(floor.revoked.contains(d.recovery)) and
      p.upper < d.expires and s.refreshed.get(d.lane) >= s.after and
      (s.by < 0 or p.upper <= s.by)
  }
  val RecoveryUsesCurrentAuthority = s.operation != "recover" or s.outcome != "loadable" or {
    val d = descriptors.nth(s.release)
    val floor = descriptor(s.floors.get(d.lane))
    floor.seq >= d.seq and floor.rev >= d.rev and not(floor.revoked.contains(d.recovery)) and
      d.security >= max(s.globalSecurity, floor.security)
  }
  val invariant = FloorRatchets and NoEquivocation and LaneIsolation and CommitUsesCurrentAuthority and RecoveryUsesCurrentAuthority
  run revokedCandidateCannotCommitTest = init.then(remember(0, 0, 0, 0))
    .then(remember(1, 0, 0, 0)).then(commit(0, 0, 0, 1)).expect(s.outcome == "revoked-artifact")
  run deferredReleaseStillSupersedesTest = init.then(remember(6, 0, 0, 0))
    .then(remember(7, 0, 0, 0)).then(commit(5, 0, 0, 1)).expect(s.outcome == "superseded")
  run storedDescriptorIsNotRefreshTest = init.then(remember(0, 0, 0, -1))
    .then(commit(0, 0, 0, 1)).expect(s.outcome == "stale-metadata")
  run conflictingCoreRefusedTest = init.then(remember(0, 0, 0, 0))
    .then(remember(4, 0, 0, 0)).expect(s.outcome == "release sequence equivocation")
}
