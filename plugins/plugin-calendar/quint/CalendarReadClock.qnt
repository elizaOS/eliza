// Calendar read-window and display clock selection. No provider writes.
// UTC instants remain canonical; display uses the current request's zone.
module CalendarReadClock {
  // 0=UTC, 1=Los Angeles, 2=New York, -1=absent/invalid client hint.
  var ui: int
  var explicit: int
  var owner: int
  var summer: bool
  var phase: int
  var selected: int
  var storedMinutes: int
  var shownMinutes: int
  pure def offset(zone: int, season: bool): int =
    if (zone == 1) { if (season) -420 else -480 }
    else if (zone == 2) { if (season) -240 else -300 } else 0
  val expectedZone = if (explicit >= 0) explicit else if (ui >= 0) ui else owner
  action init = {
    nondet chosenUi = Set(-1, 0, 1, 2).oneOf()
    nondet chosenExplicit = Set(-1, 0, 1, 2).oneOf()
    nondet chosenOwner = Set(0, 1, 2).oneOf()
    nondet chosenSeason = Bool.oneOf()
    all { ui' = chosenUi, explicit' = chosenExplicit, owner' = chosenOwner, summer' = chosenSeason,
      phase' = 0, selected' = -1, storedMinutes' = 1140, shownMinutes' = -1 }
  }
  action resolve = all {
    phase == 0, phase' = 1, selected' = expectedZone,
    ui' = ui, explicit' = explicit, owner' = owner, summer' = summer,
    storedMinutes' = storedMinutes, shownMinutes' = shownMinutes
  }
  action project = all {
    phase == 1, phase' = 2, shownMinutes' = storedMinutes + offset(selected, summer),
    ui' = ui, explicit' = explicit, owner' = owner, summer' = summer,
    selected' = selected, storedMinutes' = storedMinutes
  }
  action done = all {
    phase == 2, phase' = phase, ui' = ui, explicit' = explicit,
    owner' = owner, summer' = summer, selected' = selected,
    storedMinutes' = storedMinutes, shownMinutes' = shownMinutes
  }
  action step = any { resolve, project, done }
  val CanonicalInstantUnchanged = storedMinutes == 1140
  val RequestClockSelected = phase == 0 or selected == expectedZone
  val DisplayOffsetMatchesDate = phase != 2 or shownMinutes == 1140 + offset(expectedZone, summer)
  val WinterPacificIsEleven = not(phase == 2 and selected == 1 and not(summer)) or shownMinutes == 660
  val invariant = CanonicalInstantUnchanged and RequestClockSelected and DisplayOffsetMatchesDate and WinterPacificIsEleven
}

// Creation clock projection only. Existing mutation admission remains external.
// A wall time of 16:17 crosses to the next UTC day in Los Angeles in winter.
module CalendarCreateClock {
  var ui: int
  // The planner proposal is independent of the source-extracted explicit zone.
  var planner: int
  var explicit: int
  var owner: int
  var context: int
  var selected: int
  var phase: int
  var utcMinutes: int
  val expectedZone = if (explicit >= 0) explicit else if (ui >= 0) ui else owner
  pure def offset(zone: int): int = if (zone == 1) -480 else if (zone == 2) -300 else 0
  action init = {
    nondet client = Set(-1, 0, 1, 2).oneOf()
    nondet proposed = Set(-1, 0, 1, 2).oneOf()
    nondet requested = Set(-1, 0, 1, 2).oneOf()
    nondet configured = Set(0, 1, 2).oneOf()
    all { ui' = client, planner' = proposed, explicit' = requested, owner' = configured,
      context' = -1, selected' = -1, phase' = 0, utcMinutes' = -1 }
  }
  action resolve = all { phase == 0, phase' = 1, selected' = expectedZone,
    context' = if (ui >= 0) ui else owner,
    ui' = ui, planner' = planner, explicit' = explicit, owner' = owner, utcMinutes' = utcMinutes }
  action project = all { phase == 1, phase' = 2, utcMinutes' = 977 - offset(selected),
    ui' = ui, planner' = planner, explicit' = explicit, owner' = owner, context' = context, selected' = selected }
  action done = all { phase == 2, phase' = phase, utcMinutes' = utcMinutes,
    ui' = ui, planner' = planner, explicit' = explicit, owner' = owner, context' = context, selected' = selected }
  action step = any { resolve, project, done }
  val ContextClockIgnoresPlanner = phase == 0 or context == (if (ui >= 0) ui else owner)
  val RequestClockSelected = phase == 0 or selected == expectedZone
  val NoProjectionBeforeResolution = phase == 2 or utcMinutes == -1
  val StoredClockMatchesRequest = phase != 2 or utcMinutes == 977 - offset(expectedZone)
  val invariant = ContextClockIgnoresPlanner and RequestClockSelected and NoProjectionBeforeResolution and StoredClockMatchesRequest
}

