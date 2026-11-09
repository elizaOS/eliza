// Source protocol: jobsRepository.claimPendingJobsWithinSharedRunningLimit.
// The production caller supplies both image-change types and the global cap3.
// Uncommitted row/lease updates are transaction locals until commit. A failed
// SQL statement rolls them back. Payload hydration happens after that commit.
// Authorized settlement composes with the separate lease and retry models.
module JobSharedCapacity {
  pure val Jobs = Set(1, 2, 3, 4, 5)
  pure val Callers = Set(1, 2)
  pure val jobTypes = Map(1 -> 1, 2 -> 2, 3 -> 1, 4 -> 2, 5 -> 1)
  pure val organizations = Map(1 -> 1, 2 -> 2, 3 -> 2, 4 -> 1, 5 -> 1)
  type Call = {
    phase: int, jobType: int, organization: int, requested: int, dueAtSelection: bool,
    observed: int, limit: int, eligible: Set[int], selected: Set[int],
    returned: Set[int]
  }
  type State = {
    status: int -> int, generation: int -> int,
    leaseGeneration: int -> int, leaseOwner: int -> int, claimBy: int -> int,
    calls: int -> Call, lockOwner: int, externalLocked: int,
    futureDue: bool, initialRunning: int, capacityViolation: bool
  }
  var s: State
  // Phases:0 not called,1 waiting,2 counted,3 selected,4 leases installed,
  // 5 committed awaiting hydration,6 returned,7 failed.
  pure val emptyCall = {phase: 0, jobType: 0, organization: 0, requested: 0, dueAtSelection: false,
    observed: 0, limit: 0, eligible: Set(), selected: Set(), returned: Set()}
  pure def initialState(running: int): State = {
    status: Jobs.mapBy(j => if (j <= running) 1 else 0),
    generation: Jobs.mapBy(j => if (j <= running) 1 else 0),
    leaseGeneration: Jobs.mapBy(j => if (j <= running) 1 else 0),
    leaseOwner: Jobs.mapBy(j => if (j <= running) 3 else 0),
    claimBy: Jobs.mapBy(_j => 0), calls: Callers.mapBy(_c => emptyCall),
    lockOwner: 0, externalLocked: 0, futureDue: false,
    initialRunning: running, capacityViolation: false
  }
  action emptyInit = s' = initialState(0)
  action occupiedInit = s' = initialState(2)
  action overfullInit = s' = initialState(4)
  val runningJobs = Jobs.filter(j => s.status.get(j) == 1)
  def budget(requested: int, observed: int): int =
    if (observed >= 3) 0 else if (requested < 3 - observed) requested else 3 - observed
  def eligible(c: int): Set[int] = Jobs.filter(j => all {
    s.status.get(j) == 0, s.externalLocked != j, j != 5 or s.futureDue,
    jobTypes.get(j) == s.calls.get(c).jobType,
    s.calls.get(c).organization == 0 or organizations.get(j) == s.calls.get(c).organization
  })
  // IDs are the strict scheduled_for/created_at ordering in this projection.
  def prefix(rows: Set[int], limit: int): Set[int] =
    rows.filter(j => rows.filter(earlier => earlier < j).size() < limit)
  def pending(c: int): bool = s.calls.get(c).phase > 0 and s.calls.get(c).phase < 6
  action begin(c: int, jobType: int, organization: int, requested: int): bool = all {
    s.calls.get(c).phase == 0,
    s' = s.with("calls", s.calls.set(c, {...emptyCall, phase: 1,
      jobType: jobType, organization: organization, requested: requested}))
  }
  // Empty shared types, nonpositive maxRunning or nonpositive limit return
  // no claims before entering the transaction. Their observable result agrees.
  action invalidRequest(c: int): bool = all {
    s.calls.get(c).phase == 0,
    s' = s.with("calls", s.calls.set(c, {...emptyCall, phase: 6}))
  }
  action acquireAndCount(c: int): bool = all {
    s.calls.get(c).phase == 1, s.lockOwner == 0,
    s' = s.with("lockOwner", c).with("calls", s.calls.set(c,
      {...s.calls.get(c), phase: 2, observed: runningJobs.size(),
        limit: budget(s.calls.get(c).requested, runningJobs.size())}))
  }
  action selectRows(c: int): bool = all {
    s.calls.get(c).phase == 2, s.lockOwner == c,
    s' = s.with("calls", s.calls.set(c, {...s.calls.get(c), phase: 3, dueAtSelection: s.futureDue,
      eligible: eligible(c), selected: prefix(eligible(c), s.calls.get(c).limit)}))
  }
  action installLeases(c: int): bool = all {
    s.calls.get(c).phase == 3, s.lockOwner == c,
    s' = s.with("calls", s.calls.set(c, {...s.calls.get(c), phase: 4}))
  }
  action commit(c: int): bool = all {
    s.calls.get(c).phase == 4, s.lockOwner == c,
    s' = s.with("status", Jobs.mapBy(j => if (s.calls.get(c).selected.contains(j)) 1 else s.status.get(j)))
      .with("generation", Jobs.mapBy(j => if (s.calls.get(c).selected.contains(j)) 1 else s.generation.get(j)))
      .with("leaseGeneration", Jobs.mapBy(j => if (s.calls.get(c).selected.contains(j)) 1 else s.leaseGeneration.get(j)))
      .with("leaseOwner", Jobs.mapBy(j => if (s.calls.get(c).selected.contains(j)) c else s.leaseOwner.get(j)))
      .with("claimBy", Jobs.mapBy(j => if (s.calls.get(c).selected.contains(j)) c else s.claimBy.get(j)))
      .with("lockOwner", 0)
      // After commit the source uses only the returned rows for hydration.
      // Keep those rows while projecting the completed query arguments away.
      .with("calls", s.calls.set(c, {...emptyCall, phase: 5,
        selected: s.calls.get(c).selected}))
      // Sticky evidence checks the commit that added occupancy, including
      // after an initially overfull state has drained below its initial size.
      .with("capacityViolation", s.capacityViolation or
        (s.calls.get(c).selected.size() > 0 and runningJobs.size() + s.calls.get(c).selected.size() > 3))
  }
  action abort(c: int): bool = all {
    s.calls.get(c).phase >= 1, s.calls.get(c).phase <= 4,
    s' = s.with("lockOwner", if (s.lockOwner == c) 0 else s.lockOwner)
      .with("calls", s.calls.set(c, {...emptyCall, phase: 7}))
  }
  // Return hydration clears its pending rows and retains the exact returned
  // IDs. A failure retains the durable database claim without a success reply.
  action hydrate(c: int, succeeds: bool): bool = all {
    s.calls.get(c).phase == 5,
    s' = s.with("calls", s.calls.set(c, {...emptyCall,
      phase: if (succeeds) 6 else 7,
      returned: if (succeeds) s.calls.get(c).selected else Set()}))
  }
  action settle(j: int): bool = all {
    s.status.get(j) == 1,
    s' = s.with("status", s.status.set(j, 2))
      .with("leaseGeneration", s.leaseGeneration.set(j, 0))
      .with("leaseOwner", s.leaseOwner.set(j, 0))
  }
  action holdRow(j: int): bool = all {
    s.externalLocked == 0, s.status.get(j) == 0,
    Callers.forall(c => s.calls.get(c).phase < 3 or s.calls.get(c).phase > 4 or
      not(s.calls.get(c).selected.contains(j))),
    s' = s.with("externalLocked", j)
  }
  action releaseRow = all {s.externalLocked != 0, s' = s.with("externalLocked", 0)}
  action dueTimeArrives = all {not(s.futureDue), s' = s.with("futureDue", true)}
  action finish(c: int): bool = {
    nondet succeeds = Set(false, true).oneOf()
    any {acquireAndCount(c), selectRows(c), installLeases(c), commit(c), abort(c), hydrate(c, succeeds)}
  }
  action step = any {
    {
      nondet c = Callers.oneOf()
      nondet t = Set(1, 2).oneOf()
      nondet org = Set(0, 1, 2).oneOf()
      nondet requested = Set(1, 3, 5).oneOf()
      begin(c, t, org, requested)
    },
    {nondet c = Callers.oneOf(); invalidRequest(c)},
    {nondet c = Callers.oneOf(); finish(c)},
    {nondet j = Jobs.oneOf(); settle(j)},
    {nondet j = Jobs.oneOf(); holdRow(j)},
    releaseRow, dueTimeArrives, s' = s
  }
  val lockAgreement = Callers.forall(c =>
    (s.calls.get(c).phase >= 2 and s.calls.get(c).phase <= 4) iff s.lockOwner == c)
  val leaseAgreement = Jobs.forall(j => if (s.status.get(j) == 1)
    s.generation.get(j) == 1 and s.leaseGeneration.get(j) == 1 and s.leaseOwner.get(j) != 0
    else s.leaseGeneration.get(j) == 0 and s.leaseOwner.get(j) == 0)
  val selectedPrefix = Callers.forall(c =>
    (s.calls.get(c).phase >= 3 and s.calls.get(c).phase <= 4) implies all {
      s.calls.get(c).selected == prefix(s.calls.get(c).eligible, s.calls.get(c).limit),
      s.calls.get(c).selected.forall(j => s.status.get(j) == 0 and s.externalLocked != j),
      s.calls.get(c).eligible.forall(j => s.status.get(j) == 0 and (j != 5 or s.calls.get(c).dueAtSelection) and
        jobTypes.get(j) == s.calls.get(c).jobType and
        (s.calls.get(c).organization == 0 or organizations.get(j) == s.calls.get(c).organization))
    })
  val observedBudget = Callers.forall(c =>
    (s.calls.get(c).phase >= 2 and s.calls.get(c).phase <= 4) implies
      (s.calls.get(c).limit == budget(s.calls.get(c).requested, s.calls.get(c).observed) and
        s.calls.get(c).observed >= runningJobs.size()))
  val returnedIdentity = Callers.forall(c =>
    s.calls.get(c).returned.forall(j => s.claimBy.get(j) == c and s.generation.get(j) == 1))
  val safety = lockAgreement and leaseAgreement and selectedPrefix and observedBudget and
    returnedIdentity and not(s.capacityViolation) and
    runningJobs.size() <= (if (s.initialRunning > 3) s.initialRunning else 3)
  temporal PendingCallCompletes =
    (finish(1).weakFair(s) and finish(2).weakFair(s)) implies all {
      always(pending(1) implies eventually(s.calls.get(1).phase >= 6)),
      always(pending(2) implies eventually(s.calls.get(2).phase >= 6))
    }

  run sharedCapacityAcrossTypesTest = occupiedInit
    .then(begin(1, 1, 0, 3)).then(begin(2, 2, 0, 3))
    .then(acquireAndCount(1)).then(selectRows(1)).then(installLeases(1)).then(commit(1))
    .then(acquireAndCount(2)).then(selectRows(2)).then(installLeases(2)).then(commit(2))
    .then(hydrate(1, true)).then(hydrate(2, true))
    .expect(runningJobs.size() == 3 and s.calls.get(1).returned == Set(3) and
      s.calls.get(2).returned == Set() and safety)
  run lockedDueRowIsSkippedTest = emptyInit.then(holdRow(1)).then(begin(1, 1, 0, 3))
    .then(acquireAndCount(1)).then(selectRows(1)).then(installLeases(1)).then(commit(1))
    .then(hydrate(1, true)).expect(s.calls.get(1).returned == Set(3) and safety)
  run failedLeaseInstallationRollsBackTest = emptyInit.then(begin(1, 1, 0, 3))
    .then(acquireAndCount(1)).then(selectRows(1)).then(abort(1))
    .expect(runningJobs == Set() and s.generation.get(1) == 0 and safety)
  run failedHydrationRetainsClaimTest = emptyInit.then(begin(1, 2, 0, 1))
    .then(acquireAndCount(1)).then(selectRows(1)).then(installLeases(1)).then(commit(1))
    .then(hydrate(1, false)).expect(s.calls.get(1).phase == 7 and s.calls.get(1).returned == Set()
      and s.status.get(2) == 1 and s.leaseOwner.get(2) == 1 and safety)
  run historicalOverfullDoesNotAdmitTest = overfullInit.then(begin(1, 1, 0, 5))
    .then(acquireAndCount(1)).then(selectRows(1)).then(installLeases(1)).then(commit(1))
    .then(hydrate(1, true)).expect(runningJobs.size() == 4 and s.calls.get(1).returned == Set() and safety)
  run settlementAfterCountIsConservativeTest = occupiedInit.then(begin(1, 1, 0, 5))
    .then(acquireAndCount(1)).then(settle(1)).then(dueTimeArrives).then(selectRows(1))
    .then(installLeases(1)).then(commit(1)).then(hydrate(1, true))
    .expect(runningJobs.size() == 2 and s.calls.get(1).returned == Set(3) and safety)
  run responseCanFollowSettlementTest = emptyInit.then(begin(1, 1, 0, 1))
    .then(acquireAndCount(1)).then(selectRows(1)).then(installLeases(1)).then(commit(1))
    .then(settle(1)).then(hydrate(1, true))
    .expect(s.calls.get(1).returned == Set(1) and s.status.get(1) == 2 and safety)
  run tenantFilterPreservesGlobalCountTest = occupiedInit.then(dueTimeArrives).then(begin(1, 1, 1, 5))
    .then(acquireAndCount(1)).then(selectRows(1)).then(installLeases(1))
    .then(commit(1)).then(hydrate(1, true))
    .expect(s.calls.get(1).returned == Set(5) and runningJobs.size() == 3 and safety)
  run selectionObservesDueAfterLockWaitTest = occupiedInit.then(begin(1, 1, 1, 5))
    .then(dueTimeArrives).then(acquireAndCount(1)).then(selectRows(1)).then(installLeases(1))
    .then(commit(1)).then(hydrate(1, true))
    .expect(s.calls.get(1).returned == Set(5) and runningJobs.size() == 3 and safety)
  run dueAfterSelectionWaitsForNextClaimTest = occupiedInit.then(begin(1, 1, 1, 5))
    .then(acquireAndCount(1)).then(selectRows(1)).then(dueTimeArrives).then(installLeases(1))
    .then(commit(1)).then(hydrate(1, true)).then(begin(2, 1, 1, 5))
    .then(acquireAndCount(2)).then(selectRows(2)).then(installLeases(2)).then(commit(2))
    .then(hydrate(2, true)).expect(s.calls.get(1).returned == Set() and
      s.calls.get(2).returned == Set(5) and runningJobs.size() == 3 and safety)
  run invalidCapacityReturnsEmptyTest = emptyInit.then(invalidRequest(1))
    .expect(s.calls.get(1).phase == 6 and runningJobs == Set() and safety)
}
