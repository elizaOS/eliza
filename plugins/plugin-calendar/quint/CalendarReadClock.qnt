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
