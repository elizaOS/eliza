// Source mapping: account-storage.ts acquireStorageLock, removeStaleLock,
// hasLiveQuarantinedLock and releaseStorageLock. A token identifies a published
// owner. Atomic rename may move a successor after an old observation. The moved
// live owner remains authoritative until release. The ordinary directory name
// is checked again immediately before admission. Each process attempts once;
// failed admission represents one retired acquisition attempt, not call success.
// Ownerless age is abstracted as an enabled stale observation. Crash removes
// process liveness. Filesystem calls eventually succeeding is a progress premise.
module AccountStorageLock {
  val processes = Set(1, 2, 3)
  val tokens = Set(1, 2, 3, 4)
  pure def owner(token: int): int = token - 1
  type State = {
    current: int,
    quarantined: Set[int],
    exists: Set[int],
    published: Set[int],
    alive: Set[int],
    critical: Set[int],
    held: int -> int,
    pc: int -> str,
    ordinaryRelease: int -> bool,
    staged: int -> int,
  }
  var s: State
  pure def initialState(deadLock: bool): State = {
    current: if (deadLock) 1 else 0,
    quarantined: Set(), exists: if (deadLock) Set(1) else Set(),
    published: if (deadLock) Set(1) else Set(),
    alive: processes, critical: Set(), held: processes.mapBy(_ => 0),
    pc: processes.mapBy(_ => "new"), ordinaryRelease: processes.mapBy(_ => false),
    staged: processes.mapBy(_ => 0),
  }
  action init = s' = initialState(true)
  action initEmpty = s' = initialState(false)
  def livePublished(token: int): bool =
    s.published.contains(token) and s.alive.contains(owner(token))

  action observeDead(p: int): bool = all {
    s.pc.get(p) == "new",
    s.current != 0,
    not(livePublished(s.current)),
    s' = { ...s, pc: s.pc.set(p, "observed") },
  }
  action quarantineObserved(p: int): bool = all {
    s.pc.get(p) == "observed",
    s' = {
      ...s, current: 0,
      quarantined: if (s.current != 0) s.quarantined.union(Set(s.current)) else s.quarantined,
      pc: s.pc.set(p, "new"),
    },
  }
  action create(p: int): bool = all {
    s.pc.get(p) == "new",
    s.current == 0,
    s.held.get(p) == 0,
    s' = {
      ...s, current: p + 1, exists: s.exists.union(Set(p + 1)),
      held: s.held.set(p, p + 1), pc: s.pc.set(p, "publishing"),
    },
  }
  action publish(p: int): bool = all {
    s.pc.get(p) == "publishing",
    s' = {
      ...s,
      published: if (s.exists.contains(s.held.get(p)))
        s.published.union(Set(s.held.get(p)))
      else s.published,
      pc: s.pc.set(p, if (s.exists.contains(s.held.get(p))) "ready" else "closing"),
    },
  }
  action publicationFailure(p: int): bool = all {
    s.pc.get(p) == "publishing",
    s' = { ...s, pc: s.pc.set(p, "closing") },
  }
  action inspectAdmission(p: int): bool = all {
    s.pc.get(p) == "ready",
    val admitted = s.current == s.held.get(p) and
      not(s.quarantined.exists(token => livePublished(token)))
    s' = { ...s, pc: s.pc.set(p, if (admitted) "checked" else "closing") },
  }
  action enter(p: int): bool = all {
    s.pc.get(p) == "checked",
    s' = {
      ...s,
      critical: if (s.current == s.held.get(p)) s.critical.union(Set(p)) else s.critical,
      pc: s.pc.set(p, if (s.current == s.held.get(p)) "inside" else "closing"),
    },
  }
  action leave(p: int): bool = all {
    s.pc.get(p) == "inside",
    s' = { ...s, critical: s.critical.exclude(Set(p)), pc: s.pc.set(p, "closing") },
  }
  action findRelease(p: int): bool = all {
    s.pc.get(p) == "closing",
    val present = s.current == s.held.get(p) or s.quarantined.contains(s.held.get(p))
    s' = {
      ...s, ordinaryRelease: s.ordinaryRelease.set(p, s.current == s.held.get(p)),
      pc: s.pc.set(p, if (present) "releaseRename" else "done"),
    },
  }
  action stageRelease(p: int): bool = all {
    s.pc.get(p) == "releaseRename",
    val moved = if (s.ordinaryRelease.get(p)) s.current else s.held.get(p)
    s' = {
      ...s,
      current: if (s.ordinaryRelease.get(p)) 0 else s.current,
      quarantined: if (moved != 0) s.quarantined.union(Set(moved)) else s.quarantined,
      staged: s.staged.set(p, moved), pc: s.pc.set(p, "releaseCheck"),
    },
  }
  action finishRelease(p: int): bool = all {
    s.pc.get(p) == "releaseCheck",
    val ours = s.staged.get(p) == s.held.get(p)
    s' = {
      ...s,
      quarantined: if (ours) s.quarantined.exclude(Set(s.held.get(p))) else s.quarantined,
      exists: if (ours) s.exists.exclude(Set(s.held.get(p))) else s.exists,
      published: if (ours) s.published.exclude(Set(s.held.get(p))) else s.published,
      pc: s.pc.set(p, if (ours) "done" else "closing"),
    },
  }
  action cleanQuarantine(token: int): bool = all {
    s.quarantined.contains(token),
    not(livePublished(token)),
    s' = {
      ...s, quarantined: s.quarantined.exclude(Set(token)),
      exists: s.exists.exclude(Set(token)), published: s.published.exclude(Set(token)),
    },
  }
  action crash(p: int): bool = all {
    s.alive.contains(p),
    s' = {
      ...s, alive: s.alive.exclude(Set(p)), critical: s.critical.exclude(Set(p)),
      pc: s.pc.set(p, "dead"),
    },
  }
  action claim(p: int): bool = any { observeDead(p), quarantineObserved(p), create(p) }
  action publication(p: int): bool = any { publish(p), publicationFailure(p) }
  action step = any {
    { nondet p = processes.oneOf() any {
      claim(p), publication(p), inspectAdmission(p), enter(p), leave(p),
      findRelease(p), stageRelease(p), finishRelease(p), crash(p),
    } },
    { nondet token = tokens.oneOf() cleanQuarantine(token) },
    s' = s,
  }
  val MutualExclusion = s.critical.size() <= 1
  val ActiveOwnership = s.critical.forall(p => and {
    s.exists.contains(s.held.get(p)), s.published.contains(s.held.get(p)),
    s.alive.contains(p), owner(s.held.get(p)) == p,
  })
  val LiveQuarantineProtected = s.critical.forall(p =>
    s.current == s.held.get(p) or s.quarantined.contains(s.held.get(p)))
  val invariant = MutualExclusion and ActiveOwnership and LiveQuarantineProtected
  temporal FairWork = processes.forall(p => and {
    claim(p).weakFair(s), publication(p).weakFair(s), inspectAdmission(p).weakFair(s),
    enter(p).weakFair(s), leave(p).weakFair(s), findRelease(p).weakFair(s),
    stageRelease(p).weakFair(s), finishRelease(p).weakFair(s),
  }) and tokens.forall(token => cleanQuarantine(token).weakFair(s))
  temporal AttemptsTerminate = FairWork.implies(eventually(
    processes.forall(p => s.pc.get(p).in(Set("done", "dead")))))

  action unsafeReap(p: int): bool = all {
    s.pc.get(p) == "observed",
    s' = {
      ...s, current: 0, exists: s.exists.exclude(Set(s.current)),
      published: s.published.exclude(Set(s.current)), pc: s.pc.set(p, "new"),
    },
  }
  run oldStaleObservationLosesOwnerTest = init.then(observeDead(1)).then(observeDead(2))
    .then(quarantineObserved(2)).then(cleanQuarantine(1)).then(create(2))
    .then(publish(2)).then(inspectAdmission(2)).then(enter(2)).then(unsafeReap(1))
    .expect(not(ActiveOwnership))
  run staleObservationPreservesOwnerTest = init.then(observeDead(1)).then(observeDead(2))
    .then(quarantineObserved(2)).then(cleanQuarantine(1)).then(create(2))
    .then(publish(2)).then(inspectAdmission(2)).then(enter(2)).then(quarantineObserved(1))
    .then(create(1)).then(publish(1)).then(inspectAdmission(1))
    .expect(invariant and s.pc.get(1) == "closing")
}
