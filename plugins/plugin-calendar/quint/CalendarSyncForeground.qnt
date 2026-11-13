// A foreground resume reads the durable opt-in before it owns a controller.
module CalendarSyncForeground {
  type State = {
    active: bool, visible: bool, generation: int, running: int,
    pending: Set[int], issued: Set[int], admitted: Set[int], refused: Set[int],
    cancelled: Set[int], settled: Set[int], status: str,
  }
  var s: State

  action init = s' = {
    active: true, visible: true, generation: 0, running: -1,
    pending: Set(), issued: Set(), admitted: Set(), refused: Set(),
    cancelled: Set(), settled: Set(), status: "idle",
  }

  action readOptIn = all {
    s.active and s.visible and s.running == -1 and not(s.issued.contains(s.generation)),
    s' = { ...s, pending: s.pending.union(Set(s.generation)), issued: s.issued.union(Set(s.generation)) },
  }

  val canRetire = s.active and s.visible and s.generation == 0
  val retired = if (s.running == -1) s.cancelled else s.cancelled.union(Set(s.running))

  action stop = all {
    canRetire,
    s' = { ...s, generation: 1, active: false, cancelled: retired },
  }

  action hide = all {
    canRetire,
    s' = { ...s, generation: 1, visible: false, cancelled: retired },
  }

  action startAgain = all {
    not(s.active),
    s' = { ...s, active: true },
  }

  action show = all {
    not(s.visible),
    s' = { ...s, visible: true },
  }

  def current(g: int): bool = s.active and s.visible and g == s.generation

  action returnOptIn(g: int, result: str): bool = all {
    s.pending.contains(g),
    val rest = s.pending.exclude(Set(g))
    val admit = current(g) and result == "enabled" and s.running == -1
    s' = if (admit) {
      ...s, pending: rest, running: g, admitted: s.admitted.union(Set(g)), status: "running",
    } else {
      ...s, pending: rest, refused: s.refused.union(Set(g)),
      status: if (current(g) and result == "failed") "failed" else s.status,
    },
  }

  action returnOld = {
    nondet result = Set("enabled", "disabled", "failed").oneOf()
    returnOptIn(0, result)
  }

  action returnCurrent = {
    nondet result = Set("enabled", "disabled", "failed").oneOf()
    returnOptIn(1, result)
  }

  // Only controller settlement releases a pass that had already been admitted.
  action finishPass = all {
    s.running != -1,
    s' = { ...s, running: -1, settled: s.settled.union(Set(s.running)),
      status: if (s.cancelled.contains(s.running)) "cancelled" else "settled" },
  }

  action step = any { readOptIn, stop, hide, startAgain, show,
    returnOld, returnCurrent, finishPass, s' = s }

  val ReadHasOneOutcome = and {
    s.issued == s.pending.union(s.admitted).union(s.refused),
    s.pending.intersect(s.admitted.union(s.refused)) == Set(),
    s.admitted.intersect(s.refused) == Set(),
  }

  val RetiredRunningPassIsCancelled =
    s.running != -1 and not(current(s.running)) implies s.cancelled.contains(s.running)

  temporal OldReadCannotPublish = always((
    s.generation == 1 and s.pending.contains(0) and not(next(s.pending).contains(0))
      implies next(s.status) == s.status and next(s.running) == s.running and next(s.admitted) == s.admitted
  ).orKeep(s))

  temporal OwnedWorkSettles = and {
    s.pending.contains(0).leadsTo(not(s.pending.contains(0))),
    s.pending.contains(1).leadsTo(not(s.pending.contains(1))),
    (s.running != -1).leadsTo(s.running == -1),
  }

  temporal FairOwnedWorkSettles = and {
    returnOld.weakFair(s), returnCurrent.weakFair(s), finishPass.weakFair(s),
  } implies OwnedWorkSettles

  run StopDiscardsTheOldReadTest = init.then(readOptIn).then(stop).then(startAgain)
    .then(readOptIn).then(returnOptIn(0, "enabled"))
    .expect(s.running == -1 and s.status == "idle" and s.pending == Set(1))
    .then(returnOptIn(1, "enabled")).then(finishPass)
    .expect(s.admitted == Set(1) and s.settled == Set(1))

  run HideAndShowRetiresThePendingReadTest = init.then(readOptIn).then(hide).then(show)
    .then(readOptIn).then(returnOptIn(0, "enabled")).then(returnOptIn(1, "enabled"))
    .expect(s.admitted == Set(1) and s.running == 1)

  run OldReadFailurePreservesCurrentStatusTest = init.then(readOptIn).then(stop).then(startAgain)
    .then(readOptIn).then(returnOptIn(1, "enabled")).then(finishPass).then(returnOptIn(0, "failed"))
    .expect(s.status == "settled" and s.refused == Set(0))
}
