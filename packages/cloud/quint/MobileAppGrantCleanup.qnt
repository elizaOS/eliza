// Bounded cleanupExpired transaction and cleanupExpiredMobileAppAuthGrants
// pagination. Two grants suffice for a skipped head, shared credential,
// mixed safe/unsafe batch, and owner changes between planning and row locks.
module MobileAppGrantCleanup {
  const BatchSize: int
  pure val Rows = Set(1, 2)
  pure val Keys = Set(1, 2, 3)
  pure val Scenarios = Set("valid", "acknowledged", "shared", "foreign", "missing", "malformed", "tombstone", "expiry-mismatch", "corrupt-tombstone", "missing-expiry", "active-tombstone", "future-tombstone", "invalid-lifecycle", "provenance", "active-unacknowledged")
  type Grant = { present: bool, status: str, owner: int, key: int, expires: int, lifecycle: bool }
  type Credential = { present: bool, owner: int, grant: int, active: bool, deleted: bool, clean: bool, timelyDeletion: bool, expires: int }
  type State = {
    clock: int,
    grants: int -> Grant,
    keys: int -> Credential,
    externalLocks: Set[int],
    phase: str,
    calls: int,
    batches: int,
    cutoff: int,
    cursor: int,
    previousCursor: int,
    planned: Set[int],
    plannedOwners: int -> int,
    lockedRows: Set[int],
    lockedKeys: Set[int],
    safeRows: Set[int],
    tombstones: Set[int],
    scanned: int,
    removed: int,
    violations: int,
    unsafeWrite: bool,
    earlyRevocation: bool,
    changedOwnerWrite: bool,
    writtenKeys: Set[int]
  }
  var s: State
  pure def initial(scenario: str, locks: Set[int]): State = {
    clock: 0,
    grants: Rows.mapBy(r => {
      present: true,
      status: if (r == 1 and Set("acknowledged", "tombstone", "expiry-mismatch").contains(scenario)) "acknowledged"
        else if (r == 1 and Set("valid", "malformed").contains(scenario)) "pending" else "exchanged",
      owner: r,
      key: if (r == 1 and scenario == "valid") 0
        else if (r == 2 and scenario == "shared") 1
        else if (r == 1 and Set("foreign", "missing").contains(scenario)) 3 else r,
      expires: if (r == 1 and Set("acknowledged", "tombstone").contains(scenario)) 3 else 1,
      lifecycle: not(Set("malformed", "invalid-lifecycle").contains(scenario)) or r != 1
    }),
    keys: Keys.mapBy(k => {
      present: scenario != "missing" or k != 3,
      owner: k, grant: if (scenario == "provenance" and k == 1) 3 else k,
      active: k == 1 and Set("acknowledged", "expiry-mismatch", "active-tombstone", "active-unacknowledged").contains(scenario),
      deleted: Set("tombstone", "corrupt-tombstone", "active-tombstone", "future-tombstone").contains(scenario) and k != 3,
      clean: Set("tombstone", "active-tombstone", "future-tombstone").contains(scenario) and k != 3,
      timelyDeletion: scenario != "future-tombstone",
      expires: if (scenario == "missing-expiry" and k == 1) 0 else 3
    }),
    externalLocks: locks, phase: "idle", calls: 0, batches: 0, cutoff: 0,
    cursor: 0, previousCursor: 0, planned: Set(), plannedOwners: Rows.mapBy(_ => 0),
    lockedRows: Set(), lockedKeys: Set(), safeRows: Set(), tombstones: Set(),
    scanned: 0, removed: 0, violations: 0,
    unsafeWrite: false, earlyRevocation: false, changedOwnerWrite: false, writtenKeys: Set()
  }
  action initCase(scenario: str, locks: Set[int]): bool = s' = initial(scenario, locks)
  action init = {
    nondet scenario = Scenarios.oneOf()
    nondet locks = Set(Set(), Set(1), Set(2)).oneOf()
    initCase(scenario, locks)
  }
  pure def Order(grant: Grant, row: int): int = grant.expires * 10 + row
  def Eligible(row: int): bool = s.grants.get(row).present and
    s.grants.get(row).expires <= s.cutoff and Order(s.grants.get(row), row) > s.cursor
  def References(key: int): int = Rows.filter(r => s.grants.get(r).present and s.grants.get(r).key == key).size()
  def MatchesCredential(row: int): bool = {
    val grant = s.grants.get(row)
    if (grant.key == 0) false else {
      val credential = s.keys.get(grant.key)
      credential.present and credential.owner == grant.owner and credential.grant == row
    }
  }
  def Owns(row: int): bool = MatchesCredential(row) and References(s.grants.get(row).key) == 1
  def Safe(row: int): bool = {
    val grant = s.grants.get(row)
    if (grant.status == "pending") grant.key == 0 and grant.lifecycle
    else if (grant.key == 0) false
    else {
      val credential = s.keys.get(grant.key)
      Owns(row) and grant.lifecycle and credential.expires > 0 and
        (if (credential.deleted) not(credential.active) and credential.clean and credential.timelyDeletion
         else if (grant.status == "exchanged") not(credential.active)
         else credential.expires <= s.cutoff and credential.expires == grant.expires)
    }
  }
  pure def endBatch(state: State, phase: str): State = {
    ...state, phase: phase, planned: Set(), plannedOwners: Rows.mapBy(_ => 0),
    lockedRows: Set(), lockedKeys: Set(), safeRows: Set(), tombstones: Set()
  }
  action Tick = all { s.clock < 3, s' = {...s, clock: s.clock + 1} }
  action Release(row: int): bool = all {
    s.externalLocks.contains(row), s' = {...s, externalLocks: s.externalLocks.exclude(Set(row))}
  }
  action ChangeOwner(row: int): bool = all {
    s.grants.get(row).present, not(s.lockedRows.contains(row)), s.grants.get(row).owner <= 2,
    s' = {...s, grants: s.grants.set(row, {...s.grants.get(row), owner: row + 2}),
      externalLocks: s.externalLocks.exclude(Set(row))}
  }
  // One valid proof may already be admitted when cleanup starts. Its commit
  // extends the grant receipt to the credential expiry before the row lock.
  action Acknowledge(row: int): bool = all {
    s.grants.get(row).present, not(s.lockedRows.contains(row)),
    s.grants.get(row).status == "exchanged", s.grants.get(row).key != 0,
    MatchesCredential(row), not(s.lockedKeys.contains(s.grants.get(row).key)),
    not(s.keys.get(s.grants.get(row).key).deleted), not(s.keys.get(s.grants.get(row).key).active),
    s' = {...s, externalLocks: s.externalLocks.exclude(Set(row)),
      grants: s.grants.set(row, {...s.grants.get(row), status: "acknowledged", expires: 3}),
      keys: s.keys.set(s.grants.get(row).key, {...s.keys.get(s.grants.get(row).key), active: true, clean: true})}
  }
  action BeginSweep = all {
    Set("idle", "done").contains(s.phase), s.calls < 2,
    s' = {...s, phase: "ready", calls: s.calls + 1, batches: 0, cutoff: s.clock,
      cursor: 0, previousCursor: 0, scanned: 0, removed: 0, violations: 0}
  }
  action Plan = {
    val eligible = Rows.filter(r => Eligible(r))
    val first = eligible.fold(0, (best, row) =>
      if (best == 0) row else if (Order(s.grants.get(row), row) < Order(s.grants.get(best), best)) row else best)
    val selected = if (BatchSize == 1 and first != 0) Set(first) else eligible
    all {
      s.phase == "ready",
      s' = if (selected.size() == 0) {...s, phase: "done"}
      else {...s, phase: "planned", planned: selected, batches: s.batches + 1,
        plannedOwners: Rows.mapBy(r => if (selected.contains(r)) s.grants.get(r).owner else 0),
        previousCursor: s.cursor,
        cursor: selected.fold(s.cursor, (last, row) =>
          if (Order(s.grants.get(row), row) > last) Order(s.grants.get(row), row) else last),
        scanned: s.scanned + selected.size()}
    }
  }
  action LockRows = {
    val selected = s.planned.filter(r => s.grants.get(r).present and
      s.grants.get(r).expires <= s.cutoff and Order(s.grants.get(r), r) > s.previousCursor and
      not(s.externalLocks.contains(r)))
    all {
      s.phase == "planned",
      s' = if (selected.exists(r => s.grants.get(r).owner != s.plannedOwners.get(r))) endBatch(s, "done")
      else {...s, phase: "rows", lockedRows: selected}
    }
  }
  action LockKeys = all {
    s.phase == "rows",
    s' = {...s, phase: "keys", lockedKeys: s.lockedRows.map(r => s.grants.get(r).key).exclude(Set(0))}
  }
  action Classify = {
    val safe = s.lockedRows.filter(r => Safe(r))
    all {
      s.phase == "keys",
      s' = {...s, phase: "staged", safeRows: safe,
        tombstones: safe.filter(r => s.grants.get(r).key != 0 and
          not(s.keys.get(s.grants.get(r).key).deleted)).map(r => s.grants.get(r).key),
        violations: s.violations + s.lockedRows.exclude(safe).size()}
    }
  }
  action Commit = all {
    s.phase == "staged",
    s' = endBatch({...s,
      grants: Rows.mapBy(r => if (s.safeRows.contains(r)) {...s.grants.get(r), present: false} else s.grants.get(r)),
      keys: Keys.mapBy(k => if (s.tombstones.contains(k)) {...s.keys.get(k), active: false, deleted: true, clean: true, timelyDeletion: true} else s.keys.get(k)),
      writtenKeys: s.writtenKeys.union(s.tombstones),
      unsafeWrite: s.unsafeWrite or s.safeRows.exists(r => not(Safe(r))),
      changedOwnerWrite: s.changedOwnerWrite or s.safeRows.exists(r => s.grants.get(r).owner != s.plannedOwners.get(r)),
      earlyRevocation: s.earlyRevocation or s.tombstones.exists(k => s.keys.get(k).active and s.keys.get(k).expires > s.cutoff),
      removed: s.removed + s.safeRows.size()
    }, if (s.batches == 2) "done" else "ready")
  }
  action Abort = all {
    Set("planned", "rows", "keys", "staged").contains(s.phase),
    s' = endBatch(s, "done")
  }
  action step = any {
    Tick, BeginSweep, Plan, LockRows, LockKeys, Classify, Commit, Abort,
    { nondet row = Rows.oneOf(); Release(row) },
    { nondet row = Rows.oneOf(); ChangeOwner(row) },
    { nondet row = Rows.oneOf(); Acknowledge(row) },
    s' = s
  }
  val TypeOK = and {
    Set(0, 1, 2, 3).contains(s.clock), s.calls >= 0, s.calls <= 2, s.batches >= 0, s.batches <= 2,
    Set("idle", "ready", "planned", "rows", "keys", "staged", "done").contains(s.phase),
    Rows.forall(r => Set("pending", "exchanged", "acknowledged").contains(s.grants.get(r).status))
  }
  val SafeDeletes = not(s.unsafeWrite)
  val OwnerFence = not(s.changedOwnerWrite)
  val NoEarlyCredentialRevocation = not(s.earlyRevocation)
  val TombstonesEraseCiphertext = s.writtenKeys.forall(k => s.keys.get(k).deleted and s.keys.get(k).clean and s.keys.get(k).timelyDeletion and not(s.keys.get(k).active))
  val CursorCountsPlannedRows = s.removed <= s.scanned and s.scanned <= s.batches * BatchSize
  val CursorAdvances = s.planned.size() == 0 or s.cursor > s.previousCursor
  val safety = TypeOK and SafeDeletes and OwnerFence and NoEarlyCredentialRevocation and
    TombstonesEraseCiphertext and CursorCountsPlannedRows and CursorAdvances
  temporal SweepsSettle = and {
    Plan.weakFair(s), LockRows.weakFair(s), LockKeys.weakFair(s), Classify.weakFair(s), Commit.weakFair(s)
  } implies eventually(always(Set("idle", "done").contains(s.phase)))
}
module MobileAppGrantCleanup_one {
  import MobileAppGrantCleanup(BatchSize = 1).*
  run skippedHeadIsRetriedNextSweepTest = initCase("valid", Set(1)).then(Tick).then(Tick)
    .then(BeginSweep).then(Plan).then(LockRows).then(LockKeys).then(Classify).then(Commit)
    .then(Plan).then(LockRows).then(LockKeys).then(Classify).then(Commit)
    .expect(s.grants.get(1).present and not(s.grants.get(2).present))
    .then(Release(1)).then(BeginSweep).then(Plan).then(LockRows).then(LockKeys).then(Classify).then(Commit)
    .expect(not(s.grants.get(1).present))
  run acknowledgementExtendsPlannedGrantDeadlineTest = initCase("acknowledged", Set()).then(Tick).then(Tick)
    .then(BeginSweep).then(Plan).then(Acknowledge(2)).then(LockRows).then(LockKeys).then(Classify).then(Commit)
    .expect(s.grants.get(2).present and s.keys.get(2).active and NoEarlyCredentialRevocation)
}
module MobileAppGrantCleanup_two {
  import MobileAppGrantCleanup(BatchSize = 2).*
  run sharedCredentialCannotBeTombstonedTest = initCase("shared", Set()).then(Tick).then(Tick)
    .then(BeginSweep).then(Plan).then(LockRows).then(LockKeys).then(Classify).then(Commit)
    .expect(s.grants.get(1).present and s.grants.get(2).present and not(s.keys.get(1).deleted))
  run changedOwnerRollsBackWholeBatchTest = initCase("valid", Set()).then(Tick).then(Tick)
    .then(BeginSweep).then(Plan).then(ChangeOwner(2)).then(LockRows)
    .expect(s.phase == "done" and s.grants.get(1).present and s.grants.get(2).present)
}
