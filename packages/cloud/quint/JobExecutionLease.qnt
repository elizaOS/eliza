// Source slice of jobs.ts and agent-lifecycle-execution-fence.ts.
// One detached, already-due job can pass through two fresh generations. Zero
// represents a legacy NULL generation. UUIDs are abstracted to distinct ints.
// Claim and lease install commit together before the caller receives a DTO.
// Successful delivery and failed hydration have the same database projection.
// Lease age0 is live, age1 is expired within the 30-second recovery grace, and
// age2 is outside that grace. Matching owners can renew any age until a recovery
// wins the job-row lock. Terminal same-generation renewal returns settled even
// when the supplied owner differs.
// Resource3 belongs to a different job. Its state must survive this job's
// recovery. Resource existence is fixed per case; deletion races, dispatch
// authorization, budgets, payload snapshots and provider effects remain gaps.
module JobExecutionLease {
  const Legacy: bool
  const Lifecycle: bool
  const ResourceExists: bool
  const ForeignResource: bool
  pure val Workers = Set(1, 2)
  pure val Terminal = Set("completed", "failed", "cancelled")
  pure val Completion = Set("completed", "cancelled")
  type Recovery = { phase: str, generation: int, quiesced: bool }
  type State = {
    status: str,
    generation: int,
    lease: bool,
    leaseGeneration: int,
    leaseOwner: int,
    leaseAge: int,
    quiesced: bool,
    startedOld: bool,
    due: bool,
    resourceFence: int,
    payload: int,
    deliveries: int -> int,
    recoveries: int -> Recovery,
    lastReturn: str,
    staleWrite: bool
  }
  var s: State
  action init = s' = {
    status: if (Legacy) "in_progress" else "pending", generation: 0,
    lease: false, leaseGeneration: 0, leaseOwner: 0, leaseAge: 0,
    quiesced: false, startedOld: Legacy, due: true, resourceFence: if (ForeignResource) 3 else 0, payload: 0,
    deliveries: Workers.mapBy(_ => 0),
    recoveries: Workers.mapBy(_ => {phase: "new", generation: 0, quiesced: false}),
    lastReturn: "none", staleWrite: false
  }
  def CurrentLease(worker: int, generation: int): bool = and {
    generation > 0, s.status == "in_progress", not(s.quiesced),
    s.generation == generation, s.lease, s.leaseGeneration == generation,
    s.leaseOwner == worker, s.leaseAge == 0
  }
  action Claim(worker: int, organization: int): bool = all {
    organization == 1, s.status == "pending", s.due, s.generation < 2,
    s' = {...s, status: "in_progress", generation: s.generation + 1,
      lease: true, leaseGeneration: s.generation + 1, leaseOwner: worker, leaseAge: 0,
      quiesced: false, startedOld: false,
      deliveries: s.deliveries.set(worker, s.generation + 1), lastReturn: "claimed"}
  }
  action Deliver(worker: int): bool = all {
    s.deliveries.get(worker) != 0,
    s' = {...s, deliveries: s.deliveries.set(worker, 0)}
  }
  action LoseClaimReply(worker: int): bool = all {
    s.deliveries.get(worker) != 0,
    s' = {...s, deliveries: s.deliveries.set(worker, 0)}
  }
  action LeaseExpires = all { s.lease, s.leaseAge == 0, s' = {...s, leaseAge: 1} }
  // Age1 is the expired-but-protected 30-second takeover grace. Renewal may
  // revive either expired age while its generation and owner still match.
  action GraceEnds = all { s.lease, s.leaseAge == 1, s' = {...s, leaseAge: 2} }
  action JobAges = all { s.status == "in_progress", not(s.startedOld), s' = {...s, startedOld: true} }
  action Renew(worker: int, generation: int): bool = all {
    generation > 0,
    s' = if (s.status != "in_progress" or s.generation != generation or s.quiesced) {
      ...s, lastReturn: if (s.generation == generation and Terminal.contains(s.status)) "settled" else "lost"
    } else if (s.lease and s.leaseGeneration == generation and s.leaseOwner == worker) {
      ...s, leaseAge: 0, lastReturn: "renewed"
    } else {...s, lastReturn: "lost"}
  }
  action AcquireResource(worker: int, generation: int): bool = all {
    Lifecycle, ResourceExists,
    s' = if (CurrentLease(worker, generation) and
      (s.resourceFence == 0 or s.resourceFence == generation)) {
      ...s, resourceFence: generation, lastReturn: "acquired"
    } else {...s, lastReturn: "stale"}
  }
  action Mutate(worker: int, generation: int, value: int): bool = {
    val allowed = CurrentLease(worker, generation)
    s' = if (allowed) {...s, payload: value, lastReturn: "written",
      staleWrite: s.staleWrite or generation != s.generation or worker != s.leaseOwner}
      else {...s, lastReturn: "stale"}
  }
  action Settle(worker: int, generation: int, status: str): bool = all {
    Completion.contains(status),
    s' = if (CurrentLease(worker, generation) and
      (not(Lifecycle) or not(ResourceExists) or s.resourceFence == generation)) {
      ...s, status: status, quiesced: true, lease: false, leaseAge: 0,
      leaseOwner: 0, leaseGeneration: 0, resourceFence: 0, lastReturn: "settled"
    } else {...s, lastReturn: "stale"}
  }
  action Reject(worker: int, generation: int): bool = all {
    generation > 0,
    s' = if (s.generation != generation) {...s, lastReturn: "stale"}
      else if (Terminal.contains(s.status)) {...s, lastReturn: "already-terminal"}
      else if (s.status != "in_progress" or s.quiesced) {...s, lastReturn: "stale"}
      else if (CurrentLease(worker, generation)) {
        ...s, status: "failed", quiesced: true,
        lease: false, leaseAge: 0, leaseOwner: 0, leaseGeneration: 0,
        lastReturn: "rejected"
      } else {...s, lastReturn: "lost"}
  }
  action CaptureRecovery(worker: int): bool = all {
    s.recoveries.get(worker).phase == "new", s.status == "in_progress", s.startedOld,
    s.generation == 0 or s.quiesced or not(s.lease) or s.leaseAge == 2,
    s' = {...s, recoveries: s.recoveries.set(worker,
      {phase: "prepared", generation: s.generation, quiesced: s.quiesced})}
  }
  action Recover(worker: int, succeeds: bool): bool = {
    val snapshot = s.recoveries.get(worker)
    // Finished calls release their snapshot. Only the completion marker remains.
    val done = s.recoveries.set(worker, {phase: "done", generation: 0, quiesced: false})
    all {
      snapshot.phase == "prepared",
      s' = if (not(succeeds)) {...s, recoveries: done, lastReturn: "storage-error"}
      else if (s.status == "in_progress" and s.startedOld and
        s.generation == snapshot.generation and s.quiesced == snapshot.quiesced and
        (s.generation == 0 or not(s.lease) or s.leaseAge == 2)) {
        ...s, status: "pending", quiesced: true,
        lease: false, leaseAge: 0, leaseOwner: 0, leaseGeneration: 0,
        resourceFence: if (s.resourceFence == s.generation) 0 else s.resourceFence,
        recoveries: done, lastReturn: "recovered"
      } else {...s, recoveries: done, lastReturn: "unchanged"}
    }
  }
  action TransactionFailure = s' = s
  action step = any {
    { nondet w = Workers.oneOf(); nondet org = Set(1, 2).oneOf(); Claim(w, org) },
    { nondet w = Workers.oneOf(); Deliver(w) },
    { nondet w = Workers.oneOf(); LoseClaimReply(w) },
    { nondet w = Workers.oneOf(); nondet g = Set(1, 2).oneOf(); Renew(w, g) },
    { nondet w = Workers.oneOf(); nondet g = Set(1, 2).oneOf(); AcquireResource(w, g) },
    { nondet w = Workers.oneOf(); nondet g = Set(1, 2).oneOf(); nondet value = Set(0, 1).oneOf(); Mutate(w, g, value) },
    { nondet w = Workers.oneOf(); nondet g = Set(1, 2).oneOf(); nondet status = Completion.oneOf(); Settle(w, g, status) },
    { nondet w = Workers.oneOf(); nondet g = Set(1, 2).oneOf(); Reject(w, g) },
    { nondet w = Workers.oneOf(); CaptureRecovery(w) },
    { nondet w = Workers.oneOf(); nondet succeeds = Set(true, false).oneOf(); Recover(w, succeeds) },
    LeaseExpires, GraceEnds, JobAges, TransactionFailure, s' = s
  }
  val TypeOK = and {
    Set("pending", "in_progress", "completed", "failed", "cancelled").contains(s.status),
    0 <= s.generation and s.generation <= 2,
    0 <= s.leaseGeneration and s.leaseGeneration <= 2,
    Set(0, 1, 2).contains(s.leaseOwner), Set(0, 1, 2).contains(s.leaseAge),
    Set(0, 1, 2, 3).contains(s.resourceFence), Set(0, 1).contains(s.payload),
    s.deliveries.keys() == Workers,
    s.recoveries.keys() == Workers,
    Workers.forall(w => and {
      Set(0, 1, 2).contains(s.deliveries.get(w)),
      Set("new", "prepared", "done").contains(s.recoveries.get(w).phase),
      Set(0, 1, 2).contains(s.recoveries.get(w).generation)
    })
  }
  val LeaseIdentity = not(s.lease) or and {
    s.status == "in_progress", not(s.quiesced), s.generation > 0,
    s.leaseGeneration == s.generation, Workers.contains(s.leaseOwner)
  }
  val TerminalHasNoLease = not(Terminal.contains(s.status)) or not(s.lease)
  val FenceMatchesGeneration = s.resourceFence == 0 or s.resourceFence == 3 or s.resourceFence == s.generation
  val ForeignFenceRetained = not(ForeignResource) or s.resourceFence == 3
  val StaleGenerationCannotWrite = not(s.staleWrite)
  val safety = TypeOK and LeaseIdentity and TerminalHasNoLease and FenceMatchesGeneration and ForeignFenceRetained and StaleGenerationCannotWrite
  temporal RecoveryCallsSettle = Workers.forall(w => Recover(w, true).weakFair(s)) implies
    eventually(always(Workers.forall(w => s.recoveries.get(w).phase != "prepared")))
}
module JobExecutionLease_plain {
  import JobExecutionLease(Legacy = false, Lifecycle = false, ResourceExists = false, ForeignResource = false).*
  run expiredLeaseCanRenewBeforeTakeoverTest = init.then(Claim(1, 1)).then(Deliver(1))
    .then(LeaseExpires).then(GraceEnds).then(Renew(1, 1))
    .expect(safety and s.lastReturn == "renewed" and s.leaseAge == 0)
  run staleGenerationLosesAfterRecoveryTest = init.then(Claim(1, 1)).then(Deliver(1))
    .then(JobAges).then(LeaseExpires).then(GraceEnds).then(CaptureRecovery(2)).then(Recover(2, true))
    .then(Claim(2, 1)).then(Deliver(2)).then(Mutate(2, 2, 1)).then(Mutate(1, 1, 0))
    .expect(safety and s.generation == 2 and s.payload == 1 and s.lastReturn == "stale")
  run renewalInvalidatesRecoverySnapshotTest = init.then(Claim(1, 1)).then(JobAges)
    .then(LeaseExpires).then(GraceEnds).then(CaptureRecovery(2)).then(Renew(1, 1)).then(Recover(2, true))
    .expect(safety and s.status == "in_progress" and s.lastReturn == "unchanged")
  run rejectionDoesNotSpendAuthorityTwiceTest = init.then(Claim(1, 1)).then(Reject(1, 1))
    .then(Reject(1, 1)).then(Renew(2, 1))
    .expect(safety and s.status == "failed" and s.lastReturn == "settled")
  run terminalReplayClassifiesAsSettledTest = init.then(Claim(1, 1)).then(Settle(1, 1, "completed")).then(Renew(2, 1))
    .expect(safety and s.lastReturn == "settled")
}
module JobExecutionLease_lifecycle {
  import JobExecutionLease(Legacy = false, Lifecycle = true, ResourceExists = true, ForeignResource = false).*
  run settlementRequiresResourceFenceTest = init.then(Claim(1, 1)).then(Settle(1, 1, "completed"))
    .expect(s.status == "in_progress").then(AcquireResource(1, 1)).then(Settle(1, 1, "completed"))
    .expect(safety and s.status == "completed" and s.resourceFence == 0)
}
module JobExecutionLease_legacy {
  import JobExecutionLease(Legacy = true, Lifecycle = false, ResourceExists = false, ForeignResource = false).*
  run missingGenerationRecoversTest = init.then(CaptureRecovery(1)).then(Recover(1, true)).then(Claim(2, 1))
    .expect(safety and s.generation == 1 and s.leaseOwner == 2)
}

module JobExecutionLease_missing_resource {
  import JobExecutionLease(Legacy = false, Lifecycle = true, ResourceExists = false, ForeignResource = false).*
  run missingResourceDoesNotBlockJobSettlementTest = init.then(Claim(1, 1)).then(Settle(1, 1, "completed"))
    .expect(safety and s.status == "completed")
}

module JobExecutionLease_foreign_resource {
  import JobExecutionLease(Legacy = false, Lifecycle = true, ResourceExists = true, ForeignResource = true).*
  run recoveryDoesNotReleaseAnotherJobsResourceTest = init.then(Claim(1, 1))
    .then(AcquireResource(1, 1)).expect(s.resourceFence == 3)
    .then(Settle(1, 1, "completed")).expect(s.status == "in_progress")
    .then(JobAges).then(LeaseExpires).then(GraceEnds)
    .then(CaptureRecovery(2)).then(Recover(2, true))
    .expect(safety and s.status == "pending" and s.resourceFence == 3)
}
