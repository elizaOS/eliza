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
