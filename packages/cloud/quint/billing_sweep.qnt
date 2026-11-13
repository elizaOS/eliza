// Source: shared/src/lib/services/credits.ts:sweepStaleReservations.
// Four rows are ordered by the complete (database timestamp, primary key)
// tuple. Rows 0/1 initially fail; rows 2/3 must still be visited in the run.
// A run has enough batch budget for all four rows. This model does not claim
// global eventual progress through a backlog larger than the run budget.
module billing_sweep {
  pure val rows = Set(0, 1, 2, 3)
  var pending: Set[int]
  var corrupt: Set[int]
  var visited: Set[int]
  var counts: int -> int
  var cursor: int
  var running: bool

  action init = all {
    pending' = rows, corrupt' = Set(0, 1), visited' = Set(),
    counts' = rows.mapBy(_ => 0), cursor' = -1, running' = true,
  }

  pure def first(candidates: Set[int]): int = candidates.fold(4, (a, b) => if (a < b) a else b)
  val remaining = pending.filter(id => id > cursor)

  action scan = {
    val id = first(remaining)
    all {
      running, remaining.size() > 0,
      pending' = if (corrupt.contains(id)) pending else pending.exclude(Set(id)),
      corrupt' = corrupt, visited' = visited.union(Set(id)),
      counts' = counts.set(id, counts.get(id) + 1), cursor' = id,
      running' = running,
    }
  }

  action finish = all {
    running, remaining.size() == 0, running' = false,
    pending' = pending, corrupt' = corrupt, visited' = visited,
    counts' = counts, cursor' = cursor,
  }

  action nextRun = all {
    not(running), running' = true, cursor' = -1,
    pending' = pending, corrupt' = corrupt, visited' = Set(),
    counts' = rows.mapBy(_ => 0),
  }

  action repair(id: int): bool = all {
    corrupt.contains(id), corrupt' = corrupt.exclude(Set(id)),
    pending' = pending, visited' = visited, counts' = counts,
    cursor' = cursor, running' = running,
  }

  // The former oldest-LIMIT loop repeatedly selected the same failing row.
  // This action is excluded from step and retained as a regression witness.
  action legacyScan = {
    val id = first(pending)
    all {
      running, pending.size() > 0,
      pending' = if (corrupt.contains(id)) pending else pending.exclude(Set(id)),
      corrupt' = corrupt, visited' = visited.union(Set(id)),
      counts' = counts.set(id, counts.get(id) + 1), cursor' = cursor,
      running' = running,
    }
  }

  action step = {
    nondet id = rows.oneOf()
    any { scan, finish, nextRun, repair(id) }
  }

  val safety = all {
    rows.forall(id => counts.get(id) <= 1),
    visited.forall(id => id <= cursor),
    cursor < 2 or not(pending.contains(2)),
    cursor < 3 or not(pending.contains(3)),
    running or pending.intersect(Set(2, 3)).size() == 0,
  }

  run poisonRowsCannotStarveTest = init.then(scan).then(scan).then(scan).then(scan)
    .then(finish).expect(safety and pending == Set(0, 1) and visited == rows)
  run failedRowsRetryNextRunTest = init.then(scan).then(scan).then(scan).then(scan)
    .then(finish).then(repair(0)).then(nextRun).then(scan)
    .expect(safety and not(pending.contains(0)))
  run legacyStarvationWitnessTest = init.then(legacyScan).then(legacyScan)
    .expect(not(safety) and pending == rows and counts.get(0) == 2)
}
