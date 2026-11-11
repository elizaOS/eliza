// Bounded terminal-cleanup scheduling: the real selector uses EXISTS and row
// locks, then moves selected operations' updated_at to the current DB clock.
// Source: agent-backup-restore-serving.ts::listAgentBackupRestoreTerminalCleanups.
// Three fixed operations, page size two, two completed cycles. Operations 1/2
// permanently lack remote proof; operation 3 can prove cleanup. No unbounded
// backlog, new arrivals, worker availability or general liveness is claimed.
module restore_cleanup_rotation {
  pure val ids = Set(1, 2, 3)
  type State = { rank: int -> int, clock: int, pending: Set[int], done: Set[int], active: bool, cycles: int }
  var s: State
  action init = s' = {
    rank: Map(1 -> 0, 2 -> 1, 3 -> 2), clock: 3, pending: Set(), done: Set(), active: false, cycles: 0
  }
  def oldestPair(a, b) = a != b and not(s.done.contains(a)) and not(s.done.contains(b))
    and ids.exclude(s.done).exclude(Set(a, b)).forall(i => s.rank.get(i) > s.rank.get(a) and s.rank.get(i) > s.rank.get(b))
  action selectPage(a, b) = all {
    not(s.active), s.cycles < 2, oldestPair(a, b),
    s' = s.with("rank", s.rank.set(a, s.clock).set(b, s.clock + 1))
      .with("clock", s.clock + 2).with("pending", Set(a, b)).with("active", true)
  }
  action failOperation(i) = all {
    s.active, s.pending.contains(i), i != 3,
    s' = s.with("pending", s.pending.exclude(Set(i)))
  }
  action succeed = all {
    s.active, s.pending.contains(3),
    s' = s.with("pending", s.pending.exclude(Set(3))).with("done", s.done.union(Set(3)))
  }
  action complete = all {
    s.active, s.pending.size() == 0,
    s' = s.with("active", false).with("cycles", s.cycles + 1)
  }
  action idle = s' = s
  action step = {
    nondet a = ids.oneOf()
    nondet b = ids.oneOf()
    any { selectPage(a, b), failOperation(a), succeed, complete, idle }
  }
  val safety = all {
    s.done.subseteq(Set(3)), s.pending.size() <= 2,
    s.cycles == 2 implies s.done.contains(3)
  }
  temporal RecoverableOperationFinishes = (ids.forall(a => ids.forall(b => selectPage(a, b).weakFair(s)))
    and ids.forall(i => failOperation(i).weakFair(s)) and succeed.weakFair(s)
    and complete.weakFair(s)).implies(eventually(s.done.contains(3)))
  run unavailablePrefixCannotStarveRecoverableOperationTest = init.then(selectPage(1, 2))
    .then(failOperation(1)).then(failOperation(2)).then(complete).then(selectPage(3, 1))
    .then(succeed).then(failOperation(1)).then(complete).expect(safety and s.done == Set(3))
  // Prior selector: repeatedly selecting unchanged oldest rows starves row 3.
  action unrotatedSelect = all {
    not(s.active), s.cycles < 2,
    s' = s.with("pending", Set(1, 2)).with("active", true)
  }
  run missingRotationDetectedTest = init.then(unrotatedSelect).then(failOperation(1)).then(failOperation(2)).then(complete)
    .then(unrotatedSelect).then(failOperation(1)).then(failOperation(2)).then(complete).expect(not(safety))
}
