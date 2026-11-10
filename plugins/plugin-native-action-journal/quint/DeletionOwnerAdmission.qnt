// One expired, queued deletion. Owner authentication and the final review fence
// are separate observations; a changed authenticated owner needs no stale fence.
module DeletionOwnerAdmission {
  type State = { kind: str, call: str, row: str, owner: str, fence: str, fenceChecks: int, effects: int }
  var s: State
  action initFor(kind: str): bool = s' = {kind: kind, call: "reading", row: "queued", owner: "none", fence: "unchecked", fenceChecks: 0, effects: 0}
  action init = {nondet kind = Set("calendar", "reminder").oneOf() initFor(kind)}
  action authenticate(owner: str): bool = all {
    s.call == "reading", owner.in(Set("same", "changed", "unavailable")),
    s' = {...s, call: "authenticated", owner: owner},
  }
  action finish(fence: str): bool = all {
    s.call == "authenticated", fence.in(Set("fresh", "stale", "throws")),
    val equal = s.owner == "same"
    val admitted = equal and fence == "fresh"
    val paused = s.owner == "changed" or (equal and (fence == "stale" or (fence == "throws" and s.kind == "calendar")))
    s' = {...s, call: "returned",
      row: if (admitted) "deleted" else if (paused) "paused" else "queued",
      fence: if (equal) fence else "unchecked", fenceChecks: if (equal) 1 else 0,
      effects: if (admitted) 1 else 0},
  }
  action retry = all {
    s.call == "returned", s.row == "queued",
    s' = {...s, call: "reading", owner: "none", fence: "unchecked", fenceChecks: 0},
  }
  action step = any {
    {nondet owner = Set("same", "changed", "unavailable").oneOf() authenticate(owner)},
    {nondet fence = Set("fresh", "stale", "throws").oneOf() finish(fence)},
    retry, s' = s,
  }
  val TypeOK = and {
    s.kind.in(Set("calendar", "reminder")),
    s.call.in(Set("reading", "authenticated", "returned")),
    s.row.in(Set("queued", "paused", "deleted")),
    s.owner.in(Set("none", "same", "changed", "unavailable")),
    s.fence.in(Set("unchecked", "fresh", "stale", "throws")),
    s.fenceChecks.in(0.to(1)), s.effects.in(0.to(1)),
  }
  val EffectRequiresCurrentOwner = (s.effects > 0).implies(
    s.owner == "same" and s.fence == "fresh" and s.fenceChecks == 1 and s.row == "deleted")
  val ChangedOwnerPauses = (s.call == "returned" and s.owner == "changed").implies(
    s.row == "paused" and s.fenceChecks == 0 and s.effects == 0)
  val UncertainFenceNeverDispatches = (s.fence == "throws").implies(
    s.effects == 0 and s.row == (if (s.kind == "calendar") "paused" else "queued"))
  val PausedNeverDispatches = (s.row == "paused").implies(s.effects == 0)
  val invariant = TypeOK and EffectRequiresCurrentOwner and ChangedOwnerPauses and UncertainFenceNeverDispatches and PausedNeverDispatches
  run changedOwnerSkipsStaleFenceTest = init.then(authenticate("changed")).then(finish("throws"))
    .expect(invariant and s.row == "paused" and s.fenceChecks == 0)
  run equalOwnerRaceRemainsBlockedTest = initFor("reminder").then(authenticate("same")).then(finish("throws"))
    .expect(invariant and s.row == "queued" and s.effects == 0)
    .then(retry).then(authenticate("changed")).then(finish("throws"))
    .expect(invariant and s.row == "paused" and s.effects == 0)
  run calendarFenceRacePausesTest = initFor("calendar").then(authenticate("same")).then(finish("throws"))
    .expect(invariant and s.row == "paused" and s.effects == 0)
  run unchangedOwnerDispatchesOnceTest = init.then(authenticate("same")).then(finish("fresh"))
    .expect(invariant and s.effects == 1).then(step).expect(invariant and s.effects == 1)
  run unavailableOwnerWaitsTest = init.then(authenticate("unavailable")).then(finish("fresh"))
    .expect(invariant and s.row == "queued" and s.fenceChecks == 0 and s.effects == 0)
}
