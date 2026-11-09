// Durable operation hydration, exact process incarnation, and terminal pruning.
// Sources: runtime/operations/repository.ts and types.ts.
// Current, previous local incarnation, dead local, remote, and legacy records
// abstract the executor proofs. Remote/uncertain owners are never reaped by age.
module runtime_operation_recovery {
  var s: { owner: str, status: str, stale: bool, reaped: bool, pruned: bool }
  action init = s' = { owner: "none", status: "absent", stale: false, reaped: false, pruned: false }
  action hydrate(owner: str): bool = all { s.status == "absent", s' = s.with("owner", owner).with("status", "running") }
  action age = s' = s.with("stale", true)
  val reclaimable = Set("previous-incarnation", "dead-local").contains(s.owner) or (s.owner == "legacy" and s.stale)
  action reap = all { s.status == "running", reclaimable, s' = s.with("status", "failed").with("reaped", true) }
  action complete = all { s.status == "running", s' = s.with("status", "succeeded") }
  action prune = all { Set("failed", "succeeded").contains(s.status), s' = s.with("pruned", true) }
  action idle = s' = s
  action step = any { hydrate("current"), hydrate("previous-incarnation"), hydrate("dead-local"), hydrate("remote"), hydrate("legacy"), age, reap, complete, prune, idle }
  val safety = all { s.reaped implies reclaimable, s.pruned implies Set("failed", "succeeded").contains(s.status), s.owner == "current" implies not(s.reaped), s.owner == "remote" implies not(s.reaped) }
  run slowCurrentOperationKeepsOwnershipTest = init.then(hydrate("current")).then(age).expect(safety and not(s.reaped) and s.status == "running")
  run previousIncarnationReleasesOwnershipTest = init.then(hydrate("previous-incarnation")).then(reap).then(prune).expect(safety and s.pruned)
  run remoteExecutorIsNotLocalAuthorityTest = init.then(hydrate("remote")).then(age).expect(safety and not(s.reaped))
}
