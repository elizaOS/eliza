// Two committed search-source publications and one captured observation.
// Source tokens stand for complete records, not truncated production content.
module MapsSearchObservation {
  type Source = { query: int, area: int, results: int, provider: int, phase: int }
  type State = { source: Source, revision: int, publications: int, live: bool,
    captured: bool, receiptSource: Source, receiptRevision: int,
    lastAccepted: bool, bad: bool }
  val initialSource = { query: 0, area: 0, results: 0, provider: 0, phase: 0 }
  var s: State
  action init = s' = { source: initialSource, revision: 0, publications: 0, live: true,
    captured: false, receiptSource: initialSource, receiptRevision: 0,
    lastAccepted: false, bad: false }
  action publish(nextSource: Source): bool = all {
    s.live, s.publications < 2,
    s' = { ...s, source: nextSource, publications: s.publications + 1,
      revision: s.revision + (if (nextSource == s.source) 0 else 1) },
  }
  action capture = all { s.live, not(s.captured),
    s' = { ...s, captured: true, receiptSource: s.source, receiptRevision: s.revision } }
  action validate = {
    val accepted = s.live and s.receiptRevision == s.revision
    all { s.captured, s' = { ...s, lastAccepted: accepted,
      bad: s.bad or (accepted and s.receiptSource != s.source) } }
  }
  action close = all { s.live, s' = s.with("live", false) }
  action render = s' = s
  // Mutation witnesses are scenario-only, never current implementation steps.
  action legacyQueryOnly(nextSource: Source): bool = all {
    s.live, s.publications < 2,
    s' = { ...s, source: nextSource, publications: s.publications + 1,
      revision: s.revision + (if (nextSource.query == s.source.query) 0 else 1) },
  }
  action step = {
    nondet query = 0.to(1).oneOf()
    nondet area = 0.to(1).oneOf()
    nondet results = 0.to(1).oneOf()
    nondet provider = 0.to(1).oneOf()
    nondet phase = 0.to(1).oneOf()
    any { publish({ query: query, area: area, results: results, provider: provider, phase: phase }),
      capture, validate, close, render }
  }
  val TypeOK = s.revision.in(0.to(2)) and s.publications.in(0.to(2)) and
    s.receiptRevision.in(0.to(2)) and
    s.source.query.in(0.to(1)) and s.source.area.in(0.to(1)) and
    s.source.results.in(0.to(1)) and s.source.provider.in(0.to(1)) and s.source.phase.in(0.to(1))
  val ObservationHadCurrentSource = not(s.bad)
  run areaChangeTest = init.then(capture).then(publish({ ...initialSource, area: 1 })).then(validate).expect(not(s.lastAccepted) and ObservationHadCurrentSource)
  run resultChangeTest = init.then(capture).then(publish({ ...initialSource, results: 1 })).then(validate).expect(not(s.lastAccepted) and ObservationHadCurrentSource)
  run queryChangeTest = init.then(capture).then(publish({ ...initialSource, query: 1 })).then(validate).expect(not(s.lastAccepted) and ObservationHadCurrentSource)
  run providerChangeTest = init.then(capture).then(publish({ ...initialSource, provider: 1 })).then(validate).expect(not(s.lastAccepted) and ObservationHadCurrentSource)
  run readinessChangeTest = init.then(capture).then(publish({ ...initialSource, phase: 1 })).then(validate).expect(not(s.lastAccepted) and ObservationHadCurrentSource)
  run closeRetiresObservationTest = init.then(capture).then(close).then(validate).expect(not(s.lastAccepted) and ObservationHadCurrentSource)
  run unchangedRenderKeepsObservationTest = init.then(capture).then(render).then(validate).expect(s.lastAccepted and s.revision == 0 and ObservationHadCurrentSource)
  run legacyAreaWitnessTest = init.then(capture).then(legacyQueryOnly({ ...initialSource, area: 1 })).then(validate).expect(s.bad)
  run legacyResultWitnessTest = init.then(capture).then(legacyQueryOnly({ ...initialSource, results: 1 })).then(validate).expect(s.bad)
}

// Following is an existing controller intent; the new view/plane ports expose it.
module MapsCameraIntent {
  var s: { live: bool, following: bool, userMoved: bool }
  action init = s' = { live: true, following: true, userMoved: false }
  action gesture = all { s.live, s' = { ...s, following: false, userMoved: true } }
  action recenter = all { s.live, s' = { ...s, following: true, userMoved: false } }
  action programmaticMove = s' = s
  action close = s' = s.with("live", false)
  action step = any { gesture, recenter, programmaticMove, close }
  val FollowingMatchesIntent = s.following == not(s.userMoved)
  run gestureStopsFollowingTest = init.then(gesture).expect(not(s.following) and FollowingMatchesIntent)
  run recenterResumesFollowingTest = init.then(gesture).then(recenter).expect(s.following and FollowingMatchesIntent)
  run automaticMoveKeepsIntentTest = init.then(gesture).then(programmaticMove).expect(not(s.following) and FollowingMatchesIntent)
}

// The host selects an opening view; each changed complete pin input is consumed
// once. Selection, route and following are independent camera owners.
module MapsResultCamera {
  var s: { live: bool, worldwide: bool, hostOpening: bool, openedAtHost: bool,
    pins: int, updates: int, fits: int, lastFitted: int, bad: bool }
  action init = {
    nondet worldwide = Set(true, false).oneOf()
    nondet hostOpening = Set(true, false).oneOf()
    s' = { live: true, worldwide: worldwide, hostOpening: hostOpening,
      openedAtHost: worldwide and hostOpening, pins: 0, updates: 0,
      fits: 0, lastFitted: 0, bad: false }
  }
  action update(pins: int, owner: int): bool = {
    val fit = pins != s.pins and pins != 0 and s.worldwide and owner == 0
    all { s.live, s.updates < 3,
      s' = { ...s, pins: pins, updates: s.updates + 1,
        fits: s.fits + (if (fit) 1 else 0),
        lastFitted: if (fit) pins else s.lastFitted,
        bad: s.bad or (fit and (owner != 0 or not(s.worldwide))) },
    }
  }
  action close = s' = s.with("live", false)
  action render = s' = s
  action step = {
    nondet pins = 0.to(2).oneOf()
    nondet owner = 0.to(3).oneOf()
    any { update(pins, owner), close, render }
  }
  val TypeOK = s.pins.in(0.to(2)) and s.updates.in(0.to(3)) and
    s.fits.in(0.to(3)) and s.lastFitted.in(0.to(2))
  val OpeningRespectsCoverage = s.openedAtHost == (s.worldwide and s.hostOpening)
  val CameraOwnerPreserved = not(s.bad) and s.fits <= s.updates
  run changedPinsFitTest = init.then(update(1, 0)).then(update(2, 0)).expect(s.fits == (if (s.worldwide) 2 else 0))
  run repeatedPinsKeepCameraTest = init.then(update(1, 0)).then(update(1, 0)).expect(s.fits == (if (s.worldwide) 1 else 0))
  run selectionKeepsCameraTest = init.then(update(1, 1)).expect(s.fits == 0)
  run routeKeepsCameraTest = init.then(update(1, 2)).expect(s.fits == 0)
  run followingKeepsCameraTest = init.then(update(1, 3)).expect(s.fits == 0)
  run blockedInputConsumedOnceTest = init.then(update(1, 2)).then(update(1, 0)).expect(s.fits == 0)
  run clearedPinsCanReturnTest = init.then(update(1, 0)).then(update(0, 0)).then(update(1, 0)).expect(s.fits == (if (s.worldwide) 2 else 0))
  run closeRetiresCameraTest = init.then(close).then(render).expect(not(s.live) and s.fits == 0)
}
