// Calendar read-window and display clock selection.
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

// A January 5 create requested after that date in 2026. Date correction keeps
// the extracted wall clock and duration. The existing past-start guard decides
// whether to ask for confirmation before the persistence path can be entered.
module CalendarStatedCreateDate {
  type State = { leading: str, trailing: int, extracted: int,
    phase: int, year: int, startMinute: int, endMinute: int, outcome: str }
  var s: State
  action begin(leading: str, trailing: int, extracted: int): bool = s' = {
    leading: leading, trailing: trailing, extracted: extracted, phase: 0,
    year: extracted, startMinute: 720, endMinute: 780, outcome: "pending" }
  action init = {
    nondet leading = Set("numeric", "next", "current", "none").oneOf()
    nondet trailing = Set(0, 2028).oneOf()
    nondet extracted = Set(2026, 2027, 2028).oneOf()
    begin(leading, trailing, extracted)
  }
  val chosenYear = if (s.trailing != 0) s.trailing
    else if (Set("numeric", "next").contains(s.leading)) 2027 else 2026
  action correct = all { s.phase == 0,
    s' = s.with("year", chosenYear).with("phase", 1) }
  action settle = all { s.phase == 1,
    s' = s.with("phase", 2)
      .with("outcome", if (s.year == 2026) "ask" else "ready") }
  action step = any { correct, settle, all { s.phase == 2, s' = s } }
  val StatedYearHasPrecedence = s.phase == 0 or s.year == chosenYear
  val WallClockAndDurationKept = s.startMinute == 720 and s.endMinute - s.startMinute == 60
  val PastStartMustAsk = (s.phase == 2 and s.year == 2026) implies s.outcome == "ask"
  val FutureStartReady = (s.phase == 2 and s.year > 2026) implies s.outcome == "ready"
  run explicitYearPreservesFutureExtractionTest = begin("numeric", 0, 2027)
    .then(correct).then(settle).expect(s.year == 2027 and s.outcome == "ready")
  run nextYearCorrectsWrongExtractionTest = begin("next", 0, 2028)
    .then(correct).then(settle).expect(s.year == 2027 and WallClockAndDurationKept)
  run yearlessPastStillAsksTest = begin("none", 0, 2027)
    .then(correct).then(settle).expect(s.year == 2026 and s.outcome == "ask")
  run explicitCurrentYearStillAsksTest = begin("current", 0, 2027)
    .then(correct).then(settle).expect(s.year == 2026 and s.outcome == "ask")
  run trailingYearStillWinsTest = begin("next", 2028, 2027)
    .then(correct).then(settle).expect(s.year == 2028 and s.outcome == "ready")
}

// Whole-second provider filtering for one selected canonical event. Identity and
// owner checks are external facts; a query window never grants read authority.
module SelectedCalendarSecondWindow {
  type State = { fraction: int, duration: int, phase: int, found: bool,
    authorized: bool, current: bool, complete: bool, matching: bool,
    cancelled: bool, published: bool, output: int }
  var s: State
  action initialize(fraction: int, duration: int): bool = s' = {
    fraction: fraction, duration: duration, phase: 0, found: false,
    authorized: true, current: true, complete: true, matching: true,
    cancelled: false, published: false, output: 0 }
  action init = {
    nondet fraction = Set(0, 500, 999).oneOf()
    nondet duration = Set(1, 1000).oneOf()
    initialize(fraction, duration)
  }
  val start = 10000 + s.fraction
  pure def second(value: int): int = (value / 1000) * 1000
  val included = start < second(start + 1000) and start + s.duration > second(start - 1000)
  val legacyIncluded = start < second(start + 1) and start + s.duration > second(start - 1)
  action queryReturns = all { s.phase == 0,
    s' = s.with("phase", 1).with("found", included) }
  action changeSelection = all { s.phase < 2, s.current,
    s' = s.with("current", false) }
  action revokeOwner = all { s.phase < 2, s.authorized,
    s' = s.with("authorized", false) }
  action partialFeed = all { s.phase < 2, s.complete,
    s' = s.with("complete", false) }
  action changeSource = all { s.phase < 2, s.matching,
    s' = s.with("matching", false) }
  action cancel = all { s.phase < 2, not(s.cancelled),
    s' = s.with("cancelled", true) }
  val eligible = s.found and s.authorized and s.current and s.complete and s.matching and not(s.cancelled)
  action finish = all { s.phase == 1,
    s' = s.with("phase", 2).with("published", eligible)
      .with("output", if (eligible) 17 else 0) }
  action step = any { queryReturns, finish, changeSelection, revokeOwner,
    partialFeed, changeSource, cancel, s' = s }
  val WholeSecondMarginIncludesSelection = included
  val PublicationNeedsExactCurrentAuthority = s.published implies eligible
  // 17 denotes the whole selected payload; adjacent records are not published.
  val FullSelectedPayload = s.published implies s.output == 17
  temporal FairReadSettles = (queryReturns.weakFair(s) and finish.weakFair(s)) implies
    (s.phase < 2).leadsTo(s.phase == 2)
  temporal ReadSettles = (s.phase < 2).leadsTo(s.phase == 2)
  run oldWindowLosesWholeSecondEventTest = initialize(0, 1)
    .expect(not(legacyIncluded) and included).then(queryReturns).then(finish)
    .expect(s.published and FullSelectedPayload)
  run fractionalStartsRemainInsideWindowTest = initialize(999, 1)
    .then(queryReturns).then(finish).expect(s.published)
  run replacedSelectionCannotPublishTest = initialize(500, 1000)
    .then(queryReturns).then(changeSelection).then(finish)
    .expect(not(s.published) and s.output == 0)
}

// The complete selected event stays canonical; date labels are derived for the
// current turn. All-day dates are civil values, not viewer-zone instants.
module SelectedCalendarCivilDate {
  type State = { minute: int, sourceOffset: int, viewerOffset: int,
    allDay: bool, phase: int, canonicalToken: int, displayDay: int }
  var s: State
  action initialize(minute: int, source: int, viewer: int, allDay: bool): bool = s' = {
    minute: minute, sourceOffset: source, viewerOffset: viewer,
    allDay: allDay, phase: 0, canonicalToken: 17, displayDay: 0 }
  action init = {
    nondet minute = Set(0, 1439).oneOf()
    nondet source = Set(-480, 0, 840).oneOf()
    nondet viewer = Set(-480, 0, 840).oneOf()
    nondet allDay = Bool.oneOf()
    initialize(minute, source, viewer, allDay)
  }
  pure def day(minute: int): int = if (minute < 0) 2 else if (minute >= 1440) 4 else 3
  val expectedDay = if (s.allDay) 3 else day(s.minute + s.viewerOffset)
  val legacyAllDayUTC = day(-s.sourceOffset)
  action project = all { s.phase == 0,
    s' = s.with("phase", 1).with("displayDay", expectedDay) }
  action done = all { s.phase == 1, s' = s }
  action step = any { project, done }
  val CanonicalEventRetained = s.canonicalToken == 17
  val CivilAllDayIndependentOfOffsets = s.phase == 0 or not(s.allDay) or s.displayDay == 3
  val TimedDateUsesCurrentTurnZone = s.phase == 0 or s.allDay or s.displayDay == day(s.minute + s.viewerOffset)
  run offsetAllDayKeepsCivilWeekdayTest = initialize(0, 840, -480, true)
    .expect(legacyAllDayUTC == 2).then(project).expect(s.displayDay == 3)
  run timedMidnightUsesViewerPreviousDayTest = initialize(0, 0, -480, false)
    .then(project).expect(s.displayDay == 2 and CanonicalEventRetained)
  run timedLateEventUsesViewerNextDayTest = initialize(1439, 0, 840, false)
    .then(project).expect(s.displayDay == 4 and CanonicalEventRetained)
}
