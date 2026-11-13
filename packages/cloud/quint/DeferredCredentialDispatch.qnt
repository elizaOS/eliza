// One already authorized API-key request through the combined proxy boundary.
module DeferredCredentialDispatch {
  var s: { kind: int, phase: str, admissions: int, standalone: int, disposed: bool }
  action initialize(kind: int): bool =
    s' = { kind: kind, phase: "preflight", admissions: 0, standalone: 0, disposed: false }
  action init = { nondet kind = 0.to(3).oneOf() initialize(kind) }
  // 0 succeeds, 1 refuses locally, 2 throws before admission, 3 throws after admission.
  action preflight = all {
    s.phase == "preflight",
    s' = { ...s, phase: if (s.kind == 0 or s.kind == 3) "dispatch" else "settled",
      admissions: if (s.kind == 0 or s.kind == 3) 1 else 0 }
  }
  action finish = all { s.phase == "dispatch", s' = s.with("phase", "settled") }
  action cancel = all { s.phase == "preflight", s' = s.with("phase", "settled") }
  action dispose = all {
    s.phase == "settled",
    s' = { ...s, phase: "done", disposed: true,
      standalone: if (s.admissions == 0) 1 else s.standalone }
  }
  action advance = any { preflight, finish, cancel, dispose }
  action step = any { advance, s' = s }
  val TypeOK = all {
    s.kind.in(0.to(3)), s.phase.in(Set("preflight", "dispatch", "settled", "done")),
    s.admissions.in(Set(0, 1)), s.standalone.in(Set(0, 1))
  }
  val GuardOwnsDispatch = s.disposed implies s.phase == "done"
  val OneCredentialBoundary = s.admissions + s.standalone <= 1
  val FinishedHasProof = s.phase == "done" implies s.admissions + s.standalone == 1
  temporal Returns = (s.phase != "done").leadsTo(s.phase == "done")
  temporal FairReturns = advance.weakFair(s) implies Returns
  // Returning the dispatch promise without awaiting it permits this old ordering.
  action legacyDispose = all {
    s.phase == "preflight", s' = { ...s, disposed: true, standalone: 1 }
  }
  run paidDispatchTest = initialize(0).then(preflight).then(finish).then(dispose)
    .expect(GuardOwnsDispatch and OneCredentialBoundary and s.admissions == 1)
  run refusalTest = initialize(1).then(preflight).then(dispose)
    .expect(OneCredentialBoundary and s.standalone == 1)
  run dispatchFailureTest = initialize(3).then(preflight).then(finish).then(dispose)
    .expect(OneCredentialBoundary and s.admissions == 1)
  run cancellationTest = initialize(0).then(cancel).then(dispose)
    .expect(OneCredentialBoundary and s.standalone == 1)
  run legacyDoubleCheckTest = initialize(0).then(legacyDispose).then(preflight)
    .expect(not(OneCredentialBoundary) and not(GuardOwnsDispatch))
}
