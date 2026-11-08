// AUDIT MODEL: job-row authority is distinct from outstanding provider effects.
// Sources: db/repositories/jobs.ts claim/renew/recover/settle and
// node/provisioning-worker.ts processJobType/assertExecutionMutationLease.
// Job/lease/resource locks and a post-wait database clock check form one commit.
// Provider effects remain outside the transaction: cancellation cannot retract them.
// Bounds: one job, two execution generations, clock 0..6, lease1/grace1.
module provisioning_execution {
  pure val generations = Set(1, 2)
  type State = {
    status: str, current: int, owner: int, now: int, expiry: int,
    quiesced: Set[int], heartbeat: Set[int], timedOut: Set[int],
    activeRemote: Set[int], remoteReceipts: Set[int], published: Set[int],
    calls: int -> int, staleJobWrite: bool, staleWorkloadWrite: bool
  }
  var s: State
  action init = s' = {
    status: "pending", current: 0, owner: 0, now: 0, expiry: 0,
    quiesced: Set(), heartbeat: Set(), timedOut: Set(), activeRemote: Set(),
    remoteReceipts: Set(), published: Set(), calls: Map(1 -> 0, 2 -> 0),
    staleJobWrite: false, staleWorkloadWrite: false
  }
  def owned(g) = s.status == "running" and s.current == g and s.owner == g and not(s.quiesced.contains(g))
  def writable(g) = owned(g) and s.now < s.expiry
  action claim = all {
    s.status == "pending", s.current < 2,
    s' = s.with("status", "running").with("current", s.current + 1)
      .with("owner", s.current + 1).with("expiry", s.now + 1)
      .with("heartbeat", s.heartbeat.union(Set(s.current + 1)))
  }
  action tick = all { s.now < 6, s' = s.with("now", s.now + 1) }
  // Expired same-generation leases can be renewed until recovery wins its CAS.
  action renew(g) = all {
    owned(g), s.heartbeat.contains(g), s' = s.with("expiry", s.now + 1)
  }
  action pauseWorker(g) = s' = s.with("heartbeat", s.heartbeat.exclude(Set(g)))
  action dispatch(g) = all {
    writable(g), s.calls.get(g) == 0,
    s' = s.with("calls", s.calls.set(g, 1)).with("activeRemote", s.activeRemote.union(Set(g)))
  }
  action timeout(g) = all {
    owned(g), s' = s.with("timedOut", s.timedOut.union(Set(g)))
  }
  // Revocation of DB authority does not cancel an already submitted daemon call.
  action recover = all {
    s.status == "running", s.now >= s.expiry + 1,
    s' = s.with("status", "pending").with("owner", 0)
      .with("quiesced", s.quiesced.union(Set(s.current)))
      .with("heartbeat", s.heartbeat.exclude(Set(s.current)))
  }
  action remoteCompletes(g) = all {
    s.activeRemote.contains(g),
    s' = s.with("activeRemote", s.activeRemote.exclude(Set(g)))
      .with("remoteReceipts", s.remoteReceipts.union(Set(g)))
  }
  action recordJobWrite(g) = s' = s.with("staleJobWrite", s.staleJobWrite or not(writable(g)))
  action updateJob(g) = all { writable(g), recordJobWrite(g) }
  action settle(g) = all {
    writable(g), not(s.activeRemote.contains(g)),
    s' = s.with("status", "completed").with("owner", 0)
      .with("quiesced", s.quiesced.union(Set(g)))
      .with("heartbeat", s.heartbeat.exclude(Set(g)))
  }
  action cancel = all { s.status == "running",
    s' = s.with("status", "cancelled").with("owner", 0)
      .with("quiesced", s.quiesced.union(Set(s.current))) }
  // A receipt alone is insufficient when the same app generation survives job takeover.
  action adapterPublish(g) = all {
    s.remoteReceipts.contains(g), not(s.published.contains(g)),
    s' = s.with("published", s.published.union(Set(g)))
      .with("staleWorkloadWrite", s.staleWorkloadWrite or not(writable(g)))
  }
  action fencedAdapterPublish(g) = all { writable(g), adapterPublish(g) }
  action rejectStaleAdapter(g) = all { not(writable(g)), s' = s }
  action idle = s' = s
  action lifecycleStep = {
    nondet g = generations.oneOf()
    any { claim, tick, renew(g), pauseWorker(g), dispatch(g), timeout(g), recover,
      remoteCompletes(g), updateJob(g), settle(g), cancel, idle }
  }
  action unguardedStep = {
    nondet g = generations.oneOf()
    any { lifecycleStep, adapterPublish(g) }
  }
  action step = {
    nondet g = generations.oneOf()
    any { lifecycleStep, fencedAdapterPublish(g), rejectStaleAdapter(g) }
  }
  val jobSafety = not(s.staleJobWrite)
  val workloadSafety = not(s.staleWorkloadWrite)
  val noRemoteOverlap = s.activeRemote.size() <= 1
  val safety = jobSafety and workloadSafety
  run timeoutRetainsOwnershipTest = init.then(claim).then(dispatch(1)).then(timeout(1))
    .expect(s.owner == 1 and s.heartbeat.contains(1) and s.activeRemote.contains(1) and jobSafety)
  run recoveryDoesNotCancelProviderTest = init.then(claim).then(dispatch(1)).then(pauseWorker(1))
    .then(tick).then(tick).then(recover).expect(s.quiesced.contains(1) and s.activeRemote.contains(1) and jobSafety)
  run staleAdapterPublicationWitnessTest = init.then(claim).then(dispatch(1)).then(pauseWorker(1))
    .then(tick).then(tick).then(recover).then(claim).then(dispatch(2)).then(remoteCompletes(2))
    .then(adapterPublish(2)).then(settle(2)).then(remoteCompletes(1)).then(adapterPublish(1))
    .expect(jobSafety and not(workloadSafety))
  run expiredLeaseRejectsPublicationBeforeTakeoverTest = init.then(claim).then(dispatch(1))
    .then(tick).then(remoteCompletes(1)).then(rejectStaleAdapter(1)).expect(safety)
  run cancelledSameGenerationRejectsPublicationTest = init.then(claim).then(dispatch(1))
    .then(cancel).then(remoteCompletes(1)).then(rejectStaleAdapter(1)).expect(safety)
  run cancellationWithoutJobWriteFenceNegativeWitnessTest = init.then(claim).then(cancel)
    .then(recordJobWrite(1)).expect(not(jobSafety))
  run providerCancellationIsNotProvedNegativeWitnessTest = init.then(claim).then(dispatch(1))
    .then(pauseWorker(1)).then(tick).then(tick).then(recover).then(claim).then(dispatch(2))
    .expect(safety and not(noRemoteOverlap))
  run currentPublicationAndSettlementTest = init.then(claim).then(dispatch(1)).then(remoteCompletes(1))
    .then(fencedAdapterPublish(1)).then(updateJob(1)).then(settle(1)).expect(safety)
  run explicitAdapterFenceRejectsStaleResultTest = init.then(claim).then(dispatch(1)).then(pauseWorker(1))
    .then(tick).then(tick).then(recover).then(claim).then(remoteCompletes(1)).then(rejectStaleAdapter(1))
    .expect(jobSafety and workloadSafety)
}

