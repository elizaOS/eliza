// Finite boundary obligations; actual text/recognition/restoration run in conformance.
module ToolPrivacyComposition {
  var s: { phase: str, known: bool, entity: str, kind: str, capture: bool,
    opaque: bool, adjacentMasked: bool, argsMasked: bool, typedHint: bool,
    innerExpanded: bool, canonical: bool, handler: bool }

  action init = s' = { phase: "choose", known: false, entity: "person",
    kind: "phone", capture: false, opaque: false, adjacentMasked: false,
    argsMasked: true, typedHint: false, innerExpanded: false,
    canonical: false, handler: false }

  action chooseBoundary(known: bool, entity: str, kind: str, capture: bool): bool = all {
    s.phase == "choose",
    s' = { ...s, phase: "ingress", known: known, entity: entity, kind: kind, capture: capture },
  }
  // Recognition sees own reference spans as whitespace; provider retains handles.
  action ingress = all {
    s.phase == "ingress",
    s' = { ...s, phase: "provider", opaque: true, adjacentMasked: true,
      typedHint: s.known },
  }
  // Historical nested person/org aliases remain supported at the private boundary.
  action expandPii = all {
    s.phase == "provider",
    s' = { ...s, phase: "secret-check", innerExpanded: true },
  }
  action strictRestore = all {
    s.phase == "secret-check",
    s' = { ...s, phase: if (s.known) "execute" else "denied",
      canonical: s.known },
  }
  action invoke = all {
    s.phase == "execute",
    s' = { ...s, phase: "done", handler: true },
  }
  action step = any {
    { nondet known = Set(false, true).oneOf()
      nondet entity = Set("person", "org").oneOf()
      nondet kind = Set("phone", "email").oneOf()
      nondet capture = Set(false, true).oneOf()
      chooseBoundary(known, entity, kind, capture) },
    ingress, expandPii, strictRestore, invoke, s' = s,
  }

  val TypeOK = Set("choose", "ingress", "provider", "secret-check", "execute", "denied", "done").contains(s.phase)
    and Set("person", "org").contains(s.entity) and Set("phone", "email").contains(s.kind)
  val ProviderPrivacy = Set("provider", "secret-check", "execute", "denied", "done").contains(s.phase)
    .implies(s.opaque and s.adjacentMasked and s.argsMasked and (s.typedHint == s.known))
  val PrivateExecution = s.handler.implies(s.known and s.canonical and s.innerExpanded and s.argsMasked)
  val UnknownFailsClosed = (not(s.known)).implies(not(s.handler) and not(s.canonical))
  val CaptureIndependent = (s.phase == "done").implies(s.canonical and s.handler)

  run privatePhoneWithoutCaptureTest = init.then(chooseBoundary(true, "person", "phone", false))
    .then(ingress).then(expandPii).then(strictRestore).then(invoke)
    .expect(s.handler and s.canonical and not(s.capture))
  run privateOrgEmailTest = init.then(chooseBoundary(true, "org", "email", true))
    .then(ingress).then(expandPii).then(strictRestore).then(invoke)
    .expect(s.typedHint and s.handler)
  run unknownNestedReferenceTest = init.then(chooseBoundary(false, "org", "phone", false))
    .then(ingress).then(expandPii).then(strictRestore)
    .expect(s.phase == "denied" and not(s.handler))
}
