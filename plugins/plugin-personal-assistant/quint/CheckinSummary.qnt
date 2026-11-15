// A summary is stored only after the configured model returns nonempty text.
module CheckinSummary {
  var outcome: int
  var phase: int
  var called: bool
  var writes: int
  var dateMatches: bool

  action init = {
    nondet result = Set(0, 1, 2, 3, 4, 5).oneOf()
    all { outcome' = result, phase' = 0, called' = false, writes' = 0, dateMatches' = result != 5 }
  }
  action collect = all {
    phase == 0, outcome' = outcome, phase' = 1,
    called' = called, writes' = writes, dateMatches' = dateMatches
  }
  action render = all {
    phase == 1, outcome' = outcome,
    phase' = if (outcome == 0 or outcome == 4) 2 else 4,
    called' = outcome != 2, writes' = writes, dateMatches' = dateMatches
  }
  action persist = all {
    phase == 2, outcome' = outcome,
    phase' = if (outcome == 0) 3 else 4,
    called' = called, writes' = if (outcome == 0) 1 else 0, dateMatches' = dateMatches
  }
  action stay = all {
    phase == 3 or phase == 4, outcome' = outcome, phase' = phase,
    called' = called, writes' = writes, dateMatches' = dateMatches
  }
  action step = any { collect, render, persist, stay }
  val ValidSummaryOnly = writes == 0 or (outcome == 0 and called and phase == 3)
  val FailureKeepsStorage = outcome == 0 or writes == 0
  val StoredDayMatches = writes == 0 or dateMatches
  val SingleWrite = writes >= 0 and writes <= 1
}

// One owner-scoped row after the database candidate read. Clock classes are
// 0 absent, 1 before the window, 2 inside it and 3 invalid. Cache refreshes
// never establish a Google edit. Date parsing and the forty-row window are
// exercised by the existing real database conformance cases.
module CalendarChangeClock {
  type State = { google: bool, malformed: bool, primary: int, alternate: int,
    created: int, cache: int, today: bool, projected: bool,
    clock: int, included: bool, invalid: bool }
  var s: State
  action initialize(google: bool, malformed: bool, primary: int,
    alternate: int, created: int, cache: int, today: bool): bool = s' = {
      google: google, malformed: malformed, primary: primary, alternate: alternate,
      created: created, cache: cache, today: today, projected: false,
      clock: 0, included: false, invalid: false }
  action init = {
    nondet google = Bool.oneOf()
    nondet malformed = Bool.oneOf()
    nondet primary = Set(0, 1, 2, 3).oneOf()
    nondet alternate = Set(0, 1, 2, 3).oneOf()
    nondet created = Set(0, 1, 2, 3).oneOf()
    nondet cache = Set(1, 2).oneOf()
    nondet today = Bool.oneOf()
    initialize(google, malformed, primary, alternate, created, cache, today)
  }
  val providerClock = if (s.primary != 0) s.primary
    else if (s.alternate != 0) s.alternate else s.created
  val expectedClock = if (not(s.google)) s.cache
    else if (s.malformed or providerClock == 3) 0 else providerClock
  action project = all { not(s.projected),
    s' = s.with("projected", true).with("clock", expectedClock)
      .with("included", s.today or expectedClock == 2)
      .with("invalid", s.google and (s.malformed or providerClock == 3)) }
  action step = any { project, all { s.projected, s' = s } }
  val SourceClockSelected = not(s.projected) or s.clock == expectedClock
  val UnknownIsNotAnEdit = not(s.projected) or s.clock != 0 or s.included == s.today
  val RetainTodayOrRecent = not(s.projected) or s.included == (s.today or s.clock == 2)
  val InvalidMetadataVisible = not(s.projected) or
    s.invalid == (s.google and (s.malformed or providerClock == 3))
  run refreshedOldGoogleIsNotNewTest = initialize(true, false, 1, 0, 0, 2, false)
    .then(project).expect(not(s.included) and s.clock == 1)
  run unknownGoogleTodayRemainsTest = initialize(true, false, 0, 0, 0, 2, true)
    .then(project).expect(s.included and s.clock == 0 and not(s.invalid))
  run invalidPrimaryDoesNotFallBackTest = initialize(true, false, 3, 2, 2, 2, false)
    .then(project).expect(s.invalid and not(s.included) and s.clock == 0)
  run providerCreationFallbackTest = initialize(true, false, 0, 0, 2, 1, false)
    .then(project).expect(s.included and s.clock == 2)
  run localEditUsesWriterClockTest = initialize(false, true, 0, 0, 0, 2, false)
    .then(project).expect(s.included and s.clock == 2 and not(s.invalid))
}
