// One unchanged route, one pending maneuver and its final arrival step.
// Geometric distance/accuracy facts are supplied by the actual projection code.
module MapsGuidanceRecovery {
  const ForwardOnly: bool
  var s: { index: int, cleared: int, evidence: str }
  action init = s' = { index: 1, cleared: 0, evidence: "none" }
  action near = all { not(ForwardOnly), s.index == 1,
    s' = { index: 2, cleared: 0, evidence: "near" } }
  action clear = all { s.index == 1,
    s' = if (s.cleared == 1) { index: 2, cleared: 0, evidence: "two-clear" }
      else { ...s, cleared: 1, evidence: "one-clear" } }
  action reset = all { not(ForwardOnly), s.index == 1,
    s' = { ...s, cleared: 0, evidence: "none" } }
  action step = any { near, clear, reset, s' = s }
  val TypeOK = s.index.in(Set(1, 2)) and s.cleared.in(Set(0, 1)) and
    s.evidence.in(Set("none", "near", "one-clear", "two-clear"))
  val ArrivalNeverPassed = s.index <= 2
  val OneClearRetainsManeuver = s.evidence == "one-clear" implies s.index == 1
  val AdvancingHasEvidence = s.index == 2 implies s.evidence.in(Set("near", "two-clear"))
  temporal PassedStaysPassed = always((s.index == 2 implies next(s.index) == 2).orKeep(s))
  temporal FairForwardProgress = clear.weakFair(s) implies eventually(s.index == 2)
  temporal UnfairForwardProgress = eventually(s.index == 2)
  run twoUsableClearFixesTest = init.then(clear).expect(s.index == 1)
    .then(clear).expect(s.index == 2 and AdvancingHasEvidence)
}
module MapsGuidanceRecovery_mixed {
  import MapsGuidanceRecovery(ForwardOnly = false).*
  run offRouteOrEarlierPositionResetsEvidenceTest = init.then(clear).then(reset)
    .then(clear).expect(s.index == 1 and s.cleared == 1)
}
module MapsGuidanceRecovery_forward {
  import MapsGuidanceRecovery(ForwardOnly = true).*
}
