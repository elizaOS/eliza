// Source: db/repositories/auto-top-up-attempts.ts. Two transactions on the
// same organization/attempt: provider authorization and a terminal mutation.
// This abstracts row locks only, not money, triggers, deadlock victim selection,
// fairness or unbounded PostgreSQL executions. Each action is one lock event.
module auto_topup_lock_order {
  type State = {
    organizationOwner: int,
    attemptOwner: int,
    phase: int -> str
  }
  var s: State
  pure val workers = Set(0, 1)

  action init = s' = {
    organizationOwner: -1, attemptOwner: -1,
    phase: workers.mapBy(_ => "organization")
  }

  // The former terminal mutation locked the attempt before its organization.
  action legacyInit = s' = {
    organizationOwner: -1, attemptOwner: -1,
    phase: Map(0 -> "attempt", 1 -> "organization")
  }

  action lockOrganization(worker: int): bool = all {
    s.phase.get(worker) == "organization", s.organizationOwner == -1,
    s' = s.with("organizationOwner", worker).with("phase", s.phase.set(worker,
      if (s.attemptOwner == worker) "work" else "attempt"))
  }
  action lockAttempt(worker: int): bool = all {
    s.phase.get(worker) == "attempt", s.attemptOwner == -1,
    s' = s.with("attemptOwner", worker).with("phase", s.phase.set(worker,
      if (s.organizationOwner == worker) "work" else "organization"))
  }
  action complete(worker: int): bool = all {
    s.phase.get(worker) == "work",
    s' = s.with("organizationOwner", -1).with("attemptOwner", -1)
      .with("phase", s.phase.set(worker, "done"))
  }
  action rollback(worker: int): bool = s'
    = s.with("organizationOwner", if (s.organizationOwner == worker) -1 else s.organizationOwner)
      .with("attemptOwner", if (s.attemptOwner == worker) -1 else s.attemptOwner)
      .with("phase", s.phase.set(worker, "done"))
  action idle = s' = s
  action step = {
    nondet worker = workers.oneOf()
    any { lockOrganization(worker), lockAttempt(worker), complete(worker), rollback(worker), idle }
  }

  val waitCycle = s.organizationOwner != -1 and s.attemptOwner != -1
    and s.organizationOwner != s.attemptOwner
    and s.phase.get(s.organizationOwner) == "attempt"
    and s.phase.get(s.attemptOwner) == "organization"
  val safety = not(waitCycle)

  run authorizationThenSettlementTest = init.then(lockOrganization(0)).then(lockAttempt(0))
    .then(complete(0)).then(lockOrganization(1)).then(lockAttempt(1)).then(complete(1))
    .expect(safety)
  run rollbackReleasesLocksTest = init.then(lockOrganization(0)).then(rollback(0))
    .then(lockOrganization(1)).then(lockAttempt(1)).expect(safety)
  run reverseOrderNegativeWitnessTest = legacyInit.then(lockAttempt(0)).then(lockOrganization(1))
    .expect(not(safety))
}
