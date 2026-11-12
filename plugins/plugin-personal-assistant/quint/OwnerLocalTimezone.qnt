// A tick preflight and its runner share the same resolved owner-local clock.
module OwnerLocalTimezone {
  var scenario: int
  var ownerZone: int
  var schedulingZone: int
  var runtimeZone: int
  var hostZone: int
  var selectedZone: int
  var resolved: bool
  pure def firstKnown(owner: int, scheduling: int, runtime: int, host: int): int =
    if (owner >= 0) owner else if (scheduling >= 0) scheduling else if (runtime >= 0) runtime else host
  action init = {
    nondet choice = Set(0, 1, 2, 3, 4, 5).oneOf()
    all {
      scenario' = choice,
      ownerZone' = if (choice == 0) 1 else if (choice == 1) 0 else -1,
      schedulingZone' = if (choice == 2) 1 else if (choice == 0 or choice == 3) 0 else -1,
      runtimeZone' = if (choice == 0 or choice == 2) 0 else if (choice == 5) -1 else 1,
      hostZone' = if (choice == 1 or choice == 3 or choice == 5) 1 else 0,
      selectedZone' = -1, resolved' = false
    }
  }
  action resolve = all {
    not(resolved), scenario' = scenario, ownerZone' = ownerZone,
    schedulingZone' = schedulingZone, runtimeZone' = runtimeZone, hostZone' = hostZone,
    selectedZone' = firstKnown(ownerZone, schedulingZone, runtimeZone, hostZone), resolved' = true
  }
  action stay = all {
    resolved, scenario' = scenario, ownerZone' = ownerZone,
    schedulingZone' = schedulingZone, runtimeZone' = runtimeZone, hostZone' = hostZone,
    selectedZone' = selectedZone, resolved' = resolved
  }
  action step = any { resolve, stay }
  val ResolvedClock = not(resolved) or selectedZone == firstKnown(ownerZone, schedulingZone, runtimeZone, hostZone)
  val NoMissingClock = not(resolved) or Set(0, 1).contains(selectedZone)
}
