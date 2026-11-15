// A serialized cron tick selects its oldest eligible rows once. Each confirmed
// result advances the row's stamp even when the origin is still unreachable.
module DomainHealthRotation {
  pure val domains = Set(0, 1, 2, 3)
  pure val registered = Set(0, 1, 2)
  type State = {
    stamps: int -> int,
    live: Set[int],
    checked: Set[int],
    pending: Set[int],
    ticks: int,
    clock: int,
  }

  var s: State
  action init = s' = {
    stamps: Map(0 -> 0, 1 -> 0, 2 -> 1, 3 -> 0),
    live: Set(),
    checked: Set(),
    pending: Set(),
    ticks: 0,
    clock: 1,
  }

  def eligible = registered.exclude(s.live)
  def older(left, right) = s.stamps.get(left) < s.stamps.get(right)
    or (s.stamps.get(left) == s.stamps.get(right) and left < right)
  def oldest(rows) = rows.filter(left => rows.forall(right => left == right or older(left, right)))
  def batch = eligible.filter(row => eligible.filter(other => older(other, row)).size() < 2)

  action admit = all {
    s.pending.size() == 0,
    s.ticks < 2,
    batch.size() > 0,
    s' = { ...s, pending: batch, ticks: s.ticks + 1 },
  }

  action settle(row, live) = all {
    oldest(s.pending).contains(row),
    val stamp = s.clock + 1
    s' = {
      ...s,
      pending: s.pending.exclude(Set(row)),
      stamps: s.stamps.set(row, stamp),
      checked: s.checked.union(Set(row)),
      live: if (live) s.live.union(Set(row)) else s.live,
      clock: stamp,
    },
  }

  action finish = {
    nondet row = domains.oneOf()
    any { settle(row, false), settle(row, true) }
  }
  action idle = s' = s
  action step = any { admit, finish, idle }

  val SelectionOrder = s.pending.subseteq(batch)
  val StoredResults = all {
    s.checked.subseteq(registered),
    s.live.subseteq(s.checked),
    domains.forall(row => s.checked.contains(row) == (s.stamps.get(row) > 1)),
  }
  val BoundedRotation = (s.ticks == 2 and s.pending.size() == 0) implies
    s.checked == registered
  temporal AllChecked = eventually(s.checked == registered)
  temporal FairRotation = (admit.weakFair(s) and finish.weakFair(s)) implies AllChecked

  run equalNeverCheckedUsesIdTest = init.then(admit)
    .expect(s.pending == Set(0, 1) and oldest(s.pending) == Set(0) and SelectionOrder)
  run unreachableRowsMoveBehindLaterRowsTest = init.then(admit).then(settle(0, false))
    .then(settle(1, false)).then(admit).expect(s.pending == Set(2, 0))
    .then(settle(2, false)).then(settle(0, false)).expect(BoundedRotation and StoredResults)
  run liveRowLeavesTheEligibleBatchTest = init.then(admit).then(settle(0, true))
    .then(settle(1, false)).then(admit).expect(s.pending == Set(2, 1))
    .then(settle(2, true)).then(settle(1, false)).expect(s.live == Set(0, 2) and BoundedRotation)
}
