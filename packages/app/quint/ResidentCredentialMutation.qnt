// Android resident credential replacement. A stop receipt proves absence for
// its exact lease. A confirmed stop alone never releases a failed write.
module ResidentCredentialMutation {
  pure val Owners = Set(1, 2)
  pure val NoJob = { phase: "unused", value: 0, before: 0, result: "none" }
  pure val NoLease = { owner: 0, pending: false, confirmed: false, abandoned: false }
  pure val NoCommit = { owner: 0, intent: 0, changed: false,
    stopped: false, stopOwner: 0, stopConfirmed: false }

  type Job = { phase: str, value: int, before: int, result: str }
  type Lease = { owner: int, pending: bool, confirmed: bool, abandoned: bool }
  type Commit = { owner: int, intent: int, changed: bool,
    stopped: bool, stopOwner: int, stopConfirmed: bool }
  type State = {
    intent: int, lifecycle: int, pendingMutation: int,
    value: int, pendingRecord: bool, stopped: bool,
    jobs: int -> Job, lease: Lease, commit: Commit
  }
  var s: State

  action init = s' = {
    intent: 0, lifecycle: 0, pendingMutation: 0,
    value: 0, pendingRecord: true, stopped: false,
    jobs: Map(1 -> NoJob, 2 -> NoJob), lease: NoLease, commit: NoCommit
  }

  action reserve(value: int): bool = {
    val id = s.intent + 1
    all {
      s.intent < 2,
      s' = { ...s, intent: id, jobs: s.jobs.set(id, { ...NoJob, phase: "reserved", value: value }) }
    }
  }

  pure def finish(x: State, id: int, result: str): State =
    { ...x, jobs: x.jobs.set(id, { ...x.jobs.get(id), phase: "done", result: result }),
      pendingMutation: if (x.pendingMutation == id) 0 else x.pendingMutation }

  pure def abandon(lease: Lease, id: int): Lease =
    if (lease.owner == id and lease.pending)
      { ...lease, abandoned: true, pending: not(lease.confirmed) }
    else lease

  action begin(id: int): bool = {
    val job = s.jobs.get(id)
    all {
      job.phase == "reserved",
      s' = if (id != s.intent) finish(s, id, "stale")
        else if (job.value == s.value)
          finish({ ...s, commit: { ...NoCommit, owner: id, intent: s.intent } }, id, "committed")
        else { ...s, lifecycle: id, pendingMutation: id,
          jobs: s.jobs.set(id, { ...job, phase: "retiring", before: s.value }) }
    }
  }

  def ownsMutation(id: int): bool =
    id == s.intent and id == s.lifecycle and id == s.pendingMutation

  action dispatchStop(id: int, delivered: bool): bool = {
    val lease = { ...NoLease, owner: id, pending: true }
    all {
      s.jobs.get(id).phase == "retiring",
      s' = if (not(ownsMutation(id))) finish(s, id, "stale")
        else if (not(delivered))
          finish({ ...s, lease: abandon(lease, id) }, id, "dispatch-failed")
        else { ...s, lease: lease,
          jobs: s.jobs.set(id, { ...s.jobs.get(id), phase: "waiting" }) }
    }
  }

  action acknowledge(id: int, stopped: bool): bool =
    s' = if (s.lease.owner == id and s.lease.pending)
      { ...s, lease: { ...s.lease, confirmed: stopped,
        pending: not(stopped and s.lease.abandoned) } }
      else s

  action inventory(stopped: bool): bool = s' = { ...s, stopped: stopped }

  action cancelOrTimeout(id: int): bool = all {
    s.jobs.get(id).phase == "waiting",
    s' = finish({ ...s, lease: abandon(s.lease, id) }, id,
      if (ownsMutation(id)) "timeout" else "stale")
  }

  // The conductor holds the lifecycle and credential locks from the final
  // owner and absence checks through exact readback.
  action commit(id: int, effect: str): bool = {
    val job = s.jobs.get(id)
    val confirmed = effect == "confirmed"
    all {
      job.phase == "waiting", ownsMutation(id),
      s.stopped, s.lease.owner == id, s.lease.pending, s.lease.confirmed,
      job.before == s.value,
      s' = finish({
        ...s, pendingRecord: false,
        value: if (effect == "missing-write") s.value else job.value,
        lease: if (confirmed) { ...s.lease, pending: false } else s.lease,
        commit: { owner: id, intent: s.intent, changed: true, stopped: s.stopped,
          stopOwner: s.lease.owner, stopConfirmed: s.lease.confirmed }
      }, id, if (confirmed) "committed" else "uncertain")
    }
  }

  action launch = all {
    not(s.lease.pending),
    s' = { ...s, stopped: false, lease: NoLease }
  }

  action advance(id: int): bool = any {
    begin(id), dispatchStop(id, true), dispatchStop(id, false),
    cancelOrTimeout(id), commit(id, "confirmed"),
    commit(id, "missing-write"), commit(id, "lost-readback")
  }

  action idle = s' = s
  action step = any {
    nondet value = Set(0, 1, 2).oneOf()
    reserve(value),
    nondet id = Owners.oneOf()
    any { advance(id), acknowledge(id, true), acknowledge(id, false) },
    inventory(true), inventory(false), launch, idle
  }

  val IntentOwnsCommit = s.commit.owner == s.commit.intent

  val ChangedCommitRequiresExactStop = (s.commit.changed).implies(all {
    s.commit.stopped, s.commit.stopConfirmed, s.commit.stopOwner == s.commit.owner
  })

  val FailedCommitRetainsLaunchFence = Owners.forall(id =>
    (s.lease.owner == id and s.jobs.get(id).result == "uncertain").implies(s.lease.pending))

  val LiveMutationHasItsEpoch = (s.pendingMutation != 0).implies(all {
    s.pendingMutation == s.lifecycle,
    s.jobs.get(s.pendingMutation).phase.in(Set("retiring", "waiting"))
  })

  val AbandonedLeaseReleasesOnlyAfterProof =
    (s.lease.abandoned and not(s.lease.pending)).implies(s.lease.confirmed)

  def active(id: int): bool =
    s.jobs.get(id).phase.in(Set("reserved", "retiring", "waiting"))

  temporal EachMutationSettles = Owners.forall(id => always(
    (active(id)).implies(eventually(not(active(id))))))
  temporal UnderFairProgress = Owners.forall(id => advance(id).weakFair(s))
    .implies(EachMutationSettles)

  run confirmedStopAndReadbackTest = init.then(reserve(1)).then(begin(1))
    .then(dispatchStop(1, true)).then(inventory(true)).then(acknowledge(2, true))
    .expect(not(s.lease.confirmed)).then(acknowledge(1, true))
    .then(commit(1, "confirmed"))
    .expect(s.value == 1 and not(s.pendingRecord) and not(s.lease.pending))

  run staleFinishCannotAbandonNewLeaseTest = init.then(reserve(1)).then(begin(1))
    .then(dispatchStop(1, true)).then(reserve(2)).then(begin(2))
    .then(dispatchStop(2, true)).then(cancelOrTimeout(1))
    .expect(s.lease.owner == 2 and s.lease.pending and not(s.lease.abandoned))

  run uncertainCommitRetainsFenceTest = init.then(reserve(1)).then(begin(1))
    .then(dispatchStop(1, true)).then(inventory(true)).then(acknowledge(1, true))
    .then(commit(1, "lost-readback"))
    .expect(s.value == 1 and s.lease.pending and s.jobs.get(1).result == "uncertain")

  run timeoutWaitsForLateExactAcknowledgementTest = init.then(reserve(1)).then(begin(1))
    .then(dispatchStop(1, true)).then(cancelOrTimeout(1)).then(acknowledge(2, true))
    .expect(s.lease.pending and s.lease.abandoned and s.value == 0)
    .then(acknowledge(1, true)).expect(not(s.lease.pending) and s.value == 0)
}
